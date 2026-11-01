/**
 * Task reminders in the running app (#1036): keep the host's schedule in step
 * with the tasks, and open the task a clicked reminder names.
 *
 * The schedule is computed here, from the task index the app already keeps,
 * so a local vault and a self-hosted one remind the same way. The host (the
 * desktop main process) only times and shows it.
 */
import { filterTasksForDisplay, inferDailyTaskDueDates } from '@shared/tasks'
import {
  computeTaskReminders,
  plainTaskTitle,
  type TaskReminder,
  type TaskReminderTarget
} from '@shared/task-reminders'
import { useStore } from '../store'
import { buildDailyNoteDateByPath } from './vault-layout'

/** The reminders the open tasks ask for, as the Tasks views see the tasks:
 *  trash and (unless shown) archived notes out, daily-note dates in. */
export function currentTaskReminders(now = new Date()): TaskReminder[] {
  const s = useStore.getState()
  if (!s.vault || !s.taskReminders) return []
  const live = new Set(s.notes.filter((n) => n.folder !== 'trash').map((n) => n.path))
  const shown = filterTasksForDisplay(s.vaultTasks, s.showArchivedTasks).filter((t) =>
    live.has(t.sourcePath)
  )
  const dated = inferDailyTaskDueDates(shown, buildDailyNoteDateByPath(s.notes, s.vaultSettings))
  return computeTaskReminders(dated, { now, defaultTime: s.taskReminderTime })
}

/**
 * Send the schedule whenever it changes, debounced, and hourly so the
 * week-ahead window moves with the clock. Nothing is sent until the vault's
 * tasks are indexed: an empty schedule at startup would read to the host as
 * "nothing to catch up on".
 */
export function startTaskReminderReporter(): () => void {
  if (!window.zen.setTaskReminders) return () => undefined
  let indexed = useStore.getState().vaultTasks.length > 0
  let last: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const send = (): void => {
    timer = null
    if (!indexed) return
    const list = currentTaskReminders()
    const key = JSON.stringify(list)
    if (key === last) return
    last = key
    window.zen.setTaskReminders?.(list)
  }
  const schedule = (): void => {
    if (timer == null) timer = setTimeout(send, 1000)
  }

  const unsubscribe = useStore.subscribe((s, prev) => {
    if (s.vault !== prev.vault) {
      indexed = false
      last = null
    }
    if ((prev.tasksLoading && !s.tasksLoading) || s.vaultTasks.length > 0) indexed = true
    if (
      s.vaultTasks !== prev.vaultTasks ||
      s.notes !== prev.notes ||
      s.vaultSettings !== prev.vaultSettings ||
      s.showArchivedTasks !== prev.showArchivedTasks ||
      s.taskReminders !== prev.taskReminders ||
      s.taskReminderTime !== prev.taskReminderTime ||
      s.tasksLoading !== prev.tasksLoading
    ) {
      schedule()
    }
  })
  const hourly = setInterval(schedule, 3_600_000)
  schedule()
  return () => {
    unsubscribe()
    clearInterval(hourly)
    if (timer != null) clearTimeout(timer)
  }
}

/** Open what a clicked reminder names: its task (found again by note and
 *  text, since lines may have moved), the note when the task is gone, or the
 *  Tasks view for a folded notification. */
export async function openTaskReminderTarget(target: TaskReminderTarget): Promise<void> {
  const state = useStore.getState()
  if (!target) {
    await state.openTasksView()
    return
  }
  const same = state.vaultTasks.filter(
    (t) => t.sourcePath === target.path && plainTaskTitle(t.content) === target.title && !t.checked
  )
  const task = same.find((t) => t.taskIndex === target.taskIndex) ?? same[0]
  if (task) {
    await state.openTaskAt(task)
    return
  }
  if (state.notes.some((n) => n.path === target.path)) {
    await state.openNoteInPane(state.activePaneId, target.path)
  }
}

/** Listen for clicked reminders. */
export function listenForTaskReminderOpen(): () => void {
  return window.zen.onTaskReminderOpen?.((target) => void openTaskReminderTarget(target)) ?? (() => undefined)
}
