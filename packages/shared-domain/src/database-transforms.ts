/**
 * Pure, type-aware filter / sort / group transforms over database rows.
 * Reused by both the Table view (filter + sort) and the Board view (group-by).
 */
import type { DbField, DbRow, FilterRule, SortRule } from './databases'
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
  fieldsById: Map<string, DbField>
): DbRow[] {
  if (!filters || filters.length === 0) return rows
  // All rules AND together (MVP).
  return rows.filter((row) => filters.every((rule) => matchesRule(row, rule, fieldsById.get(rule.fieldId))))
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
