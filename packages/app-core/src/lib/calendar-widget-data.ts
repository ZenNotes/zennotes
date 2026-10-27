/**
 * What the phones' home-screen Calendar widget draws: the calendar panel's
 * month grid marks and week agenda for the months around today, as plain
 * data a native widget can render without running this app.
 *
 * Every rule comes from the panel's own helpers (calendar-data.ts) and the
 * same task inference the panel runs, so the widget shows exactly what the
 * Calendar sheet shows. The one thing added for the widget is `toggled`: the
 * task's line after core's own `toggleTaskAtIndex`, so a host that writes a
 * tick outside the app swaps one known line for another and never needs a
 * task-line parser of its own.
 */
import type { NoteMeta } from '@shared/ipc'
import {
  filterTasksForDisplay,
  inferDailyTaskDueDates,
  isTaskOpen,
  type TaskPriority,
  type VaultTask,
} from '@shared/tasks'
import { toggleTaskAtIndex } from '@shared/tasklists'
import { useStore } from '../store'
import {
  buildDailyNoteDateByPath,
  buildDateNoteIndexes,
  normalizeVaultSettings,
} from './vault-layout'
import { resolveWeekStartDay } from './week-start'
import {
  addMonths,
  buildGrid,
  dotsFor,
  isoDateStr,
  isoWeekStr,
  measureNote,
  type NoteStats,
} from './calendar-data'

/** A grid mark: the day's (or week's) note and how much is in it. */
export interface CalendarWidgetMark {
  /** Word-count dots, 1 to 3. */
  dots: number
  /** Drawn faint: an empty note, or one not measured yet. */
  faint: boolean
  /** Open tasks written in this note (the panel's corner dot). */
  openTasks: number
}

export interface CalendarWidgetTask {
  /** VaultTask id (`${sourcePath}#${taskIndex}`). */
  id: string
  path: string
  noteTitle: string
  content: string
  inProgress: boolean
  priority: TaskPriority | null
  /** Written in that day's own daily note; the panel leaves the note title
   *  off those rows. */
  inDailyNote: boolean
  /** 0-based line of the task in its file. */
  line: number
  /** The line as it is on disk. */
  raw: string
  /** `raw` ticked by core's own toggle, or null when only the app can tick
   *  it (a file task's status lives in frontmatter and stamps a date). */
  toggled: string | null
}

export interface CalendarWidgetDay {
  /** Open tasks due that day, including any past the cap. */
  total: number
  tasks: CalendarWidgetTask[]
}

export interface CalendarWidgetData {
  todayIso: string
  /** 0 = Sunday … 6 = Saturday, the resolved week-start preference. */
  weekStart: number
  showWeekNumbers: boolean
  dailyEnabled: boolean
  weeklyEnabled: boolean
  /** First and last day (inclusive) the marks and agenda cover: the previous,
   *  current and next month grids. */
  from: string
  to: string
  /** Daily notes in range, by `YYYY-MM-DD`. A day with no note is absent. */
  days: Record<string, CalendarWidgetMark>
  /** Weekly notes in range, by ISO week (`2026-W44`). */
  weeks: Record<string, CalendarWidgetMark>
  /** Open tasks due each day in range (explicit `due:` or written in that
   *  day's daily note), in the panel's order. A day with none is absent. */
  agenda: Record<string, CalendarWidgetDay>
}

export const CALENDAR_WIDGET_MAX_TASKS_PER_DAY = 30

const stats = new Map<string, NoteStats>()

async function noteStats(note: NoteMeta): Promise<NoteStats | undefined> {
  const sig = `${note.updatedAt}:${note.size}`
  const cached = stats.get(note.path)
  if (cached?.sig === sig) return cached
  let body = useStore.getState().noteContents[note.path]?.body
  if (body == null) {
    try {
      body = (await window.zen.readNote(note.path)).body
    } catch {
      return undefined
    }
  }
  const measured = measureNote(note, body)
  stats.set(note.path, measured)
  return measured
}

function markFor(measured: NoteStats | undefined): CalendarWidgetMark {
  const { count, faint } = dotsFor(measured)
  return { dots: count, faint, openTasks: measured?.openTasks ?? 0 }
}

function widgetTask(task: VaultTask, dailyPath: string | undefined): CalendarWidgetTask {
  const file = task.kind === 'file'
  const ticked = file ? null : toggleTaskAtIndex(task.rawText, 0, true)
  return {
    id: task.id,
    path: task.sourcePath,
    noteTitle: task.noteTitle,
    content: task.content.trim() || 'Untitled task',
    inProgress: task.inProgress,
    priority: task.priority ?? null,
    inDailyNote: task.sourcePath === dailyPath,
    line: task.lineNumber,
    raw: task.rawText,
    toggled: ticked && ticked !== task.rawText ? ticked : null,
  }
}

/**
 * Build the widget's data from the store as it is now. Daily and weekly
 * note bodies are read once and remembered by `updatedAt:size`, so a
 * republish after an edit re-reads only the note that changed.
 */
export async function getCalendarWidgetData(
  now = new Date(),
  maxTasksPerDay = CALENDAR_WIDGET_MAX_TASKS_PER_DAY
): Promise<CalendarWidgetData> {
  const state = useStore.getState()
  const settings = normalizeVaultSettings(state.vaultSettings)
  const weekStart = resolveWeekStartDay(state.calendarWeekStart)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const first = buildGrid(addMonths(today, -1), weekStart)[0]
  const last = buildGrid(addMonths(today, 1), weekStart)[41]
  const from = isoDateStr(first)
  const to = isoDateStr(last)

  const { dailyByDate, weeklyByWeek } = buildDateNoteIndexes(state.notes, settings)
  const days: Record<string, CalendarWidgetMark> = {}
  const weeks: Record<string, CalendarWidgetMark> = {}
  const dayIsos: string[] = []
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const iso = isoDateStr(d)
    dayIsos.push(iso)
    const daily = settings.dailyNotes.enabled ? dailyByDate.get(iso) : undefined
    if (daily) days[iso] = markFor(await noteStats(daily))
    const week = isoWeekStr(d)
    const weekly = settings.weeklyNotes.enabled ? weeklyByWeek.get(week) : undefined
    if (weekly && !weeks[week]) weeks[week] = markFor(await noteStats(weekly))
  }

  // The agenda is the panel's: open tasks by due date, with daily-note tasks
  // inheriting the note's date. Tasks of a note that left the index (trashed,
  // deleted from the drawer) can linger until the next full scan; skip them.
  const live = new Set(state.notes.filter((n) => n.folder !== 'trash').map((n) => n.path))
  const inferred = inferDailyTaskDueDates(
    filterTasksForDisplay(state.vaultTasks, state.showArchivedTasks).filter((t) =>
      live.has(t.sourcePath)
    ),
    buildDailyNoteDateByPath(state.notes, state.vaultSettings)
  )
  const byDay = new Map<string, VaultTask[]>()
  for (const task of inferred) {
    if (!task.due || task.due < from || task.due > to || !isTaskOpen(task)) continue
    const list = byDay.get(task.due)
    if (list) list.push(task)
    else byDay.set(task.due, [task])
  }
  const agenda: Record<string, CalendarWidgetDay> = {}
  for (const iso of dayIsos) {
    const due = byDay.get(iso)
    if (!due?.length) continue
    const dailyPath = dailyByDate.get(iso)?.path
    agenda[iso] = {
      total: due.length,
      tasks: due.slice(0, maxTasksPerDay).map((task) => widgetTask(task, dailyPath)),
    }
  }

  return {
    todayIso: isoDateStr(today),
    weekStart,
    showWeekNumbers: state.calendarShowWeekNumbers,
    dailyEnabled: settings.dailyNotes.enabled,
    weeklyEnabled: settings.weeklyNotes.enabled,
    from,
    to,
    days,
    weeks,
    agenda,
  }
}
