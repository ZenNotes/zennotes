import type { VaultTask } from '@shared/tasks'
import { describeRepeatRule, parseRepeatRule } from '@shared/task-recurrence'
import { describeRemindSpec, parseRemindSpec } from '@shared/task-reminders'
import { PLANNED_DAY_FIELD, deadlineApartFromDay, plannedDay } from '@shared/task-planning'
import { useStore } from '../store'
import { BellIcon, FlagIcon, PlannedIcon, RepeatIcon } from './icons'

/**
 * The quiet marks a recurring task wears on the Tasks surfaces (#1036): a
 * repeat icon when it repeats (the rule in its tooltip) and a bell with the
 * time when it has a reminder. They stand in for the raw `@repeat:` and
 * `@remind:` field chips, which read as noise next to the due date.
 */
export function TaskRecurrenceBadges({ task }: { task: VaultTask }): JSX.Element | null {
  const timeFormat = useStore((s) => s.timeFormat)
  const rule = parseRepeatRule(task.fields?.repeat)
  const spec = parseRemindSpec(task.fields?.remind)
  if (!rule && !spec) return null
  return (
    <>
      {rule && (
        <span
          data-task-repeat={task.fields?.repeat}
          title={`Repeats: ${describeRepeatRule(rule)}`}
          className="inline-flex shrink-0 items-center text-current/50"
        >
          <RepeatIcon width={12} height={12} aria-label="Repeats" />
        </span>
      )}
      {spec && (
        <span
          data-task-remind={task.fields?.remind}
          title="Reminder"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-current/50"
        >
          <BellIcon width={12} height={12} aria-hidden="true" />
          {describeRemindSpec(spec, timeFormat)}
        </span>
      )}
    </>
  )
}

function parseDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** "Dec 2": a day as the due chips write it. */
export function shortTaskDay(iso: string): string {
  return parseDay(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function longTaskDay(iso: string): string {
  return parseDay(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}

/**
 * The quiet mark of a planned day (#1119): a small calendar with the day
 * beside it, in place of the raw `@scheduled:` chip. `compact` keeps the icon
 * alone, for a row already listed under its day (the calendars, the
 * Timeline), where the tooltip still says which day was planned. Finished
 * work no longer has a plan worth showing.
 */
export function TaskPlanBadge({
  task,
  compact = false
}: {
  task: VaultTask
  compact?: boolean
}): JSX.Element | null {
  const day = plannedDay(task)
  if (!day || task.checked || task.cancelled) return null
  return (
    <span
      data-task-planned={day}
      title={`Planned for ${longTaskDay(day)}`}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-current/50"
    >
      <PlannedIcon width={12} height={12} aria-label="Planned" />
      {!compact && shortTaskDay(day)}
    </span>
  )
}

/**
 * The deadline of a task that sits on another day, its planned one (#1119):
 * a small flag and the date. Nothing for a task that sits on its deadline,
 * since the row is already where the date is.
 */
export function TaskDeadlineFlag({
  task,
  todayIso
}: {
  task: VaultTask
  todayIso: string
}): JSX.Element | null {
  const deadline = deadlineApartFromDay(task, todayIso)
  if (!deadline || task.checked || task.cancelled) return null
  return (
    <span
      data-task-deadline={deadline}
      title={`Due ${longTaskDay(deadline)}`}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-current/50"
    >
      <FlagIcon width={12} height={12} aria-label="Due" />
      {shortTaskDay(deadline)}
    </span>
  )
}

/** Fields the boards and filters leave alone: the recurrence fields and the
 *  planned day are scheduling, not a status, so they never become a column,
 *  a lane or a group-by. */
export const SCHEDULING_FIELDS: ReadonlySet<string> = new Set(['repeat', 'remind', PLANNED_DAY_FIELD])
