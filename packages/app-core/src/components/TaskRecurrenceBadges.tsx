import type { VaultTask } from '@shared/tasks'
import { describeRepeatRule, parseRepeatRule } from '@shared/task-recurrence'
import { describeRemindSpec, parseRemindSpec } from '@shared/task-reminders'
import { useStore } from '../store'
import { BellIcon, RepeatIcon } from './icons'

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

/** Fields the boards and filters leave alone: the recurrence fields are
 *  scheduling, not a status, so they never become a column or a lane. */
export const SCHEDULING_FIELDS: ReadonlySet<string> = new Set(['repeat', 'remind'])
