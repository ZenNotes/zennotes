import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// The Go consumer of these fixtures is ZenNotes/znserver. Point at a checkout
// with ZENNOTES_SERVER_DIR (or the first non-flag argument); --write copies the
// fixtures and their provenance in, and without it the copies are compared.
const serverDir = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? process.env.ZENNOTES_SERVER_DIR
if (!serverDir) throw new Error('Pass a ZenNotes/znserver checkout path or set ZENNOTES_SERVER_DIR')
const fixtures = [
  ['task-roundtrip.json', 'vault'],
  ['self-hosted-http.json', 'httpserver']
]
for (const [name, consumer] of fixtures) {
  const source = `packages/bridge-contract/fixtures/${name}`
  const target = resolve(serverDir, `internal/${consumer}/testdata/${name}`)
  const bytes = await readFile(resolve(root, source))
  const provenance =
    JSON.stringify(
      {
        sourceRepository: 'https://github.com/ZenNotes/zennotes',
        sourcePath: source,
        sha256: createHash('sha256').update(bytes).digest('hex')
      },
      null,
      2
    ) + '\n'

  for (const [path, content] of [
    [target, bytes],
    [`${target}.source.json`, Buffer.from(provenance)]
  ]) {
    if (process.argv.includes('--write')) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    } else {
      const current = await readFile(path)
      if (!current.equals(content)) {
        throw new Error(`Contract fixture differs: ${path}. Run npm run sync:contract-fixtures -- <znserver checkout>.`)
      }
    }
  }
}
process.stdout.write(`Go fixtures in ${serverDir} match the shared contract bytes.\n`)
