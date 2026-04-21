/**
 * Pick a title for a brand-new Quick Note.
 *
 * Two formats:
 *  - Default: "Quick Note YYYY-MM-DD HHMM" (timestamped, never collides
 *    in normal usage).
 *  - Date-titled (when the user's pref is on): "YYYY-MM-DD", with " (2)",
 *    " (3)", … appended for additional notes the same day.
 */
import type { NoteMeta } from '@shared/ipc'

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

export function nowTimestamped(date = new Date()): string {
  return (
    `Quick Note ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}${pad(date.getMinutes())}`
  )
}

export function dateTitleForToday(
  notes: NoteMeta[],
  date = new Date()
): string {
  const today = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const used = new Set(
    notes.filter((n) => n.folder === 'quick').map((n) => n.title.toLowerCase())
  )
  if (!used.has(today.toLowerCase())) return today
  let n = 2
  while (used.has(`${today} (${n})`.toLowerCase())) n++
  return `${today} (${n})`
}

export function resolveQuickNoteTitle(
  notes: NoteMeta[],
  useDateTitle: boolean,
  date = new Date()
): string {
  return useDateTitle ? dateTitleForToday(notes, date) : nowTimestamped(date)
}
