import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packAppCore } from './pack-app-core.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const target = process.argv[2]
assert.ok(['core', 'web', 'viewer'].includes(target), 'Expected core, web or viewer')
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
  const script = target === 'web' ? 'pack-web-artifact.mjs' : 'pack-share-viewer.mjs'
  const log = execFileSync(process.execPath, [join(root, 'tooling/scripts', script)], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const result = JSON.parse(log.slice(log.lastIndexOf('\n{')))
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
  version = result.version
  entries = [{ archive: result.archive, manifest, filename: manifest.archive.file }]
}
const output = join(root, 'dist/boundary-release', `${target}-${version}`)
await mkdir(output, { recursive: true })
// Runtime tests use absolute paths; public provenance must remain portable.
function portable(value) {
  if (Array.isArray(value)) return value.map(portable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key, val]) => !(key === 'archive' && typeof val === 'string')).map(([key, val]) => [key, portable(val)]))
}
const files = []
for (const entry of entries) {
  const bytes = await readFile(entry.archive)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.manifest.sha256 ?? entry.manifest.archive.sha256)
  assert.equal(entry.manifest.sourceCommit ?? entry.manifest.source.commit, commit)
  assert.ok(local || !(entry.manifest.workingTreeDirty ?? entry.manifest.source?.dirty), 'Dirty artifacts cannot be released')
  await copyFile(entry.archive, join(output, entry.filename))
  await writeFile(join(output, `${entry.filename}.json`), JSON.stringify(portable(entry.manifest), null, 2) + '\n')
  files.push(entry.filename, `${entry.filename}.json`)
}
const release = { target, tag: `${target}-${version}`, sourceCommit: commit, localCandidate: local, files }
await writeFile(join(output, 'release.json'), JSON.stringify(release, null, 2) + '\n')
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `directory=${output}\ntag=${release.tag}\n`, { flag: 'a' })
console.log(JSON.stringify({ output, ...release }, null, 2))
