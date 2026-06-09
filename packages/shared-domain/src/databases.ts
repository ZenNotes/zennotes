/**
 * CSV-backed "Databases" — a general data primitive (à la Notion / Obsidian
 * Bases). A `.csv` file in the vault is a database: rows are records, columns
 * are typed fields. The same data is shown through multiple VIEWS (an editable
 * Table and a Board grouped by a field).
 *
 * On disk a database is a pair:
 *   <folder>/<Name>.csv            — the data (an `id` UUID column gives rows a
 *                                    stable identity across external edits)
 *   <folder>/<Name>.csv.base.json  — the sidecar: field types, select options,
 *                                    and view definitions (a CSV can't hold these)
 *
 * This module is PURE (no node/DOM imports) so it is shared by the main process
 * and the renderer. Cell values are stored as raw CSV strings; the field type
 * drives parse/format/compare at the edges (lossless round-trips, no coercion
 * on load).
 */

export const DATABASE_SIDECAR_SUFFIX = '.base.json'
export const DEFAULT_ID_FIELD_NAME = 'id'
/** Board column key for rows whose group-by cell is empty/unmatched. */
export const EMPTY_GROUP = '__empty__'

export type FieldType = 'text' | 'number' | 'checkbox' | 'date' | 'select' | 'multiSelect'

export interface SelectOption {
  id: string
  /** The literal stored in the CSV cell. */
  value: string
  /** Display override; defaults to `value`. */
  label?: string
  /** Palette token name (not a raw hex), mapped to a chip color by the UI. */
  color?: string
}

export interface DbField {
  /** Stable uuid referenced by rows/views — NOT the CSV header. */
  id: string
  /** The CSV column header (display + the header text written to disk). */
  name: string
  type: FieldType
  /** For `select` / `multiSelect`. */
  options?: SelectOption[]
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

/** The sidecar JSON written to `<name>.csv.base.json`. */
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

/** Cells are raw CSV strings keyed by DbField.id. */
export interface DbRow {
  /** == cells[idFieldId]. */
  id: string
  cells: Record<string, string>
}

/** Fully-hydrated database handed to the renderer (sidecar + rows + identity). */
export interface DatabaseDoc extends DatabaseSidecar {
  /** Vault-relative POSIX path of the `.csv` — identity / cache key. */
  path: string
  /** Basename without `.csv`. */
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

// ---------------------------------------------------------------------------
// Virtual tab-path helpers (mirror lib/asset-tabs.ts). A database opens as a
// virtual tab keyed by the real CSV path, so it never hits the markdown
// pipeline but the path stays recoverable for IPC.
// ---------------------------------------------------------------------------

const DATABASE_TAB_PREFIX = 'zen://database/'

export function databaseTabPath(csvPath: string): string {
  return `${DATABASE_TAB_PREFIX}${encodeURIComponent(csvPath.replace(/^\/+/, ''))}`
}

export function isDatabaseTabPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(DATABASE_TAB_PREFIX)
}

export function csvPathFromDatabaseTab(path: string | null | undefined): string | null {
  if (!path || !isDatabaseTabPath(path)) return null
  const encoded = path.slice(DATABASE_TAB_PREFIX.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

export function databaseTitleFromTab(path: string | null | undefined): string {
  const csv = csvPathFromDatabaseTab(path)
  if (!csv) return 'Database'
  const base = csv.split('/').filter(Boolean).pop() ?? csv
  return base.replace(/\.csv$/i, '')
}

/** True for the sidecar file path (`*.csv.base.json`). */
export function isDatabaseSidecarPath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(`.csv${DATABASE_SIDECAR_SUFFIX}`)
}

/**
 * True for files that belong to a database but aren't the user-facing `.csv` —
 * the sidecar and any `.bak` backups. These are hidden from the note list.
 */
export function isDatabaseInternalPath(relPath: string): boolean {
  const l = relPath.toLowerCase()
  return (
    l.endsWith(`.csv${DATABASE_SIDECAR_SUFFIX}`) ||
    l.endsWith('.csv.bak') ||
    l.endsWith(`.csv${DATABASE_SIDECAR_SUFFIX}.bak`)
  )
}

/** True for a database data file (`*.csv`, but not the sidecar). */
export function isDatabaseCsvPath(relPath: string): boolean {
  const lower = relPath.toLowerCase()
  return lower.endsWith('.csv') && !lower.endsWith(`.csv${DATABASE_SIDECAR_SUFFIX}`)
}

/** Given a `.csv` or its `.base.json` sidecar, return the canonical `.csv` path. */
export function databaseCsvPathFor(relPath: string): string | null {
  if (isDatabaseSidecarPath(relPath)) return relPath.slice(0, -DATABASE_SIDECAR_SUFFIX.length)
  if (isDatabaseCsvPath(relPath)) return relPath
  return null
}
