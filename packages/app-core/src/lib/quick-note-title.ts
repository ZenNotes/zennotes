/**
 * Pick a title for a brand-new Quick Note.
 *
 * Two formats:
 *  - Default: "<prefix> YYYY-MM-DD HHMM" (timestamped, never collides
 *    in normal usage).
 *  - Date-titled (when the user's pref is on): "<prefix> YYYY-MM-DD",
 *    with " (2)", " (3)", … appended for additional notes the same day.
 *
 * When the prefix is blank, titles fall back to the raw timestamp/date.
 */
import type { NoteMeta } from '@shared/ipc'

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function normalizePrefix(prefix: string | null | undefined): string {
  return (prefix ?? '').trim()
}

function joinPrefix(prefix: string, suffix: string): string {
  return prefix ? `${prefix} ${suffix}` : suffix
}

export function nowTimestamped(
  prefix = 'Quick Note',
  date = new Date()
): string {
  const stem =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}${pad(date.getMinutes())}`
  return joinPrefix(normalizePrefix(prefix), stem)
}

export function dateTitleForToday(
  notes: NoteMeta[],
  prefix = '',
  date = new Date()
): string {
  const today = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const stem = joinPrefix(normalizePrefix(prefix), today)
  const used = new Set(
    notes.filter((n) => n.folder === 'quick').map((n) => n.title.toLowerCase())
  )
  if (!used.has(stem.toLowerCase())) return stem
  let n = 2
  while (used.has(`${stem} (${n})`.toLowerCase())) n++
  return `${stem} (${n})`
}

export function resolveQuickNoteTitle(
  notes: NoteMeta[],
  useDateTitle: boolean,
  prefix = 'Quick Note',
  date = new Date()
): string {
  return useDateTitle
    ? dateTitleForToday(notes, prefix, date)
    : nowTimestamped(prefix, date)
}
