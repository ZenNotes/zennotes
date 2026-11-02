import { describe, expect, it } from 'vitest'
import { assembleNotionImport } from './assemble'
import { NotionApiError } from './client'
import { collectNotionWorkspace, type NotionImportStore } from './collect'
import { createMcpNotionClient, dashedNotionId } from './mcp-source'
import type { NotionMcpTransport } from './mcp-transport'
import { createNotionMcpTransport, type McpFetchResponse } from './mcp-transport'
import { notionTreeChildren, notionTreeRoots } from './tree'

const PAGE_A = 'aaaaaaaa00004000800000000000000a'
const PAGE_B = 'bbbbbbbb00004000800000000000000b'
const ROW_1 = 'cccccccc00004000800000000000000c'
const ROW_2 = 'dddddddd00004000800000000000000d'
const DB = 'eeeeeeee00004000800000000000000e'
const SOURCE = 'ffffffff-0000-4000-8000-00000000000f'
const VIEW = '11111111-0000-4000-8000-000000000001'
const url = (id: string): string => `https://app.notion.com/p/${id}`

function pageEntity(id: string, title: string, content: string, ancestors = '', extra: object = {}) {
  return {
    metadata: { type: 'page' },
    title,
    url: url(id),
    text: `Here is the result:\n<page url="${url(id)}">\n<ancestor-path>${ancestors}</ancestor-path>\n<properties>\n{"title":"${title}"}\n</properties>\n<content>\n${content}\n</content>\n</page>`,
    page_last_edited_at: '2026-04-13T18:01:12.452Z',
    cover: null,
    ...extra
  }
}

function databaseEntity(viewJson: object) {
  return {
    metadata: { type: 'database' },
    title: 'Videos',
    url: url(DB),
    text: `<database url="{{${url(DB)}}}" inline="true">\nThe title of this Database is: Videos\n<ancestor-path>\n<parent-page url="${url(PAGE_A)}" title="Top"/>\n</ancestor-path>\n<data-sources>\n<data-source url="{{collection://${SOURCE}}}">\nsomething\n</data-source>\n</data-sources>\n<views>\n<view url="{{view://${VIEW}}}">\n${JSON.stringify({ dataSourceUrl: `{{collection://${SOURCE}}}`, ...viewJson })}\n</view>\n</views>\n</database>`
  }
}

const SOURCE_ENTITY = {
  metadata: { type: 'data_source' },
  title: 'Videos',
  url: url(DB),
  text: `<data-source url="{{collection://${SOURCE}}}">\n<data-source-state>\n${JSON.stringify({
    name: 'Videos',
    schema: {
      Name: { name: 'Name', type: 'title' },
      Status: {
        name: 'Status',
        type: 'status',
        groups: { to_do: [{ name: 'Not started' }], complete: [{ name: 'Done', color: 'green' }] }
      },
      'userDefined:URL': { name: 'URL', type: 'url' },
      Count: { name: 'Count', type: 'number' },
      Tags: { name: 'Tags', type: 'multi_select', options: [{ name: 'a' }, { name: 'b' }] },
      When: { name: 'When', type: 'date' },
      Ok: { name: 'Ok', type: 'checkbox' },
      Link: { name: 'Link', type: 'relation' },
      Calc: { name: 'Calc', type: 'formula' }
    },
    url: `{{collection://${SOURCE}}}`
  })}\n</data-source-state>\n</data-source>`
}

const row = (id: string, name: string, extra: object = {}) => ({
  url: url(id),
  Name: name,
  Status: 'Done',
  'userDefined:URL': 'https://x.io/',
  Count: 7,
  Tags: '["a","b"]',
  'date:When:start': '2026-01-02',
  'date:When:end': '2026-01-05',
  Ok: '__YES__',
  Link: `["${url(ROW_2)}"]`,
  Calc: 14,
  ...extra
})

interface Fake {
  transport: NotionMcpTransport
  calls: Array<{ tool: string; args: Record<string, unknown> }>
}

function fake(handler: (tool: string, args: Record<string, unknown>) => unknown): Fake {
  const calls: Fake['calls'] = []
  return {
    calls,
    transport: {
      callTool: async <T,>(tool: string, args: Record<string, unknown>): Promise<T> => {
        calls.push({ tool, args })
        return handler(tool, args) as T
      }
    }
  }
}

function workspace(viewJson: object, rows: (args: { mode?: string; query?: string; view_url?: string }) => unknown) {
  return (tool: string, args: Record<string, unknown>): unknown => {
    switch (tool) {
      case 'get-self':
        return { workspace: { name: 'Real Workspace' } }
      case 'list-private-pages':
        return { results: [{ type: 'page', url: `${url(PAGE_A)}?pvs=204`, title: 'Top' }] }
      case 'list-shared-pages':
        return { results: [] }
      case 'get-teams':
        return { joinedTeams: [], otherTeams: [] }
      case 'get-users':
        return { results: [] }
      case 'fetch': {
        const id = String(args.id).replace(/-/g, '')
        if (id.includes('collection')) return SOURCE_ENTITY
        if (id === PAGE_A) {
          return pageEntity(
            PAGE_A,
            'Top',
            `Intro <b>bold</b>\n\n<columns>\n<column>\n<page url="${url(PAGE_B)}">\nInner <b>page</b>\n</page>\n</column>\n</columns>\n\n<database url="${url(DB)}" inline="true"></database>`,
            '',
            { cover: { type: 'external', external: { url: 'https://images.test/cover.jpg' } } }
          )
        }
        if (id === PAGE_B) {
          const source = 'notion-file-block://12345678-1234-4234-8234-123456789abc/f?space_id=s&name=shot.png'
          return pageEntity(
            PAGE_B,
            'Inner page',
            `<image source="${source}" />\n\n![Web](https://images.test/web.jpg)`,
            `<parent-page url="${url(PAGE_A)}" title="Top"/>`,
            { references: { [source]: 'https://s3.test/shot.png' } }
          )
        }
        if (id === DB) return databaseEntity(viewJson)
        if (id === ROW_1) {
          return pageEntity(ROW_1, 'First', 'Row body', `<parent-data-source url="collection://${SOURCE}" name="Videos"/>`)
        }
        if (id === ROW_2) {
          return pageEntity(ROW_2, 'Second', '', `<parent-data-source url="collection://${SOURCE}" name="Videos"/>`)
        }
        throw new NotionApiError(404, 'tool_error', `not found ${id}`)
      }
      case 'query-data-sources':
        return rows((args.data ?? {}) as { mode?: string; query?: string })
      default:
        throw new NotionApiError(404, 'no_tool', tool)
    }
  }
}

function memoryStore(): NotionImportStore & { files: Map<string, string> } {
  const records = new Map<string, unknown>()
  const files = new Map<string, string>()
  return {
    files,
    readRecord: async <T,>(key: string) => (records.get(key) as T | undefined) ?? null,
    writeRecord: async (key, value) => {
      records.set(key, structuredClone(value))
    },
    hasFile: async (key) => files.has(key),
    downloadFile: async (key, _url, name) => {
      files.set(key, name)
    },
    listFiles: async () => [...files].map(([key, name]) => ({ key, name }))
  }
}

async function run(handler: (tool: string, args: Record<string, unknown>) => unknown, excluded?: string[]) {
  const f = fake(handler)
  const client = createMcpNotionClient(f.transport)
  const store = memoryStore()
  const collected = await collectNotionWorkspace({ client, store, excluded })
  const out = new Map<string, string>()
  const summary = await assembleNotionImport({
    collected,
    store,
    sink: {
      writeText: async (path, content) => {
        out.set(path, content)
      },
      placeFile: async () => undefined
    },
    import: { vaultFolder: 'Notion Import', includeTasks: false }
  })
  return { out, summary, calls: f.calls, store }
}

const openView = { name: 'All', type: 'table', displayProperties: ['Name', 'Status', 'userDefined:URL'] }
const viewRows = () => ({ results: [row(ROW_1, 'First'), row(ROW_2, '<p>\nSecond \n</p>')], has_more: false })

describe('sign-in import, end to end', () => {
  it('walks from the sidebar pages down, through columns, into a database', async () => {
    const { out, summary } = await run(workspace(openView, viewRows))
    expect(out.get('Top.md')).toContain('Intro **bold**')
    expect(out.get('Top.md')).toContain('[[Notion Import/Top/Inner page|Inner page]]')
    expect(out.get('Top.md')).toContain('[[Videos]]')
    expect(out.has('Top/Inner page.md')).toBe(true)
    expect(out.has('Top/Videos.base/schema.json')).toBe(true)
    expect(summary.pages).toBe(2)
    expect(summary.databases).toBe(1)
    expect(summary.rows).toBe(2)
  })

  it('types every kind of cell from the schema', async () => {
    const { out } = await run(workspace(openView, viewRows))
    const lines = (out.get('Top/Videos.base/data.csv') as string).split('\n')
    expect(lines[0]).toBe('id,Name,Status,URL,Count,Tags,When,When end,Ok,Link,Calc')
    expect(lines[1]).toContain(`${dashedNotionId(ROW_1)},First,Done,https://x.io/,7,"a, b",2026-01-02,2026-01-05,true,`)
    expect(lines[1]).toContain('[[Notion Import/Top/Videos.base/pages/Second|Second]]')
    expect(lines[1].endsWith(',14')).toBe(true)
    expect(lines[2]).toContain(',Second,')
    const schema = JSON.parse(out.get('Top/Videos.base/schema.json') as string)
    expect(schema.fields.map((f: { type: string }) => f.type)).toEqual([
      'text', 'text', 'select', 'text', 'number', 'multiSelect', 'date', 'date', 'checkbox', 'noteMulti', 'number'
    ])
    expect(schema.fields[2].options.map((o: { value: string }) => o.value)).toEqual(['Not started', 'Done'])
  })

  it('hides the columns a view leaves out, and keeps its name', async () => {
    const { out } = await run(workspace(openView, viewRows))
    const schema = JSON.parse(out.get('Top/Videos.base/schema.json') as string)
    const view = schema.views[0]
    const name = (id: string) => schema.fields.find((f: { id: string }) => f.id === id)?.name
    expect(view.name).toBe('All')
    expect(view.hiddenFieldIds.map(name)).toContain('Count')
    expect(view.hiddenFieldIds.map(name)).not.toContain('URL')
  })

  it('gives an unnamed view its type as a name', async () => {
    const { out } = await run(workspace({ ...openView, name: '' }, viewRows))
    expect(JSON.parse(out.get('Top/Videos.base/schema.json') as string).views[0].name).toBe('Table')
  })

  it('downloads hosted and outside images and the cover', async () => {
    const { out, store } = await run(workspace(openView, viewRows))
    expect([...store.files.values()].sort()).toEqual(['cover.jpg', 'shot.png', 'web.jpg'])
    expect(out.get('Top/Inner page.md')).toBe(
      '![[Notion Import/assets/shot.png]]\n\n![[Notion Import/assets/web.jpg]]\n\n*Web*\n'
    )
    expect(out.get('Top.md')).toContain('banner: "![[Notion Import/assets/cover.jpg]]"')
  })

  it('reads an unfiltered view for rows, which has no quota', async () => {
    const { calls } = await run(workspace(openView, viewRows))
    const queries = calls.filter((c) => c.tool === 'query-data-sources').map((c) => c.args.data as { mode: string })
    expect(queries).toHaveLength(1)
    expect(queries[0].mode).toBe('view')
  })

  it('follows view cursors to the end', async () => {
    let page = 0
    const { summary } = await run(
      workspace(openView, () => {
        page += 1
        return page === 1
          ? { results: [row(ROW_1, 'First')], has_more: true, next_cursor: 'next' }
          : { results: [row(ROW_2, 'Second')], has_more: false }
      })
    )
    expect(summary.rows).toBe(2)
  })

  describe('when the only view is filtered', () => {
    const filtered = {
      ...openView,
      simpleFilters: [
        {
          filter: {
            operator: 'status_is',
            property: 'Status',
            propertyType: 'status',
            type: 'property',
            value: [{ type: 'is_group', value: 'In progress' }]
          }
        }
      ]
    }

    it('does not trust the view: a Done row it hides still comes over', async () => {
      const { summary, calls, out } = await run(
        workspace(filtered, (data) => {
          if (data.mode === 'view') return { results: [], has_more: false }
          return { results: [row(ROW_1, 'First'), row(ROW_2, 'Second')], has_more: false }
        })
      )
      expect(summary.rows).toBe(2)
      const modes = calls.filter((c) => c.tool === 'query-data-sources').map((c) => (c.args.data as { mode?: string }).mode)
      expect(modes).toEqual(['rows'])
      // A status group has no ZenNotes equal, so the view shows more and says so.
      expect(JSON.parse(out.get('Top/Videos.base/schema.json') as string).views[0].filters).toEqual([])
      expect(summary.issues.map((issue) => issue.kind)).toContain('filter-dropped')
    })

    it('goes on with SQL past 100 rows', async () => {
      const queries: string[] = []
      const { summary } = await run(
        workspace(filtered, (data) => {
          if (data.mode === 'rows') return { results: [row(ROW_1, 'First')], has_more: true }
          queries.push(String(data.query))
          return { results: [row(ROW_1, 'First'), row(ROW_2, 'Second')] }
        })
      )
      expect(queries[0]).toContain('LIMIT 100 OFFSET 0')
      expect(summary.rows).toBe(2)
    })

    it('says so when a quota stops it, and keeps what it read', async () => {
      const { summary } = await run(
        workspace(filtered, (data) => {
          if (data.mode === 'rows') return { results: [row(ROW_1, 'First')], has_more: true }
          if (data.mode === 'view') return { results: [row(ROW_2, 'Second')], has_more: false }
          throw new NotionApiError(400, 'tool_error', 'over the limit')
        })
      )
      expect(summary.rows).toBe(2)
      expect(summary.issues.map((issue) => issue.kind)).toContain('rows-capped')
    })
  })

  it('leaves out what was unticked, with everything under it', async () => {
    const { out, summary, calls } = await run(workspace(openView, viewRows), [PAGE_B, DB])
    expect(out.has('Top/Inner page.md')).toBe(false)
    expect(out.has('Top/Videos.base/schema.json')).toBe(false)
    expect(out.get('Top.md')).not.toContain('Inner page')
    expect(out.get('Top.md')).not.toContain('Videos')
    expect(summary.pages).toBe(1)
    // A page left out is never even read.
    expect(calls.some((c) => c.tool === 'fetch' && String(c.args.id).replace(/-/g, '') === PAGE_B)).toBe(false)
    expect(summary.issues).toEqual([])
  })

  it('imports nothing under an unticked top-level page', async () => {
    const { out } = await run(workspace(openView, viewRows), [PAGE_A])
    expect([...out.keys()]).toEqual(['Import Report.md'])
  })

  it('places a page in a column under the page holding it, not the column it names', async () => {
    const column = 'abababab00004000800000000000000a'
    const base = workspace(openView, viewRows)
    const { out } = await run((tool, args) => {
      if (tool === 'fetch' && String(args.id).replace(/-/g, '') === PAGE_B) {
        return pageEntity(PAGE_B, 'Inner page', 'x', `<parent-page url="${url(column)}" title=""/>`)
      }
      return base(tool, args)
    })
    expect(out.has('Top/Inner page.md')).toBe(true)
    expect(out.has('Inner page.md')).toBe(false)
  })

  it('names a database nobody named after the page around it', async () => {
    const base = workspace(openView, viewRows)
    const { out } = await run((tool, args) => {
      const answer = base(tool, args) as { text?: string }
      return answer?.text && tool === 'fetch' && answer.text.includes('The title of this Database')
        ? { ...answer, text: answer.text.replace('Database is: Videos', 'Database is: New database') }
        : answer
    })
    expect(out.has('Top/Top database.base/schema.json')).toBe(true)
    expect(out.get('Top.md')).toContain('[[Top database]]')
  })

  it('keeps the title of a link card Notion leaves out of a page', async () => {
    const card = '12121212000040008000000000000012'
    const base = workspace(openView, viewRows)
    const { out, summary } = await run((tool, args) => {
      const id = String(args.id).replace(/-/g, '')
      if (tool === 'fetch' && id === PAGE_B) {
        return pageEntity(PAGE_B, 'Inner page', `<unknown url="${url(PAGE_B)}#${card}" alt="external_object_instance" />`, `<parent-page url="${url(PAGE_A)}" title="Top"/>`)
      }
      if (tool === 'fetch' && id === card) {
        return {
          metadata: { type: 'page' },
          title: 'a-library',
          text: `<ancestor-path>\n<parent-page url="${url(PAGE_B)}" title="Inner page"/>\n</ancestor-path>\n<properties>\n{"title":"a-library"}\n</properties>\n<blank-page>This page is blank and has no content.</blank-page>`
        }
      }
      return base(tool, args)
    })
    expect(out.get('Top/Inner page.md')).toBe('a-library\n')
    expect(summary.issues.filter((issue) => issue.kind === 'unresolved-link')).toEqual([])
  })

  it('downloads what a files column holds, hosted or not', async () => {
    const ref = 'notion-file-block://1/2?space_id=s&name=My%20Deed.pdf'
    const base = workspace(openView, () => ({
      results: [row(ROW_1, 'First', { Attach: `["${ref}","https://files.test/outside.zip"]` })],
      has_more: false
    }))
    const { out, store } = await run((tool, args) => {
      if (tool === 'get-file-download-urls') return { files: [{ url: 'https://s3.test/signed.pdf' }] }
      if (tool === 'fetch' && String(args.id).includes('collection')) {
        return {
          ...SOURCE_ENTITY,
          text: SOURCE_ENTITY.text.replace('"Name":{"name":"Name","type":"title"}', '"Name":{"name":"Name","type":"title"},"Attach":{"name":"Attach","type":"file"}')
        }
      }
      return base(tool, args)
    })
    expect([...store.files.values()]).toEqual(expect.arrayContaining(['My Deed.pdf', 'outside.zip']))
    const page = out.get('Top/Videos.base/pages/First.md') as string
    expect(page).toContain('![[Notion Import/assets/My Deed.pdf]]')
    expect(page).toContain('[outside.zip](Notion Import/assets/outside.zip)'.replace('(Notion Import/assets/outside.zip)', '(<Notion Import/assets/outside.zip>)'))
  })

  it('fills the picker a level at a time, finding pages in columns', async () => {
    const f = fake(workspace(openView, viewRows))
    const client = createMcpNotionClient(f.transport)
    expect(await notionTreeRoots(client)).toEqual([{ id: PAGE_A, title: 'Top', kind: 'page' }])
    expect(await notionTreeChildren(client, PAGE_A)).toEqual([
      { id: PAGE_B, title: 'Inner page', kind: 'page' },
      { id: DB, title: 'Videos', kind: 'database' }
    ])
  })
})

describe('createNotionMcpTransport', () => {
  const textResponse = (status: number, body: string, headers: Record<string, string> = {}): McpFetchResponse => ({
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => body
  })

  function server(toolResult: (name: string) => McpFetchResponse | object) {
    const requests: Array<{ method: string; auth: string; session?: string }> = []
    let token = 'token-1'
    const transport = createNotionMcpTransport({
      baseUrl: 'https://mcp.test',
      spacingMs: 0,
      sleep: async () => undefined,
      accessToken: async () => token,
      refreshToken: async () => {
        token = 'token-2'
        return token
      },
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body as string) as {
          id: number
          method: string
          params?: { name?: string }
        }
        requests.push({
          method: body.method,
          auth: init.headers.authorization,
          session: init.headers['mcp-session-id']
        })
        const reply = (result: object): McpFetchResponse =>
          textResponse(200, JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { 'mcp-session-id': 'session-1' })
        if (body.method === 'initialize') return reply({ protocolVersion: 'x' })
        if (body.method === 'notifications/initialized') return textResponse(202, '')
        if (body.method === 'tools/list') return reply({ tools: [{ name: 'notion-fetch' }] })
        const result = toolResult(body.params?.name ?? '')
        if ('status' in result) return result as McpFetchResponse
        return reply(result)
      }
    })
    return { transport, requests }
  }

  it('sets up once, carries the session, and maps the prefixed tool name', async () => {
    const { transport, requests } = server(() => ({ content: [{ type: 'text', text: '{"a":1}' }] }))
    await expect(transport.callTool('fetch', {})).resolves.toEqual({ a: 1 })
    await transport.callTool('fetch', {})
    expect(requests.filter((r) => r.method === 'initialize')).toHaveLength(1)
    expect(requests[requests.length - 1].session).toBe('session-1')
  })

  it('reads an answer sent as a server-sent event', async () => {
    let id = 0
    const transport = createNotionMcpTransport({
      baseUrl: 'https://mcp.test',
      spacingMs: 0,
      sleep: async () => undefined,
      accessToken: async () => 't',
      refreshToken: async () => null,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body as string) as { id: number; method: string }
        id = body.id
        if (body.method === 'notifications/initialized') return textResponse(202, '')
        const result =
          body.method === 'tools/list'
            ? { tools: [{ name: 'fetch' }] }
            : { content: [{ type: 'text', text: '{"ok":true}' }] }
        return textResponse(
          200,
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`
        )
      }
    })
    await expect(transport.callTool('fetch', {})).resolves.toEqual({ ok: true })
  })

  it('refreshes once on a 401 and retries with the new token', async () => {
    let first = true
    const { transport, requests } = server(() => {
      if (first) {
        first = false
        return textResponse(401, '')
      }
      return { content: [{ type: 'text', text: '{}' }] }
    })
    await transport.callTool('fetch', {})
    expect(requests[requests.length - 1].auth).toBe('Bearer token-2')
  })

  it('waits out a rate limit, whether as a status or as a tool error', async () => {
    let calls = 0
    const { transport } = server(() => {
      calls += 1
      if (calls === 1) return textResponse(429, '', { 'retry-after': '1' })
      if (calls === 2) return { isError: true, content: [{ type: 'text', text: 'rate limited' }] }
      return { content: [{ type: 'text', text: '{"ok":1}' }] }
    })
    await expect(transport.callTool('fetch', {})).resolves.toEqual({ ok: 1 })
    expect(calls).toBe(3)
  })

  it('reports a tool error, as not-found where it says so', async () => {
    const { transport } = server(() => ({ isError: true, content: [{ type: 'text', text: 'Could not find page' }] }))
    const error = await transport.callTool('fetch', {}).catch((e: unknown) => e)
    expect((error as NotionApiError).status).toBe(404)
  })

  it('refuses a tool Notion does not offer', async () => {
    const { transport } = server(() => ({ content: [] }))
    await expect(transport.callTool('other', {})).rejects.toThrow('doesn')
  })
})
