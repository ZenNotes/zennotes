import { describe, it, expect } from 'vitest'
import {
  parseTable,
  serializeTable,
  insertRow,
  deleteRow,
  duplicateRow,
  moveRow,
  insertColumn,
  deleteColumn,
  duplicateColumn,
  moveColumn,
  setColumnAlign,
  sortByColumn,
  setCell,
  clearCells,
  cellWidth,
  type MarkdownTable
} from './markdown-table'

const SIMPLE = `| A | B |
| --- | --- |
| 1 | 2 |
| 3 | 4 |`

function parse(src: string): MarkdownTable {
  const t = parseTable(src)
  expect(t).not.toBeNull()
  return t as MarkdownTable
}

describe('parseTable', () => {
  it('parses headers, aligns, and rows', () => {
    const t = parse(SIMPLE)
    expect(t.headers).toEqual(['A', 'B'])
    expect(t.aligns).toEqual(['none', 'none'])
    expect(t.rows).toEqual([
      ['1', '2'],
      ['3', '4']
    ])
  })

  it('reads column alignments', () => {
    const t = parse(`| a | b | c |
| :-- | :-: | --: |
| x | y | z |`)
    expect(t.aligns).toEqual(['left', 'center', 'right'])
  })

  it('pads short rows and truncates long rows to header width', () => {
    const t = parse(`| a | b | c |
| - | - | - |
| 1 |
| 1 | 2 | 3 | 4 |`)
    expect(t.rows).toEqual([
      ['1', '', ''],
      ['1', '2', '3']
    ])
  })

  it('handles escaped pipes inside cells', () => {
    const t = parse(`| a | b |
| - | - |
| x \\| y | z |`)
    expect(t.rows[0]).toEqual(['x | y', 'z'])
  })

  it('tolerates missing leading/trailing pipes', () => {
    const t = parse(`a | b
- | -
1 | 2`)
    expect(t.headers).toEqual(['a', 'b'])
    expect(t.rows).toEqual([['1', '2']])
  })

  it('returns null when the second line is not a delimiter', () => {
    expect(parseTable(`| a | b |\n| 1 | 2 |`)).toBeNull()
    expect(parseTable(`just text`)).toBeNull()
  })
})

describe('serializeTable round-trip', () => {
  it('produces aligned, padded markdown', () => {
    const t = parse(SIMPLE)
    expect(serializeTable(t)).toBe(`| A   | B   |
| --- | --- |
| 1   | 2   |
| 3   | 4   |`)
  })

  it('re-parses to an equal model (stable round-trip)', () => {
    const t = parse(SIMPLE)
    const again = parse(serializeTable(t))
    expect(again).toEqual(t)
  })

  it('keeps alignment markers in the delimiter', () => {
    const t = parse(`| a | b | c |
| :-- | :-: | --: |
| x | y | z |`)
    const out = serializeTable(t)
    expect(out.split('\n')[1]).toBe('| :-- | :-: | --: |')
    expect(parse(out).aligns).toEqual(['left', 'center', 'right'])
  })

  it('escapes pipes on the way out and round-trips them', () => {
    const t = setCell(parse(SIMPLE), { row: 0, col: 0 }, 'a | b')
    const out = serializeTable(t)
    expect(out).toContain('a \\| b')
    expect(parse(out).rows[0][0]).toBe('a | b')
  })
})

describe('row operations', () => {
  it('inserts an empty row', () => {
    const t = insertRow(parse(SIMPLE), 1)
    expect(t.rows).toEqual([
      ['1', '2'],
      ['', ''],
      ['3', '4']
    ])
  })

  it('deletes a row', () => {
    expect(deleteRow(parse(SIMPLE), 0).rows).toEqual([['3', '4']])
  })

  it('duplicates a row right below', () => {
    expect(duplicateRow(parse(SIMPLE), 0).rows).toEqual([
      ['1', '2'],
      ['1', '2'],
      ['3', '4']
    ])
  })

  it('moves a row', () => {
    expect(moveRow(parse(SIMPLE), 0, 1).rows).toEqual([
      ['3', '4'],
      ['1', '2']
    ])
  })
})

describe('column operations', () => {
  it('inserts a column with alignment', () => {
    const t = insertColumn(parse(SIMPLE), 1, 'center')
    expect(t.headers).toEqual(['A', '', 'B'])
    expect(t.aligns).toEqual(['none', 'center', 'none'])
    expect(t.rows[0]).toEqual(['1', '', '2'])
  })

  it('deletes a column but never the last one', () => {
    const t = deleteColumn(parse(SIMPLE), 0)
    expect(t.headers).toEqual(['B'])
    expect(t.rows).toEqual([['2'], ['4']])
    const single = parse(`| only |\n| - |\n| v |`)
    expect(deleteColumn(single, 0)).toBe(single) // unchanged
  })

  it('duplicates a column', () => {
    const t = duplicateColumn(parse(SIMPLE), 0)
    expect(t.headers).toEqual(['A', 'A', 'B'])
    expect(t.rows[0]).toEqual(['1', '1', '2'])
  })

  it('moves a column', () => {
    const t = moveColumn(parse(SIMPLE), 0, 1)
    expect(t.headers).toEqual(['B', 'A'])
    expect(t.rows[0]).toEqual(['2', '1'])
  })

  it('sets column alignment', () => {
    expect(setColumnAlign(parse(SIMPLE), 1, 'right').aligns).toEqual([
      'none',
      'right'
    ])
  })
})

describe('sortByColumn', () => {
  it('sorts numerically when all values are numbers', () => {
    const t = parse(`| n |
| - |
| 10 |
| 2 |
| 1 |`)
    expect(sortByColumn(t, 0, 'asc').rows.map((r) => r[0])).toEqual([
      '1',
      '2',
      '10'
    ])
    expect(sortByColumn(t, 0, 'desc').rows.map((r) => r[0])).toEqual([
      '10',
      '2',
      '1'
    ])
  })

  it('sorts as strings otherwise', () => {
    const t = parse(`| s |
| - |
| banana |
| apple |
| cherry |`)
    expect(sortByColumn(t, 0, 'asc').rows.map((r) => r[0])).toEqual([
      'apple',
      'banana',
      'cherry'
    ])
  })
})

describe('cell editing', () => {
  it('sets a header cell with row === -1', () => {
    expect(setCell(parse(SIMPLE), { row: -1, col: 1 }, 'Z').headers).toEqual([
      'A',
      'Z'
    ])
  })

  it('clears a list of cells', () => {
    const t = clearCells(parse(SIMPLE), [
      { row: 0, col: 0 },
      { row: 1, col: 1 }
    ])
    expect(t.rows).toEqual([
      ['', '2'],
      ['3', '']
    ])
  })
})

describe('cellWidth', () => {
  it('counts CJK as double width', () => {
    expect(cellWidth('ab')).toBe(2)
    expect(cellWidth('中文')).toBe(4)
    expect(cellWidth('a中')).toBe(3)
  })
})
