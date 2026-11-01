import { completeRecurringTaskAtIndex } from '@shared/task-recurrence'
import { toggleTaskAtIndex } from '@shared/tasklists'
import { toIsoDateLocal } from '@shared/tasks'
import { useStore } from '../store'
import { dailyNoteDueForPath } from './vault-layout'

/** The date a daily note gives its tasks, when `path` is one and its tasks
 *  take it. A recurring task without `due:` counts from it (#1036). */
export function dailyDueForNote(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  const state = useStore.getState()
  return dailyNoteDueForPath(state.notes, state.vaultSettings, path)
}

/**
 * `markdown` with the task at `taskIndex` checked off. A recurring task writes
 * its next occurrence above itself (#1036); any other task just gets its `x`.
 * For surfaces that edit a note's body directly, like Preview's checkboxes.
 */
export function checkOffTaskInMarkdown(
  markdown: string,
  taskIndex: number,
  notePath: string | null | undefined
): string {
  const recurring = completeRecurringTaskAtIndex(markdown, taskIndex, {
    today: toIsoDateLocal(new Date()),
    fallbackDue: dailyDueForNote(notePath)
  })
  return recurring?.body ?? toggleTaskAtIndex(markdown, taskIndex, true)
}
