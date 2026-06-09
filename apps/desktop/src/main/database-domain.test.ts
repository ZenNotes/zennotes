import { describe, expect, it } from 'vitest'
import {
  parseCsv,
  serializeCsv,
  parseRows,
  serializeRows,
  inferFields,
  buildDefaultViews,
  type GenId
} from '@shared/database-csv'
import {
  filterRows,
  sortRows,
  boardColumns,
  splitMultiSelect,
  joinMultiSelect
} from '@shared/database-transforms'
import { EMPTY_GROUP, type DbField, type DbRow } from '@shared/databases'

/** Deterministic id factory for tests. */
function counterGenId(): GenId {
  let n = 0
  return () => `id-${++n}`
}

const fieldsById = (fields: DbField[]): Map<string, DbField> =>
  new Map(fields.map((f) => [f.id, f]))

describe('parseCsv / serializeCsv round-trip', () => {
  it('round-trips embedded commas, quotes, and newlines', () => {
    const grid = [
      ['id', 'name', 'note'],
      ['1', 'a,b', 'he said "hi"'],
      ['2', 'line1\nline2', 'plain'],
      ['3', '', 'trailing space ']
    ]
    expect(parseCsv(serializeCsv(grid))).toEqual(grid)
  })

  it('parses CRLF and a leading BOM, drops blank lines', () => {
    const text = '﻿id,name\r\n1,Alpha\r\n\r\n2,Beta\r\n'
    expect(parseCsv(text)).toEqual([
      ['id', 'name'],
      ['1', 'Alpha'],
      ['2', 'Beta']
    ])
  })

  it('preserves empty trailing cells and a no-trailing-newline last row', () => {
    expect(parseCsv('a,')).toEqual([['a', '']])
    expect(parseCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('round-trips a cell that is a single double-quote', () => {
    const grid = [['x'], ['"']]
    expect(parseCsv(serializeCsv(grid))).toEqual(grid)
  })
})

describe('parseRows / serializeRows', () => {
  const fields: DbField[] = [
    { id: 'fid', name: 'id', type: 'text', hidden: true },
    { id: 'fname', name: 'Name', type: 'text' },
    { id: 'fdone', name: 'Done', type: 'checkbox' }
  ]

  it('keys cells by field id and round-trips', () => {
    const csv = serializeCsv([
      ['id', 'Name', 'Done'],
      ['u1', 'Task A', 'true'],
      ['u2', 'Task, B', 'false']
    ])
    const rows = parseRows(csv, fields, 'fid')
    expect(rows).toEqual([
      { id: 'u1', cells: { fid: 'u1', fname: 'Task A', fdone: 'true' } },
      { id: 'u2', cells: { fid: 'u2', fname: 'Task, B', fdone: 'false' } }
    ])
    expect(serializeRows(rows, fields)).toEqual(csv)
  })

  it('synthesizes ids for rows missing one', () => {
    const csv = 'id,Name,Done\n,No Id,true\n'
    const rows = parseRows(csv, fields, 'fid', counterGenId())
    expect(rows[0].id).toBe('id-1')
    expect(rows[0].cells.fid).toBe('id-1')
  })

  it('matches columns by header name regardless of order', () => {
    const csv = 'Name,Done,id\nReordered,true,u9\n'
    const rows = parseRows(csv, fields, 'fid')
    expect(rows[0]).toEqual({ id: 'u9', cells: { fid: 'u9', fname: 'Reordered', fdone: 'true' } })
  })
})

describe('inferFields', () => {
  it('infers number, checkbox, date, and text columns', () => {
    const { fields, idFieldId } = inferFields(
      ['id', 'Count', 'Done', 'Due', 'Title'],
      [
        ['1', '10', 'true', '2026-01-01', 'hello'],
        ['2', '20', 'false', '2026-02-15', 'world']
      ],
      counterGenId()
    )
    const byName = new Map(fields.map((f) => [f.name, f]))
    expect(byName.get('Count')!.type).toBe('number')
    expect(byName.get('Done')!.type).toBe('checkbox')
    expect(byName.get('Due')!.type).toBe('date')
    expect(byName.get('Title')!.type).toBe('text')
    // existing unique id column is used + hidden
    expect(byName.get('id')!.id).toBe(idFieldId)
    expect(byName.get('id')!.hidden).toBe(true)
  })

  it('synthesizes a leading id field when no id column exists', () => {
    const { fields, idFieldId } = inferFields(['Name'], [['a'], ['b']], counterGenId())
    expect(fields[0].name).toBe('id')
    expect(fields[0].id).toBe(idFieldId)
    expect(fields[0].hidden).toBe(true)
    expect(fields).toHaveLength(2)
  })

  it('dedupes blank and duplicate headers', () => {
    const { fields } = inferFields(['', 'Name', 'Name'], [], counterGenId())
    const names = fields.map((f) => f.name)
    // includes synthesized id + Column 1 + Name + Name (2)
    expect(names).toContain('Column 1')
    expect(names.filter((n) => n.startsWith('Name'))).toEqual(['Name', 'Name (2)'])
  })

  it('buildDefaultViews creates one table view with the id field hidden', () => {
    const { fields, idFieldId } = inferFields(['id', 'Name'], [['1', 'a']], counterGenId())
    const { views, activeViewId } = buildDefaultViews(fields, counterGenId())
    expect(views).toHaveLength(1)
    expect(views[0].type).toBe('table')
    expect(views[0].id).toBe(activeViewId)
    expect(views[0].hiddenFieldIds).toContain(idFieldId)
    expect(views[0].columnOrder).toEqual(fields.map((f) => f.id))
  })
})

describe('transforms', () => {
  const fields: DbField[] = [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'count', name: 'Count', type: 'number' },
    { id: 'due', name: 'Due', type: 'date' },
    { id: 'status', name: 'Status', type: 'select' }
  ]
  const map = fieldsById(fields)
  const rows: DbRow[] = [
    { id: '1', cells: { name: 'Beta', count: '2', due: '2026-03-01', status: 'todo' } },
    { id: '2', cells: { name: 'Alpha', count: '10', due: '2026-01-15', status: 'done' } },
    { id: '3', cells: { name: 'Gamma', count: '1', due: '', status: '' } }
  ]

  it('sorts numerically, not lexically', () => {
    const sorted = sortRows(rows, [{ fieldId: 'count', direction: 'asc' }], map)
    expect(sorted.map((r) => r.cells.count)).toEqual(['1', '2', '10'])
  })

  it('sorts dates chronologically and pushes empty values last', () => {
    const sorted = sortRows(rows, [{ fieldId: 'due', direction: 'asc' }], map)
    expect(sorted.map((r) => r.id)).toEqual(['2', '1', '3'])
  })

  it('filters by contains and is', () => {
    expect(filterRows(rows, [{ fieldId: 'name', op: 'contains', value: 'a' }], map).map((r) => r.id)).toEqual([
      '1',
      '2',
      '3'
    ])
    expect(filterRows(rows, [{ fieldId: 'status', op: 'is', value: 'done' }], map).map((r) => r.id)).toEqual([
      '2'
    ])
    expect(filterRows(rows, [{ fieldId: 'due', op: 'isEmpty' }], map).map((r) => r.id)).toEqual(['3'])
  })

  it('groups into board columns with an EMPTY_GROUP bucket', () => {
    const cols = boardColumns(rows, fields[3], ['todo', 'done'])
    expect(cols.map((c) => c.key)).toEqual(['todo', 'done', EMPTY_GROUP])
    expect(cols[0].rows.map((r) => r.id)).toEqual(['1'])
    expect(cols[1].rows.map((r) => r.id)).toEqual(['2'])
    expect(cols[2].rows.map((r) => r.id)).toEqual(['3'])
  })

  it('splits and joins multiSelect cells', () => {
    expect(splitMultiSelect('a, b ,c')).toEqual(['a', 'b', 'c'])
    expect(joinMultiSelect(['a', 'b'])).toBe('a, b')
    expect(splitMultiSelect('')).toEqual([])
  })
})
