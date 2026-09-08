/**
 * Date math behind the `@date` calendar (#743): ISO round-trips, the month
 * grid, and the moves its keyboard answers with. Everything works on local
 * calendar days (never UTC): a date picked at 23:30 in Sydney must insert
 * that day, not the one the UTC clock is still on. Kept pure so the picker's
 * behavior is testable without rendering it, and so the `@` menu and the
 * modal agree on what a day looks like on disk (`YYYY-MM-DD`).
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatISODate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * Strict `YYYY-MM-DD` to a local-midnight Date, or null. A day that does not
 * exist (2026-02-30) is rejected rather than rolled into March: the picker
 * would otherwise insert a date the user never typed.
 */
export function parseISODate(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function firstOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/**
 * Same day-of-month `months` away, clamped to the target month's length
 * (Jan 31 + 1 month is Feb 28, not Mar 3). PageUp/PageDown in the picker
 * would otherwise skip past short months.
 */
export function addMonths(date: Date, months: number): Date {
  const first = new Date(date.getFullYear(), date.getMonth() + months, 1)
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), lastDay))
}

/** First day of the week containing `date`, with `firstDay` as 0 (Sunday) .. 6. */
export function startOfWeek(date: Date, firstDay: number): Date {
  return addDays(date, -((date.getDay() - firstDay + 7) % 7))
}

/** 6-row (42-cell) grid for the month containing `anchor`, starting on `firstDay`. */
export function buildMonthGrid(anchor: Date, firstDay: number): Date[] {
  const start = startOfWeek(firstOfMonth(anchor), firstDay)
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

export function monthTitle(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export type DatePickerMove =
  | 'prev-day'
  | 'next-day'
  | 'prev-week'
  | 'next-week'
  | 'prev-month'
  | 'next-month'
  | 'prev-year'
  | 'next-year'
  | 'week-start'
  | 'week-end'
  | 'today'

export function moveDate(
  date: Date,
  move: DatePickerMove,
  firstDay: number,
  today: Date = new Date()
): Date {
  switch (move) {
    case 'prev-day':
      return addDays(date, -1)
    case 'next-day':
      return addDays(date, 1)
    case 'prev-week':
      return addDays(date, -7)
    case 'next-week':
      return addDays(date, 7)
    case 'prev-month':
      return addMonths(date, -1)
    case 'next-month':
      return addMonths(date, 1)
    case 'prev-year':
      return addMonths(date, -12)
    case 'next-year':
      return addMonths(date, 12)
    case 'week-start':
      return startOfWeek(date, firstDay)
    case 'week-end':
      return addDays(startOfWeek(date, firstDay), 6)
    case 'today':
      return startOfDay(today)
  }
}

/**
 * The picker's keyboard: the WAI-ARIA date-grid pattern (arrows move a day or
 * a week, PageUp/PageDown a month, with Shift a year, Home/End the week's
 * ends), plus h/j/k/l and `t` (today) only while Vim mode is on. With Vim off
 * a letter must never be a shortcut, the same rule the list views follow.
 */
export function datePickerMoveForKey(
  key: string,
  modifiers: { shift: boolean; vimMode: boolean }
): DatePickerMove | null {
  switch (key) {
    case 'ArrowLeft':
      return 'prev-day'
    case 'ArrowRight':
      return 'next-day'
    case 'ArrowUp':
      return 'prev-week'
    case 'ArrowDown':
      return 'next-week'
    case 'PageUp':
      return modifiers.shift ? 'prev-year' : 'prev-month'
    case 'PageDown':
      return modifiers.shift ? 'next-year' : 'next-month'
    case 'Home':
      return 'week-start'
    case 'End':
      return 'week-end'
  }
  if (!modifiers.vimMode) return null
  switch (key) {
    case 'h':
      return 'prev-day'
    case 'l':
      return 'next-day'
    case 'k':
      return 'prev-week'
    case 'j':
      return 'next-week'
    case 't':
      return 'today'
  }
  return null
}
