/**
 * Pure model for GFM pipe tables: parse a table block into a structured
 * form, run structural edits (insert/move/duplicate/delete rows & columns,
 * alignment, sort, clear), and serialize back to nicely-padded markdown.
 *
 * The on-disk markdown stays the single source of truth — the live-preview
 * table widget (`cm-table.ts`) parses the block under the cursor, applies an
 * op here, and writes the serialized result back as one CodeMirror change.
 * Keeping all of this side-effect-free makes it trivially unit-testable and
 * keeps undo/redo, autosave, and multi-pane sync working for free.
 */

export type ColumnAlign = 'none' | 'left' | 'center' | 'right'

export interface MarkdownTable {
  /** Header cell text, one per column. */
  headers: string[]
  /** Body rows; each row has exactly `headers.length` cells (padded). */
  rows: string[][]
  /** Per-column alignment, length === headers.length. */
  aligns: ColumnAlign[]
}

/** A cell address. `row === -1` denotes the header row; body rows are 0-based. */
export interface CellRef {
  row: number
  col: number
}

// ---------------------------------------------------------------------------
// Width helpers — pad source columns so the raw markdown lines up in a
// monospace view (and reads tidily when Live Preview is off). CJK and other
// fullwidth glyphs count as two columns.
// ---------------------------------------------------------------------------

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f || // Hangul Jamo
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) || // CJK..Yi
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul Syllables
      (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
      (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK Compatibility Forms
      (codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth Forms
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) || // emoji & symbols
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)) // CJK Ext B+
  )
}

export function cellWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    width += isWide(cp) ? 2 : 1
  }
  return width
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Split one `| a | b |` row into trimmed, unescaped cell strings. Honors
 *  `\|` (escaped pipe) and `\\` so cells can contain literal pipes. */
function splitRow(line: string): string[] {
  let trimmed = line.trim()
  // Drop a single leading / trailing unescaped pipe (the common form).
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (endsWithUnescapedPipe(trimmed)) trimmed = trimmed.slice(0, -1)

  const cells: string[] = []
  let current = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '\\' && i + 1 < trimmed.length) {
      // Preserve the escape sequence verbatim for an exact round-trip;
      // unescaping happens in `unescapeCell` for display.
      current += ch + trimmed[i + 1]
      i++
      continue
    }
    if (ch === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current)
  return cells.map((c) => unescapeCell(c.trim()))
}

function endsWithUnescapedPipe(text: string): boolean {
  if (!text.endsWith('|')) return false
  // Count trailing backslashes before the final pipe; even count → unescaped.
  let backslashes = 0
  for (let i = text.length - 2; i >= 0 && text[i] === '\\'; i--) backslashes++
  return backslashes % 2 === 0
}

function unescapeCell(text: string): string {
  return text.replace(/\\([|\\])/g, '$1')
}

function escapeCell(text: string): string {
  return text.replace(/([|\\])/g, '\\$1')
}

function parseAlign(spec: string): ColumnAlign {
  const s = spec.trim()
  const left = s.startsWith(':')
  const right = s.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return 'none'
}

/** Returns true when `line` looks like a GFM delimiter row (`|---|:--:|`). */
function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line)
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-+:?$/.test(c.trim()))
}

/**
 * Parse a markdown table block. Returns null when the text is not a
 * well-formed table (header + delimiter + zero or more body rows).
 */
export function parseTable(block: string): MarkdownTable | null {
  const lines = block.replace(/\n+$/, '').split('\n')
  if (lines.length < 2) return null
  if (!isDelimiterRow(lines[1])) return null

  const headers = splitRow(lines[0])
  const alignCells = splitRow(lines[1])
  const colCount = headers.length
  if (colCount === 0) return null

  const aligns: ColumnAlign[] = []
  for (let c = 0; c < colCount; c++) aligns.push(parseAlign(alignCells[c] ?? ''))

  const rows: string[][] = []
  for (let i = 2; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    rows.push(normalizeRow(splitRow(lines[i]), colCount))
  }

  return { headers, rows, aligns }
}

function normalizeRow(cells: string[], colCount: number): string[] {
  const out = cells.slice(0, colCount)
  while (out.length < colCount) out.push('')
  return out
}

// ---------------------------------------------------------------------------
// Serialization (padded, Obsidian/prettier-ish)
// ---------------------------------------------------------------------------

function padCell(text: string, width: number, align: ColumnAlign): string {
  const pad = Math.max(0, width - cellWidth(text))
  if (align === 'right') return ' '.repeat(pad) + text
  if (align === 'center') {
    const leftPad = Math.floor(pad / 2)
    return ' '.repeat(leftPad) + text + ' '.repeat(pad - leftPad)
  }
  return text + ' '.repeat(pad)
}

function delimiterCell(width: number, align: ColumnAlign): string {
  // Width here is the inner content width; dashes fill it (min 3 visually
  // with the colons). Keep at least one dash.
  const dashes = Math.max(1, width - (align === 'center' ? 2 : align === 'none' ? 0 : 1))
  const bar = '-'.repeat(dashes)
  if (align === 'center') return `:${bar}:`
  if (align === 'left') return `:${bar}`
  if (align === 'right') return `${bar}:`
  return bar
}

export function serializeTable(table: MarkdownTable): string {
  const colCount = table.headers.length
  const widths: number[] = []
  for (let c = 0; c < colCount; c++) {
    let w = cellWidth(escapeCell(table.headers[c] ?? ''))
    for (const row of table.rows) w = Math.max(w, cellWidth(escapeCell(row[c] ?? '')))
    // Delimiter needs room for `:` markers and at least one dash.
    const align = table.aligns[c] ?? 'none'
    const minDelim = align === 'center' ? 3 : align === 'none' ? 1 : 2
    widths.push(Math.max(3, w, minDelim))
  }

  const renderRow = (cells: string[]): string => {
    const padded = cells.map((cell, c) =>
      padCell(escapeCell(cell ?? ''), widths[c], table.aligns[c] ?? 'none')
    )
    return `| ${padded.join(' | ')} |`
  }

  const header = renderRow(table.headers)
  const delim = `| ${table.aligns
    .map((a, c) => delimiterCell(widths[c], a))
    .join(' | ')} |`
  const body = table.rows.map(renderRow)
  return [header, delim, ...body].join('\n')
}

// ---------------------------------------------------------------------------
// Structural operations — all return a new table, never mutate the input.
// ---------------------------------------------------------------------------

function clone(table: MarkdownTable): MarkdownTable {
  return {
    headers: [...table.headers],
    rows: table.rows.map((r) => [...r]),
    aligns: [...table.aligns]
  }
}

export function columnCount(table: MarkdownTable): number {
  return table.headers.length
}

export function setCell(
  table: MarkdownTable,
  ref: CellRef,
  value: string
): MarkdownTable {
  const next = clone(table)
  if (ref.row < 0) {
    if (ref.col >= 0 && ref.col < next.headers.length) next.headers[ref.col] = value
  } else if (ref.row < next.rows.length) {
    const row = next.rows[ref.row]
    if (ref.col >= 0 && ref.col < row.length) row[ref.col] = value
  }
  return next
}

function emptyRow(colCount: number): string[] {
  return Array.from({ length: colCount }, () => '')
}

/** Insert an empty body row at `index` (clamped). */
export function insertRow(table: MarkdownTable, index: number): MarkdownTable {
  const next = clone(table)
  const at = Math.max(0, Math.min(index, next.rows.length))
  next.rows.splice(at, 0, emptyRow(columnCount(next)))
  return next
}

export function deleteRow(table: MarkdownTable, index: number): MarkdownTable {
  if (index < 0 || index >= table.rows.length) return table
  const next = clone(table)
  next.rows.splice(index, 1)
  return next
}

export function duplicateRow(table: MarkdownTable, index: number): MarkdownTable {
  if (index < 0 || index >= table.rows.length) return table
  const next = clone(table)
  next.rows.splice(index + 1, 0, [...next.rows[index]])
  return next
}

export function moveRow(
  table: MarkdownTable,
  from: number,
  to: number
): MarkdownTable {
  if (from < 0 || from >= table.rows.length) return table
  const next = clone(table)
  const [row] = next.rows.splice(from, 1)
  const at = Math.max(0, Math.min(to, next.rows.length))
  next.rows.splice(at, 0, row)
  return next
}

/** Insert an empty column at `index` (clamped) with the given alignment. */
export function insertColumn(
  table: MarkdownTable,
  index: number,
  align: ColumnAlign = 'none'
): MarkdownTable {
  const next = clone(table)
  const at = Math.max(0, Math.min(index, columnCount(next)))
  next.headers.splice(at, 0, '')
  next.aligns.splice(at, 0, align)
  for (const row of next.rows) row.splice(at, 0, '')
  return next
}

export function deleteColumn(table: MarkdownTable, index: number): MarkdownTable {
  if (index < 0 || index >= columnCount(table)) return table
  if (columnCount(table) <= 1) return table // never leave a 0-column table
  const next = clone(table)
  next.headers.splice(index, 1)
  next.aligns.splice(index, 1)
  for (const row of next.rows) row.splice(index, 1)
  return next
}

export function duplicateColumn(
  table: MarkdownTable,
  index: number
): MarkdownTable {
  if (index < 0 || index >= columnCount(table)) return table
  const next = clone(table)
  next.headers.splice(index + 1, 0, next.headers[index])
  next.aligns.splice(index + 1, 0, next.aligns[index])
  for (const row of next.rows) row.splice(index + 1, 0, row[index])
  return next
}

export function moveColumn(
  table: MarkdownTable,
  from: number,
  to: number
): MarkdownTable {
  if (from < 0 || from >= columnCount(table)) return table
  const next = clone(table)
  const moveItem = <T>(arr: T[]): void => {
    const [item] = arr.splice(from, 1)
    const at = Math.max(0, Math.min(to, arr.length))
    arr.splice(at, 0, item)
  }
  moveItem(next.headers)
  moveItem(next.aligns)
  for (const row of next.rows) moveItem(row)
  return next
}

export function setColumnAlign(
  table: MarkdownTable,
  index: number,
  align: ColumnAlign
): MarkdownTable {
  if (index < 0 || index >= columnCount(table)) return table
  const next = clone(table)
  next.aligns[index] = align
  return next
}

/** Sort body rows by a column. Numeric when every value parses as a number;
 *  otherwise a locale-aware string compare. */
export function sortByColumn(
  table: MarkdownTable,
  index: number,
  direction: 'asc' | 'desc'
): MarkdownTable {
  if (index < 0 || index >= columnCount(table)) return table
  const next = clone(table)
  const dir = direction === 'asc' ? 1 : -1
  const values = next.rows.map((r) => (r[index] ?? '').trim())
  const allNumeric =
    values.length > 0 &&
    values.every((v) => v !== '' && !Number.isNaN(Number(v)))
  next.rows.sort((a, b) => {
    const av = (a[index] ?? '').trim()
    const bv = (b[index] ?? '').trim()
    if (allNumeric) return (Number(av) - Number(bv)) * dir
    return av.localeCompare(bv) * dir
  })
  return next
}

/** Set a list of cells to empty strings (header cells use row === -1). */
export function clearCells(table: MarkdownTable, cells: CellRef[]): MarkdownTable {
  let next = table
  for (const ref of cells) next = setCell(next, ref, '')
  return next
}
