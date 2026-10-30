import type { VaultTask } from '@shared/tasks'

/**
 * A checkbox with nothing written after it: the `- [ ]` a daily-note template
 * leaves for the day's tasks (#1026). The parser falls back to the raw tail
 * when stripping tokens leaves nothing, so a task that is only `due:…` or
 * `!high` still has text here and is never counted as empty.
 */
export function isEmptyTask(task: Pick<VaultTask, 'content'>): boolean {
  return task.content.trim() === ''
}

/** The tasks with text, and how many empty ones were left out. The same
 *  array comes back when nothing was empty, so memoized consumers keep
 *  their identity. */
export function withoutEmptyTasks<T extends Pick<VaultTask, 'content'>>(
  tasks: T[]
): { shown: T[]; hidden: number } {
  const shown = tasks.filter((task) => !isEmptyTask(task))
  const hidden = tasks.length - shown.length
  return { shown: hidden === 0 ? tasks : shown, hidden }
}

/** The quiet "3 hidden" pill's tooltip, which also says what a click does,
 *  so the hidden placeholders read as hidden rather than lost. */
export function emptyTasksShowLabel(count: number): string {
  return `Show ${count} empty task${count === 1 ? '' : 's'}`
}
