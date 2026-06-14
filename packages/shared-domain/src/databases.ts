/**
 * CSV-backed "Databases" — a general data primitive (à la Notion / Obsidian
 * Bases). A `.csv` file in the vault is a database: rows are records, columns
 * are typed fields. The same data is shown through multiple VIEWS (an editable
 * Table and a Board grouped by a field).
 *
 * On disk a database is ONE self-contained folder whose name ends with the
 * reserved `.base` suffix (so it never collides with an ordinary folder):
 *   <Name>.base/data.csv      — the data (an `id` UUID column gives rows a
 *                               stable identity across external edits)
 *   <Name>.base/schema.json   — field types, select options, view definitions,
 *                               and the row→page map (a CSV can't hold these)
 *   <Name>.base/pages/        — the record-page notes (one `.md` per record)
 * The form's identity / cache key is its `data.csv` path; its title is the
 * folder name minus `.base`. Because everything lives in one folder, rename =
 * folder rename and trash/move = folder move (no path rewriting). Record-page
 * paths in `schema.json` are stored RELATIVE to the folder for the same reason.
 *
 * This module is PURE (no node/DOM imports) so it is shared by the main process
 * and the renderer. Cell values are stored as raw CSV strings; the field type
 * drives parse/format/compare at the edges (lossless round-trips, no coercion
 * on load).
 */

/** Legacy sidecar suffix (`<Name>.csv.base.json`) — kept only for path guards. */
export const DATABASE_SIDECAR_SUFFIX = '.base.json'
export const DEFAULT_ID_FIELD_NAME = 'id'
/** Board column key for rows whose group-by cell is empty/unmatched. */
export const EMPTY_GROUP = '__empty__'

/** A form/database lives in a folder whose name ends with this suffix. */
export const FORM_DIR_SUFFIX = '.base'
/** Fixed names of a form folder's contents. */
export const FORM_DATA_FILE = 'data.csv'
export const FORM_SCHEMA_FILE = 'schema.json'
export const FORM_PAGES_DIR = 'pages'

const toPosixPath = (p: string): string => p.replace(/\\/g, '/')
const lastSegment = (p: string): string => {
  const s = toPosixPath(p)
  return s.slice(s.lastIndexOf('/') + 1)
}

/** True when a folder name (or a path's last segment) marks a form folder. */
export function isFormDirName(nameOrPath: string): boolean {
  return lastSegment(nameOrPath).toLowerCase().endsWith(FORM_DIR_SUFFIX)
}

/**
 * The form folder path for a form's `data.csv` path, or null when `csvPath`
 * isn't a form data file. e.g. `a/X.base/data.csv` → `a/X.base`.
 */
export function formDirFromCsvPath(csvPath: string): string | null {
  const p = toPosixPath(csvPath)
  const slash = p.lastIndexOf('/')
  if (slash < 0) return null
  const dir = p.slice(0, slash)
  const file = p.slice(slash + 1)
  if (file.toLowerCase() !== FORM_DATA_FILE) return null
  return isFormDirName(dir) ? dir : null
}

/** The `data.csv` path for a form folder path. e.g. `a/X.base` → `a/X.base/data.csv`. */
export function csvPathForFormDir(formDir: string): string {
  return `${toPosixPath(formDir)}/${FORM_DATA_FILE}`
}

/** The `schema.json` path for a form's `data.csv` path, or null. */
export function databaseSchemaPathFor(csvPath: string): string | null {
  const dir = formDirFromCsvPath(csvPath)
  return dir ? `${dir}/${FORM_SCHEMA_FILE}` : null
}

/** Display title from a form folder name/path (strips the `.base` suffix). */
export function formTitleFromDir(nameOrPath: string): string {
  const name = lastSegment(nameOrPath)
  return name.toLowerCase().endsWith(FORM_DIR_SUFFIX)
    ? name.slice(0, -FORM_DIR_SUFFIX.length)
    : name
}

/** Display title from a form's `data.csv` path. */
export function formTitleFromCsvPath(csvPath: string): string {
  const dir = formDirFromCsvPath(csvPath)
  return dir ? formTitleFromDir(dir) : csvPath
}

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
  /** Template id applied to the BODY of newly-created record pages (the record
   *  frontmatter is always composed from the row's cells). */
  recordPageTemplate?: string
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
  if (!csv) return 'Base'
  // A form's title is its `<Name>.base` folder name, not the `data.csv` basename.
  if (formDirFromCsvPath(csv)) return formTitleFromCsvPath(csv)
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

/**
 * Given any file that belongs to a form (`data.csv` or `schema.json`), return
 * the canonical `data.csv` path; null otherwise. Used to normalize a watcher
 * event on any form file back to the form's identity.
 */
export function databaseCsvPathFor(relPath: string): string | null {
  const p = relPath.replace(/\\/g, '/')
  if (p.toLowerCase().endsWith(`/${FORM_SCHEMA_FILE}`)) {
    const dir = p.slice(0, p.lastIndexOf('/'))
    if (isFormDirName(dir)) return `${dir}/${FORM_DATA_FILE}`
  }
  if (formDirFromCsvPath(p)) return p
  // Legacy: a `<Name>.csv.base.json` sidecar maps to its `.csv`.
  if (isDatabaseSidecarPath(p)) return p.slice(0, -DATABASE_SIDECAR_SUFFIX.length)
  if (isDatabaseCsvPath(p)) return p
  return null
}
