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
import { goesThroughLink } from './vault-ops'

const DIARY = '# Diary\n\nprivate needle\n'
const UNMARKED =
  'This ZenNotes server cannot share part of a vault: its listings do not mark links, so nothing is shared until the server is updated.'

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

describe('a restore', () => {
  const planted = async (rel: string): Promise<void> => {
    await fsp.mkdir(path.dirname(inVault(rel)), { recursive: true })
    await fsp.writeFile(inVault(rel), '# Planted\n')
  }

  it.each([
    ['unarchive_note', 'archive'],
    ['restore_from_trash', 'trash']
  ])('%s does not land beside the folder it was checked against', async (tool, dir) => {
    await planted(`${dir}/Pr\u00f6jects/planted.md`)
    const scope = newMcpScope({ access: 'write', allow: ['Projects', dir] })
    await expect(callTool(tool, { path: `${dir}/Pr\u00f6jects/planted.md` }, backend, scope)).rejects.toThrow(
      new Error(`This assistant can create and move notes only inside: Projects, ${dir}.`)
    )
    expect(await exists(inVault('Pr\u00f6jects'))).toBe(false)
    expect(await exists(inVault(`${dir}/Pr\u00f6jects/planted.md`))).toBe(true)
  })

  it.each([
    ['unarchive_note', 'archive'],
    ['restore_from_trash', 'trash']
  ])('%s does not land behind a link beside a real folder', async (tool, dir) => {
    await fsp.mkdir(inVault('cafe'))
    await fsp.writeFile(inVault('cafe/Menu.md'), '# Menu\n')
    await fsp.symlink('Journal', inVault('caf\u00e9'))
    await planted(`${dir}/caf\u00e9/planted.md`)
    const deny = newMcpScope({ access: 'write', deny: ['Journal'] })
    await expect(callTool(tool, { path: `${dir}/caf\u00e9/planted.md` }, backend, deny)).rejects.toThrow(
      new Error('This assistant cannot put notes there.')
    )
    expect(await exists(inVault('Journal/planted.md'))).toBe(false)
  })

  it.each([
    ['unarchive_note', 'archive/Pr\u00f6jects/Back.md'],
    ['restore_from_trash', 'trash/Pr\u00f6jects/Trashed.md']
  ])('%s does not follow a link spelled like an allowed folder', async (tool, rel) => {
    await planted(rel)
    await fsp.symlink('Journal', inVault('Pr\u00f6jects'))
    const scope = newMcpScope({ access: 'write', allow: ['Projects', 'archive', 'trash'] })
    await expect(callTool(tool, { path: rel }, backend, scope)).rejects.toThrow(
      new Error('This assistant can create and move notes only inside: Projects, archive, trash.')
    )
    expect(await fsp.readdir(inVault('Journal'))).toEqual(['Diary.md'])
    expect(await exists(inVault(rel))).toBe(true)
  })

  it('still lands in a folder spelled as the note keeps it', async () => {
    await planted('archive/Projects/Back.md')
    const allow = newMcpScope({ access: 'write', allow: ['Projects', 'archive'] })
    await expect(
      callTool('unarchive_note', { path: 'archive/Projects/Back.md' }, backend, allow)
    ).resolves.toMatchObject({ path: 'Projects/Back.md' })
  })

  it('still lands at the top of a vault', async () => {
    await planted('trash/Top.md')
    const deny = newMcpScope({ access: 'write', deny: ['Journal'] })
    await expect(callTool('restore_from_trash', { path: 'trash/Top.md' }, backend, deny)).resolves.toMatchObject({
      path: 'Top.md'
    })
  })
})

describe('where a local vault keeps its system folders', () => {
  const setLayout = async (layout: Record<string, unknown>): Promise<void> => {
    await fsp.writeFile(inVault('.zennotes/vault.json'), JSON.stringify(layout))
  }

  it('hides an inbox that is a link in inbox mode', async () => {
    await setLayout({ primaryNotesLocation: 'inbox' })
    await fsp.mkdir(inVault('archive/Old'), { recursive: true })
    await fsp.writeFile(inVault('archive/Old/Gone.md'), '# Gone\n')
    await fsp.symlink('Journal', inVault('inbox'))
    const deny = newMcpScope({ access: 'write', deny: ['archive/Old'] })
    const notes = JSON.stringify(await callTool('list_notes', {}, backend, deny))
    expect(notes).not.toContain('Diary')
    await expect(callTool('read_note', { path: 'inbox/Diary.md' }, backend, deny)).rejects.toThrow(
      new Error('Note not found: inbox/Diary.md')
    )
    await expect(
      callTool('create_note', { folder: 'inbox', title: 'Via', body: 'X' }, backend, deny)
    ).rejects.toThrow(new Error('This assistant cannot put notes there.'))
    expect(await exists(inVault('Journal/Via.md'))).toBe(false)
  })

  it('does not count a link named inbox in root mode, where it is no system folder', async () => {
    await fsp.symlink('Journal', inVault('inbox'))
    expect(await backend.linkedSystemFolders()).toEqual([])
  })

  it('finds a remapped system folder that is a link', async () => {
    await setLayout({ primaryNotesLocation: 'root', systemFolderPaths: { archive: '99 Archive' } })
    await fsp.symlink('Journal', inVault('99 Archive'))
    const deny = newMcpScope({ access: 'write', deny: ['Journal'] })
    expect(await backend.linkedSystemFolders()).toEqual(['99 Archive'])
    await expect(callTool('read_note', { path: '99 Archive/Diary.md' }, backend, deny)).rejects.toThrow(
      new Error('Note not found: 99 Archive/Diary.md')
    )
    await expect(callTool('archive_note', { path: 'Open/Free.md' }, backend, deny)).rejects.toThrow(
      new Error('This assistant cannot put notes there.')
    )
    expect(await exists(inVault('Journal/Free.md'))).toBe(false)
  })

  it('counts a path it cannot walk as going through a link', async () => {
    expect(await goesThroughLink(root, 'Open/Free.md/below')).toBe(true)
    expect(await goesThroughLink(root, 'Open/Missing/below')).toBe(false)
    expect(await goesThroughLink(root, 'Open')).toBe(false)
  })
})

describe('a destination folder that is a link to nothing', () => {
  const allow = newMcpScope({ access: 'write', allow: ['Projects'] })
  const REFUSAL = 'This assistant can create and move notes only inside: Projects.'

  beforeEach(async () => {
    await fsp.symlink('../Journal/NoDir', inVault('Projects/dang'))
  })

  it.each([
    ['create_note', { folder: 'inbox', subpath: 'Projects/dang', title: 'Via', body: 'X' }],
    ['create_note', { folder: 'inbox', subpath: 'Projects/dang/Deeper', title: 'Via', body: 'X' }],
    ['create_folder', { folder: 'inbox', subpath: 'Projects/dang/Made' }],
    ['move_note', { path: 'Projects/Plan.md', targetFolder: 'inbox', targetSubpath: 'Projects/dang' }]
  ])('refuses %s %j', async (tool, args) => {
    await expect(callTool(tool, args, backend, allow)).rejects.toThrow(new Error(REFUSAL))
    expect(await exists(inVault('Journal/NoDir'))).toBe(false)
    expect(await exists(inVault('Projects/Plan.md'))).toBe(true)
  })
})

describe('an attachment folder that is a link', () => {
  const deny = newMcpScope({ access: 'write', deny: ['Journal'] })

  beforeEach(async () => {
    await fsp.writeFile(inVault('Journal/secret.png'), 'png')
  })

  // First in this block: the hint fires once per folder name per process.
  it('hints once on stderr', async () => {
    const lines: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    await fsp.symlink('Journal', inVault('attachements'))
    await callTool('list_assets', {}, backend, deny)
    await callTool('list_assets', {}, backend, deny)
    expect(lines.filter((line) => line.includes('attachements'))).toHaveLength(1)
  })

  it.each(['assets', 'attachements', '_assets'])('shows nothing through %s', async (dir) => {
    await fsp.symlink('Journal', inVault(dir))
    expect(await callTool('list_assets', {}, backend, deny)).toEqual([])
  })

  it('shows nothing through it even when an allow entry names it', async () => {
    await fsp.symlink('Journal', inVault('assets'))
    const allow = newMcpScope({ access: 'write', allow: ['assets'] })
    expect(await callTool('list_assets', {}, backend, allow)).toEqual([])
  })

  it('still lists a real attachment folder', async () => {
    await fsp.mkdir(inVault('assets'))
    await fsp.writeFile(inVault('assets/real.png'), 'png')
    const assets = (await callTool('list_assets', {}, backend, deny)) as { path: string }[]
    expect(assets.map((a) => a.path)).toEqual(['assets/real.png'])
  })

  it('stays as it was for a client with no path scope', async () => {
    await fsp.symlink('Journal', inVault('assets'))
    const read = newMcpScope({ access: 'read' })
    const assets = (await callTool('list_assets', {}, backend, read)) as { path: string }[]
    expect(assets.map((a) => a.path)).toContain('assets/secret.png')
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
  let postStatus: number
  /** Notes listed beside Open/Free.md. */
  let extraNotes: Record<string, unknown>[]

  beforeEach(async () => {
    linked = ['quick', 'archive']
    posts = []
    postStatus = 200
    extraNotes = []
    server = createServer((req, res) => {
      const at = new URL(req.url ?? '/', 'http://x')
      const json = (value: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'POST') {
        posts.push(at.pathname)
        if (postStatus !== 200) {
          res.writeHead(postStatus)
          return res.end('path goes through a symbolic link')
        }
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
          return json([meta, ...extraNotes])
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

  it('accepts a remapped or nested folder in the list', async () => {
    linked = ['99 Archive', 'Sys/Held']
    await expect(callTool('list_notes', {}, remote(), deny)).resolves.toBeTruthy()
  })

  it('matches a linked folder however it is spelled', async () => {
    linked = ['ARCHIVE']
    await expect(callTool('archive_note', { path: 'Open/Free.md' }, remote(), deny)).rejects.toThrow(
      new Error('This assistant cannot put notes there.')
    )
    expect(posts).toEqual([])
  })

  it.each([
    ['unarchive_note', 'archive', '/api/notes/unarchive'],
    ['restore_from_trash', 'trash', '/api/notes/restore']
  ])('%s does not ask the server to land beside what it checked', async (tool, dir) => {
    linked = []
    const rel = `${dir}/Op\u00e9n/planted.md`
    extraNotes = [{ path: rel, title: 'planted', folder: dir, tags: [], wikilinks: [], excerpt: '' }]
    await expect(callTool(tool, { path: rel }, remote(), deny)).rejects.toThrow(
      new Error('This assistant cannot put notes there.')
    )
    expect(posts).toEqual([])
  })

  it.each([
    ['archive_note', 'Open/Free.md', 400],
    ['archive_note', 'Open/Free.md', 404],
    ['move_to_trash', 'Open/Free.md', 404],
    ['unarchive_note', 'archive/Open/Back.md', 400],
    ['unarchive_note', 'archive/Open/Back.md', 404],
    ['restore_from_trash', 'trash/Open/Back.md', 400],
    ['restore_from_trash', 'trash/Open/Back.md', 404]
  ])('answers %s of %s the server turns away with %i with the usual refusal', async (tool, rel, status) => {
    linked = []
    postStatus = status
    const folder = rel.split('/')[0]
    if (rel !== 'Open/Free.md') {
      extraNotes = [{ path: rel, title: 'Back', folder, tags: [], wikilinks: [], excerpt: '' }]
    }
    const failure = await callTool(tool, { path: rel }, remote(), deny).catch((err: Error) => err)
    expect(failure).toEqual(new Error('This assistant cannot put notes there.'))
    expect(posts).toHaveLength(1)
  })

  it('treats an empty list as no linked folders', async () => {
    linked = []
    await callTool('create_note', { folder: 'quick', title: 'Via', body: 'X' }, remote(), deny)
    expect(posts).toContain('/api/notes/create')
  })

  // A server too old to send the field says nothing about its folders, which
  // is not the same as having none linked.
  it.each([
    [undefined],
    ['quick'],
    [7],
    [null],
    [[7]],
    [['quick', null]],
    [['quick/']],
    [['/quick']],
    [['./quick']],
    [['../quick']],
    [['quick/../archive']],
    [['quick//x']],
    [['quick\\x']],
    [[' quick']],
    [['quick ']],
    [['a /b']],
    [['a/ b']],
    [['']],
    [['quick', '']]
  ])(
    'shares nothing when the field is %j',
    async (bad) => {
      linked = bad
      const stopped = new Error(UNMARKED)
      await expect(callTool('list_notes', {}, remote(), deny)).rejects.toThrow(stopped)
      await expect(
        callTool('create_note', { folder: 'quick', title: 'Via', body: 'X' }, remote(), deny)
      ).rejects.toThrow(stopped)
      expect(posts).toEqual([])
    }
  )

  it('hints once on stderr, and never to the model', async () => {
    const lines: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    linked = ['HintedOnce']
    for (let i = 0; i < 2; i++) {
      const notes = JSON.stringify(await callTool('list_notes', {}, remote(), deny))
      expect(notes).not.toContain('HintedOnce')
    }
    expect(lines.filter((line) => line.includes('HintedOnce'))).toEqual([
      '[zennotes-mcp] the system folder HintedOnce is a symbolic link, so it is hidden from a client with --allow-path or --deny-path\n'
    ])
  })

  it.each([
    ['archive_note', '/api/notes/archive'],
    ['move_to_trash', '/api/notes/trash']
  ])('answers %s the server turns away with the usual refusal', async (tool, route) => {
    linked = []
    postStatus = 400
    const failure = await callTool(tool, { path: 'Open/Free.md' }, remote(), deny).catch((err: Error) => err)
    expect(failure).toEqual(new Error('This assistant cannot put notes there.'))
    expect((failure as Error).message).not.toContain('symbolic')
    expect(posts).toEqual([route])
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
    const vault = (await fetch(`${url}/api/vault`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    }).then((res) => res.json())) as Record<string, unknown>
    marks = capabilities.supportsSymlinkMarks === true && Array.isArray(vault.linkedSystemFolders)
    // Without this a server that stopped marking links would only skip tests.
    if (process.env.ZENNOTES_SERVER_CONTRACT_REQUIRE_MARKS) {
      expect(marks, 'the server marks links and lists linked system folders').toBe(true)
    }
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

  it('gives the usual refusal for a link on the subpath a move keeps', async (ctx) => {
    await fsp.mkdir(inVault('archive/Hidden'), { recursive: true })
    await fsp.writeFile(inVault('archive/Hidden/Kept.md'), '# Kept\n')
    await fsp.symlink('Hidden', inVault('archive/Projects'))
    await start()
    if (!marks) ctx.skip()
    const hide = newMcpScope({ access: 'write', deny: ['archive/Hidden'] })
    await expect(callTool('archive_note', { path: 'Projects/Plan.md' }, remote, hide)).rejects.toThrow(
      new Error('This assistant cannot put notes there.')
    )
    expect(await exists(inVault('archive/Hidden/Plan.md'))).toBe(false)
    expect(await exists(inVault('Projects/Plan.md'))).toBe(true)
  })

  it('keeps a restore where it was checked', async (ctx) => {
    await fsp.mkdir(inVault('cafe'))
    await fsp.writeFile(inVault('cafe/Menu.md'), '# Menu\n')
    await fsp.mkdir(inVault('archive/caf\u00e9'), { recursive: true })
    await fsp.writeFile(inVault('archive/caf\u00e9/planted.md'), '# Planted\n')
    await fsp.mkdir(inVault('trash/Pr\u00f6jects'), { recursive: true })
    await fsp.writeFile(inVault('trash/Pr\u00f6jects/planted.md'), '# Planted\n')
    await fsp.symlink('Journal', inVault('caf\u00e9'))
    await start()
    if (!marks) ctx.skip()
    await expect(
      callTool('unarchive_note', { path: 'archive/caf\u00e9/planted.md' }, remote, deny)
    ).rejects.toThrow(new Error('This assistant cannot put notes there.'))
    expect(await journal()).toEqual(['Diary.md'])
    const scope = newMcpScope({ access: 'write', allow: ['Projects', 'trash'] })
    await expect(
      callTool('restore_from_trash', { path: 'trash/Pr\u00f6jects/planted.md' }, remote, scope)
    ).rejects.toThrow(new Error('This assistant can create and move notes only inside: Projects, trash.'))
    expect(await exists(inVault('Pr\u00f6jects'))).toBe(false)
  })

  it('still archives when nothing is a link', async (ctx) => {
    await start()
    if (!marks) ctx.skip()
    await expect(callTool('archive_note', { path: 'Projects/Plan.md' }, remote, allow)).resolves.toMatchObject({
      path: 'archive/Projects/Plan.md'
    })
  })
})
