import type { KanbanGroupBy, TaskMutation } from '../store'
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
