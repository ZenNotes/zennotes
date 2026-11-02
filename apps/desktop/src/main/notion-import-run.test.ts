import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotionAbortError, createNotionClient, type NotionFetch } from '@shared/notion-import/client'
import { readNoteCreatedAt } from './note-creation-metadata'
import { createStagingStore, isPrivateHost, runNotionImport } from './notion-import-run'

const PAGE_A = 'aaaaaaaa-0000-4000-8000-000000000000'
const PAGE_B = 'bbbbbbbb-0000-4000-8000-000000000000'
const rich = (content: string) => [{ type: 'text', plain_text: content, text: { content } }]
const title = (content: string) => ({ title: { id: 'title', type: 'title', title: rich(content) } })

function fakeNotion(): { fetch: NotionFetch; calls: string[] } {
  const calls: string[] = []
  const routes: Record<string, unknown> = {
    'POST /v1/search': {
      results: [
        {
          object: 'page',
          id: PAGE_A,
          parent: { type: 'workspace', workspace: true },
          created_time: '2021-02-03T04:05:06.000Z',
          last_edited_time: '2022-03-04T05:06:07.000Z',
          properties: title('Work')
        },
        {
          object: 'page',
          id: PAGE_B,
          parent: { type: 'page_id', page_id: PAGE_A },
          last_edited_time: '2022-03-04T05:06:07.000Z',
          properties: title('Plan')
        }
      ],
      has_more: false
    },
    [`GET /v1/blocks/${PAGE_A}/children`]: {
      results: [
        { id: 'p1', type: 'paragraph', paragraph: { rich_text: rich('hello') } },
        { id: PAGE_B, type: 'child_page', child_page: { title: 'Plan' } },
        { id: 'img1', type: 'image', image: { type: 'file', file: { url: 'https://files.test/shot.png' }, caption: [] } }
      ],
      has_more: false
    },
    [`GET /v1/blocks/${PAGE_B}/children`]: {
      results: [{ id: 'p2', type: 'paragraph', paragraph: { rich_text: rich('details') } }],
      has_more: false
    },
    'GET /v1/users/me': { bot: { workspace_name: 'Test' } }
  }
  const fetch: NotionFetch = async (url, init) => {
    const { pathname } = new URL(url)
    const key = `${init.method} ${pathname}`
    calls.push(key)
    const body = routes[key]
    return {
      status: body ? 200 : 404,
      headers: { get: () => null },
      json: async () => body ?? { code: 'object_not_found', message: `No ${key}` }
    }
  }
  return { fetch, calls }
}

const fileFetch = async (): Promise<Response> => new Response(new Uint8Array([1, 2, 3]))

describe('runNotionImport', () => {
  let scratch: string
  let root: string
  let stagingDir: string

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-notion-'))
    root = path.join(scratch, 'vault')
    stagingDir = path.join(scratch, 'staging')
    await fs.mkdir(root, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true })
  })

  const client = (fetch: NotionFetch, signal?: AbortSignal) =>
    createNotionClient({ fetch, token: 't', baseUrl: 'https://notion.test', spacingMs: 0, signal })

  const run = (notesRoot = root, fetch = fakeNotion().fetch) =>
    runNotionImport({
      client: client(fetch),
      store: createStagingStore(stagingDir, fileFetch),
      stagingDir,
      root,
      notesRoot,
      includeTasks: false,
      onProgress: () => undefined
    })

  it('moves the finished folder into the vault and clears staging', async () => {
    const result = await run()
    expect(result.folder).toBe('Notion Import')
    expect(result.reportPath).toBe('Notion Import/Import Report.md')
    expect(result.pages).toBe(2)
    expect(result.files).toBe(1)
    const work = await fs.readFile(path.join(root, 'Notion Import/Work.md'), 'utf8')
    expect(work).toContain('hello')
    expect(work).toContain('[[Notion Import/Work/Plan|Plan]]')
    expect(work).toContain('![[Notion Import/assets/shot.png]]')
    expect(await fs.readFile(path.join(root, 'Notion Import/Work/Plan.md'), 'utf8')).toBe('details\n')
    expect(await fs.readFile(path.join(root, 'Notion Import/assets/shot.png'))).toEqual(Buffer.from([1, 2, 3]))
    await expect(fs.access(stagingDir)).rejects.toThrow()
  })

  it('keeps Notion dates on the notes', async () => {
    await run()
    const abs = path.join(root, 'Notion Import/Work.md')
    expect((await fs.stat(abs)).mtimeMs).toBe(Date.parse('2022-03-04T05:06:07.000Z'))
    expect(await readNoteCreatedAt(root, 'Notion Import/Work.md', 0)).toBe(Date.parse('2021-02-03T04:05:06.000Z'))
  })

  it('never touches a folder an earlier import left', async () => {
    await fs.mkdir(path.join(root, 'Notion Import'))
    await fs.writeFile(path.join(root, 'Notion Import/Mine.md'), 'keep')
    const result = await run()
    expect(result.folder).toBe('Notion Import 2')
    expect(await fs.readFile(path.join(root, 'Notion Import/Mine.md'), 'utf8')).toBe('keep')
    expect(await fs.readFile(path.join(root, 'Notion Import 2/Work.md'), 'utf8')).toContain('[[Notion Import 2/Work/Plan|Plan]]')
  })

  it('lands in the notes folder of a vault that keeps one, and links by the vault path', async () => {
    const notes = path.join(root, 'inbox')
    const result = await run(notes)
    expect(result.folder).toBe('inbox/Notion Import')
    const work = await fs.readFile(path.join(notes, 'Notion Import/Work.md'), 'utf8')
    expect(work).toContain('[[inbox/Notion Import/Work/Plan|Plan]]')
  })

  it('leaves the vault alone when stopped, and picks up without refetching', async () => {
    const controller = new AbortController()
    const notion = fakeNotion()
    const stoppingFetch: NotionFetch = async (url, init) => {
      if (url.endsWith(`${PAGE_A}/children?page_size=100`)) controller.abort()
      return notion.fetch(url, init)
    }
    const stopped = runNotionImport({
      client: client(stoppingFetch, controller.signal),
      store: createStagingStore(stagingDir, fileFetch, { signal: controller.signal }),
      stagingDir,
      root,
      notesRoot: root,
      includeTasks: false,
      onProgress: () => undefined,
      signal: controller.signal
    })
    await expect(stopped).rejects.toBeInstanceOf(NotionAbortError)
    expect(await fs.readdir(root)).toEqual([])

    const resumed = fakeNotion()
    await run(root, resumed.fetch)
    expect(resumed.calls).not.toContain(`GET /v1/blocks/${PAGE_A}/children`)
    expect(resumed.calls).toContain(`GET /v1/blocks/${PAGE_B}/children`)
    expect(await fs.readFile(path.join(root, 'Notion Import/Work/Plan.md'), 'utf8')).toBe('details\n')
  })

  it('holds a Stop pressed after the last page was read', async () => {
    const controller = new AbortController()
    const notion = fakeNotion()
    const stoppingFetch: NotionFetch = async (url, init) => {
      const response = await notion.fetch(url, init)
      if (url.endsWith(`${PAGE_B}/children?page_size=100`)) controller.abort()
      return response
    }
    const stopped = runNotionImport({
      client: client(stoppingFetch, controller.signal),
      store: createStagingStore(stagingDir, fileFetch),
      stagingDir,
      root,
      notesRoot: root,
      includeTasks: false,
      onProgress: () => undefined,
      signal: controller.signal
    })
    await expect(stopped).rejects.toBeInstanceOf(NotionAbortError)
    expect(await fs.readdir(root)).toEqual([])
  })

  it('refuses a file link that is not https', async () => {
    const store = createStagingStore(stagingDir, fileFetch)
    await expect(store.downloadFile('k', 'http://files.test/a.png', 'a.png')).rejects.toThrow('Refused')
    await expect(store.hasFile('k')).resolves.toBe(false)
  })

  it('does not count an unfinished download as stored', async () => {
    const store = createStagingStore(stagingDir, async () => new Response('gone', { status: 403 }))
    await expect(store.downloadFile('k', 'https://files.test/a.png', 'a.png')).rejects.toThrow('403')
    await expect(store.hasFile('k')).resolves.toBe(false)
    await expect(store.listFiles()).resolves.toEqual([])
  })

  it('refuses a file link to the private network', async () => {
    const store = createStagingStore(stagingDir, fileFetch)
    await expect(store.downloadFile('k', 'https://192.168.1.10/a.png', 'a.png')).rejects.toThrow('private')
    for (const host of ['localhost', '127.0.0.1', '10.0.0.2', '169.254.169.254', '[::1]', 'printer.local']) {
      expect(isPrivateHost(host)).toBe(true)
    }
    for (const host of ['images.unsplash.com', '172.32.0.1', '8.8.8.8']) {
      expect(isPrivateHost(host)).toBe(false)
    }
  })

  it('names the type when a link has no extension, so an image still embeds', async () => {
    const store = createStagingStore(
      stagingDir,
      async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg; x=1' } })
    )
    await store.downloadFile('k', 'https://images.test/photo-123', 'photo-123')
    await expect(store.listFiles()).resolves.toEqual([{ key: 'k', name: 'photo-123.jpg' }])
  })

  it('does not keep a web page that answered for a file', async () => {
    const store = createStagingStore(
      stagingDir,
      async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })
    )
    await expect(store.downloadFile('k', 'https://images.test/a.png', 'a.png')).rejects.toThrow('web page')
    await expect(store.hasFile('k')).resolves.toBe(false)
  })
})
