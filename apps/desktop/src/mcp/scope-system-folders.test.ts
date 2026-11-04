import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newMcpScope, type McpScopeFlags } from '@shared/mcp-scope'
import { runMcpServer } from './server'
import { sanitizeTitle } from './vault-ops'

// What a path scope hides when a note moves between system folders, what an allow
// entry's accents mean, where a copy lands, and the names create_note picks.

let root: string
const clients: Client[] = []

const ROOT_LAYOUT = '{"primaryNotesLocation":"root"}'
const INBOX_LAYOUT = '{"primaryNotesLocation":"inbox"}'

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, body)
  }
}

const exists = (rel: string): Promise<boolean> =>
  fsp.lstat(path.join(root, ...rel.split('/'))).then(
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

async function expectHidden(client: Client, rel: string): Promise<void> {
  const read = await call(client, 'read_note', { path: rel })
  expect(read.isError, rel).toBe(true)
  expect(read.text).toContain('Note not found')
}

async function expectShared(client: Client, rel: string): Promise<void> {
  const read = await call(client, 'read_note', { path: rel })
  expect(read.isError, `${rel}: ${read.text}`).toBe(false)
}

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-scope-folders-')))
  vi.stubEnv('ZENNOTES_CONFIG_DIR', path.join(root, '.config-for-test'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await fsp.rm(root, { recursive: true, force: true })
})

describe('a deny entry and the other system folders', () => {
  const INBOX_VAULT = {
    '.zennotes/vault.json': INBOX_LAYOUT,
    'inbox/Journal/d.md': 'live',
    'archive/Journal/s.md': 'archived',
    'trash/Journal/t.md': 'trashed',
    'quick/Q/n.md': 'quick',
    'archive/Q/q.md': 'archived quick',
    'archive/AJ/x.md': 'archived',
    'trash/AJ/a.md': 'trashed',
    'inbox/Journal2/n.md': 'shared',
    'archive/Journal2/k.md': 'shared',
    'inbox/Projects/Journal/n.md': 'shared',
    'archive/Projects/Journal/k.md': 'shared'
  }

  it.each([
    ['INBOX/journal', 'archive/Journal/s.md'],
    ['INBOX/journal', 'trash/Journal/t.md'],
    ['inbox/Journal', 'inbox/Journal/d.md'],
    ['quick/Q', 'archive/Q/q.md'],
    ['QUICK/q', 'archive/Q/q.md'],
    ['archive/AJ', 'trash/AJ/a.md'],
    ['Archive/aj', 'trash/AJ/a.md']
  ])('%s hides %s', async (deny, hidden) => {
    await seed(INBOX_VAULT)
    await expectHidden(await connect({ access: 'read', deny: [deny] }), hidden)
  })

  it.each([
    'inbox/Journal2/n.md',
    'archive/Journal2/k.md',
    'inbox/Projects/Journal/n.md',
    'archive/Projects/Journal/k.md'
  ])('INBOX/journal leaves %s shared', async (shared) => {
    await seed(INBOX_VAULT)
    await expectShared(await connect({ access: 'read', deny: ['INBOX/journal'] }), shared)
  })

  it('leaves it out of a listing and a search too', async () => {
    await seed({ ...INBOX_VAULT, 'archive/Journal/s.md': 'findme' })
    const client = await connect({ access: 'read', deny: ['INBOX/journal'] })
    expect((await call(client, 'list_notes', { folder: 'archive' })).text).not.toContain('Journal/s.md')
    expect((await call(client, 'search_text', { query: 'findme' })).text).not.toContain('Journal/s.md')
  })

  it("goes by the entry's own wording in a vault that keeps notes at its root", async () => {
    await seed({
      '.zennotes/vault.json': ROOT_LAYOUT,
      'Journal/Day.md': 'live',
      'archive/Journal/Old.md': 'archived',
      'trash/Journal/Gone.md': 'trashed',
      'archive/Other.md': 'other',
      'Keep/Note.md': 'keep',
      'trash/Keep/Bin.md': 'binned'
    })
    const client = await connect({ access: 'read', deny: ['Journal', 'trash/Keep'] })
    for (const rel of [
      'Journal/Day.md',
      'archive/Journal/Old.md',
      'trash/Journal/Gone.md',
      'trash/Keep/Bin.md'
    ]) {
      await expectHidden(client, rel)
    }
    for (const rel of ['archive/Other.md', 'Keep/Note.md']) await expectShared(client, rel)
  })

  it('follows a system folder under the name it was moved to', async () => {
    await seed({
      '.zennotes/vault.json':
        '{"primaryNotesLocation":"root","systemFolderPaths":{"archive":"99 Archive","trash":"Binned"}}',
      'Journal/Day.md': 'live',
      '99 Archive/Journal/Old.md': 'archived',
      'Binned/Journal/Gone.md': 'trashed',
      'archive/Journal/Mine.md': 'an ordinary folder here',
      '99 Archive/AJ/x.md': 'archived',
      'Binned/AJ/a.md': 'trashed'
    })
    const journal = await connect({ access: 'read', deny: ['Journal'] })
    await expectHidden(journal, '99 Archive/Journal/Old.md')
    await expectHidden(journal, 'Binned/Journal/Gone.md')
    // Under a moved archive, archive/ is a folder like any other.
    await expectShared(journal, 'archive/Journal/Mine.md')
    const named = await connect({ access: 'read', deny: ['99 ARCHIVE/aj'] })
    await expectHidden(named, 'Binned/AJ/a.md')
  })

  it('says nothing when the entry names a system folder itself', async () => {
    await seed({
      '.zennotes/vault.json': ROOT_LAYOUT,
      'archive/Old.md': 'archived',
      'trash/Gone.md': 'trashed',
      'Keep.md': 'keep'
    })
    const client = await connect({ access: 'read', deny: ['archive'] })
    await expectHidden(client, 'archive/Old.md')
    await expectShared(client, 'trash/Gone.md')
    await expectShared(client, 'Keep.md')
  })

  it('refuses a new note in the same folder under another system folder', async () => {
    await seed(INBOX_VAULT)
    const client = await connect({ access: 'write', deny: ['INBOX/journal'] })
    const refused = await call(client, 'create_note', {
      title: 'New',
      folder: 'quick',
      subpath: 'Journal'
    })
    expect(refused.isError, refused.text).toBe(true)
    expect(refused.text).toContain('This assistant cannot put notes there.')
    expect(await exists('quick/Journal/New.md')).toBe(false)
  })

  it.each([
    ['delete_folder', 'delete', { folder: 'archive', subpath: 'Journal', confirm: true }],
    ['rename_folder', 'rename', { folder: 'archive', oldSubpath: 'Journal', newSubpath: 'Elsewhere' }]
  ])(
    '%s leaves alone a folder holding what an entry hides in another system folder',
    async (tool, verb, args) => {
      await seed({
        '.zennotes/vault.json': ROOT_LAYOUT,
        'Journal/secret.md': 'live',
        'Journal/open.md': 'shared',
        'archive/Journal/secret.md': 'hidden',
        'archive/Journal/open.md': 'shared'
      })
      const client = await connect({ access: 'write', deny: ['Journal/secret.md'] })
      const refused = await call(client, tool, args)
      expect(refused.isError, refused.text).toBe(true)
      expect(refused.text).toContain(`This assistant cannot ${verb} that folder.`)
      expect(await exists('archive/Journal/secret.md')).toBe(true)
    }
  )

  it('still deletes a folder under another system folder when it holds nothing hidden', async () => {
    await seed({
      '.zennotes/vault.json': ROOT_LAYOUT,
      'Journal/secret.md': 'live',
      'archive/Other/open.md': 'shared'
    })
    const client = await connect({ access: 'write', deny: ['Journal/secret.md'] })
    const deleted = await call(client, 'delete_folder', {
      folder: 'archive',
      subpath: 'Other',
      confirm: true
    })
    expect(deleted.isError, deleted.text).toBe(false)
    expect(await exists('archive/Other')).toBe(false)
  })
})

describe('an allow entry and accents', () => {
  const VAULT = { '.zennotes/vault.json': ROOT_LAYOUT, 'Cafe/Menu.md': 'plain' }

  it('with accents does not match a folder without them', async () => {
    await seed(VAULT)
    const client = await connect({ access: 'read', allow: ['Café'] })
    await expectHidden(client, 'Cafe/Menu.md')
    expect((await call(client, 'vault_info', {})).text).toContain('Café')
  })

  it('without accents still finds a folder that has them', async () => {
    await seed({ '.zennotes/vault.json': ROOT_LAYOUT, 'Café/Menu.md': 'accented' })
    await expectShared(await connect({ access: 'read', allow: ['cafe'] }), 'Café/Menu.md')
  })

  it('without accents matches a folder without them', async () => {
    await seed(VAULT)
    await expectShared(await connect({ access: 'read', allow: ['cafe'] }), 'Cafe/Menu.md')
  })

  it('with the same accents matches, in any case and either Unicode form', async () => {
    await seed({ '.zennotes/vault.json': ROOT_LAYOUT, 'Café/Menu.md': 'accented' })
    const upper = await connect({ access: 'read', allow: ['CAFÉ'] })
    await expectShared(upper, 'Café/Menu.md')
    const decomposed = await connect({ access: 'read', allow: ['Café'] })
    await expectShared(decomposed, 'Café/Menu.md')
  })

  it('leaves a deny entry matching either way', async () => {
    await seed(VAULT)
    const client = await connect({ access: 'read', deny: ['Café'] })
    // Nothing has that exact name, and a near miss over-hides.
    await expectHidden(client, 'Cafe/Menu.md')
  })
})

describe('duplicate_note under a scope', () => {
  it('refuses a copy that would land outside an entry naming one note', async () => {
    await seed({ '.zennotes/vault.json': ROOT_LAYOUT, 'Pub/a.md': 'body', 'Pub/b.md': 'other' })
    const client = await connect({ access: 'write', allow: ['Pub/a.md'] })
    const refused = await call(client, 'duplicate_note', { path: 'Pub/a.md' })
    expect(refused.isError, refused.text).toBe(true)
    expect(refused.text).toContain('This assistant cannot give the note that name.')
    expect(await exists('Pub/a copy.md')).toBe(false)
  })

  it('refuses a copy whose name a deny entry hides', async () => {
    await seed({ '.zennotes/vault.json': ROOT_LAYOUT, 'a.md': 'body', 'a copy.md': 'hidden' })
    const client = await connect({ access: 'write', deny: ['a copy.md'] })
    const refused = await call(client, 'duplicate_note', { path: 'a.md' })
    expect(refused.isError, refused.text).toBe(true)
    expect(await exists('a copy 2.md')).toBe(false)
  })

  it('takes back a numbered copy that lands outside what the client sees', async () => {
    await seed({ '.zennotes/vault.json': ROOT_LAYOUT, 'Pub/a.md': 'body', 'Pub/a copy.md': 'first' })
    const client = await connect({ access: 'write', allow: ['Pub/a.md', 'Pub/a copy.md'] })
    const refused = await call(client, 'duplicate_note', { path: 'Pub/a.md' })
    expect(refused.isError, refused.text).toBe(true)
    expect(refused.text).toContain('This assistant cannot give the note that name.')
    expect(await exists('Pub/a copy 2.md')).toBe(false)
    expect(await exists('Pub/a copy.md')).toBe(true)
  })

  it('still copies inside a shared folder', async () => {
    await seed({ '.zennotes/vault.json': ROOT_LAYOUT, 'Pub/a.md': 'body' })
    const client = await connect({ access: 'write', allow: ['Pub'] })
    const copied = await call(client, 'duplicate_note', { path: 'Pub/a.md' })
    expect(copied.isError, copied.text).toBe(false)
    expect(JSON.parse(copied.text).path).toBe('Pub/a copy.md')
  })
})

describe('a note title', () => {
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

  it.each([
    ['latin', 'x'.repeat(300)],
    ['chinese', '漢'.repeat(200)],
    ['emoji', '\u{1f600}'.repeat(200)]
  ])('is cut to 200 bytes of whole characters: %s', (_label, title) => {
    const cut = sanitizeTitle(title)
    expect(bytes(cut)).toBeLessThanOrEqual(200)
    expect(bytes(cut)).toBeGreaterThan(190)
    expect(title.startsWith(cut)).toBe(true)
  })

  it('never ends in half a character', async () => {
    await seed({ '.zennotes/vault.json': ROOT_LAYOUT })
    const client = await connect()
    const created = await call(client, 'create_note', {
      title: `${'x'.repeat(199)}\u{1f600}`,
      folder: 'inbox'
    })
    expect(created.isError, created.text).toBe(false)
    expect(JSON.parse(created.text).path).toBe(`${'x'.repeat(199)}.md`)
  })

  it('answers for half a character sent in the title', async () => {
    await seed({ '.zennotes/vault.json': ROOT_LAYOUT })
    const created = await call(await connect(), 'create_note', { title: 'a\ud83db', folder: 'inbox' })
    expect(created.isError, created.text).toBe(false)
    expect(JSON.parse(created.text).path).toBe('a�b.md')
  })

  it('does not end in a space left by the cut', () => {
    expect(sanitizeTitle(`${'x'.repeat(199)} yy`)).toBe('x'.repeat(199))
  })

  it.each([
    ['nothing but spaces', '   ', 'Untitled'],
    ['a separator', 'a/b', 'a-b'],
    ['a NUL', 'a\u0000b', 'a-b'],
    ['a way out of the folder', '../up', '..-up']
  ])('stays inside the folder with %s', (_label, title, want) => {
    expect(sanitizeTitle(title)).toBe(want)
  })

  it('stops looking for a free name on a filesystem error', async () => {
    await seed({ '.zennotes/vault.json': ROOT_LAYOUT })
    const client = await connect()
    const lstat = fsp.lstat.bind(fsp)
    let looks = 0
    vi.spyOn(fsp, 'lstat').mockImplementation((async (p: string, options: never) => {
      if (String(p).endsWith('.md')) {
        looks += 1
        throw Object.assign(new Error('name too long'), { code: 'ENAMETOOLONG' })
      }
      return await lstat(p, options)
    }) as never)
    const refused = await call(client, 'create_note', { title: 'Plan', folder: 'inbox' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('name too long')
    expect(looks).toBe(1)
  })

  it('gives up when every name is taken', async () => {
    await seed({ '.zennotes/vault.json': ROOT_LAYOUT })
    const client = await connect()
    const lstat = fsp.lstat.bind(fsp)
    let looks = 0
    vi.spyOn(fsp, 'lstat').mockImplementation((async (p: string, options: never) => {
      if (String(p).endsWith('.md')) {
        looks += 1
        return { isSymbolicLink: () => false, isDirectory: () => false }
      }
      return await lstat(p, options)
    }) as never)
    const refused = await call(client, 'create_note', { title: 'Plan', folder: 'inbox' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('no free name')
    expect(looks).toBeLessThanOrEqual(10000)
  }, 30000)
})
