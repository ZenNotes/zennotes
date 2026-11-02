/** What rendering asks of the rest of the import. Lookups go through here so
 *  the renderers stay pure and every link and file is resolved in one place. */

export type NotionIssueKind =
  | 'unsupported-block'
  | 'unknown-block'
  | 'linked-database'
  | 'unresolved-link'
  | 'file-missing'
  | 'page-failed'
  | 'view-converted'
  | 'filter-dropped'
  | 'sort-dropped'
  | 'computed-empty'
  | 'option-renamed'
  | 'search-incomplete'
  | 'rows-capped'
  | 'views-unavailable'

export interface NotionIssue {
  kind: NotionIssueKind
  detail: string
  /** The page or database it happened on, when there is one. */
  nodeId?: string
}

export interface NotionLinkTarget {
  /** A `[[wikilink]]` target: a vault-relative path with no extension, or a
   *  database's title. */
  target: string
  title: string
}

export interface NotionAsset {
  /** Vault-relative path of the file as it will sit in the vault. */
  path: string
  name: string
}

export interface NotionRenderContext {
  resolvePage(id: string): NotionLinkTarget | null
  /** A database block can hold several data sources, each its own database
   *  here. Empty when the database can't be read (a linked database). */
  resolveDatabase(id: string): NotionLinkTarget[]
  assetFor(key: string): NotionAsset | null
  /** The person left this page or database out of the import. */
  isExcluded?(id: string): boolean
  issue(kind: NotionIssueKind, detail: string): void
}
