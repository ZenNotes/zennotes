import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runNpm } from './pack-shared-package.mjs'
import { webDistLockEnv, withWebDistLock } from './web-dist-lock.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function inventory(directory, prefix = '') {
  const files = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    const path = prefix + entry.name
    if (entry.isDirectory())
      files.push(...(await inventory(join(directory, entry.name), `${path}/`)))
    else if (entry.isFile()) {
      const bytes = await readFile(join(directory, entry.name))
      files.push({ path, size: bytes.length, sha256: sha256(bytes) })
    } else throw new Error(`Browser artifacts must contain regular files: ${path}`)
  }
  return files
}

async function writeImmutable(path, bytes) {
  try {
    await writeFile(path, bytes, { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!bytes.equals(await readFile(path)))
      throw new Error(`Artifact already exists with different bytes: ${path}`)
  }
}

/**
 * The browser artifacts this script packs, one immutable archive each, whose
 * manifest records the source commit and every file's SHA-256:
 * - `web`: the self-hosted web client (apps/web/dist), embedded by znserver;
 * - `viewer`: the public share viewer, installed by the website;
 * - `cloud-web`: ZenNotes in your browser (apps/web/dist-cloud), installed by
 *   the website for app.zennotes.org (docs/ideas/cloud-in-browser.md,
 *   "Hosting"). `headers.json` carries the headers its shell must be served
 *   with.
 */
export const TARGETS = {
  web: {
    artifact: 'zennotes-self-hosted-web',
    protocol: 'self-hosted-http-v1',
    packageName: '@zennotes/self-hosted-web',
    entrypoints: ['index.html', 'sw.js', 'manifest.webmanifest'],
    workspaceScript: 'build',
    distribution: 'apps/web/dist'
  },
  viewer: {
    artifact: 'zennotes-share-viewer',
    protocol: 'share-page-payload-v1',
    packageName: '@zennotes/share-viewer-dist',
    entrypoints: ['share-viewer.js', 'share-viewer.css'],
    staticLicense: true
  },
  'cloud-web': {
    artifact: 'zennotes-cloud-web',
    protocol: 'browser-vault-v1',
    packageName: '@zennotes/cloud-web',
    entrypoints: ['index.html', 'sw.js', 'manifest.webmanifest', 'headers.json', 'THIRD_PARTY_NOTICES.txt'],
    workspaceScript: 'build:cloud',
    distribution: 'apps/web/dist-cloud',
    staticLicense: true
  }
}

export async function packWebDistribution({
  distribution,
  output,
  productVersion,
  source,
  toolchain,
  license = join(root, 'LICENSE'),
  target = 'web'
}) {
  if (
    typeof source?.dirty !== 'boolean' ||
    source.repository !== 'https://github.com/ZenNotes/zennotes' ||
    !/^[a-f0-9]{40}$/.test(source.commit)
  ) {
    throw new Error(
      'Artifact source must include its repository, commit, and explicit dirty boolean'
    )
  }
  const profile = TARGETS[target]
  if (!profile) throw new Error('Unknown frontend artifact target')
  const stage = await mkdtemp(join(tmpdir(), 'zennotes-web-artifact-'))
  try {
    await cp(distribution, join(stage, 'dist'), {
      recursive: true,
      verbatimSymlinks: true
    })
    const licenseBytes = await readFile(license)
    // The viewer and the browser app are installed as static files; retain
    // the license in that tree.
    if (profile.staticLicense) await writeFile(join(stage, 'dist', 'LICENSE'), licenseBytes, { flag: 'wx' })
    const files = await inventory(join(stage, 'dist'))
    const entrypoints = profile.entrypoints
    for (const path of entrypoints) {
      if (!files.some((file) => file.path === path && file.size > 0))
        throw new Error(`Missing browser entrypoint: ${path}`)
    }
    const identity = {
      schemaVersion: 1,
      artifact: profile.artifact,
      protocol: profile.protocol,
      source,
      toolchain,
      entrypoints,
      files
    }
    const version = `${productVersion}-${target}.h${sha256(JSON.stringify({ ...identity, licenseSha256: sha256(licenseBytes), packFormat: 1 })).slice(0, 16)}`
    await writeFile(join(stage, 'LICENSE'), licenseBytes)
    await writeFile(
      join(stage, 'package.json'),
      JSON.stringify(
        {
          name: profile.packageName,
          version,
          private: true,
          license: 'MIT',
          files: ['dist', 'LICENSE']
        },
        null,
        2
      ) + '\n'
    )
    const packed = JSON.parse(
      runNpm(['pack', '--json', '--ignore-scripts'], {
        cwd: stage,
        encoding: 'utf8'
      })
    )[0]
    const bytes = await readFile(join(stage, packed.filename))
    const archive = {
      file: packed.filename,
      size: bytes.length,
      sha256: sha256(bytes),
      ...(!source.dirty
        ? {
            url: `https://github.com/ZenNotes/zennotes/releases/download/${target}-${version}/${packed.filename}`
          }
        : {})
    }
    const manifest = { ...identity, version, archive }
    await mkdir(output, { recursive: true })
    const archivePath = join(output, packed.filename)
    const manifestPath = `${archivePath}.json`
    await writeImmutable(archivePath, bytes)
    await writeImmutable(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
    return { archivePath, manifestPath, manifest }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targetArgument = process.argv.find((argument) => argument.startsWith('--target='))
  const target = targetArgument ? targetArgument.slice('--target='.length) : 'web'
  const profile = TARGETS[target]
  if (!profile?.workspaceScript) throw new Error(`pack-web-artifact builds --target=web or --target=cloud-web, not ${target}`)
  await withWebDistLock(async (lock) => {
    const source = {
      repository: 'https://github.com/ZenNotes/zennotes',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim(),
      dirty:
        execFileSync('git', ['status', '--porcelain'], {
          cwd: root,
          encoding: 'utf8'
        }).trim().length > 0,
      lockfileSha256: sha256(await readFile(join(root, 'package-lock.json')))
    }
    runNpm(['run', profile.workspaceScript, '--workspace', '@zennotes/web'], {
      cwd: root,
      env: webDistLockEnv(lock),
      stdio: 'inherit'
    })
    const product = JSON.parse(await readFile(join(root, 'apps/web/package.json'), 'utf8'))
    const result = await packWebDistribution({
      distribution: join(root, profile.distribution),
      output: join(root, 'dist/web-artifacts'),
      productVersion: product.version,
      target,
      source,
      toolchain: {
        node: process.version,
        npm: runNpm(['--version'], { encoding: 'utf8' }).trim()
      }
    })
    process.stdout.write(
      JSON.stringify(
        {
          version: result.manifest.version,
          archive: result.archivePath,
          manifest: result.manifestPath
        },
        null,
        2
      ) + '\n'
    )
  })
}
