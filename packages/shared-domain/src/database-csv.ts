/**
 * Pure CSV (de)serialization + schema inference for the Databases feature.
 *
 * Hand-rolled RFC-4180 parser/serializer (no dependency) so `shared-domain`
 * stays dependency-free. Round-trip fidelity (embedded commas, double-quotes,
 * newlines, CRLF) is covered by unit tests. `multiSelect` uses a second layer
 * of encoding inside a single cell ("a, b") — option values therefore may not
 * contain commas (enforced when options are created).
 */
import type { DbField, DbRow, DbView, FieldType } from './databases'
import { DEFAULT_ID_FIELD_NAME } from './databases'

/** Injectable id factory (main passes node's randomUUID; tests pass a counter). */
export type GenId = () => string

export const defaultGenId: GenId = () => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `r-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

// ---------------------------------------------------------------------------
// Low-level RFC-4180 CSV
// ---------------------------------------------------------------------------

/** Parse CSV text into a grid of string cells. Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0 // strip BOM
  const n = text.length

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    // Drop blank lines (a single empty field).
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }

  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
    } else if (ch === ',') {
      endField()
      i++
    } else if (ch === '\r') {
      endRow()
      i += text[i + 1] === '\n' ? 2 : 1
    } else if (ch === '\n') {
      endRow()
      i++
    } else {
      field += ch
      i++
    }
  }
  // Flush trailing field/row unless the text ended exactly on a row boundary.
  if (field !== '' || row.length > 0) endRow()
  return rows
}

function serializeCell(value: string): string {
  if (value === '') return ''
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** Serialize a grid to RFC-4180 CSV text (LF newlines, trailing newline). */
export function serializeCsv(rows: string[][]): string {
  if (rows.length === 0) return ''
  return `${rows.map((r) => r.map(serializeCell).join(',')).join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Schema-aware rows
// ---------------------------------------------------------------------------

/**
 * Hydrate rows from CSV text given the known fields. Columns are matched to
 * fields by header NAME (robust to external column reordering). Rows missing an
 * id cell get a fresh UUID. Returns rows keyed by field.id.
 */
export function parseRows(
  csvText: string,
  fields: DbField[],
  idFieldId: string,
  genId: GenId = defaultGenId
): DbRow[] {
  const grid = parseCsv(csvText)
  if (grid.length === 0) return []
  const headers = grid[0]
  // header name -> column index
  const colByName = new Map<string, number>()
  headers.forEach((h, idx) => {
    if (!colByName.has(h)) colByName.set(h, idx)
  })
  const idField = fields.find((f) => f.id === idFieldId)

  const out: DbRow[] = []
  for (let r = 1; r < grid.length; r++) {
    const raw = grid[r]
    const cells: Record<string, string> = {}
    for (const field of fields) {
      const col = colByName.get(field.name)
      cells[field.id] = col === undefined ? '' : (raw[col] ?? '')
    }
    let id = idField ? cells[idField.id] : ''
    if (!id) {
      id = genId()
      if (idField) cells[idField.id] = id
    }
    out.push({ id, cells })
  }
  return out
}

/** Serialize rows back to CSV text (header from field.name in field order). */
export function serializeRows(rows: DbRow[], fields: DbField[]): string {
  const header = fields.map((f) => f.name)
  const body = rows.map((row) => fields.map((f) => row.cells[f.id] ?? ''))
  return serializeCsv([header, ...body])
}

// ---------------------------------------------------------------------------
// Inference (opening a CSV that has no sidecar yet)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const BOOL_TRUE = new Set(['true', 'x', '1', 'yes', 'checked'])
const BOOL_FALSE = new Set(['false', '', '0', 'no', 'unchecked'])

function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function inferColumnType(samples: string[]): FieldType {
  const nonEmpty = samples.map((s) => s.trim()).filter((s) => s.length > 0)
  if (nonEmpty.length === 0) return 'text'
  if (nonEmpty.every((s) => BOOL_TRUE.has(s.toLowerCase()) || BOOL_FALSE.has(s.toLowerCase())))
    return 'checkbox'
  if (nonEmpty.every((s) => s !== '' && Number.isFinite(Number(s)))) return 'number'
  if (nonEmpty.every((s) => isValidIsoDate(s))) return 'date'
  return 'text'
  // select/multiSelect are never auto-inferred — they require user intent
  // (promote a low-cardinality text column to select in the UI).
}

function dedupeHeader(name: string, used: Set<string>, index: number): string {
  let base = name.trim() || `Column ${index + 1}`
  let candidate = base
  let n = 2
  while (used.has(candidate)) candidate = `${base} (${n++})`
  used.add(candidate)
  return candidate
}

export interface InferredSchema {
  idFieldId: string
  fields: DbField[]
}

/**
 * Infer fields + the id field from a header row and sample data rows. If a
 * usable `id` column exists (all-unique, non-empty) it becomes the id field;
 * otherwise a leading `id` field is synthesized.
 */
export function inferFields(
  headers: string[],
  sampleRows: string[][],
  genId: GenId = defaultGenId
): InferredSchema {
  const usedNames = new Set<string>()
  const normalizedHeaders = headers.map((h, i) => dedupeHeader(h, usedNames, i))

  // Detect a usable id column.
  let idColIndex = -1
  const idHeaderIdx = normalizedHeaders.findIndex((h) => h.toLowerCase() === DEFAULT_ID_FIELD_NAME)
  if (idHeaderIdx >= 0) {
    const values = sampleRows.map((r) => r[idHeaderIdx] ?? '')
    const allPresent = values.length > 0 && values.every((v) => v.trim().length > 0)
    const unique = new Set(values).size === values.length
    if (sampleRows.length === 0 || (allPresent && unique)) idColIndex = idHeaderIdx
  }

  const fields: DbField[] = normalizedHeaders.map((name, i) => ({
    id: genId(),
    name,
    type:
      i === idColIndex
        ? 'text'
        : inferColumnType(sampleRows.map((r) => r[i] ?? ''))
  }))

  let idFieldId: string
  if (idColIndex >= 0) {
    idFieldId = fields[idColIndex].id
    fields[idColIndex].hidden = true
  } else {
    // Synthesize a leading id field.
    const idField: DbField = { id: genId(), name: DEFAULT_ID_FIELD_NAME, type: 'text', hidden: true }
    fields.unshift(idField)
    idFieldId = idField.id
  }
  return { idFieldId, fields }
}

/** A single default Table view (id hidden) covering all fields in order. */
export function buildDefaultViews(
  fields: DbField[],
  genId: GenId = defaultGenId
): { views: DbView[]; activeViewId: string } {
  const id = genId()
  const view: DbView = {
    id,
    name: 'Table',
    type: 'table',
    filters: [],
    sorts: [],
    columnOrder: fields.map((f) => f.id),
    hiddenFieldIds: fields.filter((f) => f.hidden).map((f) => f.id)
  }
  return { views: [view], activeViewId: id }
}
