import { describe, it, expect } from 'vitest'
import type { DbField, DbRow } from './databases'
import { EMPTY_GROUP } from './databases'
import { boardColumns, joinNoteLinks, pickRows, splitNoteLinks, viewRows } from './database-transforms'

describe('splitNoteLinks / joinNoteLinks (#500)', () => {
  it('round-trips targets, including titles with commas', () => {
    const targets = ['Project X', 'Smith, John', '/a/Dup']
    expect(splitNoteLinks(joinNoteLinks(targets))).toEqual(targets)
  })

  it('extracts targets and drops alias and surrounding text', () => {
    expect(splitNoteLinks('see [[A|alias]] and [[B]] maybe')).toEqual(['A', 'B'])
  })

  it('ignores empty and malformed brackets', () => {
    expect(splitNoteLinks('')).toEqual([])
    expect(splitNoteLinks('[[]] [[  ]] [[ok]]')).toEqual(['ok'])
    expect(splitNoteLinks('plain text, no links')).toEqual([])
  })
})

describe('pickRows / viewRows: picked rows', () => {
  const fields: DbField[] = [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'status', name: 'Status', type: 'select', options: [] },
    { id: 'n', name: 'N', type: 'number' }
  ]
  const map = new Map(fields.map((f) => [f.id, f]))
  const row = (id: string, name: string, status: string, n: string): DbRow => ({
    id,
    cells: { name, status, n }
  })
  const rows = [
    row('r1', 'Alpha', 'todo', '3'),
    row('r2', 'Beta', 'done', '1'),
    row('r3', 'Gamma', 'todo', '2'),
    row('r4', 'Delta', 'done', '4')
  ]
  const ids = (list: DbRow[]): string[] => list.map((r) => r.id)

  it('keeps every row without picks, and only the picked ones with them', () => {
    expect(pickRows(rows, undefined)).toBe(rows)
    expect(ids(pickRows(rows, ['r3', 'r1']))).toEqual(['r1', 'r3'])
    expect(pickRows(rows, [])).toEqual([])
  })

  it('ignores picks that name deleted rows', () => {
    expect(ids(pickRows(rows, ['gone', 'r2', 'also-gone']))).toEqual(['r2'])
  })

  it('applies picks before the filters and the sorts', () => {
    const view = {
      pickedRowIds: ['r1', 'r2', 'r3'],
      filters: [{ fieldId: 'status', op: 'is' as const, value: 'todo' }],
      sorts: [{ fieldId: 'n', direction: 'asc' as const }]
    }
    // r4 was never picked and r2 fails the filter; r1 and r3 sort by N.
    expect(ids(viewRows(rows, view, map))).toEqual(['r3', 'r1'])
    // An OR filter still cannot bring an unpicked row back.
    const any = {
      ...view,
      filters: [
        { fieldId: 'status', op: 'is' as const, value: 'done' },
        { fieldId: 'name', op: 'contains' as const, value: 'a' }
      ],
      filterConjunction: 'or' as const
    }
    expect(ids(viewRows(rows, any, map))).toEqual(['r2', 'r3', 'r1'])
  })

  it('is the plain filter and sort pipeline for a view without picks', () => {
    const view = { filters: [], sorts: [{ fieldId: 'n', direction: 'desc' as const }] }
    expect(ids(viewRows(rows, view, map))).toEqual(['r4', 'r1', 'r3', 'r2'])
  })

  it('feeds the board the picked rows only', () => {
    const picked = viewRows(rows, { pickedRowIds: ['r2', 'r3'], filters: [], sorts: [] }, map)
    const columns = boardColumns(picked, fields[1], ['todo', 'done'])
    expect(columns.map((c) => [c.key, ids(c.rows)])).toEqual([
      ['todo', ['r3']],
      ['done', ['r2']],
      [EMPTY_GROUP, []]
    ])
  })
})
