import { describe, it, expect } from 'vitest'
import {
  parseTable,
  parseTableBlock,
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
  parseColWidthsComment,
  serializeColWidthsComment,
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
  it('preserves latex backslashes on serialize', () => {
    const t = setCell(parse(SIMPLE), { row: 0, col: 0 }, '\\sum')
    const out = serializeTable(t)
    expect(out).toContain('\\sum')
    expect(parse(out).rows[0][0]).toBe('\\sum')
  })

  it('still escapes literal pipes', () => {
    const t = setCell(parse(SIMPLE), { row: 0, col: 0 }, 'a | b')
    const out = serializeTable(t)
    expect(out).toContain('a \\| b')
    expect(parse(out).rows[0][0]).toBe('a | b')
  })

  it('round-trips latex and pipes together', () => {
    const t = setCell(parse(SIMPLE), { row: 0, col: 0 }, '\\sum | x')
    const out = serializeTable(t)
    expect(out).toContain('\\sum \\| x')
    expect(parse(out).rows[0][0]).toBe('\\sum | x')
  })

  it('preserves LaTeX line breaks (double backslash) on round-trip', () => {
    // A matrix/aligned line break `\\` must not collapse to `\` when parsed back.
    const t = setCell(parse(SIMPLE), { row: 0, col: 0 }, 'a \\\\ b')
    const out = serializeTable(t)
    expect(out).toContain('a \\\\ b')
    expect(parse(out).rows[0][0]).toBe('a \\\\ b')
  })

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

describe('column-width marker (#294)', () => {
  it('un-resized tables serialize byte-identical (no marker)', () => {
    expect(serializeTable(parse(SIMPLE))).not.toContain('zen:cols')
  })

  it('serializeTable appends a zen:cols comment when widths are set', () => {
    const t: MarkdownTable = { ...parse(SIMPLE), colWidths: [120, 200] }
    expect(serializeTable(t).split('\n').at(-1)).toBe('<!-- zen:cols=120,200 -->')
  })

  it('emits auto for unset columns and rounds px', () => {
    expect(serializeColWidthsComment([120, null, 90.4])).toBe('<!-- zen:cols=120,auto,90 -->')
  })

  it('returns null when nothing is set', () => {
    expect(serializeColWidthsComment(undefined)).toBeNull()
    expect(serializeColWidthsComment([null, null])).toBeNull()
  })

  it('parses a zen:cols comment back to widths (auto → null)', () => {
    expect(parseColWidthsComment('<!-- zen:cols=120,auto,90 -->')).toEqual([120, null, 90])
  })

  it('ignores non-marker lines and round-trips', () => {
    expect(parseColWidthsComment('| A | B |')).toBeNull()
    expect(parseColWidthsComment('<!-- a normal comment -->')).toBeNull()
    const widths = [120, null, 90]
    expect(parseColWidthsComment(serializeColWidthsComment(widths)!)).toEqual(widths)
  })
})

describe('parseTableBlock (table + trailing zen:cols marker, #832)', () => {
  it('parses a bare table exactly like parseTable', () => {
    expect(parseTableBlock(SIMPLE)).toEqual(parseTable(SIMPLE))
  })

  it('lifts a trailing zen:cols marker into colWidths instead of a body row', () => {
    const t = parseTableBlock(`${SIMPLE}\n<!-- zen:cols=120,auto -->`)
    expect(t).not.toBeNull()
    expect(t!.rows).toEqual([
      ['1', '2'],
      ['3', '4']
    ])
    expect(t!.colWidths).toEqual([120, null])
  })

  it('still rejects text that is not a table', () => {
    expect(parseTableBlock('| just one line |')).toBeNull()
    expect(parseTableBlock('<!-- zen:cols=1 -->')).toBeNull()
  })
})

describe('column-width marker round-trip (#294)', () => {
  it('re-serializing a widths-bearing table is idempotent (single marker, stable)', () => {
    const t: MarkdownTable = { ...parse(SIMPLE), colWidths: [120, 200] }
    const out1 = serializeTable(t)
    // Mirror the editor's resize→commit loop: re-parse the table body (dropping
    // the marker line), re-attach widths, re-serialize. Output must be stable.
    const body = out1.split('\n').filter((l) => !l.startsWith('<!--')).join('\n')
    const out2 = serializeTable({ ...parse(body), colWidths: [120, 200] })
    expect(out2).toBe(out1)
    expect((out2.match(/zen:cols/g) ?? []).length).toBe(1)
  })
})

describe('column widths survive table operations (#294 follow-up)', () => {
  // Every structural op runs through `clone`, which dropped `colWidths`. The
  // editor extends the replaced range over the `<!-- zen:cols=… -->` line, so a
  // model without widths doesn't just forget them — it deletes the marker from
  // the note. Resize a column, then use any menu action, and the widths were
  // gone.
  const withWidths = (): MarkdownTable => ({ ...parse(SIMPLE), colWidths: [120, 200] })

  it('keeps widths through an alignment change', () => {
    const out = setColumnAlign(withWidths(), 0, 'center')
    expect(out.colWidths).toEqual([120, 200])
    expect(serializeTable(out)).toContain('<!-- zen:cols=120,200 -->')
  })

  it('keeps widths through row operations', () => {
    expect(insertRow(withWidths(), 0).colWidths).toEqual([120, 200])
    expect(deleteRow(withWidths(), 0).colWidths).toEqual([120, 200])
    expect(setCell(withWidths(), { row: 0, col: 0 }, 'x').colWidths).toEqual([120, 200])
  })

  it('does not share the widths array with the original', () => {
    const original = withWidths()
    const next = setColumnAlign(original, 0, 'right')
    next.colWidths![0] = 999
    expect(original.colWidths).toEqual([120, 200])
  })

  it('tracks the columns when one is inserted, deleted, duplicated or moved', () => {
    // A width belongs to a column, so it has to follow that column around —
    // carrying the array along unchanged would mis-size every column after the
    // edit, which is worse than losing it.
    expect(insertColumn(withWidths(), 1).colWidths).toEqual([120, null, 200])
    expect(deleteColumn(withWidths(), 0).colWidths).toEqual([200])
    expect(duplicateColumn(withWidths(), 0).colWidths).toEqual([120, 120, 200])
    expect(moveColumn(withWidths(), 0, 1).colWidths).toEqual([200, 120])
  })

  it('leaves a table without widths alone', () => {
    expect(setColumnAlign(parse(SIMPLE), 0, 'left').colWidths).toBeUndefined()
    expect(serializeTable(insertColumn(parse(SIMPLE), 1))).not.toContain('zen:cols')
  })
})
