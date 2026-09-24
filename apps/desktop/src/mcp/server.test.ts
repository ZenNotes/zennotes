import { createServer, type Server as HttpServer } from 'node:http'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from '../cli/args'
import type { VaultBackend } from '../cli/backend'
import { resolveTarget, type VaultTarget } from '../cli/vault-target'
import { RemoteRequestError } from '../main/remote/connection'
import {
  callTool,
  commentAuthorForClient,
  describeToolError,
  listToolNames,
  runMcpServer,
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

describe('describeToolError', () => {
  it('turns a 401 from the server into the token hint', () => {
    const text = describeToolError(
      new RemoteRequestError('The ZenNotes server rejected the connection.', 401)
    )
    expect(text).toContain('rejected the connection')
    expect(text).toContain('ZENNOTES_REMOTE_TOKEN')
  })
  it('passes other errors through untouched', () => {
    expect(describeToolError(new Error('boom'))).toBe('boom')
    expect(describeToolError(new RemoteRequestError('nope', 500))).toBe('nope')
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
    return {
      stderr,
      vaultInfo: async () => {
        const result = await client.callTool({ name: 'vault_info', arguments: {} })
        const text = (result.content as Array<{ text: string }>)[0].text
        return result.isError ? { error: text } : { info: JSON.parse(text) as Record<string, unknown> }
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

  it('pins the first vault that resolves and retries only after a failure', async () => {
    // One attempt at startup (warned), one per failing tool call, then the
    // session keeps the first vault that resolved.
    const outcomes: Array<Error | VaultTarget> = [
      new Error('not at startup'),
      new Error('not yet'),
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
    expect((await s.vaultInfo()).info).toMatchObject({ vaultRoot: beta })
    // A further call must not move the session to alpha: the target is pinned.
    expect((await s.vaultInfo()).info).toMatchObject({ vaultRoot: beta })
    expect(calls).toBe(3)
    await s.close()
  })
})
