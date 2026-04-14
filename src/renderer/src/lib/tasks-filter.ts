import type { VaultTask, VaultTaskGroups } from '@shared/tasks'
import { groupTasks, isOverdue } from '@shared/tasks'

/** Simple substring filter across content, note title, tags, and priority. */
export function filterTasks(tasks: VaultTask[], query: string): VaultTask[] {
  const q = query.trim().toLowerCase()
  if (!q) return tasks
  return tasks.filter((task) => {
    if (task.content.toLowerCase().includes(q)) return true
    if (task.noteTitle.toLowerCase().includes(q)) return true
    if (task.priority && `!${task.priority}`.includes(q)) return true
    if (task.tags.some((t) => t.toLowerCase().includes(q))) return true
    return false
  })
}

export interface FlattenedTaskRow {
  kind: 'header' | 'task'
  /** Group the row belongs to — drives the collapse state for 'task' rows. */
  group: 'today' | 'upcoming' | 'waiting' | 'done'
  /** Only set when kind === 'task'. */
  task?: VaultTask
  /** Only set when kind === 'header'. */
  count?: number
  /** Only set when kind === 'header' (today group). */
  overdueCount?: number
}

/** Flatten grouped tasks into a linear list for cursor navigation. Collapsed
 *  groups still show a header but no task rows. */
export function flattenRows(
  groups: VaultTaskGroups,
  collapsed: { today: boolean; upcoming: boolean; waiting: boolean; done: boolean }
): FlattenedTaskRow[] {
  const rows: FlattenedTaskRow[] = []
  const push = (
    group: FlattenedTaskRow['group'],
    tasks: VaultTask[],
    extras?: Partial<FlattenedTaskRow>
  ): void => {
    if (tasks.length === 0 && group !== 'today') return
    rows.push({
      kind: 'header',
      group,
      count: tasks.length,
      ...extras
    })
    if (collapsed[group]) return
    for (const t of tasks) rows.push({ kind: 'task', group, task: t })
  }
  push('today', groups.today, { overdueCount: groups.overdueCount })
  push('upcoming', groups.upcoming)
  push('waiting', groups.waiting)
  push('done', groups.done)
  return rows
}

export interface TasksRender {
  rows: FlattenedTaskRow[]
  groups: VaultTaskGroups
  filtered: VaultTask[]
}

/** One-stop computation used by TasksView — takes raw tasks + filter + today
 *  and returns everything the view needs. */
export function computeTasksRender(
  tasks: VaultTask[],
  filter: string,
  today: Date,
  collapsed: { today: boolean; upcoming: boolean; waiting: boolean; done: boolean }
): TasksRender {
  const filtered = filterTasks(tasks, filter)
  const groups = groupTasks(filtered, today)
  const rows = flattenRows(groups, collapsed)
  return { rows, groups, filtered }
}

export { isOverdue }
