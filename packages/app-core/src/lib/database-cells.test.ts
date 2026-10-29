import { describe, it, expect } from 'vitest'
import type { DatabaseDoc } from '@shared/databases'
import { FRONTMATTER_BLOCK_RE, parseFrontmatterFields } from '@shared/frontmatter'
import { parseFrontmatter } from '@shared/template-files'
import {
  addRowInView,
  addView,
  clearViewPicks,
  composePageBody,
  duplicateView,
  hideAllColumns,
  isLastVisibleColumn,
  moveColumn,
  moveColumnToField,
  pickedRowCount,
  removeFromViewPicks,
  setColumnHidden,
  setFieldOptionsSource,
  setViewPicks,
  showAllColumns,
  viewColumnFields,
  visibleColumnIds
} from './database-cells'

// Minimal doc with four fields; the reorder helpers only read `fields` + `views`.
function makeDoc(columnOrder?: string[], hiddenFieldIds?: string[]): DatabaseDoc {
  return {
    path: 'db.base/data.csv',
    title: 'db',
    version: 1,
    idFieldId: 'f_id',
    activeViewId: 'v1',
    fields: [
      { id: 'f_id', name: 'id', type: 'text' },
      { id: 'f_a', name: 'A', type: 'text' },
      { id: 'f_b', name: 'B', type: 'text' },
      { id: 'f_c', name: 'C', type: 'text' }
    ],
    views: [
      { id: 'v1', name: 'Table', type: 'table', filters: [], sorts: [], columnOrder, hiddenFieldIds }
    ],
    rows: []
  } as unknown as DatabaseDoc
}

const orderOf = (doc: DatabaseDoc): string[] | undefined =>
  doc.views.find((v) => v.id === 'v1')?.columnOrder

describe('moveColumn (#317)', () => {
  it('moves a column one step left / right', () => {
    const doc = makeDoc(['f_id', 'f_a', 'f_b', 'f_c'])
    expect(orderOf(moveColumn(doc, 'v1', 'f_b', 'left'))).toEqual(['f_id', 'f_b', 'f_a', 'f_c'])
    expect(orderOf(moveColumn(doc, 'v1', 'f_b', 'right'))).toEqual(['f_id', 'f_a', 'f_c', 'f_b'])
  })

  it('is a no-op at the edges', () => {
    const doc = makeDoc(['f_id', 'f_a', 'f_b', 'f_c'])
    expect(moveColumn(doc, 'v1', 'f_id', 'left')).toBe(doc)
    expect(moveColumn(doc, 'v1', 'f_c', 'right')).toBe(doc)
  })

  it('skips hidden columns so the move is always visible', () => {
    // Visible order is f_id, f_c (f_a + f_b hidden); moving f_c left lands it
    // before f_id, past the hidden pair.
    const doc = makeDoc(['f_id', 'f_a', 'f_b', 'f_c'], ['f_a', 'f_b'])
    expect(orderOf(moveColumn(doc, 'v1', 'f_c', 'left'))).toEqual(['f_c', 'f_a', 'f_b', 'f_id'])
  })

  it('normalizes a missing columnOrder against the fields', () => {
    const doc = makeDoc(undefined)
    expect(orderOf(moveColumn(doc, 'v1', 'f_a', 'right'))).toEqual(['f_id', 'f_b', 'f_a', 'f_c'])
  })
})

describe('moveColumnToField — drag reorder (#317)', () => {
  it('inserts the dragged column immediately before the target', () => {
    const doc = makeDoc(['f_id', 'f_a', 'f_b', 'f_c'])
    expect(orderOf(moveColumnToField(doc, 'v1', 'f_c', 'f_a'))).toEqual(['f_id', 'f_c', 'f_a', 'f_b'])
    expect(orderOf(moveColumnToField(doc, 'v1', 'f_id', 'f_c'))).toEqual(['f_a', 'f_b', 'f_id', 'f_c'])
  })

  it('is a no-op for a self-drop', () => {
    const doc = makeDoc(['f_id', 'f_a', 'f_b', 'f_c'])
    expect(moveColumnToField(doc, 'v1', 'f_a', 'f_a')).toBe(doc)
  })
})

describe('composePageBody — YAML-unsafe cell values (#500 groundwork)', () => {
  it('quotes wikilink and bracket values so frontmatter reads back as the cell string', () => {
    const doc = makeDoc()
    const row = {
      id: 'r1',
      cells: { f_id: 'r1', f_a: 'Meeting 1', f_b: '[[Project X]]', f_c: '- agenda item' }
    } as unknown as Parameters<typeof composePageBody>[1]
    const page = composePageBody(doc, row, 'Body\n')
    expect(page).toContain('B: "[[Project X]]"')
    expect(page).toContain('C: "- agenda item"')
    const m = FRONTMATTER_BLOCK_RE.exec(page)
    const parsed = parseFrontmatterFields(m?.[1] ?? '')
    expect(parsed.b).toBe('[[Project X]]')
    expect(parsed.c).toBe('- agenda item')
    // The record-page round-trip itself reads through template-files
    // parseFrontmatter (first-colon split + quote strip); it must agree.
    const page2 = parseFrontmatter(page)
    expect(page2.data.B).toBe('[[Project X]]')
    expect(page2.data.C).toBe('- agenda item')
    expect(page2.body).toBe('Body\n')
  })
})

describe('setFieldOptionsSource (#500)', () => {
  it('sets, replaces, and clears a select field options source', () => {
    const doc = makeDoc()
    const withSource = setFieldOptionsSource(doc, 'f_b', { kind: 'folder', path: 'inbox/projects' })
    expect(withSource.fields.find((f) => f.id === 'f_b')?.optionsSource).toEqual({
      kind: 'folder',
      path: 'inbox/projects'
    })
    const swapped = setFieldOptionsSource(withSource, 'f_b', { kind: 'tag', tag: 'project' })
    expect(swapped.fields.find((f) => f.id === 'f_b')?.optionsSource).toEqual({
      kind: 'tag',
      tag: 'project'
    })
    const cleared = setFieldOptionsSource(swapped, 'f_b', null)
    expect('optionsSource' in (cleared.fields.find((f) => f.id === 'f_b') ?? {})).toBe(false)
  })
})

// A database the way the app writes one: a schema-hidden id column, four
// user columns, three rows, a table view and a board view.
function makeViewsDoc(): DatabaseDoc {
  return {
    path: 'db.base/data.csv',
    title: 'db',
    version: 1,
    idFieldId: 'f_id',
    activeViewId: 'v1',
    fields: [
      { id: 'f_id', name: 'id', type: 'text', hidden: true },
      { id: 'f_name', name: 'Name', type: 'text' },
      { id: 'f_status', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'todo' }] },
      { id: 'f_n', name: 'N', type: 'number' },
      { id: 'f_due', name: 'Due', type: 'date' }
    ],
    views: [
      {
        id: 'v1',
        name: 'Table',
        type: 'table',
        filters: [{ fieldId: 'f_status', op: 'is', value: 'todo' }],
        filterConjunction: 'or',
        sorts: [{ fieldId: 'f_n', direction: 'desc' }],
        columnOrder: ['f_id', 'f_due', 'f_name', 'f_status', 'f_n'],
        hiddenFieldIds: ['f_id'],
        columnWidths: { f_name: 240 }
      },
      {
        id: 'v2',
        name: 'Board',
        type: 'board',
        filters: [],
        sorts: [],
        groupByFieldId: 'f_status',
        boardColumnOrder: ['todo'],
        cardFieldIds: ['f_n']
      }
    ],
    rows: [
      { id: 'r1', cells: { f_id: 'r1', f_name: 'One' } },
      { id: 'r2', cells: { f_id: 'r2', f_name: 'Two' } },
      { id: 'r3', cells: { f_id: 'r3', f_name: 'Three' } }
    ]
  } as unknown as DatabaseDoc
}

const viewOf = (doc: DatabaseDoc, id: string) => doc.views.find((v) => v.id === id)!

describe('columns a view shows', () => {
  it('lists the user columns in the view order, never the hidden id', () => {
    const doc = makeViewsDoc()
    expect(viewColumnFields(doc, viewOf(doc, 'v1')).map((f) => f.id)).toEqual([
      'f_due',
      'f_name',
      'f_status',
      'f_n'
    ])
  })

  it('hides and shows a column in one view only', () => {
    const doc = duplicateView(makeViewsDoc(), 'v1')
    const copyId = doc.activeViewId
    const hidden = setColumnHidden(doc, 'v1', 'f_due', true)
    expect(visibleColumnIds(hidden, viewOf(hidden, 'v1'))).toEqual(['f_name', 'f_status', 'f_n'])
    expect(visibleColumnIds(hidden, viewOf(hidden, copyId))).toEqual([
      'f_due',
      'f_name',
      'f_status',
      'f_n'
    ])
    const shown = setColumnHidden(hidden, 'v1', 'f_due', false)
    expect(viewOf(shown, 'v1').hiddenFieldIds).toEqual(['f_id'])
    // Hiding twice or showing a visible column changes nothing.
    expect(setColumnHidden(hidden, 'v1', 'f_due', true)).toBe(hidden)
    expect(setColumnHidden(doc, 'v1', 'f_due', false)).toBe(doc)
  })

  it('never hides the last visible column', () => {
    let doc = makeViewsDoc()
    for (const id of ['f_due', 'f_name', 'f_status']) doc = setColumnHidden(doc, 'v1', id, true)
    expect(visibleColumnIds(doc, viewOf(doc, 'v1'))).toEqual(['f_n'])
    expect(isLastVisibleColumn(doc, viewOf(doc, 'v1'), 'f_n')).toBe(true)
    expect(setColumnHidden(doc, 'v1', 'f_n', true)).toBe(doc)
  })

  it('leaves the id column and board views alone', () => {
    const doc = makeViewsDoc()
    expect(setColumnHidden(doc, 'v1', 'f_id', false)).toBe(doc)
    expect(setColumnHidden(doc, 'v2', 'f_n', true)).toBe(doc)
  })

  it('shows all, and hides all but the title column', () => {
    const doc = makeViewsDoc()
    const none = hideAllColumns(doc, 'v1')
    expect(visibleColumnIds(none, viewOf(none, 'v1'))).toEqual(['f_name'])
    expect(viewOf(none, 'v1').hiddenFieldIds).toContain('f_id')
    const all = showAllColumns(none, 'v1')
    expect(visibleColumnIds(all, viewOf(all, 'v1'))).toEqual(['f_due', 'f_name', 'f_status', 'f_n'])
    expect(viewOf(all, 'v1').hiddenFieldIds).toEqual(['f_id'])
  })
})

describe('more views', () => {
  it('names a second table view apart from the first', () => {
    const doc = addView(makeViewsDoc(), 'table')
    const added = doc.views[doc.views.length - 1]
    expect(added.name).toBe('Table 2')
    expect(added.type).toBe('table')
    expect(doc.activeViewId).toBe(added.id)
    expect(added.hiddenFieldIds).toEqual(['f_id'])
  })

  it('duplicates every setting of a table view, right after it', () => {
    const base = setViewPicks(setColumnHidden(makeViewsDoc(), 'v1', 'f_due', true), 'v1', ['r2'])
    const doc = duplicateView(base, 'v1')
    expect(doc.views.map((v) => v.name)).toEqual(['Table', 'Table copy', 'Board'])
    const copy = doc.views[1]
    expect(doc.activeViewId).toBe(copy.id)
    expect(copy.id).not.toBe('v1')
    const { id: _a, name: _b, ...copied } = copy
    const { id: _c, name: _d, ...source } = viewOf(base, 'v1')
    void [_a, _b, _c, _d]
    expect(copied).toEqual(source)
    // Deep: editing the copy cannot reach the source.
    copy.filters[0].value = 'changed'
    copy.hiddenFieldIds!.push('f_n')
    expect(viewOf(doc, 'v1').filters[0].value).toBe('todo')
    expect(viewOf(doc, 'v1').hiddenFieldIds).toEqual(['f_id', 'f_due'])
  })

  it('duplicates the board settings and picks of a board view', () => {
    const base = setViewPicks(makeViewsDoc(), 'v2', ['r3'])
    const doc = duplicateView(base, 'v2')
    const copy = doc.views[2]
    expect(copy).toMatchObject({
      name: 'Board copy',
      type: 'board',
      groupByFieldId: 'f_status',
      boardColumnOrder: ['todo'],
      cardFieldIds: ['f_n'],
      pickedRowIds: ['r3']
    })
    expect(duplicateView(doc, 'v2').views.map((v) => v.name)).toContain('Board copy 2')
  })
})

describe('picked rows', () => {
  it('saves picks in row order, existing rows only', () => {
    const doc = setViewPicks(makeViewsDoc(), 'v1', ['r3', 'gone', 'r1', 'r3'])
    expect(viewOf(doc, 'v1').pickedRowIds).toEqual(['r1', 'r3'])
    expect(viewOf(doc, 'v2').pickedRowIds).toBeUndefined()
  })

  it('counts only the picks whose row still exists', () => {
    const doc = makeViewsDoc()
    const stale = { ...viewOf(doc, 'v1'), pickedRowIds: ['r2', 'deleted'] }
    expect(pickedRowCount(doc, stale)).toBe(1)
    expect(pickedRowCount(doc, viewOf(doc, 'v1'))).toBe(0)
  })

  it('removes picks, keeps an empty list after the last, and clears', () => {
    const doc = setViewPicks(makeViewsDoc(), 'v1', ['r1', 'r2'])
    const one = removeFromViewPicks(doc, 'v1', ['r1'])
    expect(viewOf(one, 'v1').pickedRowIds).toEqual(['r2'])
    const none = removeFromViewPicks(one, 'v1', ['r2'])
    expect(viewOf(none, 'v1').pickedRowIds).toEqual([])
    const cleared = clearViewPicks(none, 'v1')
    expect('pickedRowIds' in viewOf(cleared, 'v1')).toBe(false)
    expect(clearViewPicks(cleared, 'v1')).toBe(cleared)
  })

  it('a row added in a picks view joins its picks', () => {
    const doc = setViewPicks(makeViewsDoc(), 'v1', ['r2'])
    const added = addRowInView(doc, 'v1')
    expect(added.picksChanged).toBe(true)
    expect(added.doc.rows).toHaveLength(4)
    expect(viewOf(added.doc, 'v1').pickedRowIds).toEqual(['r2', added.rowId])
    expect(added.doc.rows[3].id).toBe(added.rowId)
  })

  it('a row added in a view without picks touches only the rows', () => {
    const doc = makeViewsDoc()
    const added = addRowInView(doc, 'v1')
    expect(added.picksChanged).toBe(false)
    expect(added.doc.views).toBe(doc.views)
    expect(added.doc.rows).toHaveLength(4)
  })
})
