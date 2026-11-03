/**
 * The database Board's keyboard and its cards (#1038, New Kanban).
 *
 * The keys follow the Tasks Kanban board, so one muscle memory drives both:
 * h / l across columns, j / k between cards, H / L carry the card a column,
 * o opens its page, a adds a card, m opens its menu, C colors the column. Like every list in the
 * app the letters are Vim mode's alone; with Vim mode off the arrows move,
 * Enter opens (or adds a card in an empty column), and Shift+F10 or the
 * Context Menu key opens the card's menu, which can also move it. A chord is
 * never the board's.
 *
 * Pure, so the gating and the cursor rules are tested apart from the view.
 */
import { EMPTY_GROUP } from '@shared/databases'
import type { BoardColumn } from '@shared/database-transforms'
import type { DatabaseDoc } from '@shared/databases'
import { addRowInView, setCell } from './database-cells'

export type DatabaseBoardKeyAction =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'move-left'
  | 'move-right'
  | 'open'
  | 'add'
  | 'menu'
  | 'color'

export interface BoardKey {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

const UNIVERSAL = new Map<string, DatabaseBoardKeyAction>(Object.entries({
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'open',
  ContextMenu: 'menu'
}) as Array<[string, DatabaseBoardKeyAction]>)

const VIM_ONLY = new Map<string, DatabaseBoardKeyAction>(Object.entries({
  h: 'left',
  l: 'right',
  k: 'up',
  j: 'down',
  H: 'move-left',
  L: 'move-right',
  o: 'open',
  a: 'add',
  m: 'menu',
  C: 'color'
}) as Array<[string, DatabaseBoardKeyAction]>)

export function databaseBoardKeyAction(e: BoardKey, vimMode: boolean): DatabaseBoardKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  if (e.key === 'F10') return e.shiftKey ? 'menu' : null
  const universal = UNIVERSAL.get(e.key)
  if (universal) return universal
  if (!vimMode) return null
  return VIM_ONLY.get(e.key) ?? null
}

/** The columns a board draws: the "No status" column only while a card
 *  sits in it, so a fresh board fits its own columns. */
export function visibleBoardColumns(columns: BoardColumn[]): BoardColumn[] {
  return columns.filter((column) => column.key !== EMPTY_GROUP || column.rows.length > 0)
}

/** The board cursor: a column and one of its cards, or the column's Add
 *  card slot below them (`rowId` null). Kept by key and row id so it
 *  follows a card across writes. */
export interface BoardCursor {
  columnKey: string
  rowId: string | null
}

/** Column and card indices for `cursor` on `columns`. A card index equal to
 *  the column's card count is its Add card slot, which is where an empty
 *  column's cursor sits. A cursor naming a column or card that is gone falls
 *  back to the first card of the first column. */
export function resolveBoardCursor(
  columns: BoardColumn[],
  cursor: BoardCursor | null
): { column: number; card: number } {
  if (columns.length === 0) return { column: -1, card: -1 }
  const found = columns.findIndex((c) => c.key === cursor?.columnKey)
  const column = Math.max(0, found)
  const rows = columns[column].rows
  if (found >= 0 && cursor?.rowId === null) return { column, card: rows.length }
  const card = rows.findIndex((r) => r.id === cursor?.rowId)
  return { column, card: Math.max(0, card) }
}

/** The cursor after an arrow or h / j / k / l. Down from a column's last card
 *  reaches its Add card slot. Across columns the cursor keeps its height
 *  where the next column is tall enough, and stays on the slot when it is
 *  on one. */
export function stepBoardCursor(
  columns: BoardColumn[],
  cursor: BoardCursor | null,
  action: 'left' | 'right' | 'up' | 'down'
): BoardCursor | null {
  const at = resolveBoardCursor(columns, cursor)
  if (at.column < 0) return null
  let column = at.column
  let card = at.card
  if (action === 'left' || action === 'right') {
    const onSlot = card === columns[column].rows.length
    column = Math.max(0, Math.min(columns.length - 1, column + (action === 'left' ? -1 : 1)))
    const count = columns[column].rows.length
    card = onSlot ? count : Math.min(card, Math.max(count - 1, 0))
  } else {
    card = Math.max(0, Math.min(columns[column].rows.length, card + (action === 'up' ? -1 : 1)))
  }
  return { columnKey: columns[column].key, rowId: columns[column].rows[card]?.id ?? null }
}

/**
 * A new card titled `title` in the column `columnKey`, appended after the
 * column's cards. Like + Row, a card added in a view of picked rows joins
 * the picks (`picksChanged` then means the schema must be written too).
 */
export function addBoardCard(
  doc: DatabaseDoc,
  viewId: string,
  titleFieldId: string | undefined,
  groupFieldId: string,
  columnKey: string,
  title: string
): { doc: DatabaseDoc; rowId: string; picksChanged: boolean } {
  const added = addRowInView(doc, viewId)
  let next = setCell(added.doc, added.rowId, groupFieldId, columnKey === EMPTY_GROUP ? '' : columnKey)
  if (titleFieldId) next = setCell(next, added.rowId, titleFieldId, title)
  return { doc: next, rowId: added.rowId, picksChanged: added.picksChanged }
}
