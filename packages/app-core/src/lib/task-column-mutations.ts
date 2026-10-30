import type { KanbanGroupBy, KanbanLaneBy, TaskMutation } from '../store'
import { toIsoDateLocal, type VaultTask } from '@shared/tasks'

/** Map a (groupBy, columnId) drop target to the task-line mutations
 *  that should land. Returns `null` when the drop has no defined
 *  semantics (e.g. when group-by is 'folder'). Returns `[]` when the
 *  task is already in the target column; caller can short-circuit. */
export function dropMutationsFor(
  groupBy: KanbanGroupBy,
  columnId: string,
  task: VaultTask,
  today: Date
): TaskMutation[] | null {
  if (groupBy === 'status') {
    const todayIso = toIsoDateLocal(today)
    switch (columnId) {
      case 'today':
        // "Live" columns; make sure neither @waiting, [x] nor [/] keep the
        // task glued to a different bucket.
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: false },
          { kind: 'set-in-progress', inProgress: false },
          { kind: 'set-due', due: todayIso }
        ]
      case 'upcoming': {
        const tomorrow = new Date(today)
        tomorrow.setDate(tomorrow.getDate() + 1)
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: false },
          { kind: 'set-in-progress', inProgress: false },
          {
            kind: 'set-due',
            due: task.due && task.due > todayIso ? task.due : toIsoDateLocal(tomorrow)
          }
        ]
      }
      case 'undated':
        // A daily note's date is not on the line, so there is no `due:` to
        // clear: the card would land straight back in its day. Refuse the
        // drop rather than pretend (#990), as the menu offers no Clear due
        // date for such a task.
        if (task.dueInferred) return null
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: false },
          { kind: 'set-in-progress', inProgress: false },
          { kind: 'set-due', due: null }
        ]
      case 'in-progress':
        // Started work: `[/]`. The due date is left alone, so a card dragged
        // back to Today or Upcoming keeps the date it had.
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: false },
          { kind: 'set-in-progress', inProgress: true }
        ]
      case 'waiting':
        // `[/]` survives underneath on purpose: clearing the wait returns the
        // card to In progress, where it came from.
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: true }
        ]
      case 'done':
        return [{ kind: 'set-checked', checked: true }]
      default:
        return null
    }
  }
  if (groupBy === 'priority') {
    if (columnId === 'high') return [{ kind: 'set-priority', priority: 'high' }]
    if (columnId === 'med') return [{ kind: 'set-priority', priority: 'med' }]
    if (columnId === 'low') return [{ kind: 'set-priority', priority: 'low' }]
    if (columnId === 'none') return [{ kind: 'set-priority', priority: null }]
    return null
  }
  if (groupBy.startsWith('field:')) {
    // Drop sets the `@<key>:<value>` token; the No-<key> column clears it.
    const key = groupBy.slice('field:'.length)
    return [{ kind: 'set-field', key, value: columnId === '__none__' ? null : columnId }]
  }
  // Folder grouping is read-only; moving the task across folders
  // means moving the source note, which the user does explicitly via
  // the sidebar.
  return null
}

/** Sentinel id of a lane for cards without the field: No tag, No <field>.
 *  The column's NO_VALUE_COLUMN_ID, which no tag or field value can be. */
const NO_LANE_ID = '__none__'

/**
 * The task-line mutations a drop on a swimlane writes (#1027): the lane's own
 * field and nothing else. Priority and `@field` lanes reuse the column drops,
 * so a lane writes exactly what its column twin would. A tag lane makes its tag
 * the card's first one (No tag strips them). Returns null when the lane cannot
 * take the card: folder lanes are read-only like folder columns (moving a note
 * is a move, not a drag), and a task note keeps its tags in a frontmatter list.
 */
export function laneDropMutationsFor(
  laneBy: KanbanLaneBy,
  laneId: string,
  task: VaultTask
): TaskMutation[] | null {
  // Only the Status board reads the date, and Status is never a lane field.
  if (laneBy === 'priority') return dropMutationsFor('priority', laneId, task, new Date())
  if (laneBy === 'tag') {
    if (task.kind === 'file') return null
    return [{ kind: 'set-tag', tag: laneId === NO_LANE_ID ? null : laneId }]
  }
  if (laneBy.startsWith('field:')) return dropMutationsFor(laneBy as KanbanGroupBy, laneId, task, new Date())
  return null
}

/** One place on the board: a column, a lane, or a cell of both. A lane
 *  header is a lane alone; a column header (or a board without lanes) is a
 *  column alone. */
export interface BoardCell {
  columnId: string | null
  laneId: string | null
}

/**
 * What a card dropped from `from` onto `to` writes: the column's tokens when it
 * crossed into another column, the lane's when it crossed into another lane,
 * both in one write when it crossed both, and nothing for a reorder inside its
 * cell. When either half cannot land the whole drop is refused, as the
 * undated drop is (#990): a card that took only half a move would sit
 * somewhere other than where it was dropped.
 */
export function boardDropMutations(
  groupBy: KanbanGroupBy,
  laneBy: KanbanLaneBy,
  from: BoardCell,
  to: BoardCell,
  task: VaultTask,
  today: Date
): TaskMutation[] | null {
  const mutations: TaskMutation[] = []
  if (to.columnId !== null && to.columnId !== from.columnId) {
    const column = dropMutationsFor(groupBy, to.columnId, task, today)
    if (!column) return null
    mutations.push(...column)
  }
  if (laneBy !== 'none' && to.laneId !== null && to.laneId !== from.laneId) {
    const lane = laneDropMutationsFor(laneBy, to.laneId, task)
    if (!lane) return null
    mutations.push(...lane)
  }
  return mutations
}
