// Links a local vault's listings do not show, under a path scope: a link to
// nothing in a shared folder, and a system folder that is a link.
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newMcpScope } from '@shared/mcp-scope'
import { createBackend, type VaultBackend } from '../cli/backend'
import { callTool } from './server'

const DIARY = '# Diary\n\nprivate needle\n'

let base: string
let root: string
let backend: VaultBackend

const exists = (abs: string): Promise<boolean> =>
  fsp.lstat(abs).then(
    () => true,
    () => false
  )
const inVault = (rel: string): string => path.join(root, ...rel.split('/'))

beforeEach(async () => {
  base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-local-links-')))
  root = path.join(base, 'vault')
  const files: Record<string, string> = {
    '.zennotes/vault.json': '{"primaryNotesLocation":"root"}',
    'Projects/Plan.md': '# Plan\n',
    'Open/Free.md': '# Free\n',
    'Journal/Diary.md': DIARY
  }
  for (const [rel, body] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(inVault(rel)), { recursive: true })
    await fsp.writeFile(inVault(rel), body)
  }
  await fsp.mkdir(path.join(base, 'outside'))
  vi.stubEnv('ZENNOTES_CONFIG_DIR', path.join(base, 'config'))
  backend = createBackend({ kind: 'local', root })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fsp.rm(base, { recursive: true, force: true })
})

describe('a link to nothing in a shared folder', () => {
  const allow = newMcpScope({ access: 'write', allow: ['Projects'] })

  it('does not take a new note out of the scope', async () => {
    await fsp.symlink('../Journal/FreshNote.md', inVault('Projects/fresh.md'))
    const made = (await callTool(
      'create_note',
      { folder: 'inbox', subpath: 'Projects', title: 'fresh', body: 'X' },
      backend,
      allow
    )) as { path: string }
    expect(made.path).toBe('Projects/fresh 2.md')
    expect(await exists(inVault('Journal/FreshNote.md'))).toBe(false)
    expect(await fsp.readFile(inVault('Projects/fresh 2.md'), 'utf8')).toBe('X')
  })

  it('does not take a new note out of the vault', async () => {
    await fsp.symlink('../../outside/esc.md', inVault('Projects/esc.md'))
    const made = (await callTool(
      'create_note',
      { folder: 'inbox', subpath: 'Projects', title: 'esc', body: 'X' },
      backend,
      allow
    )) as { path: string }
    expect(made.path).toBe('Projects/esc 2.md')
    expect(await fsp.readdir(path.join(base, 'outside'))).toEqual([])
  })

  it('does not take a copy out of the scope', async () => {
    await fsp.symlink('../Journal/PlanCopy.md', inVault('Projects/Plan copy.md'))
    const made = (await callTool('duplicate_note', { path: 'Projects/Plan.md' }, backend, allow)) as {
      path: string
    }
    expect(made.path).toBe('Projects/Plan copy 2.md')
    expect(await exists(inVault('Journal/PlanCopy.md'))).toBe(false)
  })

  it('does not take a moved note out of the scope', async () => {
    await fsp.mkdir(inVault('Projects/Sub'))
    await fsp.writeFile(inVault('Projects/Sub/Plan.md'), '# Sub plan\n')
    await fsp.symlink('../Journal/Moved.md', inVault('Projects/Plan 2.md'))
    await callTool(
      'move_note',
      { path: 'Projects/Sub/Plan.md', targetFolder: 'inbox', targetSubpath: 'Projects' },
      backend,
      allow
    )
    expect(await exists(inVault('Journal/Moved.md'))).toBe(false)
  })

  it('still creates under a free name for a client with the whole vault', async () => {
    await fsp.symlink('../Journal/FreshNote.md', inVault('Projects/fresh.md'))
    await callTool('create_note', { folder: 'inbox', subpath: 'Projects', title: 'fresh', body: 'X' }, backend, null)
    expect(await exists(inVault('Journal/FreshNote.md'))).toBe(false)
  })
})

describe('a link inside a system folder', () => {
  it.each([
    ['archive_note', 'archive'],
    ['move_to_trash', 'trash']
  ])('refuses %s when the folder the note would keep is the link', async (tool, dir) => {
    await fsp.mkdir(inVault(`${dir}/Hidden`), { recursive: true })
    await fsp.writeFile(inVault(`${dir}/Hidden/Kept.md`), '# Kept\n')
    await fsp.symlink('Hidden', inVault(`${dir}/Open`))
    const deny = newMcpScope({ access: 'write', deny: [`${dir}/Hidden`] })
    await expect(callTool(tool, { path: 'Open/Free.md' }, backend, deny)).rejects.toThrow(
      new Error('This assistant cannot put notes there.')
    )
    expect(await exists(inVault(`${dir}/Hidden/Free.md`))).toBe(false)
    expect(await exists(inVault('Open/Free.md'))).toBe(true)
  })
})

describe('a system folder that is a link', () => {
  const deny = newMcpScope({ access: 'write', deny: ['Journal'] })
  const REFUSAL = 'This assistant cannot put notes there.'

  beforeEach(async () => {
    await fsp.symlink('Journal', inVault('quick'))
  })

  it('shows nothing through it', async () => {
    const notes = (await callTool('list_notes', {}, backend, deny)) as { path: string }[]
    expect(notes.map((n) => n.path).sort()).toEqual(['Open/Free.md', 'Projects/Plan.md'])
    const hits = JSON.stringify(await callTool('search_text', { query: 'needle' }, backend, deny))
    expect(hits).not.toContain('needle')
  })

  it.each([
    ['read_note', { path: 'quick/Diary.md' }],
    ['write_note', { path: 'quick/Diary.md', body: 'overwritten\n' }],
    ['delete_note', { path: 'quick/Diary.md', confirm: true }]
  ])('answers %s as a note that is not there', async (tool, args) => {
    await expect(callTool(tool, args, backend, deny)).rejects.toThrow(
      new Error('Note not found: quick/Diary.md')
    )
    expect(await fsp.readFile(inVault('Journal/Diary.md'), 'utf8')).toBe(DIARY)
  })

  it.each([
    ['create_note', { folder: 'quick', title: 'ViaBucket', body: 'X' }, 'Journal/ViaBucket.md'],
    ['create_folder', { folder: 'quick', subpath: 'SubViaBucket' }, 'Journal/SubViaBucket'],
    ['move_note', { path: 'Open/Free.md', targetFolder: 'quick', targetSubpath: '' }, 'Journal/Free.md']
  ])('refuses %s into it', async (tool, args, landed) => {
    await expect(callTool(tool, args, backend, deny)).rejects.toThrow(new Error(REFUSAL))
    expect(await exists(inVault(landed))).toBe(false)
  })

  it.each([
    ['archive_note', 'archive'],
    ['move_to_trash', 'trash']
  ])('refuses %s when %s is the link', async (tool, dir) => {
    await fsp.symlink('Journal', inVault(dir))
    await expect(callTool(tool, { path: 'Open/Free.md' }, backend, deny)).rejects.toThrow(new Error(REFUSAL))
    expect(await exists(inVault('Journal/Free.md'))).toBe(false)
    expect(await exists(inVault('Open/Free.md'))).toBe(true)
  })

  it('leaves an archive with no link on the way working', async () => {
    await expect(callTool('archive_note', { path: 'Open/Free.md' }, backend, deny)).resolves.toMatchObject({
      path: 'archive/Open/Free.md'
    })
  })

  it('stays as it was for a client with no path scope', async () => {
    const read = newMcpScope({ access: 'read' })
    await expect(callTool('read_note', { path: 'quick/Diary.md' }, backend, read)).resolves.toMatchObject({
      body: DIARY
    })
    await expect(
      callTool('create_note', { folder: 'quick', title: 'Mine', body: 'X' }, backend, null)
    ).resolves.toMatchObject({ path: 'quick/Mine.md' })
  })
})

describe('a system folder a server names as a link', () => {
  const deny = newMcpScope({ access: 'write', deny: ['Journal'] })
  let server: Server
  let url: string
  /** What `linkedSystemFolders` holds in `/api/vault`; left out when undefined. */
  let linked: unknown
  let posts: string[]

  beforeEach(async () => {
    linked = ['quick', 'archive']
    posts = []
    server = createServer((req, res) => {
      const at = new URL(req.url ?? '/', 'http://x')
      const json = (value: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'POST') {
        posts.push(at.pathname)
        return json({ path: 'Open/Free.md', title: 'Free', folder: 'inbox' })
      }
      const meta = { path: 'Open/Free.md', title: 'Free', folder: 'inbox', tags: [], wikilinks: [], excerpt: '' }
      switch (at.pathname) {
        case '/api/capabilities':
          return json({ supportsSymlinkMarks: true })
        case '/api/vault':
          return json({ root: '/srv', name: 'notes', ...(linked === undefined ? {} : { linkedSystemFolders: linked }) })
        case '/api/vault/settings':
          return json({ primaryNotesLocation: 'root' })
        case '/api/notes':
          return json([meta])
        case '/api/folders':
          return json([{ folder: 'inbox', subpath: 'Open' }, { folder: 'inbox', subpath: 'Journal' }])
        default:
          res.writeHead(404)
          return res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    url = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const remote = (): VaultBackend => createBackend({ kind: 'remote', name: '', baseUrl: url, authToken: 't' })

  it('refuses a destination in it', async () => {
    await expect(
      callTool('create_note', { folder: 'quick', title: 'Via', body: 'X' }, remote(), deny)
    ).rejects.toThrow(new Error('This assistant cannot put notes there.'))
    await expect(
      callTool('move_note', { path: 'Open/Free.md', targetFolder: 'quick', targetSubpath: '' }, remote(), deny)
    ).rejects.toThrow(new Error('This assistant cannot put notes there.'))
    expect(posts).toEqual([])
  })

  it('refuses a lifecycle move only when its own folder is the link', async () => {
    await expect(callTool('archive_note', { path: 'Open/Free.md' }, remote(), deny)).rejects.toThrow(
      new Error('This assistant cannot put notes there.')
    )
    expect(posts).toEqual([])
    await callTool('move_to_trash', { path: 'Open/Free.md' }, remote(), deny)
    expect(posts).toEqual(['/api/notes/trash'])
  })

  it('denies it even when an allow entry names it', async () => {
    const allow = newMcpScope({ access: 'write', allow: ['quick'] })
    await expect(
      callTool('create_note', { folder: 'quick', title: 'Via', body: 'X' }, remote(), allow)
    ).rejects.toThrow(new Error('This assistant can create and move notes only inside: quick.'))
    expect(posts).toEqual([])
  })

  it('does not name it to the client', async () => {
    const info = JSON.stringify(await callTool('vault_info', {}, remote(), deny))
    expect(info).not.toContain('linkedSystemFolders')
    expect(info).not.toContain('"deny"')
  })

  it.each([undefined, []])('treats %j as no linked folders', async (none) => {
    linked = none
    await callTool('create_note', { folder: 'quick', title: 'Via', body: 'X' }, remote(), deny)
    expect(posts).toContain('/api/notes/create')
  })

  it.each(['quick', 7, null, [7], ['quick', null]])('shares nothing when the field is %j', async (bad) => {
    linked = bad
    await expect(callTool('list_notes', {}, remote(), deny)).rejects.toThrow('linked system folders')
    await expect(
      callTool('create_note', { folder: 'quick', title: 'Via', body: 'X' }, remote(), deny)
    ).rejects.toThrow('linked system folders')
    expect(posts).toEqual([])
  })

  it('does not ask for a scope that only limits access', async () => {
    linked = 'quick'
    const read = newMcpScope({ access: 'read' })
    await expect(callTool('list_notes', {}, remote(), read)).resolves.toBeTruthy()
  })
})

const binary = process.env.ZENNOTES_SERVER_CONTRACT_BINARY

describe.skipIf(!binary)('links on a real server', () => {
  const TOKEN = 'tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const allow = newMcpScope({ access: 'write', allow: ['Projects'] })
  const deny = newMcpScope({ access: 'write', deny: ['Journal'] })
  let child: ChildProcess
  let remote: VaultBackend
  let marks: boolean

  const journal = async (): Promise<string[]> => (await fsp.readdir(inVault('Journal'))).sort()

  // A server makes the system folders it finds missing when it starts, so a
  // link standing in for one has to be there first.
  const start = async (): Promise<void> => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer()
      probe.on('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        probe.close(() => resolve(address && typeof address === 'object' ? address.port : 0))
      })
    })
    const url = `http://127.0.0.1:${port}`
    child = spawn(binary as string, [], {
      cwd: base,
      stdio: 'ignore',
      env: {
        ...process.env,
        ZENNOTES_BIND: `127.0.0.1:${port}`,
        ZENNOTES_VAULT_PATH: root,
        ZENNOTES_CONFIG_PATH: path.join(base, 'server.json'),
        ZENNOTES_AUTH_TOKEN: TOKEN
      }
    })
    for (let attempt = 0; ; attempt += 1) {
      const ready = await fetch(`${url}/healthz`).then(
        (res) => res.ok,
        () => false
      )
      if (ready) break
      if (attempt > 400) throw new Error('server did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const capabilities = (await fetch(`${url}/api/capabilities`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    }).then((res) => res.json())) as Record<string, unknown>
    marks = capabilities.supportsSymlinkMarks === true
    remote = createBackend({ kind: 'remote', name: '', baseUrl: url, authToken: TOKEN })
  }

  afterEach(() => {
    child.kill()
  })

  it('keeps a new note off a link to nothing', async (ctx) => {
    await fsp.symlink('../Journal/FreshNote.md', inVault('Projects/fresh.md'))
    await fsp.symlink('../../outside/esc.md', inVault('Projects/esc.md'))
    await start()
    if (!marks) ctx.skip()
    for (const title of ['fresh', 'esc']) {
      const made = (await callTool(
        'create_note',
        { folder: 'inbox', subpath: 'Projects', title, body: 'X' },
        remote,
        allow
      )) as { path: string }
      expect(made.path).toBe(`Projects/${title} 2.md`)
    }
    expect(await journal()).toEqual(['Diary.md'])
    expect(await fsp.readdir(path.join(base, 'outside'))).toEqual([])
  })

  it('keeps a copy off a link to nothing', async (ctx) => {
    await fsp.symlink('../Journal/PlanCopy.md', inVault('Projects/Plan copy.md'))
    await start()
    if (!marks) ctx.skip()
    const made = (await callTool('duplicate_note', { path: 'Projects/Plan.md' }, remote, allow)) as {
      path: string
    }
    expect(made.path).toBe('Projects/Plan copy 2.md')
    expect(await journal()).toEqual(['Diary.md'])
  })

  it('refuses a destination in a linked system folder', async (ctx) => {
    await fsp.symlink('Journal', inVault('quick'))
    await start()
    if (!marks) ctx.skip()
    for (const [tool, args] of [
      ['create_note', { folder: 'quick', title: 'ViaBucket', body: 'X' }],
      ['create_folder', { folder: 'quick', subpath: 'SubViaBucket' }],
      ['move_note', { path: 'Open/Free.md', targetFolder: 'quick', targetSubpath: '' }]
    ] as const) {
      await expect(callTool(tool, args, remote, deny), tool).rejects.toThrow(
        new Error('This assistant cannot put notes there.')
      )
    }
    expect(await journal()).toEqual(['Diary.md'])
  })

  it.each([
    ['archive_note', 'archive'],
    ['move_to_trash', 'trash']
  ])('refuses %s when %s is a link', async (tool, dir) => {
    await fsp.symlink('Journal', inVault(dir))
    await start()
    if (!marks) return
    await expect(callTool(tool, { path: 'Projects/Plan.md' }, remote, allow)).rejects.toThrow(
      new Error('This assistant can create and move notes only inside: Projects.')
    )
    expect(await journal()).toEqual(['Diary.md'])
    expect(await exists(inVault('Projects/Plan.md'))).toBe(true)
  })

  it('still archives when nothing is a link', async (ctx) => {
    await start()
    if (!marks) ctx.skip()
    await expect(callTool('archive_note', { path: 'Projects/Plan.md' }, remote, allow)).resolves.toMatchObject({
      path: 'archive/Projects/Plan.md'
    })
  })
})
