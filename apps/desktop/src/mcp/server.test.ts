import { createServer, type Server as HttpServer } from 'node:http'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from '../cli/args'
import { createBackend, type VaultBackend } from '../cli/backend'
import { resolveTarget, type VaultTarget } from '../cli/vault-target'
import { RemoteRequestError } from '../main/remote/connection'
import {
  callTool,
  commentAuthorForClient,
  describeToolError,
  listToolNames,
  runMcpServer,
  VaultSwitchedError,
  type McpServerOptions
} from './server'

// Only the members a given test reaches are implemented; the cast keeps the
// stubs honest about being partial.
function backend(partial: Partial<VaultBackend>): VaultBackend {
  return partial as VaultBackend
}

describe('vault_info (#688)', () => {
  it('describes a server-backed vault as remote, with the auth state and no disk paths', async () => {
    const info = (await callTool(
      'vault_info',
      {},
      backend({
        kind: 'remote',
        describe: async () => ({
          kind: 'remote',
          baseUrl: 'http://192.168.1.10:7878',
          name: 'home',
          vaultPath: '/srv/notes',
          vaultName: 'notes',
          primaryNotesLocation: 'inbox',
          authConfigured: false
        }),
        listFolders: async () => [{ folder: 'inbox', subpath: 'Work' }]
      })
    )) as Record<string, unknown>
    expect(info).toMatchObject({
      kind: 'remote',
      server: 'http://192.168.1.10:7878',
      serverName: 'home',
      vaultPath: '/srv/notes',
      vaultName: 'notes',
      primaryNotesLocation: 'inbox',
      authConfigured: false,
      subfolders: [{ folder: 'inbox', subpath: 'Work' }]
    })
    expect(info).not.toHaveProperty('vaultRoot')
    expect(String(info.notes)).toContain('ZENNOTES_REMOTE_TOKEN')
    expect(String(info.notes)).toContain('zn connect http://192.168.1.10:7878 --no-default')
    expect(String(info.notes)).toContain('INBOX mode')
  })

  it('keeps the local shape (vaultRoot, inboxAbsolutePath) for a folder vault', async () => {
    const info = (await callTool(
      'vault_info',
      {},
      backend({
        kind: 'local',
        describe: async () => ({
          kind: 'local',
          root: '/home/me/notes',
          primaryNotesLocation: 'root'
        }),
        listFolders: async () => []
      })
    )) as Record<string, unknown>
    expect(info).toMatchObject({
      kind: 'local',
      vaultRoot: '/home/me/notes',
      inboxAbsolutePath: '/home/me/notes',
      primaryNotesLocation: 'root'
    })
    expect(String(info.notes)).toContain('ROOT mode')
    expect(String(info.notes)).not.toContain('ZENNOTES_REMOTE_TOKEN')
  })
})

describe('tools run through the backend', () => {
  it('routes a write through the backend rather than the filesystem', async () => {
    const calls: unknown[] = []
    const result = await callTool(
      'append_to_note',
      { path: 'inbox/Daily.md', text: '- item' },
      backend({
        appendToNote: async (rel, text) => {
          calls.push([rel, text])
          return { path: rel, title: 'Daily' } as never
        }
      })
    )
    expect(calls).toEqual([['inbox/Daily.md', '- item']])
    expect(result).toMatchObject({ path: 'inbox/Daily.md' })
  })

  it('exposes every tool the server advertised before the refactor', () => {
    expect(listToolNames()).toEqual([
      'vault_info',
      'list_notes',
      'list_folders',
      'list_assets',
      'read_note',
      'write_note',
      'create_note',
      'rename_note',
      'move_note',
      'duplicate_note',
      'move_to_trash',
      'restore_from_trash',
      'empty_trash',
      'delete_note',
      'archive_note',
      'unarchive_note',
      'create_folder',
      'rename_folder',
      'delete_folder',
      'search_text',
      'search_by_title',
      'search_by_tag',
      'list_tags',
      'backlinks',
      'list_tasks',
      'toggle_task',
      'append_to_note',
      'prepend_to_note',
      'insert_at_line',
      'replace_in_note',
      'list_comments',
      'add_comment',
      'reply_to_comment',
      'resolve_comment'
    ])
  })
})

describe('list_tasks', () => {
  const task = (content: string, extra: Record<string, unknown> = {}): unknown => ({
    content,
    noteFolder: 'inbox',
    checked: false,
    waiting: false,
    forwarded: false,
    cancelled: false,
    tags: [],
    ...extra
  })
  const tasksBackend = backend({
    scanAllTasks: async () =>
      [
        task('Buy milk', { due: '2026-10-20' }),
        task('Cancelled plan', { cancelled: true, due: '2026-10-15' }),
        task('Done thing', { checked: true })
      ] as never
  })
  const contents = (rows: unknown): string[] =>
    (rows as Array<{ content: string }>).map((t) => t.content)

  it('leaves `[-]` cancelled tasks out of the default open list (#450, #476)', async () => {
    expect(contents(await callTool('list_tasks', {}, tasksBackend))).toEqual(['Buy milk'])
    expect(
      contents(await callTool('list_tasks', { dueBefore: '2026-10-31' }, tasksBackend))
    ).toEqual(['Buy milk'])
  })

  it('still returns cancelled tasks for status "all"', async () => {
    expect(contents(await callTool('list_tasks', { status: 'all' }, tasksBackend))).toContain(
      'Cancelled plan'
    )
  })
})

// #1024: a template folder's notes are placeholders. The tag tools and text
// search leave them out as the app's tag list and search do; title search and
// a plain listing still reach them, which is how a template is found to edit.
describe('the template folder in the tag and search tools (#1024)', () => {
  let dir: string
  let vault: VaultBackend

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-templates-'))
    await fsp.mkdir(path.join(dir, 'Templates', 'Work'), { recursive: true })
    await fsp.mkdir(path.join(dir, '.zennotes'), { recursive: true })
    await fsp.writeFile(
      path.join(dir, '.zennotes', 'vault.json'),
      JSON.stringify({ primaryNotesLocation: 'root', templates: { folder: 'Templates' } })
    )
    await fsp.writeFile(path.join(dir, 'Standup.md'), '# Standup\n\nagenda #meeting\n')
    await fsp.writeFile(
      path.join(dir, 'Templates', 'Meeting.md'),
      '# Meeting\n\nagenda #meeting #agenda-only\n'
    )
    await fsp.writeFile(path.join(dir, 'Templates', 'Work', 'Retro.md'), '# Retro\n\n#retro\n')
    vault = createBackend({ kind: 'local', root: dir })
  })

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  const paths = (rows: unknown): string[] =>
    (rows as Array<{ path: string }>).map((row) => row.path).sort()

  it('list_tags counts no tag a template carries', async () => {
    expect(await callTool('list_tags', {}, vault)).toEqual([{ tag: 'meeting', count: 1 }])
  })

  it('search_by_tag and a tag-filtered list_notes return no template', async () => {
    expect(paths(await callTool('search_by_tag', { tag: '#meeting' }, vault))).toEqual(['Standup.md'])
    expect(paths(await callTool('search_by_tag', { tag: 'agenda-only' }, vault))).toEqual([])
    expect(paths(await callTool('list_notes', { tag: 'meeting' }, vault))).toEqual(['Standup.md'])
  })

  it('search_text returns no template', async () => {
    expect(paths(await callTool('search_text', { query: 'agenda' }, vault))).toEqual(['Standup.md'])
  })

  it('a plain list_notes and search_by_title still reach the templates', async () => {
    expect(paths(await callTool('list_notes', {}, vault))).toEqual([
      'Standup.md',
      'Templates/Meeting.md',
      'Templates/Work/Retro.md'
    ])
    expect(paths(await callTool('search_by_title', { query: 'meeting' }, vault))).toEqual([
      'Templates/Meeting.md'
    ])
  })
})

// The ZenNotes/tui#21 probe cases, through the real tools on a root-mode
// vault, where the inbox is the vault root and the internal dir, the
// attachments dir and the other buckets are all one subpath away. Mirrors
// TestMCPToolsStayInsideTheNoteFolders in ZenNotes/tui's internal/mcp.
describe('tools stay inside the note folders (tui#21 Phase 0)', () => {
  let base: string
  let root: string

  beforeEach(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'zennotes-mcp-tools-safety-'))
    root = path.join(base, 'vault')
    vi.stubEnv('ZENNOTES_CONFIG_DIR', path.join(base, 'config'))
    const files: Record<string, string> = {
      '.zennotes/vault.json': '{"primaryNotesLocation":"root"}',
      'Projects/Plan.md': '# Plan\n',
      'Projects/notes.txt': 'plain text\n',
      'attachements/img.png': 'PNG',
      'archive/Old.md': '# Old\n',
      '../outside/secret.md': '# OUTSIDE SECRET\n'
    }
    for (const [rel, body] of Object.entries(files)) {
      await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
      await fsp.writeFile(path.join(root, rel), body)
    }
    await fsp.symlink(path.join(base, 'outside'), path.join(root, 'Projects', 'link'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await fsp.rm(base, { recursive: true, force: true })
  })

  it('refuses what reaches past them and keeps the vault whole', async () => {
    const local = createBackend({ kind: 'local', root })
    const refused = async (name: string, args: Record<string, unknown>, text: string) =>
      await expect(callTool(name, args, local)).rejects.toThrow(text)
    await refused(
      'move_note',
      { path: '.zennotes/vault.json', targetFolder: 'inbox', targetSubpath: 'Projects' },
      'Note not in a known folder'
    )
    await refused('read_note', { path: 'Projects/vault.json' }, 'Not a Markdown note: Projects/vault.json')
    await refused(
      'create_note',
      { folder: 'inbox', subpath: '.zennotes', title: 'planted' },
      'Not a note folder: .zennotes'
    )
    await refused(
      'delete_folder',
      { folder: 'inbox', subpath: 'attachements', confirm: true },
      'Not a note folder: attachements'
    )
    await refused(
      'delete_folder',
      { folder: 'inbox', subpath: 'archive', confirm: true },
      'Not a note folder: archive'
    )
    await refused(
      'delete_folder',
      { folder: 'inbox', subpath: 'x/..', confirm: true },
      'Cannot delete the top-level folder'
    )
    await refused(
      'rename_folder',
      { folder: 'inbox', oldSubpath: '.zennotes', newSubpath: 'Projects/internals' },
      'Not a note folder: .zennotes'
    )
    await refused('delete_note', { path: '.zennotes/vault.json', confirm: true }, 'Note not in a known folder')
    await refused('archive_note', { path: '.zennotes/vault.json' }, 'Note not in a known folder')
    await refused('read_note', { path: 'Projects/link/secret.md' }, 'Path escapes vault')
    await refused('read_note', { path: 'Projects/notes.txt' }, 'Not a Markdown note: Projects/notes.txt')

    for (const rel of ['.zennotes/vault.json', 'Projects/Plan.md', 'attachements/img.png', 'archive/Old.md']) {
      await expect(fsp.stat(path.join(root, rel))).resolves.toBeTruthy()
    }
    await expect(fsp.stat(path.join(root, '.zennotes', 'planted.md'))).rejects.toThrow(/ENOENT/)
    expect(await callTool('read_note', { path: 'Projects/Plan.md' }, local)).toMatchObject({
      body: '# Plan\n'
    })
  })
})

describe('describeToolError', () => {
  const rejected = () => new RemoteRequestError('The ZenNotes server rejected the connection.', 401)
  const server = (authToken: string | null): VaultTarget => ({
    kind: 'remote',
    name: 'home',
    baseUrl: 'https://notes.example.com',
    authToken
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('turns a 401 from the server into the token hint', () => {
    const text = describeToolError(rejected())
    expect(text).toContain('rejected the connection')
    expect(text).toContain('ZENNOTES_REMOTE_TOKEN')
    expect(text).toContain('zn connect <server-url> --no-default')
  })

  it('points at the app first, then names the server to run `zn connect` for (#830)', () => {
    vi.stubEnv('ZENNOTES_REMOTE_TOKEN', '')
    const text = describeToolError(rejected(), server(null))
    expect(text).toContain('no valid token')
    expect(text).toContain('Let assistants use it under Settings → MCP → Server token')
    expect(text).toContain('`zn connect https://notes.example.com --no-default`')
    expect(text).toContain('the next call uses it')
  })

  it('blames a stale ZENNOTES_REMOTE_TOKEN, which a saved token cannot outrank', () => {
    vi.stubEnv('ZENNOTES_REMOTE_TOKEN', 'stale')
    const text = describeToolError(rejected(), server('stale'))
    expect(text).toContain('The rejected token is ZENNOTES_REMOTE_TOKEN')
    expect(text).toContain('remove it and run `zn connect https://notes.example.com --no-default`')
    // A different rejected token is not the environment's fault.
    expect(describeToolError(rejected(), server('saved'))).toContain('no valid token')
  })

  it('passes other errors through untouched', () => {
    expect(describeToolError(new Error('boom'))).toBe('boom')
    expect(describeToolError(new RemoteRequestError('nope', 500))).toBe('nope')
  })
})

describe('VaultSwitchedError', () => {
  it('names a saved server by its quoted name and URL, and never the token', () => {
    const err = new VaultSwitchedError(
      { kind: 'remote', name: 'Server Vault (10.0.0.5:7878)', baseUrl: 'http://10.0.0.5:7878', authToken: 'tok-secret' },
      { kind: 'local', root: '/notes' }
    )
    expect(err.message).toContain(
      'it was the server "Server Vault (10.0.0.5:7878)" at http://10.0.0.5:7878 and is now the local vault /notes.'
    )
    expect(err.message).not.toContain('tok-secret')
  })
})

describe('comment tools (#738)', () => {
  it('lists the four comment tools', () => {
    const names = listToolNames()
    for (const name of ['list_comments', 'add_comment', 'reply_to_comment', 'resolve_comment']) {
      expect(names).toContain(name)
    }
  })

  it('signs a comment with the connected client, readably', () => {
    expect(commentAuthorForClient('claude-code')).toBe('Claude Code')
    expect(commentAuthorForClient('claude-ai')).toBe('Claude')
    expect(commentAuthorForClient('codex-cli')).toBe('Codex')
    expect(commentAuthorForClient('my_custom-agent')).toBe('My Custom Agent')
    expect(commentAuthorForClient(null)).toBe('Assistant')
    expect(commentAuthorForClient('  ')).toBe('Assistant')
  })

  it('reply_to_comment threads under the top-level comment with the author', async () => {
    let stored: Array<Record<string, unknown>> = [
      {
        id: 'c1',
        notePath: 'inbox/Plan.md',
        anchorStart: 8,
        anchorEnd: 33,
        anchorText: 'Ship the beta in October.',
        body: 'Still realistic?',
        createdAt: 1,
        updatedAt: 1,
        resolvedAt: null
      }
    ]
    const result = (await callTool(
      'reply_to_comment',
      { path: 'inbox/Plan.md', id: 'c1', body: 'Yes, the blocker runs at night.' },
      backend({
        readNote: async () =>
          ({ path: 'inbox/Plan.md', body: '# Plan\n\nShip the beta in October.\n' }) as never,
        listComments: async () => stored as never,
        writeComments: async (_rel, comments) => {
          stored = comments.map((c, i) => ({ ...c, id: (c as { id?: string }).id ?? `c${i + 1}` }))
          return stored as never
        }
      })
    )) as { id: string; replies: Array<{ author: string | null; body: string }> }
    expect(result.id).toBe('c1')
    expect(result.replies).toEqual([
      expect.objectContaining({ author: 'Assistant', body: 'Yes, the blocker runs at night.' })
    ])
    expect(stored[1]).toMatchObject({ parentId: 'c1', anchorText: 'Ship the beta in October.' })
  })
})

/**
 * `zn mcp --vault beta` used to serve the vault the desktop app had open
 * (#831): the CLI parsed the flags and then started the server without them.
 * These sessions run the real server over an in-memory transport with the
 * real flag parser and target resolution, against a scratch config whose
 * active vault is "alpha".
 */
describe('runMcpServer follows the target it is given (#831)', () => {
  let tmpDir: string
  let configDir: string
  let alpha: string
  let beta: string

  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    await fsp.writeFile(path.join(configDir, 'zennotes.config.json'), JSON.stringify(config))
  }

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-831-'))
    configDir = path.join(tmpDir, 'config')
    alpha = path.join(tmpDir, 'alpha')
    beta = path.join(tmpDir, 'beta')
    await Promise.all(
      [configDir, path.join(alpha, 'inbox'), path.join(beta, 'inbox')].map((dir) =>
        fsp.mkdir(dir, { recursive: true })
      )
    )
  })

  afterAll(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    vi.stubEnv('ZENNOTES_CONFIG_DIR', configDir)
    vi.stubEnv('ZENNOTES_VAULT', '')
    vi.stubEnv('ZENNOTES_SERVER', '')
    vi.stubEnv('ZENNOTES_REMOTE_TOKEN', '')
    await writeConfig({
      vaultRoot: alpha,
      localVaults: [
        { root: alpha, name: 'alpha', lastOpenedAt: 2_000 },
        { root: beta, name: 'beta', lastOpenedAt: 1_000 }
      ]
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /** A connected client for one server session; `vaultInfo` is what an agent
   *  sees when it calls the tool, `stderr` what the user sees at startup. */
  async function session(options: Omit<McpServerOptions, 'transport'> = {}) {
    const stderr: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await runMcpServer({ ...options, transport: serverTransport })
    const client = new Client({ name: 'server-test', version: '0' })
    await client.connect(clientTransport)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args })
      return { text: (result.content as Array<{ text: string }>)[0].text, isError: !!result.isError }
    }
    return {
      stderr,
      call,
      vaultInfo: async () => {
        const { text, isError } = await call('vault_info')
        return isError ? { error: text } : { info: JSON.parse(text) as Record<string, unknown> }
      },
      close: () => client.close()
    }
  }

  /** What `zn mcp <flags>` hands the server. */
  const flags = (...argv: string[]) => ({ resolveTarget: () => resolveTarget(parse(argv)) })

  it('without a target follows the vault the app has open, quietly', async () => {
    const s = await session()
    expect((await s.vaultInfo()).info).toMatchObject({ kind: 'local', vaultRoot: alpha })
    expect(s.stderr).toEqual([])
    await s.close()
  })

  it('serves the vault --vault names, by path or by known name', async () => {
    const byPath = await session(flags('--vault', beta))
    expect((await byPath.vaultInfo()).info).toMatchObject({ kind: 'local', vaultRoot: beta })
    await byPath.close()

    const byName = await session(flags('--vault', 'beta'))
    expect((await byName.vaultInfo()).info).toMatchObject({ kind: 'local', vaultRoot: beta })
    await byName.close()
  })

  it('tells the user at startup when --vault names nothing, and still serves', async () => {
    const s = await session(flags('--vault', path.join(tmpDir, 'no-such-vault')))
    // Said once, on stderr, before any tool call: that is where a terminal
    // user and the MCP client's log see it.
    expect(s.stderr).toHaveLength(1)
    expect(s.stderr[0]).toContain('[zennotes-mcp] No vault named')
    expect(s.stderr[0]).toContain('Known vaults: alpha, beta')
    expect(s.stderr[0]).toContain('running anyway')
    // The agent gets the same error instead of a silent fall-back to alpha.
    const { error } = await s.vaultInfo()
    expect(error).toContain('No vault named')
    expect(error).toContain('alpha')
    expect(s.stderr).toHaveLength(1)
    await s.close()
  })

  it('reaches the server --server names and sends --token as its bearer token', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const fake: HttpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      seen.push({ url: url.pathname, auth: req.headers.authorization ?? null })
      const bodies: Record<string, unknown> = {
        '/api/vault': { root: '/srv/notes', name: 'notes' },
        '/api/vault/settings': { primaryNotesLocation: 'inbox', systemFolderPaths: null },
        '/api/folders': []
      }
      res.writeHead(url.pathname in bodies ? 200 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(bodies[url.pathname] ?? null))
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const address = fake.address()
    if (address == null || typeof address === 'string') throw new Error('no port')
    const baseUrl = `http://127.0.0.1:${address.port}`

    try {
      const s = await session(flags('--server', `127.0.0.1:${address.port}`, '--token', 'secret-831'))
      const { info } = await s.vaultInfo()
      expect(info).toMatchObject({ kind: 'remote', server: baseUrl, authConfigured: true })
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.map((r) => r.auth)).toEqual(seen.map(() => 'Bearer secret-831'))
      await s.close()
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })

  it('reaches the server the app has open with the token `zn connect` saved, from the next call on (#830)', async () => {
    const seen: Array<string | null> = []
    const fake: HttpServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      seen.push(req.headers.authorization ?? null)
      if (req.headers.authorization !== 'Bearer saved-830') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const bodies: Record<string, unknown> = {
        '/api/vault': { root: '/srv/notes', name: 'notes' },
        '/api/vault/settings': { primaryNotesLocation: 'inbox', systemFolderPaths: null },
        '/api/folders': []
      }
      res.writeHead(url.pathname in bodies ? 200 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(bodies[url.pathname] ?? null))
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const address = fake.address()
    if (address == null || typeof address === 'string') throw new Error('no port')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const credentials = path.join(configDir, 'credentials.toml')

    try {
      // The app is connected to the server. Its token sits in the OS secret
      // store, so the config this process reads carries none.
      await writeConfig({
        vaultRoot: alpha,
        workspaceMode: 'remote',
        remoteWorkspace: { baseUrl },
        remoteWorkspaceProfileId: 'srv',
        remoteWorkspaceProfiles: [{ id: 'srv', name: 'Server', baseUrl, vaultPath: '/srv/notes' }]
      })
      // No flags: the entry Settings → MCP installs when zn is not the app's own.
      const s = await session()
      const before = await s.vaultInfo()
      expect(before.error).toContain('no valid token')
      expect(before.error).toContain(`zn connect ${baseUrl} --no-default`)

      // `zn connect <url> --no-default` in a terminal while the agent runs.
      await fsp.writeFile(credentials, `[tokens]\n  "${baseUrl}" = "saved-830"\n`, { mode: 0o600 })
      const { info } = await s.vaultInfo()
      expect(info).toMatchObject({ kind: 'remote', server: baseUrl, authConfigured: true })
      expect(seen.at(-1)).toBe('Bearer saved-830')
      await s.close()
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()))
      await fsp.rm(credentials, { force: true })
    }
  })

  it('retries until a vault resolves, and starts the session at the first call it serves', async () => {
    // One attempt at startup (warned), then one per tool call.
    const outcomes: Array<Error | VaultTarget> = [
      new Error('not at startup'),
      new Error('not yet'),
      { kind: 'local', root: beta },
      { kind: 'local', root: beta },
      { kind: 'local', root: alpha }
    ]
    let calls = 0
    const s = await session({
      resolveTarget: async () => {
        const next = outcomes[calls++]
        if (next instanceof Error) throw next
        return next
      }
    })
    expect(s.stderr.join('')).toContain('not at startup')
    expect((await s.vaultInfo()).error).toBe('Error: not yet')
    // Nothing was served before, so beta is no switch.
    const first = (await s.vaultInfo()).info
    expect(first).toMatchObject({ vaultRoot: beta })
    expect(String(first?.notes)).not.toContain('The vault changed')
    expect((await s.call('list_notes')).isError).toBe(false)
    // The app moved to alpha: the next call stops instead of running there.
    const moved = await s.call('list_notes')
    expect(moved.isError).toBe(true)
    expect(moved.text).toContain(`it was the local vault ${beta} and is now the local vault ${alpha}`)
    expect(calls).toBe(5)
    await s.close()
  })

  it('a vault the app left before the first call is no switch', async () => {
    const s = await session()
    await writeConfig({ vaultRoot: beta, localVaults: [{ root: beta, name: 'beta' }] })
    const listed = await s.call('list_notes')
    expect(listed.isError).toBe(false)
    await s.close()
  })

  it('refuses writes between case-sensitive server paths until vault_info confirms the switch', async () => {
    const writes: string[] = []
    const fake = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const prefix = url.pathname.startsWith('/Work/') ? '/Work' : '/work'
      const route = url.pathname.slice(prefix.length)
      if (req.method === 'POST') writes.push(url.pathname)
      const bodies: Record<string, unknown> = {
        '/api/vault': { root: `/srv${prefix}`, name: prefix.slice(1) },
        '/api/vault/settings': { primaryNotesLocation: 'inbox', systemFolderPaths: null },
        '/api/folders': [],
        '/api/notes/write': { path: 'inbox/Plan.md', title: 'Plan' }
      }
      res.writeHead(route in bodies ? 200 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(bodies[route] ?? null))
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const address = fake.address()
    if (address == null || typeof address === 'string') throw new Error('no port')
    const origin = `http://127.0.0.1:${address.port}`
    let target: VaultTarget = { kind: 'remote', baseUrl: `${origin}/Work`, name: '', authToken: null }
    let s: Awaited<ReturnType<typeof session>> | undefined

    try {
      s = await session({ resolveTarget: async () => target })
      expect((await s.vaultInfo()).info).toMatchObject({ server: `${origin}/Work` })

      target = { ...target, baseUrl: `${origin}/work` }
      const refused = await s.call('write_note', { path: 'inbox/Plan.md', body: 'planned for Work' })
      expect(writes).toEqual([])
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain('The ZenNotes vault changed')

      const { info } = await s.vaultInfo()
      expect(info).toMatchObject({ server: `${origin}/work` })
      expect(String(info?.notes)).toContain(`until this call the session worked in the server at ${origin}/Work`)
      expect((await s.call('write_note', { path: 'inbox/Plan.md', body: 'planned for work' })).isError).toBe(false)
      expect(writes).toEqual(['/work/api/notes/write'])
    } finally {
      await s?.close()
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })

  it('follows the app to another vault only after vault_info confirms it', async () => {
    await fsp.writeFile(path.join(alpha, 'inbox', 'Alpha.md'), '# Alpha\n')
    await fsp.writeFile(path.join(beta, 'inbox', 'Beta.md'), '# Beta\n')
    try {
      const s = await session()
      const before = await s.call('list_notes')
      expect(before.isError).toBe(false)
      expect(before.text).toContain('inbox/Alpha.md')

      await writeConfig({ vaultRoot: beta, localVaults: [{ root: beta, name: 'beta' }] })
      // A write planned against alpha must not land in beta, and a whole
      // batch stops, not only its first call.
      const batch = await Promise.all([
        s.call('write_note', { path: 'inbox/Alpha.md', body: 'planned for alpha' }),
        s.call('list_notes'),
        s.call('read_note', { path: 'inbox/Alpha.md' })
      ])
      for (const result of batch) {
        expect(result.isError).toBe(true)
        expect(result.text).toContain('The ZenNotes vault changed')
        expect(result.text).toContain(alpha)
        expect(result.text).toContain(beta)
        expect(result.text).toContain('vault_info')
      }
      await expect(fsp.access(path.join(beta, 'inbox', 'Alpha.md'))).rejects.toThrow()
      expect(await fsp.readFile(path.join(alpha, 'inbox', 'Alpha.md'), 'utf8')).toBe('# Alpha\n')

      const { info } = await s.vaultInfo()
      expect(info).toMatchObject({ kind: 'local', vaultRoot: beta })
      expect(
        String(info?.notes).startsWith(
          `The vault changed: until this call the session worked in the local vault ${alpha}.`
        )
      ).toBe(true)
      const after = await s.call('list_notes')
      expect(after.isError).toBe(false)
      expect(after.text).toContain('inbox/Beta.md')
      expect(after.text).not.toContain('Alpha.md')
      expect(String((await s.vaultInfo()).info?.notes)).not.toContain('The vault changed')
      await s.close()
    } finally {
      await fsp.rm(path.join(alpha, 'inbox', 'Alpha.md'), { force: true })
      await fsp.rm(path.join(beta, 'inbox', 'Beta.md'), { force: true })
    }
  })
})
