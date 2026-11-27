/**
 * The planned day (#1119): the day a task is meant to be worked on, apart
 * from the day it is due.
 *
 * A task had one date, `due:`, and that is a deadline. Saying "I will do this
 * on Wednesday" meant moving the deadline, which breaks overdue, the Timeline
 * and reminders, or moving the line into Wednesday's daily note. The planned
 * day is the second date:
 *
 *   - [ ] Send the report due:2026-12-04 @scheduled:2026-12-02
 *
 * A checkbox task carries it as the `@scheduled:` field, which rides the
 * `@key:value` grammar (#354), so the four synced task parsers already read
 * it and none changed. A task note carries it as frontmatter `scheduled:`,
 * the TaskNotes key, parsed into `VaultTask.scheduled`. The Logseq importer
 * has written `@scheduled:` since 2.84.0, so imported vaults hold it already.
 *
 * What is new is only the MEANING, and it lives here so no surface answers
 * "which day is this task on" by itself:
 *
 *   - A task sits on its planned day when it has one, on its deadline when it
 *     has none.
 *   - The deadline still wins once it arrives: a task due today or overdue
 *     shows as that, whatever day it was planned for.
 *   - A planned day that passed with the task still open is not lateness. The
 *     task waits under today, in the normal color, and nothing is written.
 *   - Lateness and reminders read the deadline only.
 *
 * A date a task takes from its daily note (`dueInferred`) is a stand-in for
 * "the day this task is on", not a date anyone wrote. A planned day says that
 * outright, so it replaces the note's date: the task is not late by a date it
 * was planned away from. Its reminder still counts from the note's date,
 * as before.
 */
import type { VaultTask } from '@zennotes/bridge-contract/tasks'
import { trailingBlockIdRange } from './block-anchors'

/** The key of the planned day: `@scheduled:` on a checkbox task, frontmatter
 *  `scheduled:` on a task note. */
export const PLANNED_DAY_FIELD = 'scheduled'

/** A date as every task date is written: `YYYY-MM-DD`. */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(t)
}

/** The day a `@scheduled:` value names. Anything but a date is inert: the
 *  field stays on the line as an ordinary field and plans nothing. */
export function parsePlannedDay(raw: string | null | undefined): string | undefined {
  const value = raw?.trim()
  return value && isValidIsoDate(value) ? value : undefined
}

type Planned = Pick<VaultTask, 'kind' | 'scheduled' | 'fields'>

/** The day `task` is planned for, if it has one. */
export function plannedDay(task: Planned): string | undefined {
  return parsePlannedDay(task.kind === 'file' ? task.scheduled : task.fields?.[PLANNED_DAY_FIELD])
}

/**
 * The date `task` has to be done by: its `due:`, the note's frontmatter
 * `due:`, or the date of the daily note it lives in. The last one gives way
 * to a planned day (see the header). Lateness reads this and nothing else.
 */
export function taskDeadline(task: Planned & Pick<VaultTask, 'due' | 'dueInferred'>): string | undefined {
  if (!task.due) return undefined
  return task.dueInferred && plannedDay(task) ? undefined : task.due
}

/**
 * The one day `task` sits on, for every surface that places tasks by date:
 * the list's groups, both calendars, the Timeline, the board's date columns
 * and the calendar widget. `todayIso` is the user's local day.
 *
 * Undefined means the task has no day (the list's No due date).
 */
export function taskDay(task: VaultTask, todayIso: string): string | undefined {
  const planned = plannedDay(task)
  const deadline = taskDeadline(task)
  if (!planned) return deadline
  // The deadline has arrived or passed: the task is due today or late, and
  // says so, wherever it was planned.
  if (deadline && deadline <= todayIso) return deadline
  // A missed plan follows the work to today. Only live work does: a done,
  // cancelled or forwarded line is a record, and stays on the day it names.
  if (planned < todayIso && !task.checked && !task.cancelled && !task.forwarded) return todayIso
  return planned
}

/**
 * The deadline to show beside a task that sits on another day: its planned
 * day, or today after a missed one. Undefined when the task sits on its
 * deadline (the date is already where the task is) or has none.
 */
export function deadlineApartFromDay(task: VaultTask, todayIso: string): string | undefined {
  const deadline = taskDeadline(task)
  return deadline && deadline !== taskDay(task, todayIso) ? deadline : undefined
}

const SCHEDULED_TOKEN = '(^|\\s)@scheduled:[\\p{L}\\d][\\p{L}\\d/_-]*'

/**
 * Set (or with null, remove) the `@scheduled:` field on a task line's text,
 * the part after its checkbox. An existing field is replaced where it stands;
 * a new one goes at the end, before a `^id` block marker, which has to end
 * its line. For the editor, which edits the line under the cursor; the Tasks
 * surfaces write through the `set-field` task mutation.
 */
export function setPlannedDayField(text: string, day: string | null): string {
  const token = new RegExp(SCHEDULED_TOKEN, 'iu')
  if (day == null) {
    if (!token.test(text)) return text
    return text
      .replace(new RegExp(SCHEDULED_TOKEN, 'giu'), '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+$/u, '')
  }
  if (token.test(text)) return text.replace(token, `$1@scheduled:${day}`)
  const trimmed = text.replace(/\s+$/u, '')
  const marker = trailingBlockIdRange(trimmed)
  if (!marker) return `${trimmed} @scheduled:${day}`
  return `${trimmed.slice(0, marker.from).replace(/\s+$/u, '')} @scheduled:${day} ${trimmed.slice(marker.from)}`
}
