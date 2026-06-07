import { useCallback, useMemo, useState } from 'react'
import { useStore } from '../store'
import {
  normalizeVaultSettings,
  noteFolderSubpath,
  weeklyNoteTitle,
} from '../lib/vault-layout'
import { getISOWeek, getISOWeekYear } from '../lib/template-render'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'
import { confirmApp } from '../lib/confirm-requests'

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

/** 6-row Monday-first grid for the month containing `anchor`. */
function buildGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const isoOffset = (first.getDay() + 6) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - isoOffset)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

function isoDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isoWeekStr(d: Date): string {
  return `${getISOWeekYear(d)}-W${String(getISOWeek(d)).padStart(2, '0')}`
}

function monthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function DailyNotesCalendar(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const openDailyNoteForDate = useStore((s) => s.openDailyNoteForDate)
  const openWeeklyNoteForDate = useStore((s) => s.openWeeklyNoteForDate)

  const settings = useMemo(() => normalizeVaultSettings(vaultSettings), [vaultSettings])
  const dailyEnabled = settings.dailyNotes.enabled
  const weeklyEnabled = settings.weeklyNotes.enabled
  const dailySubpath = settings.dailyNotes.directory
  const weeklySubpath = settings.weeklyNotes.directory

  const today = useMemo(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  }, [])

  const [anchor, setAnchor] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1)
  )

  const notedDays = useMemo(() => {
    const set = new Set<string>()
    if (!dailyEnabled) return set
    for (const note of notes) {
      if (note.folder !== 'inbox') continue
      if (noteFolderSubpath(note, settings) !== dailySubpath) continue
      if (/^\d{4}-\d{2}-\d{2}$/.test(note.title)) set.add(note.title)
    }
    return set
  }, [notes, settings, dailyEnabled, dailySubpath])

  const notedWeeks = useMemo(() => {
    const set = new Set<string>()
    if (!weeklyEnabled) return set
    for (const note of notes) {
      if (note.folder !== 'inbox') continue
      if (noteFolderSubpath(note, settings) !== weeklySubpath) continue
      if (/^\d{4}-W\d{2}$/.test(note.title)) set.add(note.title)
    }
    return set
  }, [notes, settings, weeklyEnabled, weeklySubpath])

  const handleDayClick = useCallback(
    async (day: Date, iso: string) => {
      if (!dailyEnabled) return
      if (notedDays.has(iso)) {
        await openDailyNoteForDate(day)
        return
      }
      const ok = await confirmApp({
        title: 'New Daily Note',
        description: `${iso} does not exist. Would you like to create it?`,
        confirmLabel: 'Create',
        cancelLabel: 'Never mind',
      })
      if (ok) await openDailyNoteForDate(day)
    },
    [dailyEnabled, notedDays, openDailyNoteForDate]
  )

  const handleWeekClick = useCallback(
    async (monday: Date, weekIso: string) => {
      if (!weeklyEnabled) return
      if (notedWeeks.has(weekIso)) {
        await openWeeklyNoteForDate(monday)
        return
      }
      const label = weeklyNoteTitle(monday)
      const ok = await confirmApp({
        title: 'New Weekly Note',
        description: `${label} does not exist. Would you like to create it?`,
        confirmLabel: 'Create',
        cancelLabel: 'Never mind',
      })
      if (ok) await openWeeklyNoteForDate(monday)
    },
    [weeklyEnabled, notedWeeks, openWeeklyNoteForDate]
  )

  const grid = useMemo(() => buildGrid(anchor), [anchor])
  const todayIso = isoDateStr(today)
  const todayWeekIso = isoWeekStr(today)
  const anchorMonth = anchor.getMonth()

  const rowMondays = useMemo(
    () => grid.filter((_, i) => i % 7 === 0),
    [grid]
  )

  return (
    <div className="select-none px-2 pb-3">
      <div className="flex items-center justify-between py-1">
        <button
          type="button"
          onClick={() => setAnchor((a) => addMonths(a, -1))}
          className="rounded p-0.5 text-ink-500 hover:text-ink-800 transition-colors"
          aria-label="Previous month"
        >
          <ChevronLeftIcon className="h-3.5 w-3.5" />
        </button>
        <span className="text-[11px] font-medium text-ink-600">{monthLabel(anchor)}</span>
        <button
          type="button"
          onClick={() => setAnchor((a) => addMonths(a, 1))}
          className="rounded p-0.5 text-ink-500 hover:text-ink-800 transition-colors"
          aria-label="Next month"
        >
          <ChevronRightIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-[1.5rem_repeat(7,1fr)] gap-y-0.5">
        <div className="text-[9px] font-medium uppercase text-ink-400 flex items-center justify-center">
          W
        </div>
        {DAY_LABELS.map((label) => (
          <div key={label} className="text-[9px] font-medium uppercase text-ink-400 text-center">
            {label}
          </div>
        ))}

        {rowMondays.map((monday, rowIdx) => {
          const rowDays = grid.slice(rowIdx * 7, rowIdx * 7 + 7)
          const weekIso = isoWeekStr(monday)
          const weekNum = getISOWeek(monday)
          const isThisWeek = weekIso === todayWeekIso
          const hasWeekNote = notedWeeks.has(weekIso)

          const weekCell = weeklyEnabled ? (
            <button
              key={`w${rowIdx}`}
              type="button"
              onClick={() => void handleWeekClick(monday, weekIso)}
              className={[
                'flex flex-col items-center rounded py-0.5 text-[11px] leading-tight transition-colors',
                isThisWeek
                  ? 'bg-accent/20 font-semibold text-accent'
                  : 'text-ink-400 hover:bg-paper-200',
              ].join(' ')}
            >
              <span>{weekNum}</span>
              <span
                className={[
                  'mt-0.5 h-1 w-1 rounded-full',
                  hasWeekNote
                    ? isThisWeek ? 'bg-accent' : 'bg-ink-400'
                    : 'invisible',
                ].join(' ')}
              />
            </button>
          ) : (
            <div
              key={`w${rowIdx}`}
              className="text-[9px] text-ink-400 flex items-center justify-center"
            >
              {weekNum}
            </div>
          )

          const dayCells = rowDays.map((day) => {
            const iso = isoDateStr(day)
            const isToday = iso === todayIso
            const inMonth = day.getMonth() === anchorMonth
            const hasNote = notedDays.has(iso)

            return (
              <button
                key={iso}
                type="button"
                onClick={() => void handleDayClick(day, iso)}
                disabled={!dailyEnabled}
                className={[
                  'flex flex-col items-center rounded py-0.5 text-[11px] leading-tight transition-colors',
                  !dailyEnabled
                    ? inMonth ? 'text-ink-600 cursor-default' : 'text-ink-400 cursor-default'
                    : isToday
                      ? 'bg-accent/20 font-semibold text-accent'
                      : inMonth
                        ? 'text-ink-700 hover:bg-paper-200'
                        : 'text-ink-400 hover:bg-paper-200',
                ].join(' ')}
              >
                <span>{day.getDate()}</span>
                <span
                  className={[
                    'mt-0.5 h-1 w-1 rounded-full',
                    hasNote
                      ? isToday ? 'bg-accent' : 'bg-ink-400'
                      : 'invisible',
                  ].join(' ')}
                />
              </button>
            )
          })

          return [weekCell, ...dayCells]
        })}
      </div>
    </div>
  )
}
