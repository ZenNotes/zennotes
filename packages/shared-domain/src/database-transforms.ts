/**
 * Pure, type-aware filter / sort / group transforms over database rows.
 * Reused by both the Table view (filter + sort) and the Board view (group-by).
 */
import type { DbField, DbRow, DbView, FilterConjunction, FilterRule, SortRule } from './databases'
import { EMPTY_GROUP } from './databases'

const MULTISELECT_SEP = ', '

/** Split a multiSelect cell ("a, b") into values. Option values never contain commas. */
export function splitMultiSelect(cell: string): string[] {
  return cell
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function joinMultiSelect(values: string[]): string {
  return values.join(MULTISELECT_SEP)
}

const TRUE_VALUES = new Set(['true', 'x', '1', 'yes', 'checked'])
export function isCheckboxTrue(cell: string): boolean {
  return TRUE_VALUES.has(cell.trim().toLowerCase())
}

/**
 * Extract the `[[wikilink]]` targets of a note / noteMulti cell, in order.
 * Bracket-delimited on purpose: unlike multiSelect's comma joins, a target
 * (a note title or path) may itself contain commas. Text outside brackets is
 * ignored, so a hand-edited cell degrades to "whatever links it contains".
 */
export function splitNoteLinks(cell: string): string[] {
  const out: string[] = []
  for (const m of cell.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const target = m[1].trim()
    if (target) out.push(target)
  }
  return out
}

/** Compose a note / noteMulti cell from targets: `[[A]] [[B]]`. */
export function joinNoteLinks(targets: string[]): string {
  return targets.map((t) => `[[${t}]]`).join(' ')
}

function cell(row: DbRow, fieldId: string): string {
  return row.cells[fieldId] ?? ''
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function matchesRule(row: DbRow, rule: FilterRule, field: DbField | undefined): boolean {
  if (!field) return true
  const raw = cell(row, field.id)
  const v = raw.trim()
  const target = (rule.value ?? '').trim()
  switch (rule.op) {
    case 'is':
      if (field.type === 'multiSelect') return splitMultiSelect(raw).includes(target)
      return v.toLowerCase() === target.toLowerCase()
    case 'isNot':
      if (field.type === 'multiSelect') return !splitMultiSelect(raw).includes(target)
      return v.toLowerCase() !== target.toLowerCase()
    case 'contains':
      return v.toLowerCase().includes(target.toLowerCase())
    case 'notContains':
      return !v.toLowerCase().includes(target.toLowerCase())
    case 'isEmpty':
      return v.length === 0
    case 'isNotEmpty':
      return v.length > 0
    case 'gt':
      return Number(v) > Number(target)
    case 'lt':
      return Number(v) < Number(target)
    case 'before':
      return v.length > 0 && v < target
    case 'after':
      return v.length > 0 && v > target
    case 'checked':
      return isCheckboxTrue(raw)
    case 'unchecked':
      return !isCheckboxTrue(raw)
    default:
      return true
  }
}

export function filterRows(
  rows: DbRow[],
  filters: FilterRule[] | undefined,
  fieldsById: Map<string, DbField>,
  conjunction: FilterConjunction = 'and'
): DbRow[] {
  if (!filters || filters.length === 0) return rows
  // `and` (default) keeps rows matching every rule; `or` keeps rows matching
  // any rule. (#394)
  const test = (row: DbRow, rule: FilterRule): boolean =>
    matchesRule(row, rule, fieldsById.get(rule.fieldId))
  return conjunction === 'or'
    ? rows.filter((row) => filters.some((rule) => test(row, rule)))
    : rows.filter((row) => filters.every((rule) => test(row, rule)))
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function compareByField(a: DbRow, b: DbRow, field: DbField): number {
  const av = cell(a, field.id).trim()
  const bv = cell(b, field.id).trim()
  // Empty values always sort last (regardless of direction is applied by caller).
  if (av === '' && bv === '') return 0
  if (av === '') return 1
  if (bv === '') return -1
  switch (field.type) {
    case 'number': {
      const na = Number(av)
      const nb = Number(bv)
      if (Number.isNaN(na) || Number.isNaN(nb)) return av.localeCompare(bv)
      return na - nb
    }
    case 'checkbox':
      return Number(isCheckboxTrue(av)) - Number(isCheckboxTrue(bv))
    case 'date':
      // ISO YYYY-MM-DD sorts correctly lexically.
      return av < bv ? -1 : av > bv ? 1 : 0
    default:
      return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' })
  }
}

export function sortRows(
  rows: DbRow[],
  sorts: SortRule[] | undefined,
  fieldsById: Map<string, DbField>
): DbRow[] {
  if (!sorts || sorts.length === 0) return rows
  const decorated = rows.map((row, index) => ({ row, index }))
  decorated.sort((a, b) => {
    for (const sort of sorts) {
      const field = fieldsById.get(sort.fieldId)
      if (!field) continue
      const cmp = compareByField(a.row, b.row, field)
      if (cmp !== 0) return sort.direction === 'desc' ? -cmp : cmp
    }
    return a.index - b.index // stable tie-break
  })
  return decorated.map((d) => d.row)
}

// ---------------------------------------------------------------------------
// Picked rows + the whole view pipeline
// ---------------------------------------------------------------------------

/**
 * The rows a view's picks keep, in the database's own row order (never the
 * order the ids were picked in, so a sort is the only thing that reorders).
 * No picks = every row. Ids naming rows that no longer exist simply match
 * nothing.
 */
export function pickRows(rows: DbRow[], pickedRowIds: string[] | undefined): DbRow[] {
  if (!pickedRowIds) return rows
  const picked = new Set(pickedRowIds)
  return rows.filter((row) => picked.has(row.id))
}

/**
 * The rows a saved view shows, in the order it shows them: picks first, then
 * the view's filters, then its sorts. Both the Table and the Board compute
 * their rows here, so a view means the same rows on either surface.
 */
export function viewRows(
  rows: DbRow[],
  view: Pick<DbView, 'pickedRowIds' | 'filters' | 'filterConjunction' | 'sorts'>,
  fieldsById: Map<string, DbField>
): DbRow[] {
  return sortRows(
    filterRows(pickRows(rows, view.pickedRowIds), view.filters, fieldsById, view.filterConjunction),
    view.sorts,
    fieldsById
  )
}

// ---------------------------------------------------------------------------
// Grouping (Board view)
// ---------------------------------------------------------------------------

export interface BoardColumn {
  /** Option value, or EMPTY_GROUP for unset/unmatched rows. */
  key: string
  rows: DbRow[]
}

/**
 * Group rows by a `select` field's value. Columns follow `optionOrder` (option
 * values), with an EMPTY_GROUP column appended for rows whose cell is empty or
 * references a removed option.
 */
export function boardColumns(
  rows: DbRow[],
  groupField: DbField,
  optionOrder: string[]
): BoardColumn[] {
  const buckets = new Map<string, DbRow[]>()
  const known = new Set(optionOrder)
  for (const value of optionOrder) buckets.set(value, [])
  buckets.set(EMPTY_GROUP, [])
  for (const row of rows) {
    const v = cell(row, groupField.id).trim()
    const key = v.length > 0 && known.has(v) ? v : EMPTY_GROUP
    buckets.get(key)!.push(row)
  }
  const columns = optionOrder.map((value) => ({ key: value, rows: buckets.get(value)! }))
  columns.push({ key: EMPTY_GROUP, rows: buckets.get(EMPTY_GROUP)! })
  return columns
}
