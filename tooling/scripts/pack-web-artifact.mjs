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
  if (!['web', 'viewer'].includes(target)) throw new Error('Unknown frontend artifact target')
  const viewer = target === 'viewer'
  const stage = await mkdtemp(join(tmpdir(), 'zennotes-web-artifact-'))
  try {
    await cp(distribution, join(stage, 'dist'), {
      recursive: true,
      verbatimSymlinks: true
    })
    const licenseBytes = await readFile(license)
    // The viewer is installed as static files; retain its license in that tree.
    if (viewer) await writeFile(join(stage, 'dist', 'LICENSE'), licenseBytes, { flag: 'wx' })
    const files = await inventory(join(stage, 'dist'))
    const entrypoints = viewer ? ['share-viewer.js', 'share-viewer.css'] : ['index.html', 'sw.js', 'manifest.webmanifest']
    for (const path of entrypoints) {
      if (!files.some((file) => file.path === path && file.size > 0))
        throw new Error(`Missing browser entrypoint: ${path}`)
    }
    const identity = {
      schemaVersion: 1,
      artifact: viewer ? 'zennotes-share-viewer' : 'zennotes-self-hosted-web',
      protocol: viewer ? 'share-page-payload-v1' : 'self-hosted-http-v1',
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
          name: viewer ? '@zennotes/share-viewer-dist' : '@zennotes/self-hosted-web',
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
    runNpm(['run', 'build', '--workspace', '@zennotes/web'], {
      cwd: root,
      env: webDistLockEnv(lock),
      stdio: 'inherit'
    })
    const product = JSON.parse(await readFile(join(root, 'apps/web/package.json'), 'utf8'))
    const result = await packWebDistribution({
      distribution: join(root, 'apps/web/dist'),
      output: join(root, 'dist/web-artifacts'),
      productVersion: product.version,
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
