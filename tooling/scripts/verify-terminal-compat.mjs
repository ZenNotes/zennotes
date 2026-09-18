// Run both implementations against disposable, identical vaults. No installed
// command or personal configuration is used. Keep this oracle until Node retires.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const binary = process.argv[2]
if (!binary)
  throw new Error(
    'Usage: node tooling/scripts/verify-terminal-compat.mjs /absolute/path/to/zn',
  )
const root = await mkdtemp(join(tmpdir(), 'zn-terminal-compat-'))
const vault = join(root, 'vault'),
  config = join(root, 'config')
const body =
  '# Project\n\ncafé 日本語.  \n#demo\n\n- [ ] Ship migration\n- [x] Existing task\n'
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('ZENNOTES_')),
)
Object.assign(env, {
  ZENNOTES_CONFIG_DIR: config,
  ZENNOTES_USER_DATA_PATH: config,
  ZENNOTES_WORKSPACE_SOURCE: 'app',
  NO_COLOR: '1',
})
const report = []
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(createdAt|updatedAt|lastOpenedAt|modifiedAt)$/.test(k) &&
        typeof v === 'number'
          ? '<timestamp>'
          : normalize(v),
      ]),
    )
  if (typeof value === 'string')
    return value.replace(
      /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
      '<uuid>',
    )
  return value
}
async function snapshot(dir, relative = '') {
  const result = {}
  for (const entry of await readdir(join(dir, relative), {
    withFileTypes: true,
  })) {
    const key = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(result, await snapshot(dir, key))
    else {
      let content = await readFile(join(dir, key), 'utf8')
      if (entry.name.endsWith('.json')) {
        try {
          content = JSON.parse(content)
        } catch {}
      }
      result[key] = normalize(content)
    }
  }
  return result
}
for (const layout of ['inbox', 'root', 'remapped']) {
  const note = layout === 'root' ? 'Project.md' : 'inbox/Project.md'
  const histories = []
  for (const [engine, command] of [
    ['node', [process.execPath, join(repo, 'apps/desktop/out/main/cli.js')]],
    ['go', [resolve(binary)]],
  ]) {
    await rm(vault, { recursive: true, force: true })
    await rm(config, { recursive: true, force: true })
    for (const dir of ['inbox', 'quick', 'archive', 'trash', '.zennotes'])
      await mkdir(join(vault, dir), { recursive: true })
    await mkdir(config)
    await writeFile(
      join(vault, '.zennotes/vault.json'),
      JSON.stringify({
        primaryNotesLocation: layout === 'root' ? 'root' : 'inbox',
        ...(layout === 'remapped'
          ? {
              systemFolderPaths: {
                quick: 'Scratch',
                trash: 'Deleted',
                archive: 'History',
              },
            }
          : {}),
      }),
    )
    await writeFile(join(vault, note), body)
    await writeFile(
      join(config, 'zennotes.config.json'),
      JSON.stringify({
        workspaceMode: 'local',
        vaultRoot: vault,
        localVaults: [{ name: 'Desktop', root: vault }],
      }),
    )
    const history = []
    function run(args, input) {
      const p = spawnSync(command[0], [...command.slice(1), ...args], {
        env,
        cwd: root,
        encoding: 'utf8',
        input,
        timeout: 15000,
      })
      if (p.error) throw p.error
      let stdout = p.stdout
      try {
        stdout = JSON.parse(stdout)
      } catch {}
      assert.equal(p.status, 0, `${engine}: ${args.join(' ')}: ${p.stderr}`)
      history.push({
        args,
        status: p.status,
        stdout: normalize(stdout),
        stderr: p.stderr,
      })
      return stdout
    }
    run(['list', '--json'])
    run(['read', note, '--json'])
    run(['search', 'café', '--json'])
    run(['vault', 'info', '--json'])
    run(['folder', 'list', '--json'])
    run(['tag', 'list', '--json'])
    const tasks = run(['task', 'list', '--all', '--json'])
    run(['task', 'toggle', tasks[0].id, '--json'])
    run(['append', note, '--body', '\nAppended ✓  ', '--json'])
    run(['write', note, '--body', '-', '--json'], body)
    assert.equal(
      await readFile(join(vault, note), 'utf8'),
      body,
      'stdin bytes must survive exactly',
    )
    run(['folder', 'create', 'inbox/Work', '--json'])
    run(['folder', 'rename', 'inbox/Work', '--to', 'inbox/Renamed', '--json'])
    const captured = run([
      'capture',
      'Pipe café 日本語',
      '--title',
      'Captured',
      '--folder',
      'quick',
      '--json',
    ])
    run(['trash', captured.path, '--json'])
    run([
      'restore',
      `${layout === 'remapped' ? 'Deleted' : 'trash'}/Captured.md`,
      '--json',
    ])
    run(['comment', 'add', note, 'Review this', '--author', 'Test', '--json'])
    run(['comment', 'list', note, '--json'])
    run(['base', 'create', 'Migration', '--json'])
    run(['base', 'add', 'Migration', '--set', 'Name=Fixture', '--json'])
    run(['base', 'rows', 'Migration', '--json'])
    histories.push({ engine, history, files: await snapshot(vault) })
  }
  const [node, go] = histories
  const comparisons = node.history.map((check, i) => {
    let equal = true
    try {
      assert.deepEqual(go.history[i], check)
    } catch {
      equal = false
    }
    return {
      args: check.args,
      equal,
      ...(equal ? {} : { node: check, go: go.history[i] }),
    }
  })
  let filesEqual = true
  try {
    assert.deepEqual(go.files, node.files)
  } catch {
    filesEqual = false
  }
  report.push({
    layout,
    comparisons,
    filesEqual,
    ...(filesEqual ? {} : { nodeFiles: node.files, goFiles: go.files }),
  })
}
const reportPath = join(root, 'report.json')
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(
  JSON.stringify(
    {
      reportPath,
      results: report.map((r) => ({
        layout: r.layout,
        commands: r.comparisons.length,
        matching: r.comparisons.filter((c) => c.equal).length,
        filesEqual: r.filesEqual,
      })),
    },
    null,
    2,
  ),
)
if (report.some((r) => !r.filesEqual || r.comparisons.some((c) => !c.equal)))
  process.exitCode = 1
