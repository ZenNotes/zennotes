import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newMcpScope, type McpScopeFlags } from '@shared/mcp-scope'
import { createBackend, type VaultBackend } from '../cli/backend'
import { readAgentEditRecord } from '../main/agent-edit-files'
import { decodeAssetBase64 } from './asset-tools'
import { findSection, noteSections, sectionBody } from './note-sections'
import { ScopedBackend } from './scoped-backend'
import { runMcpServer } from './server'
import {
  AssetDestinationRefused,
  importAsset,
  listAssets,
  listDeletedAssets,
  renameAsset,
  writeNote
} from './vault-ops'

// Files and notes keep their bytes and their links when calls race, a write
// fails, or a name would not survive a link.

let root: string
const clients: Client[] = []

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, body)
  }
}

const inVault = (rel: string): string => path.join(root, ...rel.split('/'))
const file = (rel: string): Promise<string> => fsp.readFile(inVault(rel), 'utf8')
const exists = (rel: string): Promise<boolean> =>
  fsp.lstat(inVault(rel)).then(
    () => true,
    () => false
  )

async function connect(flags?: McpScopeFlags): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await runMcpServer({
    resolveTarget: async () => ({ kind: 'local', root }),
    scope: flags ? newMcpScope(flags) : null,
    transport: serverTransport
  })
  const client = new Client({ name: 'claude-code', version: '0' })
  await client.connect(clientTransport)
  clients.push(client)
  return client
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args })
  const parts = result.content as { text?: string }[]
  return { text: parts[0]?.text ?? '', isError: !!result.isError }
}

async function ok(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const { text, isError } = await call(client, name, args)
  expect(isError, text).toBe(false)
  return text
}

async function refused(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const { text, isError } = await call(client, name, args)
  expect(isError, text).toBe(true)
  return text
}

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-review-')))
  vi.stubEnv('ZENNOTES_CONFIG_DIR', path.join(root, '.config-for-test'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await fsp.rm(root, { recursive: true, force: true })
})

async function contents(dir: string): Promise<string[]> {
  const names = await fsp.readdir(inVault(dir))
  const bodies = await Promise.all(names.map((name) => file(`${dir}/${name}`)))
  return bodies.sort()
}

describe('asset writes at the same time', () => {
  it('keeps both files when two moves into one folder race', async () => {
    const backend = createBackend({ kind: 'local', root })
    for (let round = 0; round < 15; round += 1) {
      const target = `Target${round}`
      await seed({ [`A${round}/x.png`]: 'from a', [`B${round}/x.png`]: 'from b' })
      await fsp.mkdir(inVault(target))
      await Promise.all([
        backend.moveAsset(`A${round}/x.png`, target),
        backend.moveAsset(`B${round}/x.png`, target)
      ])
      expect(await contents(target)).toEqual(['from a', 'from b'])
    }
  })

  it('lets one of two renames onto a name win, and keeps the other file', async () => {
    const backend = createBackend({ kind: 'local', root })
    for (let round = 0; round < 15; round += 1) {
      const dir = `Dir${round}`
      await seed({ [`${dir}/a.png`]: 'a', [`${dir}/b.png`]: 'b' })
      const outcomes = await Promise.allSettled([
        backend.renameAsset(`${dir}/a.png`, 'c.png'),
        backend.renameAsset(`${dir}/b.png`, 'c.png')
      ])
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
      expect(await contents(dir)).toEqual(['a', 'b'])
    }
  })

  it('does not replace a file that another program made after the name was checked', async () => {
    await seed({ 'assets/x.png': 'moved', 'Target/keep.txt': 'keep' })
    const backend = createBackend({ kind: 'local', root })
    const dest = inVault('Target/x.png')
    const lstat = fsp.lstat.bind(fsp)
    let raced = false
    vi.spyOn(fsp, 'lstat').mockImplementation((async (p: string, options?: never) => {
      const answer = await lstat(p, options).then(
        (info) => ({ info }),
        (err: unknown) => ({ err })
      )
      if (p === dest && !raced && 'err' in answer) {
        raced = true
        await fsp.writeFile(dest, 'theirs')
      }
      if ('err' in answer) throw answer.err
      return answer.info
    }) as never)
    const moved = await backend.moveAsset('assets/x.png', 'Target')
    expect(raced).toBe(true)
    expect(await file('Target/x.png')).toBe('theirs')
    expect(moved.path).toBe('Target/x 2.png')
    expect(await file('Target/x 2.png')).toBe('moved')
  })

  it.each(['EPERM', 'ENOTSUP', 'EXDEV'])('still moves a file where a hard link answers %s', async (code) => {
    await seed({ 'assets/x.png': 'moved', 'Target/x.png': 'kept' })
    const backend = createBackend({ kind: 'local', root })
    vi.spyOn(fsp, 'link').mockRejectedValue(Object.assign(new Error(code), { code }))
    const moved = await backend.moveAsset('assets/x.png', 'Target')
    expect(moved.path).toBe('Target/x 2.png')
    expect(await file('Target/x.png')).toBe('kept')
    expect(await file('Target/x 2.png')).toBe('moved')
    expect(await exists('assets/x.png')).toBe(false)
  })

  it('takes the next number for an upload whose name was taken after the check', async () => {
    await seed({ 'assets/keep.png': 'keep' })
    const dest = inVault('assets/x.png')
    const lstat = fsp.lstat.bind(fsp)
    let raced = false
    vi.spyOn(fsp, 'lstat').mockImplementation((async (p: string, options?: never) => {
      const answer = await lstat(p, options).then(
        (info) => ({ info }),
        (err: unknown) => ({ err })
      )
      if (p === dest && !raced && 'err' in answer) {
        raced = true
        await fsp.writeFile(dest, 'theirs')
      }
      if ('err' in answer) throw answer.err
      return answer.info
    }) as never)
    const added = await importAsset(root, 'x.png', new Uint8Array([109]))
    expect(added.path).toBe('assets/x 2.png')
    expect(await file('assets/x.png')).toBe('theirs')
  })

  it('leaves no partial file behind when an upload fails', async () => {
    const writeFile = fsp.writeFile.bind(fsp)
    vi.spyOn(fsp, 'writeFile').mockImplementation((async (p: string, data: never, options: never) => {
      await writeFile(p, 'par', options)
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
    }) as never)
    await expect(importAsset(root, 'x.png', new Uint8Array([1, 2, 3]))).rejects.toThrow('no space')
    expect(await exists('assets/x.png')).toBe(false)
  })
})

describe('a name rename_asset can give a file', () => {
  it.each(['b#c.png', 'h?i.png', '50%25.png', 'd|e.png', 'f]g.png', 'j[k.png', 'l^m.png', 'n\no.png', 'p\tq.png', 'r:s.png', 't.png.', 'u*v.png', 'w"x.png', '<c.png', 'y>z.png', 'a`b.png'])(
    'refuses %j, whose links would break',
    async (name) => {
      await seed({ 'assets/a.png': 'a', 'N.md': '![[assets/a.png]]\n' })
      const client = await connect()
      expect(await refused(client, 'rename_asset', { path: 'assets/a.png', name })).toContain(
        'A file name cannot'
      )
      expect(await file('assets/a.png')).toBe('a')
      expect(await file('N.md')).toBe('![[assets/a.png]]\n')
    }
  )

  it('still numbers and cleans an uploaded name', async () => {
    const client = await connect()
    expect(JSON.parse(await ok(client, 'upload_asset', { filename: 'a#b.png', content_base64: 'cG5n' }))).toMatchObject({
      path: 'assets/a-b.png'
    })
  })

  it.each(['note.md.', 'note.md ..', 'note.md .'])('treats %j as a note', async (name) => {
    await seed({ 'assets/a.png': 'a' })
    const client = await connect()
    const words = 'Notes are not attachments'
    expect(await refused(client, 'upload_asset', { filename: name, content_base64: 'cG5n' })).toContain(words)
    expect(await refused(client, 'rename_asset', { path: 'assets/a.png', name })).toContain(words)
  })

  it('treats a name that reads as a note after a colon as one, for a rename', async () => {
    await seed({ 'assets/a.png': 'a' })
    const client = await connect()
    expect(await refused(client, 'rename_asset', { path: 'assets/a.png', name: 'note.MD:x' })).toContain(
      'Notes are not attachments'
    )
    expect(JSON.parse(await ok(client, 'upload_asset', { filename: 'note.MD:x', content_base64: 'cG5n' }))).toMatchObject({
      path: 'assets/note.MD-x'
    })
  })

  it.each(['CON', 'con.png', 'con .png', 'CONIN$', 'conout$.txt', 'NUL', 'Aux.txt', 'COM1.png', 'lpt9', 'com\u00b9.png'])(
    'refuses %j for a rename, a name Windows keeps',
    async (name) => {
      await seed({ 'assets/a.png': 'a' })
      const client = await connect()
      expect(await refused(client, 'rename_asset', { path: 'assets/a.png', name })).toContain('reserved on Windows')
    }
  )

  it.each([
    ['aux.png', 'assets/_aux.png'],
    ['CON', 'assets/_CON']
  ])('cleans %j for an upload', async (filename, want) => {
    const client = await connect()
    expect(JSON.parse(await ok(client, 'upload_asset', { filename, content_base64: 'cG5n' }))).toMatchObject({ path: want })
  })

  it.each(['x.csv.bak', 'x.csv.base.json.bak', 'x.csv.base.json', 'x.excalidraw .'])('refuses %j, not a file of the user\'s', async (filename) => {
    const client = await connect()
    expect(await refused(client, 'upload_asset', { filename, content_base64: 'cG5n' })).toContain(
      'cannot be managed as an attachment'
    )
  })
})

describe('update_task on a recurring task', () => {
  const NOTE = 'Projects/Plan.md'

  it('writes the next occurrence and reports the finished task, as toggle_task does', async () => {
    await seed({ [NOTE]: '# Plan\n\n- [ ] water @repeat:daily due:2099-01-01\n- [ ] other\n' })
    const client = await connect()
    const task = JSON.parse(
      await ok(client, 'update_task', { id: `${NOTE}#0`, state: 'done' })
    ) as { checked: boolean; id: string }
    expect(task.checked).toBe(true)
    expect(task.id).toBe(`${NOTE}#1`)
    const lines = (await file(NOTE)).split('\n')
    expect(lines[2]).toMatch(/^- \[ \] water @repeat:daily due:2099-01-02/)
    expect(lines[3]).toMatch(/^- \[x\] water/)
    expect(lines[4]).toBe('- [ ] other')
  })

  it('counts from the due date the same call sets', async () => {
    await seed({ [NOTE]: '- [ ] water @repeat:daily due:2099-01-01\n' })
    const client = await connect()
    await ok(client, 'update_task', { id: `${NOTE}#0`, state: 'done', due: '2099-05-05' })
    expect((await file(NOTE)).split('\n')[0]).toContain('due:2099-05-06')
  })

  it('keeps the line endings of a Windows note', async () => {
    await seed({ [NOTE]: '- [ ] water @repeat:daily due:2026-01-01\r\n- [ ] other\r\n' })
    const client = await connect()
    await ok(client, 'update_task', { id: `${NOTE}#0`, state: 'done' })
    const body = await file(NOTE)
    expect(body.replace(/\r\n/g, '')).not.toContain('\n')
    expect(body).toContain('- [ ] other\r\n')
  })

  it('checks off a plain task as before', async () => {
    await seed({ [NOTE]: '- [ ] plain\n' })
    const client = await connect()
    await ok(client, 'update_task', { id: `${NOTE}#0`, state: 'done' })
    expect(await file(NOTE)).toBe('- [x] plain\n')
  })
})

describe('update_task keeps the rest of a note', () => {
  const NOTE = 'Projects/Plan.md'

  it('does not touch a Windows note when nothing changes', async () => {
    const body = '# Plan\r\n\r\n- [ ] ship it due:2026-01-01\r\n\r\nend\r\n'
    await seed({ [NOTE]: body })
    const client = await connect()
    await ok(client, 'update_task', { id: `${NOTE}#0`, due: '2026-01-01' })
    expect(await file(NOTE)).toBe(body)
  })

  it('changes one line of a Windows note, and only that line', async () => {
    await seed({ [NOTE]: '# Plan\r\n\r\n- [ ] ship it\r\n\r\nend\r\n' })
    const client = await connect()
    await ok(client, 'update_task', { id: `${NOTE}#0`, due: '2026-01-01' })
    expect(await file(NOTE)).toBe('# Plan\r\n\r\n- [ ] ship it due:2026-01-01\r\n\r\nend\r\n')
  })

  it('edit_section keeps a Windows note a Windows note', async () => {
    await seed({ [NOTE]: '# Plan\r\n\r\n## A\r\n\r\none\r\n\r\n## B\r\n\r\ntwo\r\n' })
    const client = await connect()
    await ok(client, 'edit_section', { path: NOTE, heading: 'A', mode: 'append', text: 'more' })
    expect(await file(NOTE)).toBe('# Plan\r\n\r\n## A\r\n\r\none\r\n\r\nmore\r\n\r\n## B\r\n\r\ntwo\r\n')
  })
})

describe('update_task and a stale id', () => {
  const NOTE = 'Projects/Plan.md'

  it('refuses and changes nothing when expectedText names another task', async () => {
    await seed({ [NOTE]: '- [ ] first\n- [ ] second\n' })
    const client = await connect()
    expect(await refused(client, 'update_task', { id: `${NOTE}#0`, expectedText: 'second', state: 'done' })).toContain(
      `Task ${NOTE}#0 now reads "first", not "second": the note changed. Run list_tasks again for its id.`
    )
    expect(await file(NOTE)).toBe('- [ ] first\n- [ ] second\n')
    expect(
      JSON.parse(await ok(client, 'update_task', { id: `${NOTE}#1`, expectedText: 'second', state: 'done' }))
    ).toMatchObject({ checked: true })
  })
})

describe('update_task on a task note', () => {
  const NOTE = 'Projects/Do.md'

  it('waiting is a status the task parser reads', async () => {
    await seed({ [NOTE]: '---\ntags: [task]\nstatus: open\n---\n# Do\n' })
    const client = await connect()
    expect(JSON.parse(await ok(client, 'update_task', { id: `${NOTE}#task`, waiting: true }))).toMatchObject({
      waiting: true,
      status: 'waiting'
    })
    expect(JSON.parse(await ok(client, 'update_task', { id: `${NOTE}#task`, waiting: false }))).toMatchObject({
      waiting: false,
      status: 'open'
    })
  })

  it('a status clears the date a finished task carries', async () => {
    await seed({ [NOTE]: '---\ntags: [task]\nstatus: done\ncompletedDate: 2026-01-01\n---\n# Do\n' })
    const client = await connect()
    await ok(client, 'update_task', { id: `${NOTE}#task`, status: 'review' })
    expect((await file(NOTE)).toLowerCase()).not.toContain('completeddate')
  })

  it.each([
    [{ state: 'open', status: 'review' }],
    [{ state: 'done', waiting: true }],
    [{ status: 'review', waiting: true }]
  ])('refuses %j, which disagree', async (fields) => {
    const body = '---\ntags: [task]\nstatus: open\n---\n# Do\n'
    await seed({ [NOTE]: body })
    const client = await connect()
    expect(await refused(client, 'update_task', { id: `${NOTE}#task`, ...fields })).toContain(
      'A task note keeps state, status and waiting in its one frontmatter status'
    )
    expect(await file(NOTE)).toBe(body)
  })
})

describe('decodeAssetBase64', () => {
  it('takes linear time on a run of padding', () => {
    const started = Date.now()
    expect(() => decodeAssetBase64(`${'='.repeat(400_000)}A`)).toThrow('content_base64 is not valid base64.')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('still strips the padding at the end', () => {
    expect(Buffer.from(decodeAssetBase64('cG5n===')).toString()).toBe('png')
  })
})

describe('a wikilink that names a note', () => {
  it('stays when a file with no extension and the same name moves', async () => {
    await seed({ 'Plan.md': '# Plan\n', 'Docs/Plan': 'data', 'N.md': 'See [[Plan]] and [[Plan|the plan]].\n' })
    const client = await connect()
    await ok(client, 'rename_asset', { path: 'Docs/Plan', name: 'Other' })
    expect(await file('N.md')).toBe('See [[Plan]] and [[Plan|the plan]].\n')
  })
})

describe('a linked attachment folder', () => {
  let outside: string

  beforeEach(async () => {
    outside = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-mcp-review-out-')))
    await fsp.mkdir(path.join(outside, 'private'))
    await fsp.writeFile(path.join(outside, 'pic.png'), 'pic')
    await fsp.writeFile(path.join(outside, 'private/held.png'), 'held')
    await seed({ 'Projects/Plan.md': '# Plan\n', '.zennotes/vault.json': '{"primaryNotesLocation":"root"}' })
  })

  afterEach(async () => {
    await fsp.rm(outside, { recursive: true, force: true })
  })

  it('lists what it holds for a client with no path scope, in or out of the vault', async () => {
    await fsp.symlink(outside, inVault('assets'))
    const client = await connect()
    const paths = (JSON.parse(await ok(client, 'list_assets', {})) as { path: string }[]).map((a) => a.path)
    expect(paths.sort()).toEqual(['assets/pic.png', 'assets/private/held.png'])
  })

  it('finds a file it uploads through a link inside the vault', async () => {
    await seed({ 'Media/old.png': 'old' })
    await fsp.symlink('Media', inVault('assets'))
    const client = await connect()
    const added = JSON.parse(await ok(client, 'upload_asset', { filename: 'x.png', content_base64: 'cG5n' })) as {
      path: string
    }
    expect(added.path).toBe('assets/x.png')
    expect(await ok(client, 'read_asset', { path: added.path })).toContain('assets/x.png')
  })

  it('takes a deny entry that names something inside it, and hides all of it', async () => {
    await fsp.symlink(outside, inVault('assets'))
    const client = await connect({ access: 'read', deny: ['assets/private'] })
    expect(JSON.parse(await ok(client, 'list_assets', {}))).toEqual([])
    expect(await refused(client, 'read_asset', { path: 'assets/pic.png' })).toContain('Asset not found')
  })

  it('stays out of a path scope that names it', async () => {
    await fsp.symlink(outside, inVault('assets'))
    const client = await connect({ access: 'read', allow: ['assets'] })
    expect(JSON.parse(await ok(client, 'list_assets', {}))).toEqual([])
  })

  it('does not follow a link further down', async () => {
    await seed({ 'Elsewhere/x.png': 'x' })
    await fsp.symlink(outside, inVault('Elsewhere/out'))
    expect((await listAssets(root)).map((a) => a.path)).toEqual(['Elsewhere/x.png'])
  })
})

describe('a failed link rewrite', () => {
  it('says which notes still point at the old name', async () => {
    await seed({ 'assets/a.png': 'a', 'Good.md': '![[assets/a.png]]\n', 'Bad.md': '![[assets/a.png]]\n' })
    const client = await connect()
    const rename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation((async (from: string, to: string) => {
      if (to === inVault('Bad.md')) throw Object.assign(new Error('busy'), { code: 'ENOSPC' })
      return await rename(from, to)
    }) as never)
    const moved = JSON.parse(await ok(client, 'rename_asset', { path: 'assets/a.png', name: 'b.png' })) as {
      path: string
      linksNotUpdated?: string[]
    }
    expect(moved.path).toBe('assets/b.png')
    expect(moved.linksNotUpdated).toEqual(['Bad.md'])
    expect(await file('Good.md')).toBe('![[assets/b.png]]\n')
    expect(await file('Bad.md')).toBe('![[assets/a.png]]\n')
  })

  it('says nothing about it when every note was updated', async () => {
    await seed({ 'assets/a.png': 'a', 'Good.md': '![[assets/a.png]]\n' })
    const client = await connect()
    const moved = JSON.parse(await ok(client, 'rename_asset', { path: 'assets/a.png', name: 'b.png' }))
    expect(moved).not.toHaveProperty('linksNotUpdated')
  })
})

describe('writeNote', () => {
  it('leaves the note whole when a write fails partway', async () => {
    await seed({ 'N.md': '# all of the note\n' })
    const open = fsp.open.bind(fsp)
    const writeFile = fsp.writeFile.bind(fsp)
    vi.spyOn(fsp, 'writeFile').mockImplementation((async (p: string, data: string, options: never) => {
      if (p !== inVault('N.md')) return await writeFile(p, data, options)
      await writeFile(p, String(data).slice(0, 2))
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
    }) as never)
    vi.spyOn(fsp, 'open').mockImplementation((async (p: string, flags: string) => {
      const handle = await open(p, flags)
      if (!p.startsWith(inVault('N.md'))) return handle
      handle.writeFile = (async (data: string) => {
        await writeFile(p, String(data).slice(0, 2))
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      }) as never
      return handle
    }) as never)
    await expect(writeNote(root, 'N.md', '# changed, and longer than before\n')).rejects.toThrow('no space')
    vi.restoreAllMocks()
    expect(await file('N.md')).toBe('# all of the note\n')
    expect((await fsp.readdir(root)).filter((name) => name.startsWith('N.md.'))).toEqual([])
  })

  it('leaves no scratch file behind, and keeps the mode', async () => {
    await seed({ 'N.md': 'old\n' })
    await writeNote(root, 'N.md', 'new\n')
    expect(await file('N.md')).toBe('new\n')
    expect((await fsp.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('a path scope and a rename or move', () => {
  it('takes a number when the name it wants is hidden and taken', async () => {
    await seed({ 'Projects/x.png': 'mine', 'Shared/x.png': 'theirs' })
    const client = await connect({ access: 'write', deny: ['Shared/x.png'] })
    expect(JSON.parse(await ok(client, 'move_asset', { path: 'Projects/x.png', targetDir: 'Shared' }))).toMatchObject({
      path: 'Shared/x 2.png'
    })
    expect(await file('Shared/x.png')).toBe('theirs')
  })

  it('lets the filter turn down where a file lands, and moves nothing', async () => {
    await seed({ 'Projects/x.png': 'mine', 'Shared/keep.png': 'k' })
    const backend = createBackend({ kind: 'local', root })
    await expect(
      backend.moveAsset('Projects/x.png', 'Shared', (rel) => rel !== 'Shared/x.png')
    ).rejects.toBeInstanceOf(AssetDestinationRefused)
    expect(await file('Projects/x.png')).toBe('mine')
    expect(await exists('Shared/x.png')).toBe(false)
  })

  it('answers such a move like any folder it may not use', async () => {
    await seed({ 'Projects/x.png': 'mine', 'Shared/keep.png': 'k' })
    const local = createBackend({ kind: 'local', root })
    const turnsDown = {
      ...local,
      moveAsset: async () => {
        throw new AssetDestinationRefused()
      }
    } as VaultBackend
    const scoped = new ScopedBackend(turnsDown, newMcpScope({ access: 'write', deny: ['Shared/keep.png'] }))
    await expect(scoped.moveAsset('Projects/x.png', 'Shared')).rejects.toThrow(
      'This assistant cannot put files there.'
    )
  })

  it('writes the same link whether or not a hidden file shares the name', async () => {
    const run = async (extra: Record<string, string>): Promise<string> => {
      await fsp.rm(root, { recursive: true, force: true })
      await fsp.mkdir(root, { recursive: true })
      await seed({ 'Projects/a.png': 'a', 'Projects/N.md': '![[a.png]]\n', 'Journal/J.md': '# J\n', ...extra })
      const client = await connect({ access: 'write', allow: ['Projects'] })
      await ok(client, 'rename_asset', { path: 'Projects/a.png', name: 'b.png' })
      return await file('Projects/N.md')
    }
    const alone = await run({})
    const beside = await run({ 'Journal/b.png': 'hidden' })
    expect(beside).toBe(alone)
    expect(alone).toBe('![[Projects/b.png]]\n')
  })

  it('keeps a bare name for a client with no paths in its scope', async () => {
    await seed({ 'Projects/a.png': 'a', 'Projects/N.md': '![[a.png]]\n' })
    const client = await connect()
    await ok(client, 'rename_asset', { path: 'Projects/a.png', name: 'b.png' })
    expect(await file('Projects/N.md')).toBe('![[b.png]]\n')
  })
})

describe('daily_note under a path scope', () => {
  const SETTINGS = '{"primaryNotesLocation":"root","dailyNotes":{"enabled":true,"directory":"Days"}}'
  const NOT_SHARED = "This note's folder is not shared with this assistant, so it cannot be created here."

  it('says it cannot create a note in a folder the client cannot see', async () => {
    await seed({ '.zennotes/vault.json': SETTINGS, 'Projects/P.md': '# P\n' })
    const client = await connect({ access: 'write', allow: ['Projects'] })
    const answer = await ok(client, 'daily_note', { date: '2026-01-02' })
    expect(answer).not.toContain('Days')
    expect(JSON.parse(answer)).toMatchObject({ exists: false, cannotCreate: NOT_SHARED })
    expect(JSON.parse(answer)).not.toHaveProperty('createWith')
  })

  it('says so when only the note itself is hidden', async () => {
    await seed({ '.zennotes/vault.json': SETTINGS, 'Days/old.md': '# old\n' })
    const client = await connect({ access: 'write', allow: ['Days/old.md'] })
    expect(JSON.parse(await ok(client, 'daily_note', { date: '2026-01-02' }))).toMatchObject({ cannotCreate: NOT_SHARED })
  })

  it('offers to create one it can see', async () => {
    await seed({ '.zennotes/vault.json': SETTINGS, 'Days/old.md': '# old\n' })
    const client = await connect({ access: 'write', allow: ['Days'] })
    expect(JSON.parse(await ok(client, 'daily_note', { date: '2026-01-02' })).createWith.subpath).toBe('Days')
  })

  it('treats the root as shared when no allow list narrows it', async () => {
    const root_ = '{"primaryNotesLocation":"root","dailyNotes":{"enabled":true,"directory":""}}'
    await seed({ '.zennotes/vault.json': root_, 'P.md': '# P\n', 'J/H.md': '# H\n' })
    const deny = await connect({ access: 'write', deny: ['J'] })
    expect(JSON.parse(await ok(deny, 'daily_note', { date: '2026-01-02' }))).toHaveProperty('createWith')
  })
})

describe('a destination whose name other systems read differently', () => {
  it.each(['Target.', 'Target ./Sub', 'Tar:get', 'Target. /x', 'Sub/Target.'])('refuses %j as a new folder', async (targetDir) => {
    await seed({ 'assets/a.png': 'a' })
    const client = await connect()
    expect(await refused(client, 'move_asset', { path: 'assets/a.png', targetDir })).toContain(
      'This assistant cannot put files there.'
    )
    expect(await file('assets/a.png')).toBe('a')
  })

  const real = process.platform === 'win32' ? ['Clients/Acme Inc.', 'v1.'] : ['Clients/Acme Inc.', 'v1.', 'Notes: 2026']

  it.each(real)('takes %j, a folder that already exists', async (targetDir) => {
    await seed({ 'assets/a.png': 'a', [`${targetDir}/keep.txt`]: 'k' })
    const client = await connect()
    expect(JSON.parse(await ok(client, 'move_asset', { path: 'assets/a.png', targetDir }))).toMatchObject({
      path: `${targetDir}/a.png`
    })
  })

  it('applies the rule under a scope only once the path is visible', async () => {
    await seed({ 'Open/a.png': 'a', 'Open/v1./keep.txt': 'k', 'Journal/J.md': '# J\n' })
    const client = await connect({ access: 'write', allow: ['Open'] })
    expect(await refused(client, 'move_asset', { path: 'Open/a.png', targetDir: 'Open/new.' })).toContain(
      'This assistant can put files only inside: Open.'
    )
    expect(await exists('Open/new.')).toBe(false)
    expect(JSON.parse(await ok(client, 'move_asset', { path: 'Open/a.png', targetDir: 'Open/v1.' }))).toMatchObject({
      path: 'Open/v1./a.png'
    })
  })
})

describe('what a move answers about a path it may not see', () => {
  it('is the same whatever is there', async () => {
    await seed({
      '.zennotes/vault.json': '{"primaryNotesLocation":"root","systemFolderPaths":{"trash":"Binned"}}',
      'Open/a.png': 'a',
      'Journal/Diary.md': '# D\n',
      'Binned/Old.md': '# O\n'
    })
    const client = await connect({ access: 'write', allow: ['Open'] })
    for (const targetDir of ['Journal/Diary.md/x', 'Journal/Nope.md/x', 'Journal', 'Binned', 'Binned/x', 'Nowhere']) {
      expect(await refused(client, 'move_asset', { path: 'Open/a.png', targetDir })).toBe(
        'Error: This assistant can put files only inside: Open.'
      )
    }
    expect(await file('Open/a.png')).toBe('a')
  })

  it('does not look under a hidden path on the disk', async () => {
    await seed({ 'Open/a.png': 'a', 'Journal/Diary.md': '# D\n' })
    const client = await connect({ access: 'write', allow: ['Open'] })
    const lstat = vi.spyOn(fsp, 'lstat')
    await refused(client, 'move_asset', { path: 'Open/a.png', targetDir: 'Journal/Diary.md/x' })
    expect(lstat.mock.calls.map(([p]) => String(p)).filter((p) => p.includes('Diary.md/x'))).toEqual([])
    expect(lstat.mock.calls.map(([p]) => String(p)).filter((p) => p.endsWith(path.join('Journal', 'Diary.md', 'x')))).toEqual([])
  })
})

describe('a move through a folder link', () => {
  it('is refused for a client with no scope too', async () => {
    await seed({ 'assets/a.png': 'a', 'Real/keep.txt': 'k' })
    await fsp.symlink('Real', inVault('Alias'))
    const client = await connect()
    expect(await refused(client, 'move_asset', { path: 'assets/a.png', targetDir: 'Alias' })).toContain(
      'This assistant cannot put files there.'
    )
    expect(await file('assets/a.png')).toBe('a')
  })
})

describe('a folder a wikilink cannot name', () => {
  const FOLDER = 'Issue #5'

  it('encodes it in a Markdown link', async () => {
    await seed({ 'assets/a.png': 'a', 'N.md': '![x](assets/a.png)\n', [`${FOLDER}/keep.txt`]: 'k' })
    const client = await connect()
    await ok(client, 'move_asset', { path: 'assets/a.png', targetDir: FOLDER })
    expect(await file('N.md')).toBe('![x](<Issue %235/a.png>)\n')
  })

  it('keeps a bare wikilink where that resolves', async () => {
    await seed({ 'assets/a.png': 'a', 'N.md': '![[assets/a.png]]\n', [`${FOLDER}/keep.txt`]: 'k' })
    const client = await connect()
    const moved = JSON.parse(await ok(client, 'move_asset', { path: 'assets/a.png', targetDir: FOLDER }))
    expect(await file('N.md')).toBe('![[a.png]]\n')
    expect(moved).not.toHaveProperty('linksNotUpdated')
  })

  it('leaves a wikilink as it was where a bare name is ambiguous, and says so', async () => {
    await seed({
      'assets/a.png': 'a',
      'Other/a.png': 'other',
      'N.md': '![[assets/a.png]]\n',
      [`${FOLDER}/keep.txt`]: 'k'
    })
    const client = await connect()
    const moved = JSON.parse(await ok(client, 'move_asset', { path: 'assets/a.png', targetDir: FOLDER }))
    expect(await file('N.md')).toBe('![[assets/a.png]]\n')
    expect(moved.linksNotUpdated).toEqual(['N.md'])
  })

  it('always keeps the bare name under a path scope', async () => {
    await seed({
      'Open/a.png': 'a',
      'Open/N.md': '![[Open/a.png]]\n',
      [`Open/${FOLDER}/keep.txt`]: 'k',
      'Hid/a.png': 'hidden'
    })
    const client = await connect({ access: 'write', allow: ['Open'] })
    const moved = JSON.parse(await ok(client, 'move_asset', { path: 'Open/a.png', targetDir: `Open/${FOLDER}` }))
    expect(await file('Open/N.md')).toBe('![[a.png]]\n')
    expect(moved).not.toHaveProperty('linksNotUpdated')
  })
})

describe('a wikilink under a filter', () => {
  it('is read as naming visible notes only', async () => {
    await seed({ 'Open/Plan': 'data', 'Open/N.md': '![[Plan]]\n', 'Hid/Plan.md': '# Hidden note\n' })
    const client = await connect({ access: 'write', allow: ['Open'] })
    await ok(client, 'rename_asset', { path: 'Open/Plan', name: 'Other' })
    expect(await file('Open/N.md')).toBe('![[Open/Other]]\n')
  })
})

describe('a restore under a scope', () => {
  it('undoes a number that lands out of view', async () => {
    const token = '11111111-1111-4111-8111-111111111111'
    await seed({
      'Open/x.png': 'x',
      [`.zennotes/deleted-assets/${token}/.zn-deleted.json`]: JSON.stringify({
        path: 'Open/x.png',
        name: 'x.png',
        deletedAt: '2026-01-01T00:00:00.000Z'
      }),
      [`.zennotes/deleted-assets/${token}/x.png`]: 'old'
    })
    const client = await connect({ access: 'write', allow: ['Open/x.png'] })
    expect(await refused(client, 'restore_asset', { undoToken: token })).toContain(`Deleted asset not found: ${token}`)
    expect(await fsp.readdir(inVault('Open'))).toEqual(['x.png'])
    expect(await file('Open/x.png')).toBe('x')
  })
})

describe('a finished task note', () => {
  it('keeps the day it was finished when marked done again', async () => {
    const NOTE = 'Do.md'
    const body = '---\ntags: [task]\nstatus: done\ncompletedDate: 2026-01-01\n---\n# Do\n'
    await seed({ [NOTE]: body })
    const client = await connect()
    await ok(client, 'update_task', { id: `${NOTE}#task`, state: 'done' })
    expect(await file(NOTE)).toBe(body)
  })
})

describe('a database pair spelled another way', () => {
  it('is still a pair', async () => {
    await seed({ 'Data/T.csv': 'a\n', 'Data/t.csv.base.json': '{}' })
    const client = await connect()
    expect(await refused(client, 'delete_asset', { path: 'Data/T.csv' })).toContain('belongs to a ZenNotes database')
  })
})

describe('a drawing beside the notes', () => {
  it('is not reported as a note whose links could not be updated', async () => {
    await seed({ 'assets/a.png': 'a', 'Sketch.excalidraw': '{}', 'N.md': '![[assets/a.png]]\n' })
    const client = await connect()
    expect(JSON.parse(await ok(client, 'rename_asset', { path: 'assets/a.png', name: 'b.png' }))).not.toHaveProperty(
      'linksNotUpdated'
    )
  })
})

describe('a database pair under a scope', () => {
  it('stays a pair when the schema file is hidden', async () => {
    await seed({ 'Data/t.csv': 'a\n', 'Data/t.csv.base.json': '{}', 'N.md': '# N\n' })
    const client = await connect({ access: 'write', deny: ['Data/t.csv.base.json'] })
    for (const [tool, args] of [
      ['rename_asset', { path: 'Data/t.csv', name: 'u.csv' }],
      ['move_asset', { path: 'Data/t.csv', targetDir: 'Elsewhere' }],
      ['delete_asset', { path: 'Data/t.csv' }]
    ] as const) {
      expect(await refused(client, tool, args)).toContain('belongs to a ZenNotes database')
    }
    expect(await file('Data/t.csv')).toBe('a\n')
  })
})

describe('a deleted asset record', () => {
  it.each(['.ZENNOTES/evil.json', '.zennotes/evil.json', '.hidden/x.png', 'a/../../x.png'])(
    'that names %s is not listed and does not restore',
    async (target) => {
      const token = '11111111-1111-4111-8111-111111111111'
      await seed({
        [`.zennotes/deleted-assets/${token}/.zn-deleted.json`]: JSON.stringify({
          path: target,
          name: 'evil.json',
          deletedAt: '2026-01-01T00:00:00.000Z'
        }),
        [`.zennotes/deleted-assets/${token}/evil.json`]: 'evil'
      })
      expect(await listDeletedAssets(root)).toEqual([])
      const backend = createBackend({ kind: 'local', root })
      await expect(
        backend.restoreDeletedAsset({ path: target, name: 'evil.json', undoToken: token, deletedAt: '' })
      ).rejects.toThrow()
      expect(await exists('.ZENNOTES/evil.json')).toBe(false)
    }
  )
})

describe('the trash as a move target', () => {
  it('stays refused through a link to it', async () => {
    await seed({ 'assets/a.png': 'a', 'trash/Old.md': '# Old\n' })
    await fsp.symlink('trash', inVault('bin-link'))
    await fsp.mkdir(inVault('Real'))
    await fsp.symlink('../trash', inVault('Real/in'))
    const client = await connect()
    for (const targetDir of ['bin-link', 'bin-link/deep', 'Real/in']) {
      expect(await refused(client, 'move_asset', { path: 'assets/a.png', targetDir })).toContain(
        'This assistant cannot put files there.'
      )
    }
    expect(await file('assets/a.png')).toBe('a')
    expect(await fsp.readdir(inVault('trash'))).toEqual(['Old.md'])
  })
})

describe('rename edges', () => {
  it('treats a hard link of the file under another name as taken', async () => {
    await seed({ 'assets/a.png': 'a' })
    await fsp.link(inVault('assets/a.png'), inVault('assets/b.png'))
    await expect(renameAsset(root, 'assets/a.png', 'b.png')).rejects.toThrow('already exists')
    expect((await fsp.readdir(inVault('assets'))).sort()).toEqual(['a.png', 'b.png'])
  })

  it('treats a link at the destination as taken, even one to nothing', async () => {
    await seed({ 'assets/a.png': 'a', 'assets/t.png': 't' })
    await fsp.symlink('t.png', inVault('assets/live.png'))
    await fsp.symlink('gone.png', inVault('assets/dead.png'))
    for (const name of ['live.png', 'dead.png']) {
      await expect(renameAsset(root, 'assets/a.png', name)).rejects.toThrow('already exists')
    }
    expect(await fsp.readlink(inVault('assets/dead.png'))).toBe('gone.png')
    expect(await file('assets/a.png')).toBe('a')
  })

  it('leaves no scratch file after changing only the case', async () => {
    await seed({ 'assets/a.png': 'a' })
    const meta = await renameAsset(root, 'assets/a.png', 'A.png')
    expect(meta.name).toBe('A.png')
    expect(await fsp.readdir(inVault('assets'))).toEqual(['A.png'])
  })

  it('does nothing to a file moved to its own folder, however the folder is spelled', async () => {
    await seed({ 'assets/a.png': 'a' })
    const sensitive = !(await exists('ASSETS'))
    const client = await connect()
    const moved = JSON.parse(await ok(client, 'move_asset', { path: 'assets/a.png', targetDir: 'ASSETS' })) as {
      path: string
    }
    if (sensitive) expect(moved.path).toBe('ASSETS/a.png')
    else expect(moved.path).toBe('assets/a.png')
  })
})

describe('a heading with nothing after its #s', () => {
  it('reads the line under it', () => {
    const body = '#   \nfirst\nsecond\n## Next\nmore\n'
    expect(noteSections(body).map((section) => section.lineNumber)).toEqual([0, 3])
    expect(sectionBody(body, findSection(body, '#')).split('\n')[0]).toBe('first')
  })
})

describe('list_assets', () => {
  it('keeps going past a folder it cannot read', async () => {
    await seed({ 'Good/a.png': 'a', 'Bad/b.png': 'b' })
    const readdir = fsp.readdir.bind(fsp)
    vi.spyOn(fsp, 'readdir').mockImplementation((async (dir: string, options?: never) => {
      if (dir === inVault('Bad')) throw Object.assign(new Error('bad disk'), { code: 'EIO' })
      return await readdir(dir, options)
    }) as never)
    expect((await listAssets(root)).map((a) => a.path)).toEqual(['Good/a.png'])
  })

  it("leaves out a database's schema file and backups, and still knows the pair", async () => {
    await seed({ 'Data/t.csv': 'a\n', 'Data/t.csv.base.json': '{}', 'Data/t.csv.bak': 'a\n', 'Data/keep.png': 'k' })
    const client = await connect()
    const paths = (JSON.parse(await ok(client, 'list_assets', {})) as { path: string }[]).map((a) => a.path)
    expect(paths.sort()).toEqual(['Data/keep.png', 'Data/t.csv'])
    expect(await refused(client, 'delete_asset', { path: 'Data/t.csv' })).toContain('belongs to a ZenNotes database')
  })

  it('says it lists the whole vault', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.find((tool) => tool.name === 'list_assets')?.description).not.toContain(
      'attachments directory'
    )
  })
})

describe('agent edit review under a scope', () => {
  it("records an edit under the note's own spelling", async () => {
    await seed({ 'Projects/Plan.md': '# Plan\n\n## A\n\none\n', 'Journal/J.md': '# J\n' })
    const client = await connect({ access: 'write', deny: ['Journal'] })
    await ok(client, 'edit_section', { path: 'PROJECTS/PLAN.MD', heading: 'A', mode: 'append', text: 'two' })
    expect(await readAgentEditRecord(root, 'Projects/Plan.md')).not.toBeNull()
    expect(await fsp.readdir(inVault('.zennotes/agent-edits'))).toEqual(['Projects'])
  })
})

describe('a link rewrite beside a note edit', () => {
  const asset = (name: string): string => `assets/${name}.png`

  it.each([
    ['append_to_note', (i: number) => ({ path: 'n.md', text: `marker${i}` })],
    ['edit_section', (i: number) => ({ path: 'n.md', heading: 'H', mode: 'append', text: `marker${i}` })],
    ['update_task', (i: number) => ({ id: 'n.md#0', text: `marker${i}` })]
  ] as const)('keeps both when %s runs in the same batch', async (tool, args) => {
    const client = await connect()
    await seed({ 'assets/keep.png': 'k' })
    for (let i = 0; i < 25; i += 1) {
      const from = `a${i}`
      const to = `b${i}`
      await seed({ [asset(from)]: 'x', 'n.md': `# H\n\n- [ ] task\n\n![[${asset(from)}]]\n` })
      const results = await Promise.all([
        call(client, 'rename_asset', { path: asset(from), name: `${to}.png` }),
        call(client, tool, args(i))
      ])
      expect(results.map((result) => result.isError)).toEqual([false, false])
      const body = await file('n.md')
      expect(body).toContain(`marker${i}`)
      expect(body).toContain(`![[${asset(to)}]]`)
    }
  })

  it('lets other asset calls go while it reads the notes', async () => {
    await seed({ 'assets/a.png': 'a', 'n.md': '![[assets/a.png]]\n' })
    const client = await connect()
    const readFile = fsp.readFile.bind(fsp)
    let release: () => void = () => undefined
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let rewriting: () => void = () => undefined
    const reached = new Promise<void>((resolve) => {
      rewriting = resolve
    })
    // Once the file has moved, a read of the note is the link rewrite.
    vi.spyOn(fsp, 'readFile').mockImplementation((async (p: string, options: never) => {
      if (p === inVault('n.md') && (await exists('assets/b.png'))) {
        rewriting()
        await hold
      }
      return await readFile(p, options)
    }) as never)
    const renaming = call(client, 'rename_asset', { path: 'assets/a.png', name: 'b.png' })
    await reached
    const answered = await Promise.race([
      call(client, 'upload_asset', { filename: 'u.png', content_base64: 'cG5n' }).then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 1000))
    ])
    release()
    await renaming
    expect(answered).toBe('answered')
    expect(await file('n.md')).toBe('![[assets/b.png]]\n')
  })
})

describe('a change of case that fails', () => {
  it('leaves the file under its old name', async () => {
    await seed({ 'assets/Photo.png': 'P' })
    if (!(await exists('assets/photo.png'))) return // a case-sensitive volume has no such rename
    const rename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation((async (from: string, to: string) => {
      if (from.endsWith('.tmp') && to.endsWith('photo.png')) {
        throw Object.assign(new Error('locked'), { code: 'EBUSY' })
      }
      return await rename(from, to)
    }) as never)
    await expect(renameAsset(root, 'assets/Photo.png', 'photo.png')).rejects.toThrow('locked')
    expect(await fsp.readdir(inVault('assets'))).toEqual(['Photo.png'])
  }, 20000)
})

describe('a name upload_asset would write', () => {
  it('passes the same check once it is cleaned', async () => {
    await seed({ 'd.csv': 'a\n' })
    const client = await connect()
    expect(await refused(client, 'upload_asset', { filename: 'd.csv.base.json .', content_base64: 'cG5n' })).toContain(
      'cannot be managed as an attachment'
    )
    expect(await refused(client, 'upload_asset', { filename: 'note?.md', content_base64: 'cG5n' })).toContain(
      'Notes are not attachments'
    )
    expect(await exists('assets')).toBe(false)
  })
})

describe('a move target with whitespace around it', () => {
  it.each([' .hidden', ' Target', 'Target ', 'db.base '])('refuses %j for any client', async (targetDir) => {
    await seed({ 'assets/a.png': 'a' })
    const client = await connect()
    expect(await refused(client, 'move_asset', { path: 'assets/a.png', targetDir })).toContain(
      'This assistant cannot put files there.'
    )
    expect(await file('assets/a.png')).toBe('a')
    expect(await exists('.hidden')).toBe(false)
  })
})

describe('a read-only note', () => {
  it('stays as it is, whichever tool writes', async () => {
    await seed({ 'N.md': 'old\n' })
    await fsp.chmod(inVault('N.md'), 0o444)
    await expect(writeNote(root, 'N.md', 'new\n')).rejects.toThrow()
    expect(await file('N.md')).toBe('old\n')
    await fsp.chmod(inVault('N.md'), 0o644)
  })
})

describe('a move under another spelling', () => {
  it('writes the folder as the listing spells it', async () => {
    await seed({ 'Caf\u00e9/keep.txt': 'k', 'pub/n.png': 'z', 'N.md': '![[pub/n.png]]\n' })
    const client = await connect()
    const insensitive = await exists('CAF\u00c9')
    const moved = JSON.parse(await ok(client, 'move_asset', { path: 'pub/n.png', targetDir: 'CAF\u00c9' })) as { path: string }
    const want = insensitive ? 'Caf\u00e9/n.png' : 'CAF\u00c9/n.png'
    expect(moved.path).toBe(want)
    expect(await file('N.md')).toBe(`![[${want}]]\n`)
    const listed = (await listAssets(root)).map((asset) => asset.path)
    expect(listed).toContain(want)
  })
})

describe('a wikilink with an anchor', () => {
  it('stays when it names a note', async () => {
    await seed({ 'Report.md': '# Report\n', 'Docs/Report': 'data', 'N.md': '[[Report#Heading]] and [[Report^block]]\n' })
    const client = await connect()
    await ok(client, 'rename_asset', { path: 'Docs/Report', name: 'Renamed' })
    expect(await file('N.md')).toBe('[[Report#Heading]] and [[Report^block]]\n')
  })
})

describe('a deleted record written by hand', () => {
  const token = '11111111-1111-4111-8111-111111111111'
  const record = async (target: string): Promise<void> => {
    await seed({
      'pub/sec/keep.txt': 'k',
      'pub/ok.png': 'k',
      [`.zennotes/deleted-assets/${token}/.zn-deleted.json`]: JSON.stringify({
        path: target,
        name: 'r.png',
        deletedAt: '2026-01-01T00:00:00.000Z'
      }),
      [`.zennotes/deleted-assets/${token}/r.png`]: 'x'
    })
  }

  it.each(['pub\\sec\\r.png', 'pub/sec\\r.png', ' pub/sec/r.png'])('is hidden by its real path: %j', async (target) => {
    await record(target)
    const client = await connect({ access: 'write', deny: ['pub/sec'] })
    expect(JSON.parse(await ok(client, 'list_assets', { deleted: true }))).toEqual([])
    expect(await refused(client, 'restore_asset', { undoToken: token })).toContain('Deleted asset not found')
    expect(await fsp.readdir(inVault('pub/sec'))).toEqual(['keep.txt'])
  })
})

describe('update_task on a Windows task note', () => {
  it('keeps its line endings', async () => {
    const NOTE = 'Do.md'
    await seed({ [NOTE]: '---\r\ntags: [task]\r\nstatus: open\r\n---\r\n# Do\r\n\r\nbody\r\n' })
    const client = await connect()
    await ok(client, 'update_task', { id: `${NOTE}#task`, due: '2026-01-01' })
    const body = await file(NOTE)
    expect(body).toContain('due: 2026-01-01\r\n')
    expect(body.replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('linksNotUpdated', () => {
  it('names a note it could not read, which may still use the old name', async () => {
    await seed({ 'assets/a.png': 'a', 'Locked.md': '![[assets/a.png]]\n', 'Good.md': '![[assets/a.png]]\n' })
    const client = await connect()
    const readFile = fsp.readFile.bind(fsp)
    vi.spyOn(fsp, 'readFile').mockImplementation((async (p: string, options: never) => {
      if (p === inVault('Locked.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return await readFile(p, options)
    }) as never)
    const moved = JSON.parse(await ok(client, 'rename_asset', { path: 'assets/a.png', name: 'b.png' })) as {
      linksNotUpdated?: string[]
    }
    expect(moved.linksNotUpdated).toEqual(['Locked.md'])
    expect(await file('Good.md')).toBe('![[assets/b.png]]\n')
  })

  it('leaves out a note a path scope hides, read or not', async () => {
    await seed({ 'Projects/a.png': 'a', 'Projects/N.md': '![[a.png]]\n', 'Journal/J.md': '![[Projects/a.png]]\n' })
    const client = await connect({ access: 'write', allow: ['Projects'] })
    const readFile = fsp.readFile.bind(fsp)
    vi.spyOn(fsp, 'readFile').mockImplementation((async (p: string, options: never) => {
      if (p === inVault('Journal/J.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return await readFile(p, options)
    }) as never)
    const moved = await ok(client, 'rename_asset', { path: 'Projects/a.png', name: 'b.png' })
    expect(moved).not.toContain('linksNotUpdated')
    expect(moved).not.toContain('Journal')
  })
})

describe('a move across volumes', () => {
  const crossVolume = (): void => {
    vi.spyOn(fsp, 'link').mockRejectedValue(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }))
  }

  it('keeps the modified time', async () => {
    await seed({ 'a/z.png': 'z' })
    const old = new Date('2020-01-01T00:00:00Z')
    await fsp.utimes(inVault('a/z.png'), old, old)
    crossVolume()
    await createBackend({ kind: 'local', root }).moveAsset('a/z.png', 'b')
    expect((await fsp.stat(inVault('b/z.png'))).mtime.toISOString()).toBe(old.toISOString())
    expect(await exists('a/z.png')).toBe(false)
  })

  it('leaves no partial copy when the copy fails', async () => {
    await seed({ 'a/z.png': 'z' })
    crossVolume()
    vi.spyOn(fsp, 'copyFile').mockImplementation((async (_from: string, to: string) => {
      await fsp.writeFile(to, 'pa')
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
    }) as never)
    await expect(createBackend({ kind: 'local', root }).moveAsset('a/z.png', 'b')).rejects.toThrow('no space')
    expect(await exists('b/z.png')).toBe(false)
    expect(await file('a/z.png')).toBe('z')
  })
})

describe('duplicate_asset under a scope', () => {
  it('undoes a copy that lands outside what it can see', async () => {
    await seed({ 'pub/x.png': 'x', 'pub/x copy.png': 'c', 'pub/y.png': 'y' })
    const client = await connect({ access: 'write', allow: ['pub/x.png', 'pub/x copy.png'] })
    expect(await refused(client, 'duplicate_asset', { path: 'pub/x.png' })).toContain(
      'This assistant cannot give the file that name.'
    )
    expect((await fsp.readdir(inVault('pub'))).sort()).toEqual(['x copy.png', 'x.png', 'y.png'])
  })
})

describe('writeFileAtomic', () => {
  it('leaves no scratch file when closing fails', async () => {
    await seed({ 'N.md': 'old\n' })
    const open = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation((async (p: string, flags: string) => {
      const handle = await open(p, flags)
      if (!p.startsWith(inVault('N.md'))) return handle
      const close = handle.close.bind(handle)
      handle.close = (async () => {
        await close()
        throw Object.assign(new Error('close failed'), { code: 'EIO' })
      }) as never
      return handle
    }) as never)
    await expect(writeNote(root, 'N.md', 'new\n')).rejects.toThrow('close failed')
    vi.restoreAllMocks()
    expect(await file('N.md')).toBe('old\n')
    expect((await fsp.readdir(root)).filter((name) => name.startsWith('N.md.'))).toEqual([])
  })
})
