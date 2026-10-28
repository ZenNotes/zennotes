import type { VaultTask } from '@shared/tasks'
import { groupTasks, isOverdue, toIsoDateLocal } from '@shared/tasks'
import type { NoteTagsByPath } from './tasks-filter'

/**
 * The Timeline panel's rail (#1007): the vault's open, dated tasks laid out
 * down one line, overdue on top, then today, then each later day that has
 * work, with the empty stretches between them folded into one quiet line.
 *
 * Which tasks count, what their date is and whether they are late all come
 * from the Tasks view, never from a rule of the rail's own: the input is the
 * list the Tasks surfaces see (display filter, the daily-note date inference,
 * the user's filter query), `groupTasks` decides which of them are live
 * Today / Upcoming work, and `isOverdue` decides lateness. So a waiting or
 * forwarded task stays where the Tasks list keeps it, in its own group, and
 * the undated count is the list's No due date group.
 */

export type TimelineRange = 'two-weeks' | 'month' | 'all'
export const TIMELINE_RANGES: readonly TimelineRange[] = ['two-weeks', 'month', 'all']
export const DEFAULT_TIMELINE_RANGE: TimelineRange = 'two-weeks'

export function normalizeTimelineRange(value: unknown): TimelineRange {
  return TIMELINE_RANGES.includes(value as TimelineRange)
    ? (value as TimelineRange)
    : DEFAULT_TIMELINE_RANGE
}

/** The tag that turns a task into a milestone on the rail. Nowhere else in the
 *  app treats it as special: it is an ordinary tag everywhere but here. */
export const MILESTONE_TAG = 'milestone'

/**
 * A task tagged `#milestone`. A whole-note task also counts when the tag is
 * written in its note's body, the same widening the Tasks filter gives a file
 * task (#1008); a checkbox task keeps to its own line.
 */
export function isMilestoneTask(task: VaultTask, noteTags?: NoteTagsByPath | null): boolean {
  if (task.tags.some((tag) => tag.toLowerCase() === MILESTONE_TAG)) return true
  if (task.kind !== 'file' || !noteTags) return false
  return noteTags.get(task.sourcePath)?.some((tag) => tag.toLowerCase() === MILESTONE_TAG) ?? false
}

export interface TimelineRow {
  task: VaultTask
  milestone: boolean
  /** Whole days past the due date; 0 unless the task is overdue. */
  lateDays: number
  /** For a milestone, the open tasks due before it since the previous
   *  milestone (or from the top of the rail for the first); null otherwise. */
  before: number | null
}

export type TimelineEntry =
  | { kind: 'overdue'; rows: TimelineRow[] }
  | { kind: 'day'; iso: string; today: boolean; milestone: boolean; rows: TimelineRow[] }
  | { kind: 'quiet'; days: number; afterIso: string }

export interface TimelineRail {
  entries: TimelineEntry[]
  /** Every row in the order drawn, which is the order the cursor walks. */
  rows: TimelineRow[]
  /** Rows on the rail: the overdue ones plus the range. */
  openCount: number
  overdueCount: number
  /** Open tasks with no date, written or inferred: the Tasks list's No due date. */
  undatedCount: number
  /** Dated open tasks past the end of the range. */
  laterCount: number
  /** Last day the range shows, or null for All. */
  rangeEnd: string | null
}

function localDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function parseIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Calendar days from `a` to `b`. Rounded, so a daylight-saving change in
 *  between (a 23 or 25 hour day) still counts as one day. */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseIso(b).getTime() - parseIso(a).getTime()) / 86_400_000)
}

/**
 * The last day a range shows. Two weeks is today and the 13 days after it.
 * A month runs to the same date next month, or to that month's last day when
 * it is shorter (Jan 31 runs to Feb 28).
 */
export function timelineRangeEnd(today: Date, range: TimelineRange): string | null {
  const day = localDay(today)
  if (range === 'all') return null
  if (range === 'two-weeks') {
    return toIsoDateLocal(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 13))
  }
  const lastOfNext = new Date(day.getFullYear(), day.getMonth() + 2, 0).getDate()
  return toIsoDateLocal(
    new Date(day.getFullYear(), day.getMonth() + 1, Math.min(day.getDate(), lastOfNext))
  )
}

function byDueThenNote(a: VaultTask, b: VaultTask): number {
  const ad = a.due ?? ''
  const bd = b.due ?? ''
  if (ad !== bd) return ad < bd ? -1 : 1
  if (a.sourcePath !== b.sourcePath) return a.sourcePath < b.sourcePath ? -1 : 1
  return a.taskIndex - b.taskIndex
}

export function buildTimelineRail(
  tasks: VaultTask[],
  options: { today: Date; range: TimelineRange; noteTags?: NoteTagsByPath | null }
): TimelineRail {
  const today = localDay(options.today)
  const todayIso = toIsoDateLocal(today)
  const rangeEnd = timelineRangeEnd(today, options.range)
  const groups = groupTasks(tasks, today)

  const row = (task: VaultTask): TimelineRow => ({
    task,
    milestone: isMilestoneTask(task, options.noteTags),
    lateDays: isOverdue(task, today) && task.due ? daysBetween(task.due, todayIso) : 0,
    before: null
  })
  // Milestones lead their day; the rest keep the order the Tasks list gives
  // them (priority first in Today, note order in Upcoming).
  const milestonesFirst = (rows: TimelineRow[]): TimelineRow[] => [
    ...rows.filter((r) => r.milestone),
    ...rows.filter((r) => !r.milestone)
  ]

  // Oldest first, so the rail reads top to bottom in date order all the way.
  const overdue = groups.today
    .filter((task) => isOverdue(task, today))
    .sort(byDueThenNote)
    .map(row)

  const byDay = new Map<string, TimelineRow[]>()
  let laterCount = 0
  for (const task of [...groups.today, ...groups.upcoming]) {
    if (!task.due || isOverdue(task, today)) continue
    if (rangeEnd && task.due > rangeEnd) {
      laterCount += 1
      continue
    }
    const list = byDay.get(task.due)
    if (list) list.push(row(task))
    else byDay.set(task.due, [row(task)])
  }

  const entries: TimelineEntry[] = []
  if (overdue.length > 0) entries.push({ kind: 'overdue', rows: milestonesFirst(overdue) })
  const todayRows = milestonesFirst(byDay.get(todayIso) ?? [])
  entries.push({
    kind: 'day',
    iso: todayIso,
    today: true,
    milestone: todayRows.some((r) => r.milestone),
    rows: todayRows
  })
  let previousIso = todayIso
  for (const iso of [...byDay.keys()].filter((d) => d > todayIso).sort()) {
    const gap = daysBetween(previousIso, iso) - 1
    if (gap > 0) entries.push({ kind: 'quiet', days: gap, afterIso: previousIso })
    const rows = milestonesFirst(byDay.get(iso) ?? [])
    entries.push({ kind: 'day', iso, today: false, milestone: rows.some((r) => r.milestone), rows })
    previousIso = iso
  }

  const rows = entries.flatMap((entry) => (entry.kind === 'quiet' ? [] : entry.rows))

  // "N tasks before it": the open tasks due on or after the previous
  // milestone's day and before this one's, so each task is counted toward
  // exactly one milestone and the numbers add up to the work on the rail.
  // The first milestone counts from the top of the rail, overdue included:
  // late work still stands between today and the milestone.
  let previousMilestoneDue: string | null = null
  for (const r of rows) {
    if (!r.milestone || !r.task.due) continue
    const due = r.task.due
    const since = previousMilestoneDue
    r.before = rows.filter(
      (other) =>
        !other.milestone &&
        !!other.task.due &&
        other.task.due < due &&
        (since === null || other.task.due >= since)
    ).length
    previousMilestoneDue = due
  }

  return {
    entries,
    rows,
    openCount: rows.length,
    overdueCount: overdue.length,
    undatedCount: groups.undated.length,
    laterCount,
    rangeEnd
  }
}

/** "Wed 28", with the month when it is not this month's: "Mon 2 Nov". */
export function timelineDayLabel(iso: string, today: Date): string {
  const date = parseIso(iso)
  const weekday = date.toLocaleDateString(undefined, { weekday: 'short' })
  const sameMonth =
    date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth()
  if (sameMonth) return `${weekday} ${date.getDate()}`
  const month = date.toLocaleDateString(undefined, { month: 'short' })
  const year = date.getFullYear() !== today.getFullYear() ? ` ${date.getFullYear()}` : ''
  return `${weekday} ${date.getDate()} ${month}${year}`
}
