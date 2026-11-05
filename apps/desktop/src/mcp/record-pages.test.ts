import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newMcpScope, type McpScopeFlags } from '@shared/mcp-scope'
import { spell } from './scoped-backend'
import { runMcpServer } from './server'

// A database's record pages are notes to an assistant on this machine, as they are
// on a server and in zn. Mirrors internal/mcp/record_pages_test.go in ZenNotes/tui.

const RECORD_PAGE = 'memory/Books.base/Alpha.md'

let root: string
const clients: Client[] = []

async function seed(): Promise<void> {
  const files: Record<string, string> = {
    '.zennotes/vault.json': '{"primaryNotesLocation":"root"}',
    'memory/note.md': '# Note\n\nneedle in the note\n\n[[Alpha]]\n',
    'memory/Books.base/data.csv': 'title\nAlpha\n',
    'memory/Books.base/schema.json': '{}\n',
    [RECORD_PAGE]: '# Alpha\n\nneedle on the page\n\n- [ ] page task\n',
    'memory/Empty.base/data.csv': 'title\n',
    'memory/Empty.base/schema.json': '{}\n'
  }
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
  args: Record<string, unknown> = {}
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args })
  const parts = result.content as { text?: string }[]
  return { text: parts[0]?.text ?? '', isError: !!result.isError }
}

/** Every listing asked whether the page is there. They must agree. */
async function seesRecordPage(client: Client): Promise<boolean> {
  const notes = (await call(client, 'list_notes')).text.includes(RECORD_PAGE)
  const search = (await call(client, 'search_text', { query: 'needle' })).text.includes(RECORD_PAGE)
  const tasks = (await call(client, 'list_tasks')).text.includes('page task')
  const read = await call(client, 'read_note', { path: RECORD_PAGE })
  const opened = !read.isError && read.text.includes('needle on the page')
  expect({ search, tasks, opened }).toEqual({ search: notes, tasks: notes, opened: notes })
  return notes
}

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-record-pages-')))
  vi.stubEnv('ZENNOTES_CONFIG_DIR', path.join(root, '.config-for-test'))
  await seed()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await fsp.rm(root, { recursive: true, force: true })
})

describe('a record page and a path scope', () => {
  it.each<[string, McpScopeFlags | undefined, boolean, boolean]>([
    ['no paths', undefined, true, true],
    ['allow the folder holding it', { allow: ['memory'] }, true, true],
    ['allow the database', { allow: ['memory/Books.base'] }, true, false],
    ['allow the page', { allow: [RECORD_PAGE] }, true, false],
    ['allow another database', { allow: ['memory/Empty.base'] }, false, false],
    ['deny the page', { deny: [RECORD_PAGE] }, false, true],
    ['deny the page in another case', { deny: ['MEMORY/books.BASE/ALPHA.md'] }, false, true],
    ['deny the database', { deny: ['memory/Books.base'] }, false, true],
    ['deny the database with no pages', { deny: ['memory/Empty.base'] }, true, true],
    ['deny its folder', { deny: ['memory'] }, false, false]
  ])('%s', async (_name, flags, page, note) => {
    const client = await connect(flags)
    expect(await seesRecordPage(client)).toBe(page)
    const listed = (await call(client, 'list_notes')).text
    expect(listed.includes('memory/note.md')).toBe(note)
    expect(listed).not.toContain('data.csv')
    expect(listed).not.toContain('schema.json')
  })

  it.each(['memory/Gone.base', 'memory/Books.base/Gone.md'])(
    'still stops the client for an entry that names nothing: %s',
    async (deny) => {
      const client = await connect({ deny: [deny] })
      const listed = await call(client, 'list_notes')
      expect(listed.isError).toBe(true)
      expect(listed.text).toContain('does not exist in this vault')
    }
  )
})

describe('what holds around a record page', () => {
  it('keeps the folder whole and the database closed', async () => {
    const client = await connect({ deny: [RECORD_PAGE] })
    expect((await call(client, 'delete_folder', { folder: 'inbox', subpath: 'memory' })).isError).toBe(true)
    expect(
      (await call(client, 'rename_folder', { folder: 'inbox', subpath: 'memory', newSubpath: 'moved' }))
        .isError
    ).toBe(true)
    expect((await call(client, 'read_asset', { path: 'memory/Books.base/data.csv' })).isError).toBe(true)
    expect(
      (await call(client, 'create_note', { folder: 'inbox', subpath: 'memory/Books.base', title: 'Nope' }))
        .isError
    ).toBe(true)
    expect(await exists(RECORD_PAGE)).toBe(true)
    expect(await exists('memory/Books.base/Nope.md')).toBe(false)
  })

  it('does not let a client that sees a database delete it as a folder', async () => {
    const client = await connect({ allow: ['memory/Books.base'] })
    const deleted = await call(client, 'delete_folder', { folder: 'inbox', subpath: 'memory/Books.base' })
    expect(deleted.isError).toBe(true)
    expect(await exists(RECORD_PAGE)).toBe(true)
  })

  it('keeps the database out of the folder listing', async () => {
    const client = await connect()
    expect((await call(client, 'list_folders')).text).not.toContain('Books.base')
  })
})

describe('spell', () => {
  const nfc = 'Caf\u00e9'
  const nfd = 'Cafe\u0301'

  it('prefers exact, then case and composition, then folded accents', () => {
    expect(spell(nfc, [nfc, nfd])).toBe(nfc)
    expect(spell(nfd, ['Cafe', nfc])).toBe(nfc)
    expect(spell('caf\u00c9', ['Cafe', nfc])).toBe(nfc)
    expect(spell('cafe', [nfc])).toBe(nfc)
  })

  it('matches nothing for two paths equal after case and composition', () => {
    expect(spell(nfd, [nfc, 'CAF\u00c9'])).toBeNull()
    expect(spell('cafe', ['Cafe', 'CAFE'])).toBeNull()
  })

  it('counts a path a list names twice once, in each pass', () => {
    expect(spell(nfd, [nfc, nfc, 'Cafe'])).toBe(nfc)
    expect(spell('cafe', [nfc, nfc])).toBe(nfc)
  })
})
