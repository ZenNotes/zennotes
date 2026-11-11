import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packAppCore } from './pack-app-core.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * The artifacts `.github/workflows/boundary-artifact-release.yml` releases, and
 * the script that packs each one: core is packed in this process, the browser
 * artifacts by their own script, whose last output is a JSON summary.
 * `cloud-web` runs what `npm run artifact:cloud-web` runs.
 */
export const RELEASE_TARGETS = {
  core: null,
  web: ['pack-web-artifact.mjs'],
  'cloud-web': ['pack-web-artifact.mjs', '--target=cloud-web'],
  viewer: ['pack-share-viewer.mjs']
}

/** Every release is tagged `<target>-<version>`, which the browser manifests' download URLs name. */
export const releaseTag = (target, version) => `${target}-${version}`

// Runtime tests use absolute paths; public provenance must remain portable.
function portable(value) {
  if (Array.isArray(value)) return value.map(portable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key, val]) => !(key === 'archive' && typeof val === 'string')).map(([key, val]) => [key, portable(val)]))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2]
  assert.ok(Object.hasOwn(RELEASE_TARGETS, target), `Expected one of ${Object.keys(RELEASE_TARGETS).join(', ')}`)
  const local = process.argv.includes('--allow-dirty')
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0
  assert.ok(local || !dirty, 'Release preparation requires an approved clean source commit; use --allow-dirty only for a local rehearsal')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (process.env.APPROVED_SOURCE) assert.equal(commit, process.env.APPROVED_SOURCE, 'Source differs from the approved commit')
  let version, entries
  if (target === 'core') {
    const core = await packAppCore()
    version = core.version
    entries = [core, ...core.dependencies].map(manifest => ({ archive: manifest.archive, manifest, filename: manifest.file }))
  } else {
    const [script, ...args] = RELEASE_TARGETS[target]
    const log = execFileSync(process.execPath, [join(root, 'tooling/scripts', script), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    const result = JSON.parse(log.slice(log.lastIndexOf('\n{')))
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
    version = result.version
    entries = [{ archive: result.archive, manifest, filename: manifest.archive.file }]
  }
  const tag = releaseTag(target, version)
  const output = join(root, 'dist/boundary-release', tag)
  await mkdir(output, { recursive: true })
  const files = []
  for (const entry of entries) {
    const bytes = await readFile(entry.archive)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.manifest.sha256 ?? entry.manifest.archive.sha256)
    assert.equal(entry.manifest.sourceCommit ?? entry.manifest.source.commit, commit)
    assert.ok(local || !(entry.manifest.workingTreeDirty ?? entry.manifest.source?.dirty), 'Dirty artifacts cannot be released')
    // Consumers download a browser artifact by its manifest's URL, so it must
    // name the release this archive is attached to.
    if (target !== 'core' && !local) {
      assert.equal(entry.manifest.archive.url, `https://github.com/ZenNotes/zennotes/releases/download/${tag}/${entry.filename}`, 'The manifest names another release')
    }
    await copyFile(entry.archive, join(output, entry.filename))
    await writeFile(join(output, `${entry.filename}.json`), JSON.stringify(portable(entry.manifest), null, 2) + '\n')
    files.push(entry.filename, `${entry.filename}.json`)
  }
  const release = { target, tag, sourceCommit: commit, localCandidate: local, files }
  await writeFile(join(output, 'release.json'), JSON.stringify(release, null, 2) + '\n')
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `directory=${output}\ntag=${release.tag}\n`, { flag: 'a' })
  console.log(JSON.stringify({ output, ...release }, null, 2))
}
