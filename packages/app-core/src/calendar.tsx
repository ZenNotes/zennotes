import { CalendarPanel } from './components/CalendarPanel'
import { useStore } from './store'
import { isoDateStr, isoWeekStr, parseIsoDate } from './lib/calendar-data'
import { buildDateNoteIndexes, normalizeVaultSettings } from './lib/vault-layout'

export {
  CALENDAR_WIDGET_MAX_TASKS_PER_DAY,
  getCalendarWidgetData,
  type CalendarWidgetData,
  type CalendarWidgetDay,
  type CalendarWidgetMark,
  type CalendarWidgetTask,
} from './lib/calendar-widget-data'

/**
 * The date calendar as a surface of its own, for hosts that open it from a
 * main screen instead of beside a note (the phone shells' Calendar entry),
 * so it works with no note open. It orients on the open note when that is a
 * daily or weekly note, else on today. `onOpen` runs once it has opened a
 * day, a week or a task's line; a host that shows it as a sheet closes it
 * there. `date` (`YYYY-MM-DD`) opens it on that day instead, and `focusAdd`
 * puts the cursor in "Add a task for …": the home-screen widget's day and
 * add buttons. Both are read on mount.
 */
export function DateCalendar({
  onOpen,
  date,
  focusAdd
}: {
  onOpen?: () => void
  date?: string
  focusAdd?: boolean
}): JSX.Element {
  const note = useStore((s) => s.activeNote)
  return <CalendarPanel note={note} onOpen={onOpen} initialDate={date} focusAdd={focusAdd} />
}

/**
 * Open the daily (or weekly) note for a `YYYY-MM-DD` day when it exists.
 * Resolves false, opening nothing, when it does not or that kind of note is
 * off: a host then shows the calendar on that day, where "Day +" asks before
 * creating the note.
 */
export async function openDateNote(kind: 'daily' | 'weekly', iso: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const date = parseIsoDate(iso)
  if (Number.isNaN(date.getTime()) || isoDateStr(date) !== iso) return false
  const state = useStore.getState()
  if (!state.vault) return false
  const settings = normalizeVaultSettings(state.vaultSettings)
  const { dailyByDate, weeklyByWeek } = buildDateNoteIndexes(state.notes, settings)
  if (kind === 'daily') {
    if (!settings.dailyNotes.enabled || !dailyByDate.has(iso)) return false
    await state.openDailyNoteForDate(date)
  } else {
    if (!settings.weeklyNotes.enabled || !weeklyByWeek.has(isoWeekStr(date))) return false
    await state.openWeeklyNoteForDate(date)
  }
  return true
}
