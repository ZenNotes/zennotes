/**
 * `note` / `noteMulti` cells store `[[wikilink]]` targets , `[[A]]`, or
 * `[[A]] [[B]]` space-joined for multi (bracket-delimited, so titles with
 * commas survive where multiSelect's comma-joined encoding cannot). Older
 * builds neither validate nor migrate unknown types: they render such cells
 * as plain text and round-trip the schema untouched, which is the intended
 * degradation. (#500)
 */
export type FieldType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multiSelect'
  | 'note'
  | 'noteMulti'

export interface SelectOption {
  id: string
  /** The literal stored in the CSV cell. */
  value: string
  /** Display override; defaults to `value`. */
  label?: string
  /** Palette token name (not a raw hex), mapped to a chip color by the UI. */
  color?: string
}

/**
 * Where a select / multiSelect field discovers pickable values beyond its
 * hand-added options: every note, a folder subtree (vault-relative path
 * prefix), or a #tag. Discovery is a picker convenience only , a picked note
 * still commits as a plain option through the normal path, so boards,
 * filters, and older builds see ordinary select values. Absent = manual. (#500)
 */
export type SelectOptionsSource =
  | { kind: 'notes' }
  | { kind: 'folder'; path: string }
  | { kind: 'tag'; tag: string }

export interface DbField {
  /** Stable uuid referenced by rows/views , NOT the CSV header. */
  id: string
  /** The CSV column header (display + the header text written to disk). */
  name: string
  type: FieldType
  /** For `select` / `multiSelect`. */
  options?: SelectOption[]
  /** For `select` / `multiSelect`: auto-discover options from notes. */
  optionsSource?: SelectOptionsSource
  /** Table column width in px. */
  width?: number
  /** Hidden in the Table view by default (e.g. the id field). */
  hidden?: boolean
}

export type FilterOp =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'notContains'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'gt'
  | 'lt'
  | 'before'
  | 'after'
  | 'checked'
  | 'unchecked'

export interface FilterRule {
  fieldId: string
  op: FilterOp
  value?: string
}

/** How a view's multiple filter conditions combine. `and` = match all (the
 *  default, backward-compatible), `or` = match any. (#394) */
export type FilterConjunction = 'and' | 'or'

export interface SortRule {
  fieldId: string
  direction: 'asc' | 'desc'
}

export type DbViewType = 'table' | 'board'

export interface DbView {
  id: string
  name: string
  type: DbViewType
  filters: FilterRule[]
  /** How the `filters` combine , `and` (match all, default) or `or` (match
   *  any). Optional so existing views keep their AND behavior. (#394) */
  filterConjunction?: FilterConjunction
  sorts: SortRule[]
  // --- table ---
  /** Ordered fieldIds (display order). */
  columnOrder?: string[]
  hiddenFieldIds?: string[]
  columnWidths?: Record<string, number>
  // --- board ---
  /** Must reference a `select` field. */
  groupByFieldId?: string
  /** Order of board columns; values are SelectOption.value (+ EMPTY_GROUP). */
  boardColumnOrder?: string[]
  /** Per-card visible fields. */
  cardFieldIds?: string[]
}

/** The sidecar JSON written to `<Name>.base/schema.json`. */
export interface DatabaseSidecar {
  version: 1
  /** Field whose cells hold the row UUID (its `name` is the CSV header). */
  idFieldId: string
  /** Order == on-disk CSV column order. */
  fields: DbField[]
  views: DbView[]
  activeViewId: string
  /** Row id → vault path of that record's "page" note (created on demand). */
  pages?: Record<string, string>
}

/**
 * Tabular contents a database is created with, when it starts from existing
 * data rather than empty: a header row and body rows of raw cell strings,
 * index-aligned. A Markdown table converted in place arrives this way (#832).
 * Per-column pixel widths, when given, follow the same column order so a
 * table whose columns were resized keeps those widths in the grid.
 */
export interface DatabaseSeed {
  headers: string[]
  rows: string[][]
  columnWidths?: Array<number | null>
}

/** Cells are raw CSV strings keyed by DbField.id. */
export interface DbRow {
  /** == cells[idFieldId]. */
  id: string
  cells: Record<string, string>
}

/** Fully-hydrated database handed to the renderer (sidecar + rows + identity). */
export interface DatabaseDoc extends DatabaseSidecar {
  /** Vault-relative POSIX path of the `data.csv` , identity / cache key. */
  path: string
  /** Database name: the `.base` folder name (legacy: the `.csv` basename). */
  title: string
  rows: DbRow[]
  /**
   * Row id → whether that record's linked page note has body content (beyond
   * frontmatter + the title heading). Derived on read; not persisted.
   */
  pageHasContent?: Record<string, boolean>
}

/** Lightweight listing entry for database discovery (sidebar / quick-open). */
export interface DatabaseSummary {
  path: string
  title: string
}
