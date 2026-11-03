import { describe, expect, it } from 'vitest'
import { EMPTY_GROUP, type DatabaseDoc, type DbRow } from '@shared/databases'
import type { BoardColumn } from '@shared/database-transforms'
import {
  addBoardCard,
  databaseBoardKeyAction,
  resolveBoardCursor,
  stepBoardCursor,
  visibleBoardColumns
} from './database-board'

const row = (id: string): DbRow => ({ id, cells: { id } })
const column = (key: string, ids: string[]): BoardColumn => ({ key, rows: ids.map(row) })

describe('databaseBoardKeyAction', () => {
  it('colors a column on C, with Vim mode on only', () => {
    expect(databaseBoardKeyAction({ key: 'C', shiftKey: true }, true)).toBe('color')
    expect(databaseBoardKeyAction({ key: 'C', shiftKey: true }, false)).toBeNull()
    expect(databaseBoardKeyAction({ key: 'c' }, true)).toBeNull()
  })

  it('answers the Tasks board letters only with Vim mode on', () => {
    const vim: Array<[string, string]> = [
      ['h', 'left'],
      ['l', 'right'],
      ['k', 'up'],
      ['j', 'down'],
      ['H', 'move-left'],
      ['L', 'move-right'],
      ['o', 'open'],
      ['a', 'add'],
      ['m', 'menu']
    ]
    for (const [key, action] of vim) {
      expect(databaseBoardKeyAction({ key }, true)).toBe(action)
      expect(databaseBoardKeyAction({ key }, false)).toBeNull()
    }
  })

  it('keeps the arrows, Enter and the menu keys in either mode', () => {
    for (const vimMode of [true, false]) {
      expect(databaseBoardKeyAction({ key: 'ArrowLeft' }, vimMode)).toBe('left')
      expect(databaseBoardKeyAction({ key: 'ArrowRight' }, vimMode)).toBe('right')
      expect(databaseBoardKeyAction({ key: 'ArrowUp' }, vimMode)).toBe('up')
      expect(databaseBoardKeyAction({ key: 'ArrowDown' }, vimMode)).toBe('down')
      expect(databaseBoardKeyAction({ key: 'Enter' }, vimMode)).toBe('open')
      expect(databaseBoardKeyAction({ key: 'ContextMenu' }, vimMode)).toBe('menu')
      expect(databaseBoardKeyAction({ key: 'F10', shiftKey: true }, vimMode)).toBe('menu')
      expect(databaseBoardKeyAction({ key: 'F10' }, vimMode)).toBeNull()
    }
  })

  it('never takes a chord', () => {
    expect(databaseBoardKeyAction({ key: 'l', metaKey: true }, true)).toBeNull()
    expect(databaseBoardKeyAction({ key: 'ArrowLeft', ctrlKey: true }, true)).toBeNull()
    expect(databaseBoardKeyAction({ key: 'Enter', altKey: true }, false)).toBeNull()
  })
})

describe('visibleBoardColumns', () => {
  it('draws No status only while a card sits in it', () => {
    const empty = [column('To do', []), column(EMPTY_GROUP, [])]
    expect(visibleBoardColumns(empty).map((c) => c.key)).toEqual(['To do'])
    const used = [column('To do', []), column(EMPTY_GROUP, ['r1'])]
    expect(visibleBoardColumns(used).map((c) => c.key)).toEqual(['To do', EMPTY_GROUP])
  })
})

describe('board cursor', () => {
  const cols = [column('To do', ['a', 'b', 'c']), column('Doing', ['d']), column('Done', [])]

  it('starts on the first card, and an empty column puts it on Add card', () => {
    expect(resolveBoardCursor(cols, null)).toEqual({ column: 0, card: 0 })
    expect(resolveBoardCursor(cols, { columnKey: 'Done', rowId: null })).toEqual({ column: 2, card: 0 })
    expect(resolveBoardCursor([], null)).toEqual({ column: -1, card: -1 })
  })

  it('falls back to the first card when its card or column is gone', () => {
    expect(resolveBoardCursor(cols, { columnKey: 'Doing', rowId: 'zz' })).toEqual({ column: 1, card: 0 })
    expect(resolveBoardCursor(cols, { columnKey: 'Gone', rowId: 'a' })).toEqual({ column: 0, card: 0 })
  })

  it('walks the cards, and down from the last one reaches Add card', () => {
    let c = stepBoardCursor(cols, { columnKey: 'To do', rowId: 'b' }, 'down')
    expect(c).toEqual({ columnKey: 'To do', rowId: 'c' })
    c = stepBoardCursor(cols, c, 'down')
    expect(c).toEqual({ columnKey: 'To do', rowId: null })
    expect(stepBoardCursor(cols, c, 'down')).toEqual({ columnKey: 'To do', rowId: null })
    expect(stepBoardCursor(cols, c, 'up')).toEqual({ columnKey: 'To do', rowId: 'c' })
    expect(stepBoardCursor(cols, { columnKey: 'To do', rowId: 'a' }, 'up')).toEqual({ columnKey: 'To do', rowId: 'a' })
  })

  it('keeps its height across columns where it can, and stays on Add card', () => {
    expect(stepBoardCursor(cols, { columnKey: 'To do', rowId: 'c' }, 'right')).toEqual({ columnKey: 'Doing', rowId: 'd' })
    expect(stepBoardCursor(cols, { columnKey: 'Doing', rowId: 'd' }, 'right')).toEqual({ columnKey: 'Done', rowId: null })
    expect(stepBoardCursor(cols, { columnKey: 'Done', rowId: null }, 'left')).toEqual({ columnKey: 'Doing', rowId: null })
    expect(stepBoardCursor(cols, { columnKey: 'Done', rowId: null }, 'right')).toEqual({ columnKey: 'Done', rowId: null })
    expect(stepBoardCursor([], null, 'left')).toBeNull()
  })
})

describe('addBoardCard', () => {
  const doc: DatabaseDoc = {
    version: 1,
    path: 'Biology/Untitled Kanban.base/data.csv',
    title: 'Untitled Kanban',
    idFieldId: 'id',
    fields: [
      { id: 'id', name: 'id', type: 'text', hidden: true },
      { id: 'name', name: 'Name', type: 'text' },
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Doing' }] }
    ],
    views: [{ id: 'board', name: 'Board', type: 'board', filters: [], sorts: [], groupByFieldId: 'status' }],
    activeViewId: 'board',
    rows: [{ id: 'r1', cells: { id: 'r1', name: 'Old', status: 'Doing' } }]
  }

  it('appends a titled card in the column', () => {
    const added = addBoardCard(doc, 'board', 'name', 'status', 'Doing', 'Read chapter 4')
    expect(added.picksChanged).toBe(false)
    expect(added.doc.rows).toHaveLength(2)
    const card = added.doc.rows[1]
    expect(card.id).toBe(added.rowId)
    expect(card.cells).toEqual({ id: added.rowId, name: 'Read chapter 4', status: 'Doing' })
  })

  it('leaves the status empty in No status, and joins a view’s picks', () => {
    const picked = { ...doc, views: [{ ...doc.views[0], pickedRowIds: ['r1'] }] }
    const added = addBoardCard(picked, 'board', 'name', 'status', EMPTY_GROUP, 'Loose')
    expect(added.doc.rows[1].cells.status).toBe('')
    expect(added.picksChanged).toBe(true)
    expect(added.doc.views[0].pickedRowIds).toEqual(['r1', added.rowId])
  })
})
