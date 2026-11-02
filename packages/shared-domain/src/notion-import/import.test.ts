import { describe, expect, it } from 'vitest'
import { parseCsv } from '../database-csv'
import type { DatabaseSidecar } from '../databases'
import { assembleNotionImport } from './assemble'
import {
  NotionAbortError,
  NotionApiError,
  createNotionClient,
  type NotionClient,
  type NotionFetch,
  type NotionFetchResponse
} from './client'
import { collectNotionWorkspace, type NotionImportStore } from './collect'
import { buildNotionDatabase } from './database'
import type { NotionIssueKind } from './render-context'
import type {
  NotionBlock,
  NotionDatabase,
  NotionDataSource,
  NotionPage,
  NotionPropertySchema,
  NotionRichText,
  NotionView
} from './types'

const id = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const compact = (n: number): string => id(n).replace(/-/g, '')

function rich(content: string): NotionRichText[] {
  return [{ type: 'text', plain_text: content, text: { content } }]
}

function para(content: string, extra: Partial<NotionBlock> = {}): NotionBlock {
  return { id: `para-${content}`, type: 'paragraph', paragraph: { rich_text: rich(content) }, ...extra }
}

function page(n: number, title: string, parent: NotionPage['parent'], extra: Partial<NotionPage> = {}): NotionPage {
  return {
    object: 'page',
    id: id(n),
    parent,
    created_time: '2024-01-02T03:04:05.000Z',
    last_edited_time: '2025-06-07T08:09:10.000Z',
    properties: { title: { id: 'title', type: 'title', title: rich(title) } },
    ...extra
  }
}

interface FakeWorkspace {
  pages: NotionPage[]
  sources?: NotionDataSource[]
  databases?: NotionDatabase[]
  rows?: Record<string, NotionPage[]>
  views?: Record<string, NotionView[]>
  blocks?: Record<string, NotionBlock[]>
  hideFromSearch?: string[]
  failPages?: string[]
  linkedDatabases?: string[]
}

function fakeClient(workspace: FakeWorkspace): NotionClient & { calls: string[] } {
  const calls: string[] = []
  const pageById = (pageId: string): NotionPage => {
    const all = [...workspace.pages, ...Object.values(workspace.rows ?? {}).flat()]
    const found = all.find((candidate) => candidate.id === pageId)
    if (!found) throw new NotionApiError(404, 'object_not_found', 'gone')
    return found
  }
  return {
    calls,
    me: async () => ({ bot: { workspace_name: 'Test' } }),
    search: async () => ({
      results: [
        ...workspace.pages.filter((item) => !workspace.hideFromSearch?.includes(item.id)),
        ...(workspace.sources ?? [])
      ],
      incomplete: false
    }),
    blockChildren: async (blockId) => {
      calls.push(`children:${blockId}`)
      if (workspace.failPages?.includes(blockId)) throw new NotionApiError(500, 'internal', 'boom')
      return structuredClone(workspace.blocks?.[blockId] ?? [])
    },
    block: async (blockId) => ({ id: blockId, type: 'paragraph' }),
    page: async (pageId) => pageById(pageId),
    database: async (databaseId) => {
      if (workspace.linkedDatabases?.includes(databaseId)) throw new NotionApiError(404, 'object_not_found', 'linked')
      const found = workspace.databases?.find((candidate) => candidate.id === databaseId)
      if (!found) throw new NotionApiError(404, 'object_not_found', 'gone')
      return found
    },
    dataSource: async (sourceId) => {
      calls.push(`source:${sourceId}`)
      const found = workspace.sources?.find((candidate) => candidate.id === sourceId)
      if (!found) throw new NotionApiError(404, 'object_not_found', 'gone')
      return found
    },
    queryDataSource: async (sourceId) => structuredClone(workspace.rows?.[sourceId] ?? []),
    views: async (databaseId) => workspace.views?.[databaseId] ?? [],
    propertyItems: async () => []
  }
}

function memoryStore(): NotionImportStore & { files: Map<string, string>; records: Map<string, unknown> } {
  const records = new Map<string, unknown>()
  const files = new Map<string, string>()
  return {
    records,
    files,
    readRecord: async <T,>(key: string) => (records.get(key) as T | undefined) ?? null,
    writeRecord: async (key, value) => {
      records.set(key, structuredClone(value))
    },
    hasFile: async (key) => files.has(key),
    downloadFile: async (key, url, name) => {
      if (url.includes('expired')) throw new Error('403')
      files.set(key, name)
    },
    listFiles: async () => [...files].map(([key, name]) => ({ key, name }))
  }
}

async function runImport(workspace: FakeWorkspace, includeTasks = false) {
  const client = fakeClient(workspace)
  const store = memoryStore()
  const collected = await collectNotionWorkspace({ client, store })
  const out = new Map<string, string>()
  const placed = new Map<string, string>()
  const times = new Map<string, { createdMs?: number; updatedMs?: number }>()
  const summary = await assembleNotionImport({
    collected,
    store,
    sink: {
      writeText: async (path, content, fileTimes) => {
        out.set(path, content)
        if (fileTimes) times.set(path, fileTimes)
      },
      placeFile: async (key, path) => {
        placed.set(path, key)
      }
    },
    import: { vaultFolder: 'Notion Import', includeTasks }
  })
  return { out, placed, times, summary, collected, client, store }
}

const workspaceParent = { type: 'workspace', workspace: true } as const
const underPage = (n: number) => ({ type: 'page_id', page_id: id(n) }) as const

describe('collect and assemble', () => {
  it('writes the page tree, links subpages where they sat, and keeps Notion dates', async () => {
    const { out, times, summary } = await runImport({
      pages: [page(1, 'Work', workspaceParent), page(2, 'Plan', underPage(1))],
      blocks: {
        [id(1)]: [para('intro'), { id: id(2), type: 'child_page', child_page: { title: 'Plan' } }],
        [id(2)]: [para('details')]
      }
    })
    expect(out.get('Work.md')).toBe('intro\n\n[[Notion Import/Work/Plan|Plan]]\n')
    expect(out.get('Work/Plan.md')).toBe('details\n')
    expect(times.get('Work.md')).toEqual({
      createdMs: Date.parse('2024-01-02T03:04:05.000Z'),
      updatedMs: Date.parse('2025-06-07T08:09:10.000Z')
    })
    expect(summary.pages).toBe(2)
  })

  it('keeps two top-level pages with one title apart, and links the right one', async () => {
    const mention: NotionRichText = {
      type: 'mention',
      plain_text: 'Work',
      mention: { type: 'page', page: { id: id(2) } }
    }
    const { out } = await runImport({
      pages: [page(1, 'Work', workspaceParent), page(2, 'Work', workspaceParent), page(3, 'Index', workspaceParent)],
      blocks: { [id(3)]: [{ id: 'm', type: 'paragraph', paragraph: { rich_text: [mention] } }] }
    })
    expect(out.has('Work.md')).toBe(true)
    expect(out.has('Work 2.md')).toBe(true)
    expect(out.get('Index.md')).toBe('[[Notion Import/Work 2|Work]]\n')
  })

  it('states the title in the note when a filesystem would not allow it', async () => {
    const { out } = await runImport({
      pages: [page(1, 'C# notes', workspaceParent)],
      blocks: { [id(1)]: [para('x')] }
    })
    expect(out.get('C- notes.md')).toBe('# C# notes\n\nx\n')
  })

  it('finds a subpage search left out', async () => {
    const hidden = page(2, 'Hidden', underPage(1))
    const { out } = await runImport({
      pages: [page(1, 'Top', workspaceParent), hidden],
      hideFromSearch: [hidden.id],
      blocks: { [id(1)]: [{ id: id(2), type: 'child_page', child_page: { title: 'Hidden' } }], [id(2)]: [para('found')] }
    })
    expect(out.get('Top/Hidden.md')).toBe('found\n')
  })

  it('places a page nested in a column under the page that holds it', async () => {
    const inColumn = page(2, 'Inner', { type: 'block_id', block_id: 'column-1' })
    const { out } = await runImport({
      pages: [page(1, 'Top', workspaceParent), inColumn],
      blocks: {
        [id(1)]: [
          { id: 'list', type: 'column_list', column_list: {}, has_children: true },
        ],
        list: [{ id: 'column-1', type: 'column', column: {}, has_children: true }],
        'column-1': [{ id: id(2), type: 'child_page', child_page: { title: 'Inner' } }]
      }
    })
    expect(out.has('Top/Inner.md')).toBe(true)
    expect(out.get('Top.md')).toBe('[[Notion Import/Top/Inner|Inner]]\n')
  })

  it('keeps to-dos out of Tasks unless asked', async () => {
    const workspace: FakeWorkspace = {
      pages: [page(1, 'List', workspaceParent)],
      blocks: { [id(1)]: [{ id: 't', type: 'to_do', to_do: { rich_text: rich('buy'), checked: false } }] }
    }
    expect((await runImport(workspace)).out.get('List.md')).toBe('---\ntasks: false\n---\n- [ ] buy\n')
    expect((await runImport(workspace, true)).out.get('List.md')).toBe('- [ ] buy\n')
  })

  it('downloads hosted files and covers, and embeds them', async () => {
    const { out, placed } = await runImport({
      pages: [
        page(1, 'Pics', workspaceParent, {
          cover: { type: 'file', file: { url: 'https://s3.example/cover.png' } }
        })
      ],
      blocks: {
        [id(1)]: [
          { id: 'img', type: 'image', image: { type: 'file', file: { url: 'https://s3.example/a%20b.png' }, caption: [] } }
        ]
      }
    })
    expect(placed.get('assets/a b.png')).toBe('block-img')
    expect(placed.get('assets/cover.png')).toBe(`cover-${id(1)}`)
    expect(out.get('Pics.md')).toBe(
      '---\nbanner: "![[Notion Import/assets/cover.png]]"\n---\n![[Notion Import/assets/a b.png]]\n'
    )
  })

  it('downloads every cover, and leaves one it could not get as a link', async () => {
    const stock = 'https://app.notion.com/images/page-cover/gradients_10.jpg'
    const { out, placed } = await runImport({
      pages: [
        page(1, 'A', workspaceParent, { cover: { type: 'external', external: { url: stock } } }),
        page(2, 'B', workspaceParent, { cover: { type: 'external', external: { url: 'https://example.com/expired.jpg' } } })
      ]
    })
    expect(placed.has('assets/gradients_10.jpg')).toBe(true)
    expect(out.get('A.md')).toContain('banner: "![[Notion Import/assets/gradients_10.jpg]]"')
    expect(out.get('B.md')).toContain('banner: "https://example.com/expired.jpg"')
  })

  it('tries a fresh link once when a download fails', async () => {
    const client = fakeClient({
      pages: [page(1, 'P', workspaceParent)],
      blocks: { [id(1)]: [{ id: 'img', type: 'image', image: { type: 'file', file: { url: 'https://s3/expired.png' } } }] }
    })
    client.block = async () => ({
      id: 'img',
      type: 'image',
      image: { type: 'file', file: { url: 'https://s3/fresh.png' } }
    })
    const store = memoryStore()
    await collectNotionWorkspace({ client, store })
    expect(store.files.has('block-img')).toBe(true)
  })

  it('reports a page it could not read, keeps going, and marks the note', async () => {
    const { out, summary } = await runImport({
      pages: [page(1, 'Bad', workspaceParent), page(2, 'Good', workspaceParent)],
      failPages: [id(1)],
      blocks: { [id(2)]: [para('ok')] }
    })
    expect(out.get('Good.md')).toBe('ok\n')
    expect(out.get('Bad.md')).toContain('could not be read')
    expect(summary.issues.map((issue) => issue.kind)).toContain('page-failed')
    expect(out.get('Import Report.md')).toContain('[[Notion Import/Bad|Bad]]: boom')
  })

  it('stops on a bad token rather than reporting every page as failed', async () => {
    const client = fakeClient({ pages: [page(1, 'P', workspaceParent)] })
    client.blockChildren = async () => {
      throw new NotionApiError(401, 'unauthorized', 'bad token')
    }
    await expect(collectNotionWorkspace({ client, store: memoryStore() })).rejects.toThrow('bad token')
  })

  it('resumes without fetching a stored page again', async () => {
    const workspace: FakeWorkspace = {
      pages: [page(1, 'A', workspaceParent), page(2, 'B', underPage(1))],
      blocks: { [id(1)]: [{ id: id(2), type: 'child_page', child_page: { title: 'B' } }], [id(2)]: [para('b')] }
    }
    const store = memoryStore()
    await collectNotionWorkspace({ client: fakeClient(workspace), store })
    const second = fakeClient({ ...workspace, hideFromSearch: [id(2)] })
    const collected = await collectNotionWorkspace({ client: second, store })
    expect(second.calls).toEqual([])
    // A subpage only its stored parent knows about is still found.
    expect(collected.nodes.map((node) => node.id)).toContain(compact(2))
  })

  describe('databases', () => {
    const source: NotionDataSource = {
      object: 'data_source',
      id: id(20),
      title: rich('Links'),
      parent: { type: 'database_id', database_id: id(10) },
      database_parent: underPage(1),
      properties: {
        Name: { id: 'title', name: 'Name', type: 'title' },
        Rating: {
          id: 'r%3A',
          name: 'Rating',
          type: 'select',
          select: { options: [{ name: 'Good', color: 'green' }, { name: 'Bad', color: 'red' }] }
        },
        Related: { id: 'rel', name: 'Related', type: 'relation', relation: { data_source_id: id(20) } }
      }
    }
    const database: NotionDatabase = {
      object: 'database',
      id: id(10),
      title: rich('Links'),
      parent: underPage(1),
      data_sources: [{ id: id(20), name: 'Links' }]
    }
    const row = (n: number, title: string, rating: string | null, related: number[] = []): NotionPage => ({
      ...page(n, title, { type: 'data_source_id', data_source_id: id(20), database_id: id(10) }),
      properties: {
        Name: { id: 'title', type: 'title', title: rich(title) },
        Rating: { id: 'r%3A', type: 'select', select: rating ? { name: rating } : null },
        Related: { id: 'rel', type: 'relation', relation: related.map((target) => ({ id: id(target) })) }
      }
    })
    const base = (rows: NotionPage[], blocks: Record<string, NotionBlock[]> = {}): FakeWorkspace => ({
      pages: [page(1, 'Cool Stuff', workspaceParent)],
      sources: [source],
      databases: [database],
      rows: { [id(20)]: rows },
      blocks: {
        [id(1)]: [{ id: id(10), type: 'child_database', child_database: { title: 'Links' } }],
        ...blocks
      }
    })

    it('writes a database folder the app can open, and links it from its page', async () => {
      const { out, summary } = await runImport(base([row(30, 'First', 'Good')]))
      expect(out.get('Cool Stuff.md')).toBe('[[Links]]\n')
      const sidecar = JSON.parse(out.get('Cool Stuff/Links.base/schema.json') as string) as DatabaseSidecar
      expect(sidecar.fields.map((field) => [field.name, field.type])).toEqual([
        ['id', 'text'],
        ['Name', 'text'],
        ['Rating', 'select'],
        ['Related', 'noteMulti']
      ])
      expect(parseCsv(out.get('Cool Stuff/Links.base/data.csv') as string)).toEqual([
        ['id', 'Name', 'Rating', 'Related'],
        [id(30), 'First', 'Good', '']
      ])
      expect(summary.databases).toBe(1)
      expect(summary.rows).toBe(1)
    })

    it('gives a record page only to a row that needs one', async () => {
      const { out } = await runImport(
        base([row(30, 'Empty', null), row(31, 'Body', null), row(32, 'Target', null), row(33, 'Linker', null, [32])], {
          [id(31)]: [para('text')]
        })
      )
      const sidecar = JSON.parse(out.get('Cool Stuff/Links.base/schema.json') as string) as DatabaseSidecar
      expect(sidecar.pages).toEqual({
        [id(31)]: 'pages/Body.md',
        [id(32)]: 'pages/Target.md'
      })
      expect(out.has('Cool Stuff/Links.base/pages/Empty.md')).toBe(false)
      expect(out.has('Cool Stuff/Links.base/pages/Linker.md')).toBe(false)
      const csv = parseCsv(out.get('Cool Stuff/Links.base/data.csv') as string)
      expect(csv[4][3]).toBe('[[Notion Import/Cool Stuff/Links.base/pages/Target|Target]]')
    })

    it('mirrors a row into its record page frontmatter, under its title', async () => {
      const { out } = await runImport(base([row(31, 'Body', 'Good')], { [id(31)]: [para('text')] }))
      expect(out.get('Cool Stuff/Links.base/pages/Body.md')).toBe(
        '---\nRating: Good\nRelated:\n---\n# Body\n\ntext\n'
      )
    })

    it('keeps a subpage of a row beside its record page', async () => {
      const { out } = await runImport({
        ...base([row(31, 'Video', null)], {
          [id(31)]: [{ id: id(40), type: 'child_page', child_page: { title: 'Script' } }],
          [id(40)]: [para('words')]
        }),
        pages: [page(1, 'Cool Stuff', workspaceParent), page(40, 'Script', underPage(31))]
      })
      expect(out.get('Cool Stuff/Links.base/pages/Video/Script.md')).toBe('words\n')
      expect(out.get('Cool Stuff/Links.base/pages/Video.md')).toContain(
        '[[Notion Import/Cool Stuff/Links.base/pages/Video/Script|Script]]'
      )
    })

    it('reports a linked database where it sat', async () => {
      const { out, summary } = await runImport({
        pages: [page(1, 'P', workspaceParent)],
        linkedDatabases: [id(99)],
        blocks: { [id(1)]: [{ id: id(99), type: 'child_database', child_database: { title: 'Mirror' } }] }
      })
      expect(out.get('P.md')).toContain('Linked database "Mirror"')
      expect(summary.issues.map((issue) => issue.kind)).toEqual(['linked-database'])
    })

    it('treats a row whose database it cannot read as an ordinary page', async () => {
      const { out } = await runImport({
        pages: [row(30, 'Stray', 'Good')],
        blocks: { [id(30)]: [para('kept')] }
      })
      expect(out.get('Stray.md')).toBe('kept\n')
    })
  })
})

describe('buildNotionDatabase', () => {
  const build = (
    schema: Record<string, NotionPropertySchema>,
    rows: NotionPage[],
    views: NotionView[] = []
  ) => {
    const issues: NotionIssueKind[] = []
    let n = 0
    const built = buildNotionDatabase({
      schema,
      rows,
      views,
      resolveRow: () => null,
      assetFor: () => null,
      issue: (kind) => issues.push(kind),
      genId: () => `g${++n}`
    })
    const cell = (rowIndex: number, name: string): string => {
      const field = built.sidecar.fields.find((candidate) => candidate.name === name)
      return built.rows[rowIndex].cells[field?.id ?? ''] ?? ''
    }
    return { built, issues, cell }
  }
  const row = (properties: NotionPage['properties']): NotionPage => ({ id: id(1), properties })
  const title: NotionPropertySchema = { id: 'title', name: 'Name', type: 'title' }

  it('puts the title first whatever order the schema came in', () => {
    const { built } = build({ Note: { id: 'n', name: 'Note', type: 'rich_text' }, Name: title }, [])
    expect(built.sidecar.fields.map((field) => field.name)).toEqual(['id', 'Name', 'Note'])
  })

  it('renames a property that collides with the id column', () => {
    const { built } = build({ Name: title, ID: { id: 'i', name: 'ID', type: 'rich_text' } }, [])
    expect(built.sidecar.fields.map((field) => field.name)).toEqual(['id', 'Name', 'ID (Notion)'])
  })

  it('keeps a header safe to mirror as a frontmatter key', () => {
    const { built } = build({ Name: title, 'Due: soon': { id: 'd', name: 'Due: soon', type: 'rich_text' } }, [])
    expect(built.sidecar.fields[2].name).toBe('Due - soon')
  })

  it('stores a plain date in one date column', () => {
    const { built, cell } = build({ Name: title, When: { id: 'w', name: 'When', type: 'date' } }, [
      row({ When: { id: 'w', type: 'date', date: { start: '2026-01-02' } } })
    ])
    expect(built.sidecar.fields.map((field) => field.name)).toEqual(['id', 'Name', 'When'])
    expect(cell(0, 'When')).toBe('2026-01-02')
  })

  it('gives ranges and times their own columns instead of losing them', () => {
    const { built, cell } = build({ Name: title, When: { id: 'w', name: 'When', type: 'date' } }, [
      row({ When: { id: 'w', type: 'date', date: { start: '2026-01-02T14:30:00.000Z', end: '2026-01-05T16:00:00.000Z' } } })
    ])
    expect(built.sidecar.fields.map((field) => [field.name, field.type])).toEqual([
      ['id', 'text'],
      ['Name', 'text'],
      ['When', 'date'],
      ['When end', 'date'],
      ['When time', 'text']
    ])
    expect(cell(0, 'When')).toBe('2026-01-02')
    expect(cell(0, 'When end')).toBe('2026-01-05')
    expect(cell(0, 'When time')).toBe('14:30 to 16:00')
  })

  it('types a formula column by what its results are', () => {
    const schema = { Name: title, F: { id: 'f', name: 'F', type: 'formula' } }
    const value = (formula: object) => row({ F: { id: 'f', type: 'formula', formula } as never })
    const numbers = build(schema, [value({ type: 'number', number: 16 }), value({ type: 'number', number: null })])
    expect(numbers.built.sidecar.fields[2].type).toBe('number')
    expect(numbers.cell(0, 'F')).toBe('16')
    const booleans = build(schema, [value({ type: 'boolean', boolean: true })])
    expect(booleans.built.sidecar.fields[2].type).toBe('checkbox')
    const mixed = build(schema, [value({ type: 'number', number: 1 }), value({ type: 'string', string: 'x' })])
    expect(mixed.built.sidecar.fields[2].type).toBe('text')
  })

  it('flattens a rollup array and reports one Notion would not compute', () => {
    const schema = { Name: title, R: { id: 'r', name: 'R', type: 'rollup' } }
    const shown = build(schema, [
      row({
        R: {
          id: 'r',
          type: 'rollup',
          rollup: {
            type: 'array',
            array: [
              { id: 'x', type: 'number', number: 1 },
              { id: 'y', type: 'select', select: { name: 'Two' } }
            ]
          }
        }
      })
    ])
    expect(shown.cell(0, 'R')).toBe('1, Two')
    const refused = build(schema, [row({ R: { id: 'r', type: 'rollup', rollup: { type: 'unsupported' } } })])
    expect(refused.issues).toContain('computed-empty')
  })

  it('swaps commas out of multi-select options, since cells are comma-joined', () => {
    const { built, cell, issues } = build(
      {
        Name: title,
        Tags: { id: 't', name: 'Tags', type: 'multi_select', multi_select: { options: [{ name: 'a, b' }, { name: 'c' }] } }
      },
      [row({ Tags: { id: 't', type: 'multi_select', multi_select: [{ name: 'a, b' }, { name: 'c' }] } })]
    )
    expect(built.sidecar.fields[2].options?.map((option) => option.value)).toEqual(['a; b', 'c'])
    expect(cell(0, 'Tags')).toBe('a; b, c')
    expect(issues).toContain('option-renamed')
  })

  describe('views', () => {
    const schema: Record<string, NotionPropertySchema> = {
      Name: title,
      Status: { id: 's%3A', name: 'Status', type: 'status', status: { options: [{ name: 'Todo' }, { name: 'Done' }] } },
      Tags: { id: 't', name: 'Tags', type: 'multi_select', multi_select: { options: [] } },
      Due: { id: 'd', name: 'Due', type: 'date' },
      Ok: { id: 'o', name: 'Ok', type: 'checkbox' }
    }
    const view = (extra: Partial<NotionView>): NotionView => ({ id: 'v', type: 'table', name: 'All', ...extra })
    const only = (extra: Partial<NotionView>) => {
      const result = build(schema, [], [view(extra)])
      const fieldId = (name: string) => result.built.sidecar.fields.find((field) => field.name === name)?.id
      return { view: result.built.sidecar.views[0], issues: result.issues, fieldId }
    }

    it('keeps a table view with its filters, sorts and columns', () => {
      const { view: out, fieldId } = only({
        filter: { and: [{ property: 'Status', status: { equals: 'Todo' } }, { property: 'Ok', checkbox: { equals: true } }] },
        sorts: [{ property: 'Due', direction: 'descending' }],
        configuration: {
          type: 'table',
          properties: [
            { property_id: 'title', visible: true, width: 300 },
            { property_id: 'd', visible: true },
            { property_id: 's%3A', visible: false }
          ]
        }
      })
      expect(out.type).toBe('table')
      expect(out.filters).toEqual([
        { fieldId: fieldId('Status'), op: 'is', value: 'Todo' },
        { fieldId: fieldId('Ok'), op: 'checked' }
      ])
      expect(out.sorts).toEqual([{ fieldId: fieldId('Due'), direction: 'desc' }])
      expect(out.columnOrder?.slice(0, 4)).toEqual([fieldId('id'), fieldId('Name'), fieldId('Due'), fieldId('Status')])
      expect(out.hiddenFieldIds).toContain(fieldId('Status'))
      expect(out.columnWidths).toEqual({ [fieldId('Name') as string]: 300 })
    })

    it('keeps a board grouped by a status, and turns other boards into tables', () => {
      const { view: board, fieldId } = only({
        type: 'board',
        configuration: { type: 'board', group_by: { type: 'status', property_id: 's%3A' } }
      })
      expect(board.type).toBe('board')
      expect(board.groupByFieldId).toBe(fieldId('Status'))
      expect(board.boardColumnOrder).toEqual(['Todo', 'Done', '__empty__'])
      const other = only({ type: 'board', configuration: { group_by: { type: 'multi_select', property_id: 't' } } })
      expect(other.view.type).toBe('table')
      expect(other.issues).toContain('view-converted')
    })

    it('turns a calendar into a table, and says so', () => {
      const { view: out, issues } = only({ type: 'calendar', name: 'Dates' })
      expect(out.type).toBe('table')
      expect(out.name).toBe('Dates')
      expect(issues).toContain('view-converted')
    })

    it('drops a clause it cannot translate from an and: the view shows more', () => {
      const { view: out, issues, fieldId } = only({
        filter: { and: [{ property: 'Status', status: { equals: 'Todo' } }, { property: 'Due', date: { past_week: {} } }] }
      })
      expect(out.filters).toEqual([{ fieldId: fieldId('Status'), op: 'is', value: 'Todo' }])
      expect(issues).toContain('filter-dropped')
    })

    it('drops a whole or when one clause has no equal, rather than hide rows', () => {
      const { view: out, issues } = only({
        filter: { or: [{ property: 'Status', status: { equals: 'Todo' } }, { property: 'Due', date: { past_week: {} } }] }
      })
      expect(out.filters).toEqual([])
      expect(issues).toContain('filter-dropped')
    })

    it('keeps an or that translates whole', () => {
      const { view: out } = only({
        filter: { or: [{ property: 'Status', status: { equals: 'Todo' } }, { property: 'Status', status: { equals: 'Done' } }] }
      })
      expect(out.filterConjunction).toBe('or')
      expect(out.filters).toHaveLength(2)
    })

    it('reports a sort on a timestamp, which has no column', () => {
      const { view: out, issues } = only({ sorts: [{ timestamp: 'created_time', direction: 'ascending' }] })
      expect(out.sorts).toEqual([])
      expect(issues).toContain('sort-dropped')
    })
  })
})

describe('createNotionClient', () => {
  const ok = (body: unknown) => ({ status: 200, headers: { get: () => null }, json: async () => body })

  function harness(responses: Array<NotionFetchResponse | Error>) {
    const waits: number[] = []
    const requests: Array<{ url: string; headers: Record<string, string>; method: string }> = []
    let clock = 0
    const fetch: NotionFetch = async (url, init) => {
      requests.push({ url, headers: init.headers, method: init.method })
      const next = responses.shift()
      if (next instanceof Error) throw next
      return next as NotionFetchResponse
    }
    const client = createNotionClient({
      fetch,
      token: 'secret',
      baseUrl: 'https://notion.test/',
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms)
        clock += ms
      }
    })
    return { client, waits, requests }
  }

  it('sends the token and pinned version, and spaces its requests', async () => {
    const { client, waits, requests } = harness([ok({ id: 'a' }), ok({ id: 'b' })])
    await client.page('a')
    await client.page('b')
    expect(requests[0].url).toBe('https://notion.test/v1/pages/a')
    expect(requests[0].headers.authorization).toBe('Bearer secret')
    expect(requests[0].headers['notion-version']).toBe('2025-09-03')
    expect(waits).toEqual([340])
  })

  it('waits as long as a 429 says, then retries', async () => {
    const limited = { status: 429, headers: { get: (name: string) => (name === 'retry-after' ? '7' : null) }, json: async () => ({}) }
    const { client, waits } = harness([limited, ok({ id: 'a' })])
    await expect(client.page('a')).resolves.toEqual({ id: 'a' })
    expect(waits[0]).toBe(7000)
  })

  it('retries a network failure and an overloaded server', async () => {
    const overloaded = { status: 529, headers: { get: () => null }, json: async () => ({}) }
    const { client } = harness([new Error('reset'), overloaded, ok({ id: 'a' })])
    await expect(client.page('a')).resolves.toEqual({ id: 'a' })
  })

  it('does not retry a refusal, and names it without the token', async () => {
    const refused = { status: 401, headers: { get: () => null }, json: async () => ({ code: 'unauthorized', message: 'API token is invalid.' }) }
    const { client, requests } = harness([refused])
    const error = await client.page('a').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NotionApiError)
    expect((error as NotionApiError).isAuth).toBe(true)
    expect(String((error as Error).message)).not.toContain('secret')
    expect(requests).toHaveLength(1)
  })

  it('follows cursors to the end', async () => {
    const { client, requests } = harness([
      ok({ results: [{ id: 'a', type: 'paragraph' }], has_more: true, next_cursor: 'c 1' }),
      ok({ results: [{ id: 'b', type: 'paragraph' }], has_more: false, next_cursor: null })
    ])
    const blocks = await client.blockChildren('p')
    expect(blocks.map((block) => block.id)).toEqual(['a', 'b'])
    expect(requests[1].url).toContain('start_cursor=c%201')
  })

  it('stops when told to', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = createNotionClient({
      fetch: async () => ok({}),
      token: 't',
      signal: controller.signal
    })
    await expect(client.page('a')).rejects.toBeInstanceOf(NotionAbortError)
  })

  it('reads a view list and each view', async () => {
    const { client, requests } = harness([
      ok({ results: [{ object: 'view', id: 'v1' }], has_more: false }),
      ok({ object: 'view', id: 'v1', type: 'table' })
    ])
    const views = await client.views('db')
    expect(views[0].type).toBe('table')
    expect(requests[0].url).toContain('/v1/views?database_id=db')
    expect(requests[1].url).toContain('/v1/views/v1')
  })
})
