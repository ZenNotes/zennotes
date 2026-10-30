/**
 * Swimlanes on the Kanban board (#1027): the pieces of the lane model that
 * need nothing from the board itself. The board splits its columns into
 * horizontal lanes by a second field (Priority, Folder, Tag, or any `@field`),
 * each lane a row across the same columns; see `laneDefsFor` and
 * `splitIntoLanes` in TasksKanban for how lanes are built.
 *
 * The keyboard cursor in lane mode is a `LaneCursor` over one column: the
 * column's header on top (lane -1), then per lane its header (card -1) and its
 * cell's cards, or the cell itself when it holds none, so an empty cell is a
 * place to stand and drop. A collapsed lane is its header alone.
 */
import type { KanbanGroupBy, KanbanLaneBy } from '../store'

export interface LaneOption {
  value: KanbanLaneBy
  label: string
}

/** The few words a lane field goes by in the View menu and its toast. */
export function laneFieldLabel(laneBy: KanbanLaneBy): string {
  switch (laneBy) {
    case 'none':
      return 'None'
    case 'priority':
      return 'Priority'
    case 'folder':
      return 'Folder'
    case 'tag':
      return 'Tag'
    default:
      return laneBy === 'field:status' ? 'Custom status' : `@${laneBy.slice('field:'.length)}`
  }
}

/**
 * The lane fields a board offers: None, Priority, Folder, Tag, Custom status
 * when there are statuses to show, then one per `@field` the tasks use. The
 * board's own column field is never one: lanes by the field the columns
 * already split would put every card on the diagonal. A chosen field nobody
 * uses at the moment stays listed, so the menu can show what is in force.
 */
export function laneOptions(
  groupBy: KanbanGroupBy,
  fieldKeys: Iterable<string>,
  { customStatus, current }: { customStatus: boolean; current: KanbanLaneBy }
): LaneOption[] {
  const values: KanbanLaneBy[] = ['none', 'priority', 'folder', 'tag']
  if (customStatus) values.push('field:status')
  for (const key of [...new Set(fieldKeys)].sort()) {
    if (key !== 'status') values.push(`field:${key}`)
  }
  if (!values.includes(current)) values.push(current)
  return values
    .filter((value) => value !== groupBy)
    .map((value) => ({ value, label: laneFieldLabel(value) }))
}

/** The lanes a board shows: none while its columns split by the lane field.
 *  The choice itself is kept, so the lanes come back with another group-by. */
export function activeLaneBy(groupBy: KanbanGroupBy, laneBy: KanbanLaneBy): KanbanLaneBy {
  return laneBy === groupBy ? 'none' : laneBy
}

/** The next lane field for `S`, wrapping back to None. */
export function nextLaneBy(options: readonly LaneOption[], current: KanbanLaneBy): KanbanLaneBy {
  if (options.length === 0) return 'none'
  const at = options.findIndex((option) => option.value === current)
  if (at < 0) return options[0].value
  return options[(at + 1) % options.length].value
}

/** Where the keyboard cursor sits in lane mode: `laneIdx` -1 is the column's
 *  header; otherwise `cardIdx` -1 is the lane's header, and 0 or more a card
 *  of the lane's cell in the focused column (0 alone: the cell, when empty). */
export interface LaneCursor {
  laneIdx: number
  cardIdx: number
}

/** One lane as the cursor sees it: its cell in the focused column. */
export interface LaneShape {
  cards: number
  collapsed: boolean
}

const COLUMN_HEADER: LaneCursor = { laneIdx: -1, cardIdx: -1 }

/** The last stop of a lane: its header when collapsed, else its last card
 *  (or its empty cell). */
function lastStop(laneIdx: number, lane: LaneShape): LaneCursor {
  return lane.collapsed ? { laneIdx, cardIdx: -1 } : { laneIdx, cardIdx: Math.max(1, lane.cards) - 1 }
}

/** `j` / `k` and the arrows in lane mode: one stop down or up the focused
 *  column, through lane headers and cells, over a collapsed lane on its
 *  header. Stays put at either end. */
export function laneCursorStep(cursor: LaneCursor, delta: -1 | 1, lanes: readonly LaneShape[]): LaneCursor {
  const at = clampLaneCursor(cursor, lanes)
  if (delta === 1) {
    if (at.laneIdx < 0) return lanes.length > 0 ? { laneIdx: 0, cardIdx: -1 } : at
    const lane = lanes[at.laneIdx]
    if (!lane.collapsed && at.cardIdx < Math.max(1, lane.cards) - 1) {
      return { laneIdx: at.laneIdx, cardIdx: at.cardIdx + 1 }
    }
    return at.laneIdx + 1 < lanes.length ? { laneIdx: at.laneIdx + 1, cardIdx: -1 } : at
  }
  if (at.laneIdx < 0) return at
  if (at.cardIdx >= 0) return { laneIdx: at.laneIdx, cardIdx: at.cardIdx - 1 }
  if (at.laneIdx === 0) return COLUMN_HEADER
  return lastStop(at.laneIdx - 1, lanes[at.laneIdx - 1])
}

/** `}` / `{`: to the next or previous lane's header. From inside a lane, `{`
 *  first goes to that lane's own header, as it goes from a block to its note
 *  in the Tags view; above the first lane is the column header. */
export function laneJump(cursor: LaneCursor, delta: -1 | 1, laneCount: number): LaneCursor {
  if (laneCount === 0) return COLUMN_HEADER
  const laneIdx = Math.min(cursor.laneIdx, laneCount - 1)
  if (delta === 1) {
    if (laneIdx < 0) return { laneIdx: 0, cardIdx: -1 }
    return { laneIdx: Math.min(laneCount - 1, laneIdx + 1), cardIdx: -1 }
  }
  if (laneIdx < 0) return COLUMN_HEADER
  if (cursor.cardIdx >= 0) return { laneIdx, cardIdx: -1 }
  return laneIdx === 0 ? COLUMN_HEADER : { laneIdx: laneIdx - 1, cardIdx: -1 }
}

const FIELD_KEY_RE = /^[a-z][a-z0-9_-]*$/

/** The lane field `:lanes <arg>` names: none (bare, `none`, `off`), priority,
 *  folder, tag, `status` for Custom status, or any field as `@key`, `field:key`
 *  or the bare key. Null when it names nothing a board can split by. */
export function parseLanesArg(raw: string): KanbanLaneBy | null {
  const arg = raw.trim().toLowerCase()
  if (!arg || arg === 'none' || arg === 'off') return 'none'
  if (arg === 'priority' || arg === 'folder' || arg === 'tag') return arg
  if (arg === 'tags') return 'tag'
  const key = arg.replace(/^@/, '').replace(/^field:/, '')
  return FIELD_KEY_RE.test(key) ? `field:${key}` : null
}

/** The cursor the board can draw after its lanes changed under it: a lane
 *  that went away clamps to the last one, a collapsed lane holds it on its
 *  header, a shorter cell on its last card. */
export function clampLaneCursor(cursor: LaneCursor, lanes: readonly LaneShape[]): LaneCursor {
  if (lanes.length === 0 || cursor.laneIdx < 0) return COLUMN_HEADER
  const laneIdx = Math.min(cursor.laneIdx, lanes.length - 1)
  const lane = lanes[laneIdx]
  if (cursor.cardIdx < 0 || lane.collapsed) return { laneIdx, cardIdx: -1 }
  return { laneIdx, cardIdx: Math.min(cursor.cardIdx, Math.max(0, lane.cards - 1)) }
}
