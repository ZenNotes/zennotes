import { NotionApiError, type NotionClient } from './client'
import type { NotionMcpTransport } from './mcp-transport'
import { parseCellText, parseNotionMarkdown } from './nfm'
import {
  compactNotionId,
  notionIdFromHref,
  type NotionBlock,
  type NotionDatabase,
  type NotionDataSource,
  type NotionFile,
  type NotionPage,
  type NotionParent,
  type NotionPropertySchema,
  type NotionPropertyValue,
  type NotionView,
  type NotionViewFilter
} from './types'

/**
 * Presents Notion's hosted service as the REST client the importer already
 * reads through, so collecting, paths, databases and the report don't know
 * which sign-in brought the data. The two differ most in rows: this service
 * has no plain "list every row", and a saved view hides what its filter hides,
 * so `queryDataSource` works down from what's free and complete.
 */

interface FetchedEntity {
  metadata?: { type?: string }
  title?: string
  url?: string
  text?: string
  references?: Record<string, string>
  cover?: NotionFile | null
  icon?: { type: string; emoji?: string } | null
  page_last_edited_at?: string
  truncated?: boolean
}

interface McpView {
  id: string
  name?: string
  type?: string
  displayProperties?: string[]
  columnWidths?: Record<string, number>
  dataSourceUrl?: string
  simpleFilters?: Array<{ filter?: McpFilter }>
  filter?: McpFilter
  advancedFilter?: McpFilter
  sorts?: Array<{ property?: string; direction?: string }>
  groupBy?: { property?: string; type?: string } | string
}

interface McpFilter {
  type?: string
  operator?: string
  filters?: McpFilter[]
  property?: string
  propertyType?: string
  value?: unknown
}

interface McpSchemaEntry {
  name?: string
  type?: string
  options?: Array<{ name: string; color?: string }>
  groups?: Record<string, Array<{ name: string; color?: string }>>
  relation?: unknown
  dataSourceUrl?: string
}

export function dashedNotionId(id: string): string {
  const c = compactNotionId(id)
  return c.length === 32
    ? `${c.slice(0, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}-${c.slice(16, 20)}-${c.slice(20)}`
    : id
}

function between(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open)
  if (start < 0) return null
  const from = start + open.length
  const end = text.lastIndexOf(close)
  return end > from ? text.slice(from, end) : null
}

function unwrapBraces(url: string): string {
  return url.replace(/^\{\{|\}\}$/g, '')
}

function firstAncestor(text: string): NotionParent {
  const path = between(text, '<ancestor-path>', '</ancestor-path>')
  const first = path ? /<parent-([a-z-]+)\s+url="([^"]+)"/.exec(path) : null
  if (!first) return { type: 'workspace', workspace: true }
  const url = first[2]
  if (url.startsWith('collection://')) {
    return { type: 'data_source_id', data_source_id: url.slice(13) }
  }
  const id = notionIdFromHref(url)
  if (!id) return { type: 'workspace', workspace: true }
  return first[1] === 'database' ? { type: 'database_id', database_id: id } : { type: 'page_id', page_id: id }
}

/** Notion wraps URLs in its JSON as `{{collection://...}}`. Only those: JSON's
 *  own nested objects close with `}}` too. */
function unwrapUrls(json: string): string {
  return json.replace(/\{\{([a-z]+:\/\/[^{}]*)\}\}/g, '$1')
}

function plainRich(text: string) {
  return [{ type: 'text', plain_text: text, text: { content: text } }]
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  const text = value.trim()
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) return parsed
    } catch {
      // A plain value that opens with a bracket.
    }
  }
  return [text]
}

const SCHEMA_TYPES: Record<string, string> = {
  text: 'rich_text',
  person: 'people',
  file: 'files',
  auto_increment_id: 'rich_text',
  location: 'rich_text',
  place: 'rich_text'
}

function toSchema(key: string, entry: McpSchemaEntry): NotionPropertySchema {
  const name = entry.name || key.replace(/^userDefined:/, '')
  const type = SCHEMA_TYPES[entry.type ?? ''] ?? entry.type ?? 'rich_text'
  const schema: NotionPropertySchema = { id: key, name, type }
  const options = entry.options ?? Object.values(entry.groups ?? {}).flat()
  if (type === 'select') schema.select = { options }
  if (type === 'status') schema.status = { options }
  if (type === 'multi_select') schema.multi_select = { options }
  return schema
}

/** Notion's filter vocabulary here, in the REST form the database builder
 *  translates. A condition with no match keeps a type it won't recognize, so
 *  it's dropped and reported the same way as any other it can't represent. */
function restFilter(filter: McpFilter): NotionViewFilter {
  if (filter.type === 'group' && filter.filters) {
    return { [filter.operator === 'or' ? 'or' : 'and']: filter.filters.map(restFilter) }
  }
  const property = filter.property ?? ''
  const single = (): string | null => {
    const value = filter.value as { value?: unknown } | Array<{ type?: string; value?: unknown }> | undefined
    if (Array.isArray(value)) {
      return value.length === 1 && value[0].type !== 'is_group' ? String(value[0].value) : null
    }
    return value && (value as { type?: string }).type !== 'relative' && value.value !== undefined
      ? String(value.value)
      : null
  }
  const leaf = (type: string, condition: string, value: unknown): NotionViewFilter =>
    value === null ? { property, unsupported: {} } : { property, [type]: { [condition]: value } }
  const text = single()
  switch (filter.operator) {
    case 'is_empty':
      return { property, rich_text: { is_empty: true } }
    case 'is_not_empty':
      return { property, rich_text: { is_not_empty: true } }
    case 'string_is':
      return leaf('rich_text', 'equals', text)
    case 'string_is_not':
      return leaf('rich_text', 'does_not_equal', text)
    case 'string_contains':
      return leaf('rich_text', 'contains', text)
    case 'string_does_not_contain':
      return leaf('rich_text', 'does_not_contain', text)
    case 'enum_is':
      return leaf('select', 'equals', text)
    case 'enum_is_not':
      return leaf('select', 'does_not_equal', text)
    case 'enum_contains':
      return leaf('multi_select', 'contains', text)
    case 'enum_does_not_contain':
      return leaf('multi_select', 'does_not_contain', text)
    case 'status_is':
      return leaf('status', 'equals', text)
    case 'status_is_not':
      return leaf('status', 'does_not_equal', text)
    case 'checkbox_is':
      return leaf('checkbox', 'equals', text === null ? null : text === 'true')
    case 'checkbox_is_not':
      return leaf('checkbox', 'does_not_equal', text === null ? null : text === 'true')
    case 'number_equals':
      return leaf('number', 'equals', text)
    case 'number_does_not_equal':
      return leaf('number', 'does_not_equal', text)
    case 'number_greater_than':
      return leaf('number', 'greater_than', text)
    case 'number_less_than':
      return leaf('number', 'less_than', text)
    case 'date_is':
      return leaf('date', 'equals', text)
    case 'date_is_before':
      return leaf('date', 'before', text)
    case 'date_is_after':
      return leaf('date', 'after', text)
    default:
      return { property, unsupported: {} }
  }
}

function viewFilterParts(view: McpView): McpFilter[] {
  const parts = (view.simpleFilters ?? []).flatMap((item) => (item.filter ? [item.filter] : []))
  if (view.filter) parts.push(view.filter)
  if (view.advancedFilter) parts.push(view.advancedFilter)
  return parts
}

export interface NotionWorkspaceRoot {
  id: string
  title: string
  kind: 'page' | 'database'
}

export interface McpNotionClient extends NotionClient {
  roots(): Promise<NotionWorkspaceRoot[]>
  pageDetails(pageId: string): Promise<Partial<NotionPage>>
}

export function createMcpNotionClient(mcp: NotionMcpTransport): McpNotionClient {
  let counter = 0
  const nextId = (): string => `nfm-${++counter}`
  /** Children of blocks parsed from a page, held until the walker asks. */
  const parsedChildren = new Map<string, NotionBlock[]>()
  /** A fetched page, held from `page` until `blockChildren` uses it. */
  const fetched = new Map<string, FetchedEntity>()
  const fileRefs = new Map<string, { type: string; source: string }>()
  const databaseViews = new Map<string, McpView[]>()
  const sourceDatabase = new Map<string, string>()
  const sourceSchemas = new Map<string, Record<string, NotionPropertySchema>>()
  const incompleteSources = new Set<string>()
  let users: Map<string, string> | null = null

  const fetchEntity = (id: string): Promise<FetchedEntity> =>
    mcp.callTool<FetchedEntity>('fetch', { id, include_file_urls: true })

  const register = (blocks: NotionBlock[]): void => {
    for (const block of blocks) {
      const media = block[block.type] as (NotionFile & { source?: string }) | undefined
      if (media?.source) fileRefs.set(compactNotionId(block.id), { type: block.type, source: media.source })
      if (block.children && block.children.length > 0) {
        parsedChildren.set(block.id, block.children)
        register(block.children)
      }
    }
  }

  const fetchPage = async (id: string): Promise<FetchedEntity> => {
    const key = compactNotionId(id)
    const cached = fetched.get(key)
    if (cached) return cached
    const entity = await fetchEntity(dashedNotionId(id))
    const type = entity.metadata?.type
    if (type && type !== 'page' && type !== 'folder') {
      throw new NotionApiError(400, 'not_a_page', `${id} is a ${type}, not a page.`)
    }
    fetched.set(key, entity)
    return entity
  }

  const toPage = (id: string, entity: FetchedEntity): NotionPage => ({
    object: 'page',
    id: dashedNotionId(id),
    parent: firstAncestor(entity.text ?? ''),
    last_edited_time: entity.page_last_edited_at,
    icon: entity.icon ?? null,
    cover: entity.cover ?? null,
    properties: { title: { id: 'title', type: 'title', title: plainRich(entity.title ?? '') } }
  })

  /** A page too large for one answer leaves `<unknown>` markers: each is fetched
   *  and put back where it sat. */
  const expandTruncated = async (blocks: NotionBlock[]): Promise<NotionBlock[]> => {
    const out: NotionBlock[] = []
    for (const block of blocks) {
      const info = block.unsupported as { block_type?: string; url?: string } | undefined
      if (block.type === 'unsupported' && info?.block_type === 'truncated' && info.url) {
        const id = info.url.split('#')[1] ?? info.url
        try {
          const entity = await fetchEntity(id)
          const content = between(entity.text ?? '', '<content>', '</content>')
          if (content !== null) {
            out.push(...(await expandTruncated(parseNotionMarkdown(content, { nextId, references: entity.references }))))
            continue
          }
          // A link card (GitHub, Figma, Drive) answers as a blank page with a
          // title and no content. The title is what there is to keep.
          const title = /"title":"((?:[^"\\]|\\.)*)"/.exec(entity.text ?? '')?.[1]
          if (title) {
            out.push({
              id: nextId(),
              type: 'paragraph',
              paragraph: { rich_text: plainRich(title.replace(/\\(.)/g, '$1')) }
            })
            continue
          }
        } catch {
          // Stays a placeholder, and the report lists it.
        }
      }
      if (block.children) block.children = await expandTruncated(block.children)
      out.push(block)
    }
    return out
  }

  const databaseEntity = async (id: string): Promise<{ entity: FetchedEntity; text: string }> => {
    const entity = await fetchEntity(dashedNotionId(id))
    if (entity.metadata?.type !== 'database') {
      throw new NotionApiError(404, 'not_a_database', 'This database cannot be read.')
    }
    return { entity, text: entity.text ?? '' }
  }

  const readViews = (text: string): McpView[] => {
    const views: McpView[] = []
    for (const match of text.matchAll(/<view url="\{\{view:\/\/([^}]+)\}\}">\s*([\s\S]*?)\s*<\/view>/g)) {
      try {
        const body = JSON.parse(unwrapUrls(match[2])) as McpView
        views.push({ ...body, id: match[1] })
      } catch {
        // Skip a view it can't read; the rest still import.
      }
    }
    return views
  }

  const userName = async (id: string): Promise<string> => {
    if (!users) {
      users = new Map()
      try {
        const answer = await mcp.callTool<{ results?: Array<{ id: string; name?: string }> }>('get-users', {})
        for (const user of answer.results ?? []) {
          if (user.name) users.set(compactNotionId(user.id), user.name)
        }
      } catch {
        // Names stay blank; the rest of the row is unaffected.
      }
    }
    return users.get(compactNotionId(id)) ?? ''
  }

  const toRow = async (
    row: Record<string, unknown>,
    sourceId: string,
    schema: Record<string, NotionPropertySchema>
  ): Promise<NotionPage> => {
    const url = String(row.url ?? '')
    const id = notionIdFromHref(url) ?? url
    const properties: Record<string, NotionPropertyValue> = {}
    for (const entry of Object.values(schema)) {
      const raw = row[entry.id] ?? row[entry.name]
      const value: NotionPropertyValue = { id: entry.id, type: entry.type }
      const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw)
      switch (entry.type) {
        case 'title':
          value.title = parseCellText(text)
          break
        case 'rich_text':
          value.rich_text = parseCellText(text)
          break
        case 'number':
          value.number = text === '' || Number.isNaN(Number(text)) ? null : Number(text)
          break
        case 'select':
          value.select = text ? { name: text } : null
          break
        case 'status':
          value.status = text ? { name: text } : null
          break
        case 'multi_select':
          value.multi_select = asArray(raw).map((name) => ({ name: String(name) }))
          break
        case 'checkbox':
          value.checkbox = raw === true || text === '__YES__' || text === 'true'
          break
        case 'url':
          value.url = text || null
          break
        case 'email':
          value.email = text || null
          break
        case 'phone_number':
          value.phone_number = text || null
          break
        case 'date': {
          const start = row[`date:${entry.name}:start`] ?? row[`date:${entry.id}:start`] ?? raw
          const end = row[`date:${entry.name}:end`] ?? row[`date:${entry.id}:end`]
          value.date = start ? { start: String(start), end: end ? String(end) : null } : null
          break
        }
        case 'people':
        case 'created_by':
        case 'last_edited_by': {
          const people = []
          for (const item of asArray(raw)) {
            const person = String(item).replace(/^user:\/\//, '')
            people.push({ id: person, name: await userName(person) })
          }
          if (entry.type === 'people') value.people = people
          else if (entry.type === 'created_by') value.created_by = people[0]
          else value.last_edited_by = people[0]
          break
        }
        case 'relation':
          value.relation = asArray(raw).flatMap((item) => {
            const target = notionIdFromHref(String(item))
            return target ? [{ id: target }] : []
          })
          value.has_more = false
          break
        case 'files': {
          const files: NotionFile[] = []
          for (const item of asArray(raw)) {
            const link = String(item)
            if (link.startsWith('notion-file-block://')) {
              // Uploaded to Notion: a reference, swapped for a signed link
              // here, since rows get read in one go and downloaded right after.
              const answer = await mcp.callTool<{ files?: Array<{ url?: string }> }>('get-file-download-urls', {
                references: [link]
              })
              const encoded = /[?&]name=([^&]+)/.exec(link)?.[1] ?? 'file'
              let name = encoded
              try {
                name = decodeURIComponent(encoded)
              } catch {
                // Keep it as written.
              }
              files.push({ type: 'file', name, file: { url: answer.files?.[0]?.url ?? '' } })
            } else {
              files.push({ type: 'external', name: link.split('?')[0].split('/').pop() ?? link, external: { url: link } })
            }
          }
          value.files = files
          break
        }
        case 'created_time':
          value.created_time = text
          break
        case 'last_edited_time':
          value.last_edited_time = text
          break
        case 'formula':
        case 'rollup': {
          const computed =
            typeof raw === 'number'
              ? { type: 'number', number: raw }
              : typeof raw === 'boolean'
                ? { type: 'boolean', boolean: raw }
                : text !== '' && !Number.isNaN(Number(text))
                  ? { type: 'number', number: Number(text) }
                  : text === '__YES__' || text === '__NO__'
                    ? { type: 'boolean', boolean: text === '__YES__' }
                    : { type: 'string', string: text }
          if (entry.type === 'formula') value.formula = computed
          else value.rollup = computed
          break
        }
        default:
          break
      }
      properties[entry.name] = value
    }
    return {
      object: 'page',
      id: dashedNotionId(id),
      parent: { type: 'data_source_id', data_source_id: dashedNotionId(sourceId) },
      properties
    }
  }

  const client: McpNotionClient = {
    me: async () => {
      const self = await mcp.callTool<{ workspace?: { name?: string } }>('get-self', {})
      return { bot: { workspace_name: self.workspace?.name ?? null } }
    },

    roots: async () => {
      const found = new Map<string, NotionWorkspaceRoot>()
      const take = (item: { type?: string; url?: string; id?: string; title?: string }): void => {
        const id = item.url ? notionIdFromHref(item.url) : item.id ? compactNotionId(item.id) : null
        if (!id || found.has(id)) return
        found.set(id, {
          id,
          title: item.title?.trim() || 'Untitled',
          kind: item.type === 'database' ? 'database' : 'page'
        })
      }
      for (const tool of ['list-private-pages', 'list-shared-pages']) {
        let cursor: string | undefined
        do {
          const answer: {
            results?: Array<{ type?: string; url?: string; title?: string }>
            next_cursor?: string | null
            nextCursor?: string | null
          } = await mcp.callTool(tool, { limit: 200, ...(cursor ? { cursor } : {}) })
          for (const item of answer.results ?? []) take(item)
          cursor = answer.next_cursor ?? answer.nextCursor ?? undefined
        } while (cursor)
      }
      // Teamspaces have no list of their own here, so search each one and
      // climb from what it finds to the pages at the top.
      try {
        const teams = await mcp.callTool<{ joinedTeams?: Array<{ id: string }>; otherTeams?: Array<{ id: string }> }>(
          'get-teams',
          {}
        )
        for (const team of [...(teams.joinedTeams ?? []), ...(teams.otherTeams ?? [])]) {
          const answer = await mcp.callTool<{
            results?: Array<{ id?: string; url?: string; title?: string; path?: string; type?: string }>
          }>('search', { query: 'a', teamspace_id: team.id, page_size: 50, max_highlight_length: 0 })
          for (const item of answer.results ?? []) if (!item.path) take(item)
        }
      } catch {
        // A workspace without teamspaces, or a plan that hides them.
      }
      return [...found.values()]
    },

    search: async () => {
      const results: Array<NotionPage | NotionDataSource> = []
      for (const root of await client.roots()) {
        if (root.kind === 'database') {
          // A stub: collect reads the source when its turn comes.
          const database = await client.database(root.id)
          for (const source of database.data_sources ?? []) {
            results.push({ object: 'data_source', id: source.id })
          }
        } else {
          results.push({ object: 'page', id: dashedNotionId(root.id) })
        }
      }
      return { results, incomplete: false }
    },

    page: async (pageId) => toPage(pageId, await fetchPage(pageId)),

    pageDetails: async (pageId) => {
      const entity = await fetchPage(pageId)
      return {
        last_edited_time: entity.page_last_edited_at,
        cover: entity.cover ?? null,
        icon: entity.icon ?? null
      }
    },

    blockChildren: async (blockId) => {
      const parsed = parsedChildren.get(blockId)
      if (parsed) {
        parsedChildren.delete(blockId)
        return parsed
      }
      const key = compactNotionId(blockId)
      const entity = await fetchPage(blockId)
      fetched.delete(key)
      const text = entity.text ?? ''
      const content = between(text, '<content>', '</content>') ?? ''
      const blocks = await expandTruncated(
        parseNotionMarkdown(content, { nextId, references: entity.references })
      )
      register(blocks)
      return blocks
    },

    block: async (blockId) => {
      const ref = fileRefs.get(compactNotionId(blockId))
      if (!ref) return { id: blockId, type: 'paragraph' }
      const answer = await mcp.callTool<{ files?: Array<{ reference?: string; url?: string }> }>(
        'get-file-download-urls',
        { references: [ref.source] }
      )
      const url = answer.files?.[0]?.url ?? ''
      return { id: blockId, type: ref.type, [ref.type]: { type: 'file', file: { url } } }
    },

    database: async (databaseId) => {
      const { entity, text } = await databaseEntity(databaseId)
      const sources = [...text.matchAll(/<data-source url="\{\{collection:\/\/([^}]+)\}\}">/g)].map((match) => ({
        id: match[1]
      }))
      const compact = compactNotionId(databaseId)
      databaseViews.set(compact, readViews(text))
      for (const source of sources) sourceDatabase.set(compactNotionId(source.id), compact)
      const title = /The title of this Database is: (.*)/.exec(text)?.[1]?.trim() ?? entity.title ?? ''
      return {
        object: 'database',
        id: dashedNotionId(databaseId),
        title: plainRich(title),
        parent: firstAncestor(text),
        data_sources: sources
      } as NotionDatabase
    },

    dataSource: async (dataSourceId) => {
      const entity = await fetchEntity(`collection://${dashedNotionId(dataSourceId)}`)
      const text = entity.text ?? ''
      const state = between(text, '<data-source-state>', '</data-source-state>')
      if (!state) throw new NotionApiError(404, 'no_schema', 'This data source has no readable schema.')
      const parsed = JSON.parse(unwrapUrls(state)) as {
        name?: string
        schema?: Record<string, McpSchemaEntry>
      }
      const properties: Record<string, NotionPropertySchema> = {}
      for (const [key, entry] of Object.entries(parsed.schema ?? {})) {
        const schema = toSchema(key, entry)
        properties[schema.name] = schema
      }
      const compact = compactNotionId(dataSourceId)
      sourceSchemas.set(compact, properties)
      const databaseId = entity.url ? notionIdFromHref(entity.url) : null
      if (databaseId) sourceDatabase.set(compact, databaseId)
      return {
        object: 'data_source',
        id: dashedNotionId(dataSourceId),
        title: plainRich(parsed.name ?? entity.title ?? ''),
        ...(databaseId ? { parent: { type: 'database_id', database_id: dashedNotionId(databaseId) } } : {}),
        properties
      }
    },

    queryDataSource: async (dataSourceId) => {
      const compact = compactNotionId(dataSourceId)
      const dashed = dashedNotionId(dataSourceId)
      const schema = sourceSchemas.get(compact) ?? {}
      const url = `collection://${dashed}`
      const convert = (rows: Array<Record<string, unknown>>): Promise<NotionPage[]> =>
        Promise.all(rows.map((row) => toRow(row, dashed, schema)))

      // A view with no filter lists everything and has no quota.
      const databaseId = sourceDatabase.get(compact)
      const views = (databaseId ? databaseViews.get(databaseId) : undefined) ?? []
      const open = views.find(
        (view) =>
          viewFilterParts(view).length === 0 &&
          (!view.dataSourceUrl || compactNotionId(unwrapBraces(view.dataSourceUrl).replace('collection://', '')) === compact)
      )
      if (open) {
        const rows: Array<Record<string, unknown>> = []
        let cursor: string | undefined
        do {
          const page: { results?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string | null } =
            await mcp.callTool('query-data-sources', {
              data: {
                mode: 'view',
                view_url: `view://${open.id}`,
                page_size: 100,
                ...(cursor ? { start_cursor: cursor } : {})
              }
            })
          rows.push(...(page.results ?? []))
          cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
        } while (cursor)
        return convert(rows)
      }

      // Every view is filtered. Up to 100 rows fit one unfiltered answer.
      const first = await mcp.callTool<{ results?: Array<Record<string, unknown>>; has_more?: boolean }>(
        'query-data-sources',
        { data: { mode: 'rows', data_source_url: url, limit: 100 } }
      )
      if (!first.has_more) return convert(first.results ?? [])

      // Past that only SQL reads everything, and it can run into a plan's quota.
      const rows = new Map<string, Record<string, unknown>>()
      const add = (results: Array<Record<string, unknown>> | undefined): void => {
        for (const row of results ?? []) rows.set(String(row.url ?? rows.size), row)
      }
      add(first.results)
      try {
        for (let offset = 0; ; offset += 100) {
          const page = await mcp.callTool<{ results?: Array<Record<string, unknown>> }>('query-data-sources', {
            data: {
              data_source_urls: [url],
              query: `SELECT * FROM "${url}" LIMIT 100 OFFSET ${offset}`
            }
          })
          add(page.results)
          if ((page.results ?? []).length < 100) break
        }
      } catch (error) {
        if (error instanceof NotionApiError && error.isAuth) throw error
        // Over quota. The filtered views are free, so take what they show, and
        // say the database may be short rather than let it pass as whole.
        incompleteSources.add(compact)
        for (const view of views) {
          let cursor: string | undefined
          do {
            const page: { results?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string | null } =
              await mcp.callTool('query-data-sources', {
                data: {
                  mode: 'view',
                  view_url: `view://${view.id}`,
                  page_size: 100,
                  ...(cursor ? { start_cursor: cursor } : {})
                }
              })
            add(page.results)
            cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
          } while (cursor)
        }
      }
      return convert([...rows.values()])
    },

    rowsIncomplete: (dataSourceId) => incompleteSources.has(compactNotionId(dataSourceId)),

    views: async (databaseId) => {
      const views = databaseViews.get(compactNotionId(databaseId)) ?? []
      const schemaKeys = new Set(
        [...sourceSchemas.values()].flatMap((properties) => Object.values(properties).map((entry) => entry.id))
      )
      return views.map((view): NotionView => {
        const parts = viewFilterParts(view)
        const shown = view.displayProperties ?? []
        const group = typeof view.groupBy === 'string' ? view.groupBy : view.groupBy?.property
        return {
          object: 'view',
          id: view.id,
          name: view.name,
          type: view.type ?? 'table',
          filter: parts.length === 0 ? null : parts.length === 1 ? restFilter(parts[0]) : { and: parts.map(restFilter) },
          sorts: (view.sorts ?? []).map((sort) => ({ property: sort.property, direction: sort.direction })),
          configuration: {
            type: view.type,
            properties: [
              ...shown.map((key) => ({
                property_id: key,
                visible: true,
                ...(view.columnWidths?.[key] ? { width: view.columnWidths[key] } : {})
              })),
              // Here a column left out of the list is a hidden one.
              ...[...schemaKeys]
                .filter((key) => shown.length > 0 && !shown.includes(key))
                .map((key) => ({ property_id: key, visible: false }))
            ],
            group_by: group ? { property_id: group } : null
          }
        }
      })
    },

    propertyItems: async () => []
  }
  return client
}
