// A vault switch never redirects work silently, including when a self-hosted
// server changes its own vault with the URL staying the same. zn's own tests
// for this are in internal/mcp/session_test.go (ZenNotes/tui#37).
import { createServer, type Server } from 'node:http'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newMcpScope, type McpScope } from '@shared/mcp-scope'
import type { VaultBackend } from '../cli/backend'
import type { VaultTarget } from '../cli/vault-target'
import { runMcpServer, VaultSession, VaultSwitchedError } from './server'

type Remote = Extract<VaultTarget, { kind: 'remote' }>

const onVault = (target: Remote, vaultPath: string, vaultName: string): Remote => ({
  ...target,
  vaultPath,
  vaultName
})

/** A session whose vault and server answer from fields a test can set. */
class Harness {
  current: VaultTarget
  fail: Error | null = null
  openError: Error | null = null
  askError: Error | null = null
  root: string
  name: string
  opens = 0
  asked = 0
  /** Runs while a server is being asked, for a call a test wants to hold. */
  beforeAnswer: (() => Promise<void>) | null = null
  afterAnswer: (() => Promise<void>) | null = null
  readonly session: VaultSession

  constructor(start: VaultTarget, root = '', name = '') {
    this.current = start
    this.root = root
    this.name = name
    this.session = new VaultSession(
      async () => {
        if (this.fail) throw this.fail
        return this.current
      },
      (target) => {
        if (this.openError) throw this.openError
        this.opens += 1
        return { target } as unknown as VaultBackend
      },
      false,
      async (target) => {
        if (target.kind !== 'remote') return target
        this.asked += 1
        const before = this.beforeAnswer
        this.beforeAnswer = null
        if (before) await before()
        if (this.askError) throw this.askError
        const answered = onVault(target, this.root, this.name)
        const after = this.afterAnswer
        this.afterAnswer = null
        if (after) await after()
        return answered
      }
    )
  }

  serve(root: string, name: string): void {
    this.root = root
    this.name = name
  }

  /** One call that succeeds, so a vault_info finishes its move here. Returns
   *  the vault that move left, null when there was none. */
  async run(confirm: boolean, want: VaultTarget): Promise<VaultTarget | null> {
    const { backend, move, failure } = await this.session.backendFor(confirm)
    expect(failure).toBeUndefined()
    expect((backend as unknown as { target: VaultTarget }).target).toEqual(want)
    if (!move) return null
    await this.session.finishMove(move)
    return move.from
  }
}

const SERVER: Remote = { kind: 'remote', name: '', baseUrl: 'https://notes.example.com', authToken: null }
const A = onVault(SERVER, '/srv/a', 'A')
const B = onVault(SERVER, '/srv/b', 'B')

describe('a session on a server', () => {
  it('stops a whole batch when the server switches its vault', async () => {
    const home: Remote = { ...SERVER, name: 'home', authToken: 'secret' }
    const h = new Harness(home, '/srv/a', 'A')
    await h.run(false, onVault(home, '/srv/a', 'A'))
    h.serve('/srv/b', 'B')

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => h.session.backendFor(false))
    )
    for (const result of results) {
      expect(result.status).toBe('rejected')
      const err = (result as PromiseRejectedResult).reason as Error
      expect(err).toBeInstanceOf(VaultSwitchedError)
      expect(err.message).toContain('the vault "A" on the server "home" at https://notes.example.com')
      expect(err.message).toContain('the vault "B" on the server "home" at https://notes.example.com')
      expect(err.message).not.toContain('secret')
      expect(err.message).not.toContain('/srv/')
    }
    expect(h.opens).toBe(1)

    const b = onVault(home, '/srv/b', 'B')
    expect(await h.run(true, b)).toEqual(onVault(home, '/srv/a', 'A'))
    expect(await h.run(false, b)).toBeNull()
  })

  it('moves only when vault_info finishes', async () => {
    const h = new Harness(SERVER, '/srv/a', 'A')
    await h.run(false, A)
    h.serve('/srv/b', 'B')

    const abandoned = await h.session.backendFor(true)
    expect(abandoned.move).toMatchObject({ from: A, to: B })
    // A call beside a running vault_info stops.
    await expect(h.session.backendFor(false)).rejects.toBeInstanceOf(VaultSwitchedError)

    // That vault_info failed, so nothing finished it. The next one reports the
    // same switch and is the one that moves the session.
    expect(await h.run(true, B)).toEqual(A)
    expect(await h.run(false, B)).toBeNull()
  })

  // A call still waiting for its answer when vault_info moved the session began
  // on the old vault, so it stops either way and does not pull the session back.
  it.each([
    ['the new vault', false],
    ['the old vault', true]
  ])('stops a call that began before the move and was answered with %s', async (_name, answersOld) => {
    const h = new Harness(SERVER, '/srv/a', 'A')
    await h.run(false, A)

    let reached: () => void = () => undefined
    let release: () => void = () => undefined
    const waiting = new Promise<void>((resolve) => (reached = resolve))
    const released = new Promise<void>((resolve) => (release = resolve))
    const hold = async (): Promise<void> => {
      reached()
      await released
    }
    if (answersOld) h.afterAnswer = hold
    else h.beforeAnswer = hold

    const stopped = h.session.backendFor(false)
    await waiting
    h.serve('/srv/b', 'B')
    expect(await h.run(true, B)).toEqual(A)
    release()

    await expect(stopped).rejects.toBeInstanceOf(VaultSwitchedError)
    expect(await h.run(false, B)).toBeNull()
  })

  it('needs no confirmation after leaving a vault and returning with no call between', async () => {
    const h = new Harness(SERVER, '/srv/a', 'A')
    await h.run(false, A)
    h.serve('/srv/b', 'B')
    await expect(h.session.backendFor(false)).rejects.toBeInstanceOf(VaultSwitchedError)
    h.serve('/srv/a', 'A')
    await h.run(false, A)
    expect(h.opens).toBe(1)
  })

  it('does not count a new display name or token as a switch', async () => {
    const h = new Harness({ ...SERVER, authToken: 'old' }, '/srv/a', 'A')
    await h.run(false, { ...A, authToken: 'old' })

    h.serve('/srv/a', 'A renamed')
    expect(await h.run(false, { ...onVault(SERVER, '/srv/a', 'A renamed'), authToken: 'old' })).toBeNull()

    h.current = { ...SERVER, authToken: 'new' }
    expect(await h.run(false, { ...onVault(SERVER, '/srv/a', 'A renamed'), authToken: 'new' })).toBeNull()
  })

  it('tells two vaults of one name apart', async () => {
    const h = new Harness(SERVER, '/home/ada/notes', 'notes')
    await h.run(false, onVault(SERVER, '/home/ada/notes', 'notes'))
    h.serve('/home/grace/notes', 'notes')
    await expect(h.session.backendFor(false)).rejects.toThrow(
      'it was the vault "notes" on the server at https://notes.example.com and is now a different vault with the same name.'
    )
  })

  it('stops the call when the server cannot answer, and stays on its vault', async () => {
    const h = new Harness(SERVER, '/srv/a', 'A')

    // Nothing is pinned, and the backend comes back so the error can name the
    // server (a 401's hint needs its URL).
    h.askError = new Error('server down')
    const first = await h.session.backendFor(false)
    expect(first.failure).toBe(h.askError)
    expect(first.backend).toBeTruthy()
    expect(first.target).toEqual(SERVER)
    h.askError = null
    expect(await h.run(false, A)).toBeNull()

    // A failure later is not an answer: no call runs on a guess, and the session
    // stays put, for vault_info too.
    h.askError = new Error('server down')
    for (const confirm of [false, true]) {
      const failed = await h.session.backendFor(confirm)
      expect(failed.failure).toBe(h.askError)
      expect(failed.move).toBeNull()
    }
    h.askError = null
    expect(await h.run(false, A)).toBeNull()
  })

  it('does not ask a server a stopped call would not use', async () => {
    const local: VaultTarget = { kind: 'local', root: '/notes' }
    const h = new Harness(local, '/srv/a', 'A')
    await h.run(false, local)

    h.current = SERVER
    h.askError = new Error('server down')
    await expect(h.session.backendFor(false)).rejects.toBeInstanceOf(VaultSwitchedError)
    expect(h.asked).toBe(0)

    // vault_info does ask, since it is what moves the session there.
    h.askError = null
    expect(await h.run(true, A)).toEqual(local)
  })

  it('leaves the session where it was when the first call has no vault yet', async () => {
    const h = new Harness(SERVER, '/srv/a', 'A')
    h.fail = new Error('no vault yet')
    await expect(h.session.backendFor(false)).rejects.toThrow('no vault yet')
    h.fail = null
    expect(await h.run(false, A)).toBeNull()
  })

  it('stays where it was when vault_info cannot open the new vault', async () => {
    const h = new Harness(SERVER, '/srv/a', 'A')
    await h.run(false, A)
    h.serve('/srv/b', 'B')
    h.openError = new Error('cannot open')
    await expect(h.session.backendFor(true)).rejects.toThrow('cannot open')
    await expect(h.session.backendFor(false)).rejects.toBeInstanceOf(VaultSwitchedError)
    h.openError = null
    expect(await h.run(true, B)).toEqual(A)
  })
})

describe('a session on a local vault', () => {
  it('also moves only when vault_info finishes', async () => {
    const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-session-')))
    try {
      const a: VaultTarget = { kind: 'local', root: path.join(base, 'a') }
      const b: VaultTarget = { kind: 'local', root: path.join(base, 'b') }
      await fsp.mkdir(a.root)
      await fsp.mkdir(b.root)
      const h = new Harness(a)
      await h.run(false, a)
      h.current = b

      const abandoned = await h.session.backendFor(true)
      expect(abandoned.move).toMatchObject({ from: a, to: b })
      await expect(h.session.backendFor(false)).rejects.toBeInstanceOf(VaultSwitchedError)
      expect(await h.run(true, b)).toEqual(a)
      expect(await h.run(false, b)).toBeNull()
    } finally {
      await fsp.rm(base, { recursive: true, force: true })
    }
  })
})

/** As much of a ZenNotes server as a vault switch touches. */
class FakeServer {
  root: string
  name: string
  notes: string[]
  settingsDown = false
  vaultDown = false
  settingsHold: Promise<void> | null = null
  settingsReached: (() => void) | null = null
  requests: string[] = []
  private server!: Server
  url = ''

  constructor(root: string, name: string, notes: string[]) {
    this.root = root
    this.name = name
    this.notes = notes
  }

  select(root: string, name: string, notes: string[]): void {
    this.root = root
    this.name = name
    this.notes = notes
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const at = new URL(req.url ?? '/', 'http://x')
      this.requests.push(`${req.method} ${at.pathname}`)
      const json = (value: unknown, status = 200): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      const meta = (rel: string): Record<string, unknown> => ({
        path: rel,
        title: path.posix.basename(rel, '.md'),
        folder: 'inbox',
        createdAt: 1,
        updatedAt: 2,
        size: 1,
        tags: [],
        wikilinks: [],
        excerpt: ''
      })
      if (req.method === 'POST') {
        req.resume()
        req.on('end', () => json(meta(this.notes[0])))
        return
      }
      switch (at.pathname) {
        case '/api/capabilities':
          return json({ supportsSymlinkMarks: true })
        case '/api/vault':
          if (this.vaultDown) return json({ error: 'down' }, 500)
          return json({ root: this.root, name: this.name, linkedSystemFolders: [] })
        case '/api/vault/settings': {
          if (this.settingsDown) return json({ error: 'down' }, 500)
          const answer = (): void => json({ primaryNotesLocation: 'root' })
          if (this.settingsHold) {
            this.settingsReached?.()
            void this.settingsHold.then(answer)
            return
          }
          return answer()
        }
        case '/api/notes':
          return json(this.notes.map(meta))
        case '/api/folders':
          return json([{ folder: 'inbox', subpath: 'Projects' }])
        case '/api/notes/read': {
          const rel = at.searchParams.get('path') ?? ''
          return this.notes.includes(rel) ? json({ ...meta(rel), body: '# Note\n' }) : json({}, 404)
        }
        default:
          return json({}, 404)
      }
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    this.url = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server.close(resolve))
  }
}

describe('the MCP server when a server switches its vault', () => {
  let config: string
  let server: FakeServer
  let client: Client

  const connect = async (scope: McpScope | null): Promise<void> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await runMcpServer({
      resolveTarget: async () => ({ kind: 'remote', name: '', baseUrl: server.url, authToken: 't' }),
      scope,
      transport: serverTransport
    })
    client = new Client({ name: 'switch', version: '0' })
    await client.connect(clientTransport)
  }

  const call = async (
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<{ text: string; isError: boolean }> => {
    const result = await client.callTool({ name, arguments: args })
    return {
      text: (result.content as { text: string }[])[0]?.text ?? '',
      isError: !!result.isError
    }
  }

  beforeEach(async () => {
    config = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-switch-'))
    vi.stubEnv('ZENNOTES_CONFIG_DIR', config)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    server = new FakeServer('/srv/vaults/home', 'Home', ['Projects/a.md'])
    await server.start()
  })

  afterEach(async () => {
    await client.close()
    await server.stop()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fsp.rm(config, { recursive: true, force: true })
  })

  it.each([
    ['with no scope', null, false],
    ['with a path scope', newMcpScope({ access: 'write', allow: ['Projects'] }), true]
  ])('stops every call until vault_info %s', async (_name, scope, scoped) => {
    await connect(scope)
    const before = await call('list_notes')
    expect(before.isError).toBe(false)
    expect(before.text).toContain('Projects/a.md')

    // A matching allow entry is no protection: Projects/ exists in both vaults.
    server.select('/srv/vaults/work', 'Work', ['Projects/other.md'])
    server.requests = []
    for (const [tool, args] of [
      ['list_notes', {}],
      ['read_note', { path: 'Projects/other.md' }],
      ['write_note', { path: 'Projects/a.md', body: 'planned for Home' }]
    ] as const) {
      const stopped = await call(tool, args)
      expect(stopped.isError, tool).toBe(true)
      expect(stopped.text).toContain(
        `it was the vault "Home" on the server at ${server.url} and is now the vault "Work" on the server at ${server.url}.`
      )
      expect(stopped.text).not.toContain('/srv/vaults')
    }
    // Only the question reached the server, nothing of the calls.
    expect(new Set(server.requests)).toEqual(new Set(['GET /api/vault']))

    const info = await call('vault_info')
    expect(info.isError).toBe(false)
    const notes = String((JSON.parse(info.text) as { notes: string }).notes)
    expect(notes.startsWith(`The vault changed: until this call the session worked in the vault "Home" on the server at ${server.url}.`)).toBe(true)
    expect(info.text).not.toContain('/srv/vaults/home')
    if (scoped) expect(info.text).not.toContain('/srv/vaults')

    const after = await call('list_notes')
    expect(after.isError).toBe(false)
    expect(after.text).toContain('Projects/other.md')
    expect(after.text).not.toContain('Projects/a.md')
    expect((await call('vault_info')).text).not.toContain('The vault changed')
  })

  it('keeps the stop when vault_info fails', async () => {
    await connect(null)
    expect((await call('list_notes')).isError).toBe(false)
    server.select('/srv/vaults/work', 'Work', ['Projects/other.md'])

    server.settingsDown = true
    expect((await call('vault_info')).isError).toBe(true)
    server.settingsDown = false
    server.requests = []

    const write = await call('write_note', { path: 'Projects/a.md', body: 'planned for Home' })
    expect(write.isError).toBe(true)
    expect(write.text).toContain('The ZenNotes vault changed')
    // The failed vault_info's own reads can still be arriving, so this looks only
    // at what the stopped write could have sent.
    expect(server.requests.filter((request) => request.startsWith('POST '))).toEqual([])

    const info = await call('vault_info')
    expect(info.isError).toBe(false)
    expect(info.text).toContain('The vault changed: until this call the session worked in the vault \\"Home\\"')
    expect((await call('list_notes')).text).toContain('Projects/other.md')
  })

  it('stops a write sent beside a vault_info still running', async () => {
    await connect(null)
    expect((await call('list_notes')).isError).toBe(false)
    server.select('/srv/vaults/work', 'Work', ['Projects/other.md'])

    let release: () => void = () => undefined
    server.settingsHold = new Promise((resolve) => (release = resolve))
    const reached = new Promise<void>((resolve) => (server.settingsReached = resolve))
    server.requests = []
    const running = call('vault_info')
    await reached

    const write = await call('write_note', { path: 'Projects/a.md', body: 'planned for Home' })
    const posts = server.requests.filter((request) => request.startsWith('POST '))
    release()
    server.settingsHold = null
    const info = await running

    expect(write.isError).toBe(true)
    expect(write.text).toContain('The ZenNotes vault changed')
    expect(posts).toEqual([])
    expect(info.isError).toBe(false)
    expect(info.text).toContain('The vault changed')
  })

  it('runs nothing when only the question fails', async () => {
    await connect(null)
    expect((await call('list_notes')).isError).toBe(false)
    server.vaultDown = true
    server.requests = []

    const stopped = await call('write_note', { path: 'Projects/a.md', body: 'on a guess' })
    expect(stopped.isError).toBe(true)
    expect(stopped.text).toContain('500')
    expect(server.requests).toEqual(['GET /api/vault'])

    // An outage is not a switch.
    server.vaultDown = false
    const after = await call('list_notes')
    expect(after.isError).toBe(false)
    expect(after.text).toContain('Projects/a.md')
  })

  it('asks the server once per unscoped call', async () => {
    await connect(null)
    server.requests = []
    expect((await call('list_notes')).isError).toBe(false)
    expect(server.requests.filter((request) => request === 'GET /api/vault')).toHaveLength(1)
    expect(server.requests[0]).toBe('GET /api/vault')
  })

  it('gives a token hint that names the server when the question is turned away', async () => {
    await connect(null)
    // A server that answers 401 to everything.
    await server.stop()
    const denied = createServer((_req, res) => {
      res.writeHead(401)
      res.end('no token')
    })
    await new Promise<void>((resolve) => denied.listen(Number(new URL(server.url).port), '127.0.0.1', resolve))
    try {
      const refused = await call('list_notes')
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain(server.url)
      expect(refused.text).toContain('no valid token')
    } finally {
      await new Promise((resolve) => denied.close(resolve))
      await server.start()
    }
  })
})
