import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'zennotes terminal & '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resources = join(root, 'ZenNotes.app/Contents/Resources')
  const electron = join(root, 'ZenNotes.app/Contents/MacOS/ZenNotes')
  const userData = join(root, 'user data')
  const trace = join(root, 'trace')
  const command = join(root, 'bin/zn')
  const cliJS = join(resources, 'cli.js')
  await Promise.all(
    [
      resources,
      dirname(electron),
      userData,
      trace,
      dirname(command),
      join(root, 'home'),
      join(root, 'config'),
    ].map((path) => mkdir(path, { recursive: true })),
  )
  await copyFile(
    new URL('../../apps/desktop/build/zen', import.meta.url),
    join(resources, 'zen'),
  )
  await chmod(join(resources, 'zen'), 0o755)
  await symlink(join(resources, 'zen'), command)
  await writeFile(
    cliJS,
    '// The fake Electron executable records this entry point.\n',
  )

  async function executable(path, engine, exitCode = 0) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      `#!/bin/sh
set -eu
printf '%s\\n' '${engine}' >> "$TEST_TRACE_DIR/calls"
printf '%s\\0' "\${ZENNOTES_WORKSPACE_SOURCE-}" "\${ELECTRON_RUN_AS_NODE-}" "$@" > "$TEST_TRACE_DIR/${engine}.args"
cat
printf '%s' "\${TEST_STDERR-}" >&2
exit ${exitCode}
`,
    )
    await chmod(path, 0o755)
  }
  await executable(electron, 'legacy')

  function run(args = [], { input = '', env = {} } = {}) {
    const result = spawnSync(command, args, {
      cwd: root,
      input,
      timeout: 5000,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: join(root, 'home'),
        XDG_CONFIG_HOME: join(root, 'config'),
        ZENNOTES_CONFIG_DIR: join(root, 'config'),
        ZENNOTES_USER_DATA_PATH: userData,
        TEST_TRACE_DIR: trace,
        ...env,
      },
    })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    return result
  }

  async function invocation(engine) {
    const fields = (
      await readFile(join(trace, `${engine}.args`), 'utf8')
    ).split('\0')
    assert.equal(fields.pop(), '')
    return {
      workspaceSource: fields[0],
      electronRunAsNode: fields[1],
      args: fields.slice(2),
    }
  }

  return {
    resources,
    electron,
    userData,
    cliJS,
    executable,
    run,
    invocation,
    calls: async () =>
      (await readFile(join(trace, 'calls'), 'utf8')).trimEnd().split('\n'),
  }
}

test('an existing desktop shortcut runs the activated Go CLI without Electron or cli.js', async (t) => {
  const app = await fixture(t)
  await app.executable(join(app.userData, 'cli/zn'), 'managed')
  await Promise.all([rm(app.electron), rm(app.cliJS)])

  const result = app.run(['list', '--json'])

  assert.equal(result.status, 0, result.stderr.toString())
  assert.equal(result.stdout.toString(), '')
  assert.equal(result.stderr.toString(), '')
  assert.deepEqual(await app.calls(), ['managed'])
  assert.deepEqual(await app.invocation('managed'), {
    workspaceSource: 'app',
    electronRunAsNode: '',
    args: ['list', '--json'],
  })
})

test('Go receives exact arguments and streams, and a nonzero exit never retries legacy', async (t) => {
  const app = await fixture(t)
  await app.executable(join(app.userData, 'cli/zn'), 'managed', 37)
  const args = [
    'write',
    'inbox/café 日本語.md',
    '--',
    '',
    'spaces & $HOME',
    'first\nsecond',
  ]
  const input = Buffer.from(
    '# café 日本語\n\nTwo trailing spaces.  \n\0binary\n',
  )
  const stderr = 'A deliberate command error.\n'

  const result = app.run(args, { input, env: { TEST_STDERR: stderr } })

  assert.equal(result.status, 37)
  assert.deepEqual(result.stdout, input)
  assert.equal(result.stderr.toString(), stderr)
  assert.deepEqual(await app.calls(), ['managed'])
  assert.deepEqual((await app.invocation('managed')).args, args)
})

test('an explicit workspace source overrides the migrated desktop default', async (t) => {
  const app = await fixture(t)
  await app.executable(join(app.userData, 'cli/zn'), 'managed')

  const result = app.run(['tui'], {
    env: { ZENNOTES_WORKSPACE_SOURCE: 'terminal' },
  })

  assert.equal(result.status, 0, result.stderr.toString())
  assert.deepEqual(await app.calls(), ['managed'])
  assert.equal((await app.invocation('managed')).workspaceSource, 'terminal')
})

test('an existing desktop shortcut prefers the persistent managed CLI', async (t) => {
  const app = await fixture(t)
  await app.executable(join(app.resources, 'terminal/zn'), 'bundled')
  await app.executable(join(app.userData, 'cli/zn'), 'managed')

  const result = app.run(['vault', 'info', '--json'])

  assert.equal(result.status, 0, result.stderr.toString())
  assert.deepEqual(await app.calls(), ['managed'])
  assert.deepEqual(await app.invocation('managed'), {
    workspaceSource: 'app',
    electronRunAsNode: '',
    args: ['vault', 'info', '--json'],
  })
})

test('the legacy override selects Electron even when both Go installations exist', async (t) => {
  const app = await fixture(t)
  await app.executable(join(app.resources, 'terminal/zn'), 'bundled')
  await app.executable(join(app.userData, 'cli/zn'), 'managed')
  const input = 'Existing MCP stdin\n'

  const result = app.run(['mcp'], {
    input,
    env: { ZENNOTES_CLI_ENGINE: 'legacy' },
  })

  assert.equal(result.status, 0, result.stderr.toString())
  assert.equal(result.stdout.toString(), input)
  assert.equal(result.stderr.toString(), '')
  assert.deepEqual(await app.calls(), ['legacy'])
  assert.deepEqual((await app.invocation('legacy')).args, [app.cliJS, 'mcp'])
  assert.equal((await app.invocation('legacy')).electronRunAsNode, '1')
})

test('a desktop bundle without a Go artifact retains the existing Electron CLI', async (t) => {
  const app = await fixture(t)
  await app.executable(app.electron, 'legacy', 19)
  const args = ['capture', '--title', 'Piped note']
  const input = 'The existing CLI remains usable.  \n'
  const stderr = 'Existing CLI error\n'

  const result = app.run(args, { input, env: { TEST_STDERR: stderr } })

  assert.equal(result.status, 19)
  assert.equal(result.stdout.toString(), input)
  assert.equal(result.stderr.toString(), stderr)
  assert.deepEqual(await app.calls(), ['legacy'])
  assert.deepEqual((await app.invocation('legacy')).args, [app.cliJS, ...args])
  assert.equal((await app.invocation('legacy')).electronRunAsNode, '1')
})

test('an unactivated Go candidate cannot bypass desktop verification', async (t) => {
  const app = await fixture(t)
  await app.executable(join(app.resources, 'terminal/zn'), 'unverified', 23)
  const result = app.run(['write', 'inbox/Existing.md'])
  assert.equal(result.status, 0)
  assert.deepEqual(await app.calls(), ['legacy'])
})
