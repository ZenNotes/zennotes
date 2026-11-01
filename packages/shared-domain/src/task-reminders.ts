/**
 * Task reminders (#1036): the `@remind:<when>` field and the schedule it gives.
 *
 * A reminder is relative to the task's due date, which is date-only, so the
 * field says WHICH day (the due date, or N days before) and at WHAT time:
 *
 *   @remind:9am     9:00 on the due date        @remind:1d      the day before,
 *   @remind:930am   9:30 on the due date                        at the default time
 *   @remind:1730    17:30 on the due date       @remind:2d-6pm  two days before, 18:00
 *   @remind:17h30   17:30 on the due date
 *
 * Like `@repeat:`, it is a plain `@key:value` field, so the four synced task
 * parsers already read it (the value is lower-cased) and none changed. A task
 * with no due date, written or taken from its daily note, has nothing to be
 * reminded about, and its reminder stays inert.
 *
 * `computeTaskReminders` is pure: the app runs it on the task index it keeps
 * and hands the result to whatever host can show a notification. Nothing here
 * knows about timers or windows.
 */
import type { TaskReminder } from '@zennotes/bridge-contract/tasks'
import type { VaultTask } from './tasks'

export type { TaskReminder, TaskReminderTarget } from '@zennotes/bridge-contract/tasks'

export interface ClockTime {
  hour: number
  minute: number
}

export interface RemindSpec {
  /** Days before the due date: 0 for the due date itself. */
  daysBefore: number
  /** Null means the default reminder time (a setting). */
  time: ClockTime | null
}

const DAYS_RE = /^(\d{1,2})d$/
const DAYS_TIME_RE = /^(\d{1,2})d-(.+)$/

/** A clock time as `@remind:` writes it: `9am`, `930am`, `1230pm`, `0930`,
 *  `1730`, `17h`, `17h30`. Colons are not allowed in a field value, so none of
 *  the forms has one. */
export function parseClockToken(raw: string): ClockTime | null {
  const v = raw.trim().toLowerCase()
  let m = /^(\d{1,2})(\d{2})?(am|pm)$/.exec(v)
  if (m) {
    const h = Number(m[1])
    const minute = m[2] ? Number(m[2]) : 0
    if (h < 1 || h > 12 || minute > 59) return null
    const hour = (h % 12) + (m[3] === 'pm' ? 12 : 0)
    return { hour, minute }
  }
  m = /^(\d{2})(\d{2})$/.exec(v)
  if (m) return validClock(Number(m[1]), Number(m[2]))
  m = /^(\d{1,2})h(\d{2})?$/.exec(v)
  if (m) return validClock(Number(m[1]), m[2] ? Number(m[2]) : 0)
  return null
}

function validClock(hour: number, minute: number): ClockTime | null {
  return hour <= 23 && minute <= 59 ? { hour, minute } : null
}

/** Parse a settings-style `HH:MM`. Falls back to 09:00. */
export function parseHhMm(raw: string | null | undefined): ClockTime {
  const m = /^(\d{1,2}):(\d{2})$/.exec((raw ?? '').trim())
  return (m && validClock(Number(m[1]), Number(m[2]))) || { hour: 9, minute: 0 }
}

/** The reminder a `@remind:` value names, or null when it names none. */
export function parseRemindSpec(raw: string | null | undefined): RemindSpec | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase()
  let m = DAYS_RE.exec(v)
  if (m) return { daysBefore: Number(m[1]), time: null }
  m = DAYS_TIME_RE.exec(v)
  if (m) {
    const time = parseClockToken(m[2])
    return time ? { daysBefore: Number(m[1]), time } : null
  }
  const time = parseClockToken(v)
  return time ? { daysBefore: 0, time } : null
}

/** `9:00 AM` / `09:00`, in the app's clock format. */
export function formatClock(time: ClockTime, format: '12h' | '24h' = '12h'): string {
  const mm = String(time.minute).padStart(2, '0')
  if (format === '24h') return `${String(time.hour).padStart(2, '0')}:${mm}`
  const suffix = time.hour < 12 ? 'AM' : 'PM'
  return `${time.hour % 12 || 12}:${mm} ${suffix}`
}

/** A short label for a reminder: "9:00 AM", "Day before", "2 days before, 6:00 PM". */
export function describeRemindSpec(spec: RemindSpec, format: '12h' | '24h' = '12h'): string {
  const time = spec.time ? formatClock(spec.time, format) : null
  if (spec.daysBefore === 0) return time ?? 'Morning of'
  const day = spec.daysBefore === 1 ? 'Day before' : `${spec.daysBefore} days before`
  return time ? `${day}, ${time}` : day
}

export interface ComputeRemindersOptions {
  now: Date
  /** `HH:MM`, for reminders that name a day but no time. */
  defaultTime?: string
  /** How far ahead to schedule. */
  horizonDays?: number
  /** How far back to keep, so a host can fire what it missed while closed. */
  lookbackHours?: number
}

/** Hosts cap what they accept; computing past it would only be dropped. */
export const MAX_TASK_REMINDERS = 500

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Markdown a notification would show literally: wikilinks become their text,
 *  emphasis and code marks go. */
export function plainTaskTitle(content: string): string {
  return content
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|==|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function dueLabel(due: Date, fireDay: Date): string {
  const days = Math.round((due.getTime() - fireDay.getTime()) / 86_400_000)
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due ${WEEKDAYS[due.getDay()]}, ${MONTHS[due.getMonth()]} ${due.getDate()}`
}

/**
 * Every reminder the open tasks ask for between `lookbackHours` ago and
 * `horizonDays` ahead, earliest first. Done, cancelled and forwarded tasks
 * never remind; `@waiting` ones do, since they keep their date. Pass tasks
 * with daily-note dates already inferred so a daily note's task reminds on
 * its note's day.
 */
export function computeTaskReminders(
  tasks: readonly VaultTask[],
  opts: ComputeRemindersOptions
): TaskReminder[] {
  const now = opts.now.getTime()
  const from = now - (opts.lookbackHours ?? 24) * 3_600_000
  const until = now + (opts.horizonDays ?? 7) * 86_400_000
  const fallback = parseHhMm(opts.defaultTime)
  const out: TaskReminder[] = []
  for (const task of tasks) {
    if (task.checked || task.cancelled || task.forwarded) continue
    const spec = parseRemindSpec(task.fields?.remind)
    const m = task.due ? ISO_RE.exec(task.due) : null
    if (!spec || !m) continue
    const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    const fireDay = new Date(due.getFullYear(), due.getMonth(), due.getDate() - spec.daysBefore)
    const time = spec.time ?? fallback
    const fireAt = new Date(
      fireDay.getFullYear(),
      fireDay.getMonth(),
      fireDay.getDate(),
      time.hour,
      time.minute
    ).getTime()
    if (fireAt < from || fireAt > until) continue
    const title = plainTaskTitle(task.content) || task.noteTitle
    out.push({
      key: `${task.sourcePath}\n${title}\n${fireAt}`,
      fireAt,
      title,
      body: `${dueLabel(due, fireDay)} · ${task.noteTitle}`,
      path: task.sourcePath,
      taskIndex: task.taskIndex
    })
  }
  out.sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key))
  return out.slice(0, MAX_TASK_REMINDERS)
}
