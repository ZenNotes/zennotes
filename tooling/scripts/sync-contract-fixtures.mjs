import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// The Go consumers of these fixtures are ZenNotes/znserver and ZenNotes/tui.
// Point at a server checkout with ZENNOTES_SERVER_DIR, --server <dir> or the
// first non-flag argument, and at a tui checkout with ZENNOTES_TUI_DIR or
// --tui <dir>; only the fixtures of the checkouts given are touched. --write
// copies the fixtures and their provenance in, and without it the copies are
// compared.
const args = process.argv.slice(2)
const flagValue = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const positional = args.find(
  (arg, i) => !arg.startsWith('--') && args[i - 1] !== '--server' && args[i - 1] !== '--tui'
)
const dirs = {
  server: flagValue('--server') ?? positional ?? process.env.ZENNOTES_SERVER_DIR,
  tui: flagValue('--tui') ?? process.env.ZENNOTES_TUI_DIR
}
if (!dirs.server && !dirs.tui) {
  throw new Error(
    'Pass a ZenNotes/znserver checkout (or --server <dir> / ZENNOTES_SERVER_DIR), a ZenNotes/tui checkout (--tui <dir> / ZENNOTES_TUI_DIR), or both'
  )
}
const fixtures = [
  ['task-roundtrip.json', 'server', 'vault'],
  ['task-subtasks.json', 'server', 'vault'],
  ['self-hosted-http.json', 'server', 'httpserver'],
  ['mcp-scope.json', 'tui', 'mcp']
]
const checked = []
for (const [name, repo, consumer] of fixtures) {
  const repoDir = dirs[repo]
  if (!repoDir) continue
  const source = `packages/bridge-contract/fixtures/${name}`
  const target = resolve(repoDir, `internal/${consumer}/testdata/${name}`)
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
    if (args.includes('--write')) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    } else {
      const current = await readFile(path)
      if (!current.equals(content)) {
        throw new Error(
          `Contract fixture differs: ${path}. Run npm run sync:contract-fixtures -- --${repo} <checkout>.`
        )
      }
    }
  }
  checked.push(repoDir)
}
process.stdout.write(
  `Go fixtures in ${[...new Set(checked)].join(' and ')} match the shared contract bytes.\n`
)
