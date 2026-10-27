/**
 * Date and note-measure helpers behind the calendar panel. They live here,
 * not inside CalendarPanel, because the phones' home-screen Calendar widget
 * draws the same grid, dots and week agenda from a snapshot
 * (calendar-widget-data.ts): one copy of the rules keeps the widget and the
 * panel from drifting apart.
 */
import type { NoteMeta } from '@shared/ipc'
import { isTaskOpen, parseTasksFromBody } from '@shared/tasks'
import { getISOWeek, getISOWeekYear } from './template-render'
import { countWords } from './word-count'

export const WORDS_PER_DOT = 80
export const MAX_DOTS = 3

export interface NoteStats {
  /** `${updatedAt}:${size}`: re-read when this changes. */
  sig: string
  words: number
  openTasks: number
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

/** 6-row (42-cell) grid for the month containing `anchor`, starting on `firstDay`. */
export function buildGrid(anchor: Date, firstDay: number): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const offset = (first.getDay() - firstDay + 7) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

export function isoDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

/** Parse a `YYYY-MM-DD` string back to a local-midnight Date. */
export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map((s) => Number.parseInt(s, 10))
  return new Date(y, m - 1, d)
}

export function isoWeekStr(d: Date): string {
  return `${getISOWeekYear(d)}-W${String(getISOWeek(d)).padStart(2, '0')}`
}

/** Number of word-count dots for a note (0 = none/unknown), plus a faint flag. */
export function dotsFor(stats: NoteStats | undefined): { count: number; faint: boolean } {
  if (!stats) return { count: 1, faint: true } // exists but not measured yet
  if (stats.words === 0) return { count: 1, faint: true }
  return { count: Math.min(MAX_DOTS, Math.ceil(stats.words / WORDS_PER_DOT)), faint: false }
}

/** Word count and open-task count of a daily or weekly note's body. */
export function measureNote(
  note: Pick<NoteMeta, 'path' | 'title' | 'folder' | 'updatedAt' | 'size'>,
  body: string
): NoteStats {
  const openTasks = parseTasksFromBody(body, {
    path: note.path,
    title: note.title,
    folder: note.folder,
  }).filter(isTaskOpen).length
  return { sig: `${note.updatedAt}:${note.size}`, words: countWords(body), openTasks }
}
