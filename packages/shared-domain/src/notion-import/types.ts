/**
 * The parts of Notion's API this importer reads, as API version 2025-09-03
 * returns them. Only what the conversion looks at is typed: Notion adds block
 * types without notice ("Do not rely on a fixed set of values"), so every
 * reader has to survive a type or field it has never seen.
 */

export interface NotionAnnotations {
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  underline?: boolean
  code?: boolean
  color?: string
}

export interface NotionMention {
  type: string
  page?: { id: string }
  database?: { id: string }
  user?: { id: string; name?: string | null }
  date?: NotionDate
  link_preview?: { url: string }
  link_mention?: { href: string; title?: string }
  custom_emoji?: { id: string; name: string; url: string }
}

export interface NotionRichText {
  type: string
  plain_text: string
  href?: string | null
  annotations?: NotionAnnotations
  text?: { content: string; link?: { url: string } | null }
  mention?: NotionMention
  equation?: { expression: string }
}

export interface NotionDate {
  start: string
  end?: string | null
  time_zone?: string | null
}

/** The shape every Notion file reference shares: media blocks, covers, and the
 *  entries of a `files` property. */
export interface NotionFile {
  type?: string
  name?: string
  caption?: NotionRichText[]
  file?: { url: string; expiry_time?: string }
  external?: { url: string }
}

export interface NotionBlock {
  object?: string
  id: string
  type: string
  has_children?: boolean
  in_trash?: boolean
  archived?: boolean
  /** Filled in by the importer; the API never nests children in a listing. */
  children?: NotionBlock[]
  [blockType: string]: unknown
}

export type NotionParent =
  | { type: 'workspace'; workspace?: boolean }
  | { type: 'page_id'; page_id: string }
  | { type: 'block_id'; block_id: string }
  | { type: 'database_id'; database_id: string }
  | { type: 'data_source_id'; data_source_id: string; database_id?: string }
  | { type: string; [key: string]: unknown }

export interface NotionIcon {
  type: string
  emoji?: string
  [key: string]: unknown
}

export interface NotionUser {
  id: string
  name?: string | null
  person?: { email?: string }
}

/** A property value on a page. Which field is present follows `type`. */
export interface NotionPropertyValue {
  id: string
  type: string
  title?: NotionRichText[]
  rich_text?: NotionRichText[]
  number?: number | null
  select?: { id?: string; name: string; color?: string } | null
  status?: { id?: string; name: string; color?: string } | null
  multi_select?: Array<{ id?: string; name: string; color?: string }>
  date?: NotionDate | null
  checkbox?: boolean
  url?: string | null
  email?: string | null
  phone_number?: string | null
  people?: NotionUser[]
  created_by?: NotionUser
  last_edited_by?: NotionUser
  created_time?: string
  last_edited_time?: string
  files?: NotionFile[]
  relation?: Array<{ id: string }>
  has_more?: boolean
  formula?: NotionComputedValue
  rollup?: NotionRollupValue
  unique_id?: { prefix?: string | null; number?: number | null }
  verification?: { state?: string } | null
  [other: string]: unknown
}

export interface NotionComputedValue {
  type: string
  string?: string | null
  number?: number | null
  boolean?: boolean | null
  date?: NotionDate | null
}

export interface NotionRollupValue extends NotionComputedValue {
  array?: NotionPropertyValue[]
  function?: string
}

export interface NotionPage {
  object?: 'page'
  id: string
  created_time?: string
  last_edited_time?: string
  in_trash?: boolean
  archived?: boolean
  parent?: NotionParent
  icon?: NotionIcon | null
  cover?: NotionFile | null
  url?: string
  properties?: Record<string, NotionPropertyValue>
}

export interface NotionSelectOption {
  id?: string
  name: string
  color?: string
}

/** One column in a data source's schema. */
export interface NotionPropertySchema {
  id: string
  name: string
  type: string
  select?: { options?: NotionSelectOption[] }
  status?: { options?: NotionSelectOption[] }
  multi_select?: { options?: NotionSelectOption[] }
  relation?: { data_source_id?: string; database_id?: string }
  [other: string]: unknown
}

export interface NotionDataSource {
  object?: 'data_source'
  id: string
  title?: NotionRichText[]
  parent?: NotionParent
  database_parent?: NotionParent
  in_trash?: boolean
  archived?: boolean
  properties?: Record<string, NotionPropertySchema>
}

export interface NotionDatabase {
  object?: 'database'
  id: string
  title?: NotionRichText[]
  parent?: NotionParent
  is_inline?: boolean
  in_trash?: boolean
  data_sources?: Array<{ id: string; name?: string }>
}

export interface NotionViewProperty {
  property_id: string
  visible?: boolean
  width?: number
}

export interface NotionViewFilter {
  property?: string
  timestamp?: string
  and?: NotionViewFilter[]
  or?: NotionViewFilter[]
  [propertyType: string]: unknown
}

export interface NotionView {
  object?: 'view'
  id: string
  name?: string
  type: string
  filter?: NotionViewFilter | null
  sorts?: Array<{ property?: string; timestamp?: string; direction?: string }> | null
  configuration?: {
    type?: string
    properties?: NotionViewProperty[]
    group_by?: { type?: string; property_id?: string } | null
  } | null
}

export interface NotionListResponse<T> {
  results: T[]
  next_cursor?: string | null
  has_more?: boolean
  request_status?: string
}

/** A Notion id with its dashes removed and lowercased, the one form the
 *  importer compares and keys by: the API prints ids dashed and URLs print
 *  them bare. */
export function compactNotionId(id: string): string {
  return id.replace(/-/g, '').toLowerCase()
}

const NOTION_HOST = /(^|\.)(notion\.so|notion\.com|notion\.site)$/i

/**
 * The page a link points at when it points inside Notion, or null. Internal
 * links arrive as `/<id>` or `/<id>#<block>` in text, and as full URLs in
 * mentions and pasted links, where a slug may lead the id (`My-Page-<id>`).
 * The block part is dropped: the importer links to the page.
 */
export function notionIdFromHref(href: string): string | null {
  let pathname: string
  if (href.startsWith('/')) {
    pathname = href.split(/[?#]/)[0]
  } else {
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return null
    }
    if (!NOTION_HOST.test(url.hostname)) return null
    pathname = url.pathname
  }
  const tail = pathname.split('/').filter(Boolean).pop() ?? ''
  const match = /([0-9a-f]{32})$/i.exec(tail.replace(/-/g, ''))
  return match ? match[1].toLowerCase() : null
}

export function plainText(rich: NotionRichText[] | undefined | null): string {
  return (rich ?? []).map((item) => item.plain_text ?? '').join('')
}

/** A page's title: the `title` property, whatever its column is named. */
export function notionPageTitle(page: NotionPage): string {
  for (const value of Object.values(page.properties ?? {})) {
    if (value?.type === 'title') return plainText(value.title).trim()
  }
  return ''
}
