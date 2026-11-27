import type { VaultTask } from '@shared/tasks'
import { toIsoDateLocal } from '@shared/tasks'
import type { ContextMenuItem } from '../components/ContextMenu'
import { useStore } from '../store'
import { PLANNED_DAY_FIELD, plannedDay, taskDay } from '@shared/task-planning'
import { DATE_PROMPT_CLEAR, promptDate } from './date-prompt-requests'
import { forwardTaskWithPicker } from './forward-task'
import { useToastStore } from './toast'
import { parseRepeatRule } from '@shared/task-recurrence'
import { chooseTaskRemind, chooseTaskRepeat } from './task-recurrence-pickers'

/**
 * The right-click menu for a task, shared by the Tasks list, the Kanban board
 * and both calendars.
 *
 * It lives here rather than in a component because the three views used to
 * disagree about what a task could do: the calendar had a menu, the list and
 * the board had none, so the same task offered a page of actions on one tab and
 * nothing on the next. One builder means a state added to the model (in
 * progress, cancelled, forwarded) shows up in every view at once.
 *
 * Everything routes through the store actions the keyboard already uses, so a
 * menu click and its keystroke take the same path to disk.
 */

export interface TaskMenuOptions {
  /** Rename in place. Views with an inline edit field pass this; others omit it
   *  and the item is left out rather than shown broken. */
  onEdit?: () => void
  /** Move the task into its due date's daily note (the calendars offer this as
   *  the keyboard/drag gesture, so the menu mirrors it). */
  onMoveToDayNote?: (task: VaultTask, iso: string) => void
  /** Today, as the view reckons it. Passed in so the menu's date presets agree
   *  with the grid the user is looking at. */
  today?: Date
  /** Show the keyboard equivalent beside each action. Pass the view's Vim-mode
   *  flag: these are single-key shortcuts, which are disabled with Vim mode off,
   *  and a hint for a key that does nothing is worse than no hint (see the
   *  cursor row's old "Space check", which never fired because Space is the
   *  leader). */
  showKeyHints?: boolean
}

function addDaysIso(today: Date, n: number): string {
  return toIsoDateLocal(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n))
}

/**
 * Any due date from a month calendar (#991). The presets stop at next week, and
 * a day further out meant looking it up first, then typing `due:` on the line,
 * which is the most work on a phone. The calendar is the one `@date` opens in a
 * note, so it starts on the task's due date (today without one) and takes a
 * tap, arrows or a typed date. Behind the menu entry and the `@` key alike.
 */
export async function chooseTaskDueDate(task: VaultTask, today: Date = new Date()): Promise<void> {
  const iso = await promptDate({
    title: 'Due date',
    description: task.content,
    initialDate: task.due ?? toIsoDateLocal(today),
    okLabel: 'Set due date'
  })
  if (!iso || (iso === task.due && !task.dueInferred)) return
  await useStore.getState().applyTaskMutation(task, { kind: 'set-due', due: iso })
}

/** A task that is done, cancelled or forwarded has no day left to plan. */
export function canPlanTask(task: VaultTask): boolean {
  return !task.checked && !task.cancelled && !task.forwarded
}

/**
 * Plan `task` for a day (#1119), or with null take its plan off. The planned
 * day is `@scheduled:` on a checkbox task and frontmatter `scheduled:` on a
 * task note, and `set-field` writes either. The deadline is not touched.
 */
export async function planTask(task: VaultTask, day: string | null): Promise<void> {
  if (!canPlanTask(task) || (plannedDay(task) ?? null) === day) return
  await useStore
    .getState()
    .applyTaskMutation(task, { kind: 'set-field', key: PLANNED_DAY_FIELD, value: day })
}

/** `p` on the Tasks surfaces: this task is today's work. It says so, since a
 *  task planned out of Upcoming leaves the cursor for Today. */
export async function planTaskForToday(task: VaultTask, today: Date = new Date()): Promise<void> {
  const day = toIsoDateLocal(today)
  if (!canPlanTask(task) || plannedDay(task) === day) return
  await planTask(task, day)
  useToastStore.getState().addToast('Planned for today', 'info')
}

/**
 * Plan for… (#1119): the day to work on a task, from the calendar the due
 * date uses. It opens on the planned day (today without one), so Enter alone
 * plans a task for today, and its Clear button takes the plan off.
 */
export async function chooseTaskPlannedDay(task: VaultTask, today: Date = new Date()): Promise<void> {
  if (!canPlanTask(task)) return
  const current = plannedDay(task)
  const iso = await promptDate({
    title: 'Plan for',
    description: task.content,
    initialDate: current ?? toIsoDateLocal(today),
    okLabel: 'Plan',
    clearLabel: current ? 'Clear' : undefined
  })
  if (!iso) return
  await planTask(task, iso === DATE_PROMPT_CLEAR ? null : iso)
}

export function buildTaskMenuItems(
  task: VaultTask,
  options: TaskMenuOptions = {}
): ContextMenuItem[] {
  const { onEdit, onMoveToDayNote, today = new Date(), showKeyHints = true } = options
  const key = (k: string): string | undefined => (showKeyHints ? k : undefined)
  const state = useStore.getState()
  const mutate = (m: Parameters<typeof state.applyTaskMutation>[1]): void =>
    void state.applyTaskMutation(task, m)
  const dueIn = (n: number): string => addDaysIso(today, n)

  const items: ContextMenuItem[] = [
    { label: 'Open note', hint: key('⏎'), onSelect: () => void state.openTaskAt(task) }
  ]
  if (onEdit) items.push({ label: 'Edit', onSelect: onEdit })

  items.push(
    { kind: 'separator' },
    {
      label: task.checked ? 'Mark not done' : 'Mark done',
      hint: key('x'),
      onSelect: () => void state.toggleTaskFromList(task)
    },
    {
      label: task.inProgress ? 'Set back to open' : 'Mark in progress',
      hint: key('i'),
      onSelect: () => void state.startTaskFromList(task)
    },
    {
      label: task.cancelled ? 'Un-cancel task' : 'Cancel task',
      hint: key('c'),
      onSelect: () => void state.cancelTaskFromList(task)
    },
    {
      label: task.waiting ? 'Clear @waiting' : 'Mark @waiting',
      onSelect: () => mutate({ kind: 'set-waiting', waiting: !task.waiting })
    },
    {
      label: 'Forward to note…',
      hint: key('>'),
      // Forwarding rewrites the checkbox on a task LINE. A whole-note task
      // keeps its state in frontmatter and has no line to rewrite.
      disabled: task.kind === 'file',
      onSelect: () => void forwardTaskWithPicker(task)
    },
    { kind: 'separator' },
    { label: 'Due today', mark: dueIn(0), onSelect: () => mutate({ kind: 'set-due', due: dueIn(0) }) },
    {
      label: 'Due tomorrow',
      mark: dueIn(1),
      onSelect: () => mutate({ kind: 'set-due', due: dueIn(1) })
    },
    {
      label: 'Due next week',
      mark: dueIn(7),
      onSelect: () => mutate({ kind: 'set-due', due: dueIn(7) })
    },
    { label: 'Choose a date…', hint: key('@'), onSelect: () => void chooseTaskDueDate(task, today) }
  )
  // An inferred due date comes from the daily note the task lives in, not from a
  // `due:` token, so there is nothing on the line to clear.
  if (task.due && !task.dueInferred) {
    items.push({ label: 'Clear due date', onSelect: () => mutate({ kind: 'set-due', due: null }) })
  }
  // The planned day (#1119), under the due date it stands beside. The picker
  // clears it too, so the menu needs one entry for both. No key beside it:
  // `p` plans for today outright, which is not what this entry does.
  items.push({
    label: 'Plan for…',
    mark: plannedDay(task),
    disabled: !canPlanTask(task),
    onSelect: () => void chooseTaskPlannedDay(task, today)
  })

  // Recurrence (#1036). Whole-note tasks keep their state in frontmatter, which
  // repeats on TaskNotes' terms, not yet built.
  const repeats = parseRepeatRule(task.fields?.repeat) != null
  items.push(
    { kind: 'separator' },
    {
      label: 'Repeat…',
      hint: key('r'),
      disabled: task.kind === 'file',
      onSelect: () => void chooseTaskRepeat(task)
    },
    {
      label: 'Remind…',
      hint: key('R'),
      disabled: task.kind === 'file',
      onSelect: () => void chooseTaskRemind(task)
    }
  )
  if (repeats && task.kind !== 'file' && !task.checked && !task.cancelled && !task.forwarded) {
    items.push({ label: 'Skip this time', onSelect: () => void state.skipTaskOccurrence(task) })
  }

  items.push(
    { kind: 'separator' },
    {
      label: 'Priority: high',
      disabled: task.priority === 'high',
      onSelect: () => mutate({ kind: 'set-priority', priority: 'high' })
    },
    {
      label: 'Priority: medium',
      disabled: task.priority === 'med',
      onSelect: () => mutate({ kind: 'set-priority', priority: 'med' })
    },
    {
      label: 'Priority: low',
      disabled: task.priority === 'low',
      onSelect: () => mutate({ kind: 'set-priority', priority: 'low' })
    },
    {
      label: 'Clear priority',
      disabled: !task.priority,
      onSelect: () => mutate({ kind: 'set-priority', priority: null })
    }
  )

  if (onMoveToDayNote) {
    const day = taskDay(task, toIsoDateLocal(today))
    items.push(
      { kind: 'separator' },
      {
        // The day the task sits on: its planned day when it has one.
        label: 'Move to its day’s note',
        disabled: !day,
        onSelect: () => {
          if (day) onMoveToDayNote(task, day)
        }
      }
    )
  }

  items.push(
    { kind: 'separator' },
    {
      // A file task IS the note, so this trashes the whole note (the store
      // confirms first); an inline task just loses its line.
      label: task.kind === 'file' ? 'Delete note' : 'Delete task',
      danger: true,
      onSelect: () => void state.deleteTaskFromList(task)
    }
  )

  return items
}
