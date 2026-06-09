/**
 * Right-side calendar panel — a date navigator for daily and weekly notes,
 * modelled on Obsidian's Calendar plugin.
 *
 * Auto-opens while the active note is a daily/weekly note (anchored to and
 * highlighting that note), but stays available on any note so it works like a
 * persistent sidebar. Each existing note shows word-count dots (more writing →
 * more dots) and a corner mark when it has unfinished tasks. Hover a day for a
 * preview; right-click for open / create / trash.
 *
 * Word counts and task counts need the note body, which isn't in the index, so
 * we read the visible month's notes lazily (preferring the in-memory cache) and
 * memoise them by `updatedAt:size` so edits invalidate cleanly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteContent, NoteMeta } from '@shared/ipc'
import { parseTasksFromBody } from '@shared/tasks'
import { useStore } from '../store'
import {
  classifyDateNote,
  noteFolderSubpath,
  normalizeVaultSettings,
  weeklyNoteTitle,
} from '../lib/vault-layout'
import { getISOWeek, getISOWeekYear } from '../lib/template-render'
import { countWords } from '../lib/word-count'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'
import { confirmApp } from '../lib/confirm-requests'
import { confirmMoveToTrash } from '../lib/confirm-trash'
import { usePanelResize } from '../lib/use-panel-resize'
import { PanelResizeHandle } from './PanelResizeHandle'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

const FULL_DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAILY_RE = /^\d{4}-\d{2}-\d{2}$/
const WEEKLY_RE = /^\d{4}-W\d{2}$/
const WORDS_PER_DOT = 80
const MAX_DOTS = 3
const HOVER_DELAY_MS = 280

interface NoteStats {
  /** `${updatedAt}:${size}` — re-read when this changes. */
  sig: string
  words: number
  openTasks: number
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

/** Best-effort first weekday from the user's locale; Monday on failure. */
function localeFirstDay(): number {
  try {
    const loc = new Intl.Locale(navigator.language) as unknown as {
      weekInfo?: { firstDay?: number }
      getWeekInfo?: () => { firstDay?: number }
    }
    const info = loc.weekInfo ?? loc.getWeekInfo?.()
    if (info && typeof info.firstDay === 'number') return info.firstDay % 7 // 7(Sun)->0
  } catch {
    /* ignore */
  }
  return 1
}

/** 6-row (42-cell) grid for the month containing `anchor`, starting on `firstDay`. */
function buildGrid(anchor: Date, firstDay: number): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const offset = (first.getDay() - firstDay + 7) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

function isoDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

function isoWeekStr(d: Date): string {
  return `${getISOWeekYear(d)}-W${String(getISOWeek(d)).padStart(2, '0')}`
}

function monthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/** Number of word-count dots for a note (0 = none/unknown), plus a faint flag. */
function dotsFor(stats: NoteStats | undefined): { count: number; faint: boolean } {
  if (!stats) return { count: 1, faint: true } // exists but not measured yet
  if (stats.words === 0) return { count: 1, faint: true }
  return { count: Math.min(MAX_DOTS, Math.ceil(stats.words / WORDS_PER_DOT)), faint: false }
}

export function CalendarPanel({ note }: { note: NoteContent }): JSX.Element {
  const notes = useStore((s) => s.notes)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const openDailyNoteForDate = useStore((s) => s.openDailyNoteForDate)
  const openWeeklyNoteForDate = useStore((s) => s.openWeeklyNoteForDate)
  const width = useStore((s) => s.panelWidths.calendar)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const weekStart = useStore((s) => s.calendarWeekStart)
  const showWeekNumbers = useStore((s) => s.calendarShowWeekNumbers)
  const { startResize } = usePanelResize(width, (px) => setPanelWidth('calendar', px))

  const settings = useMemo(() => normalizeVaultSettings(vaultSettings), [vaultSettings])
  const dailyEnabled = settings.dailyNotes.enabled
  const weeklyEnabled = settings.weeklyNotes.enabled
  const dailySubpath = settings.dailyNotes.directory
  const weeklySubpath = settings.weeklyNotes.directory

  const firstDay = weekStart === 'sunday' ? 0 : weekStart === 'locale' ? localeFirstDay() : 1
  const dayLabels = useMemo(
    () => Array.from({ length: 7 }, (_, i) => FULL_DAY_LABELS[(firstDay + i) % 7]),
    [firstDay]
  )

  // The date the active note represents — what the calendar orients around.
  const active = useMemo(() => classifyDateNote(note, vaultSettings), [note, vaultSettings])
  const refDate = active?.date ?? new Date()
  const activeDayIso = active?.kind === 'daily' ? isoDateStr(active.date) : null
  const activeWeekIso = active?.kind === 'weekly' ? isoWeekStr(active.date) : null

  const today = useMemo(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  }, [])
  const todayIso = isoDateStr(today)

  const [anchor, setAnchor] = useState(
    () => new Date(refDate.getFullYear(), refDate.getMonth(), 1)
  )

  // Re-center on the active note whenever it changes.
  useEffect(() => {
    setAnchor(new Date(refDate.getFullYear(), refDate.getMonth(), 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.path])

  // title -> NoteMeta for the daily/weekly notes that exist on disk.
  const dailyByTitle = useMemo(() => {
    const m = new Map<string, NoteMeta>()
    if (!dailyEnabled) return m
    for (const n of notes) {
      if (n.folder !== 'inbox') continue
      if (noteFolderSubpath(n, settings) !== dailySubpath) continue
      if (DAILY_RE.test(n.title)) m.set(n.title, n)
    }
    return m
  }, [notes, settings, dailyEnabled, dailySubpath])

  const weeklyByTitle = useMemo(() => {
    const m = new Map<string, NoteMeta>()
    if (!weeklyEnabled) return m
    for (const n of notes) {
      if (n.folder !== 'inbox') continue
      if (noteFolderSubpath(n, settings) !== weeklySubpath) continue
      if (WEEKLY_RE.test(n.title)) m.set(n.title, n)
    }
    return m
  }, [notes, settings, weeklyEnabled, weeklySubpath])

  const grid = useMemo(() => buildGrid(anchor, firstDay), [anchor, firstDay])
  const rows = useMemo(() => {
    const out: { days: Date[]; monday: Date }[] = []
    for (let i = 0; i < 6; i++) {
      const days = grid.slice(i * 7, i * 7 + 7)
      out.push({ days, monday: days.find((d) => d.getDay() === 1) ?? days[0] })
    }
    return out
  }, [grid])
  const anchorMonth = anchor.getMonth()

  // Notes visible in the current month view that need stats loaded.
  const visibleNotes = useMemo(() => {
    const list: NoteMeta[] = []
    const seen = new Set<string>()
    const push = (n: NoteMeta | undefined): void => {
      if (n && !seen.has(n.path)) {
        seen.add(n.path)
        list.push(n)
      }
    }
    for (const d of grid) push(dailyByTitle.get(isoDateStr(d)))
    for (const { monday } of rows) push(weeklyByTitle.get(isoWeekStr(monday)))
    return list
  }, [grid, rows, dailyByTitle, weeklyByTitle])

  const [stats, setStats] = useState<Map<string, NoteStats>>(new Map())
  const statsRef = useRef(stats)
  statsRef.current = stats

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const updates: Array<[string, NoteStats]> = []
      for (const n of visibleNotes) {
        const sig = `${n.updatedAt}:${n.size}`
        if (statsRef.current.get(n.path)?.sig === sig) continue
        let body = useStore.getState().noteContents[n.path]?.body
        if (body == null) {
          try {
            body = (await window.zen.readNote(n.path)).body
          } catch {
            continue
          }
        }
        if (cancelled) return
        const openTasks = parseTasksFromBody(body, {
          path: n.path,
          title: n.title,
          folder: n.folder,
        }).filter((t) => !t.checked).length
        updates.push([n.path, { sig, words: countWords(body), openTasks }])
      }
      if (!cancelled && updates.length) {
        setStats((prev) => {
          const next = new Map(prev)
          for (const [p, v] of updates) next.set(p, v)
          return next
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [visibleNotes])

  const handleDayClick = useCallback(
    async (day: Date, iso: string) => {
      if (!dailyEnabled) return
      if (dailyByTitle.has(iso)) {
        await openDailyNoteForDate(day)
        return
      }
      const ok = await confirmApp({
        title: 'New daily note',
        description: `${iso} does not exist yet. Create it?`,
        confirmLabel: 'Create',
        cancelLabel: 'Never mind',
      })
      if (ok) await openDailyNoteForDate(day)
    },
    [dailyEnabled, dailyByTitle, openDailyNoteForDate]
  )

  const handleWeekClick = useCallback(
    async (monday: Date, weekIso: string) => {
      if (!weeklyEnabled) return
      if (weeklyByTitle.has(weekIso)) {
        await openWeeklyNoteForDate(monday)
        return
      }
      const ok = await confirmApp({
        title: 'New weekly note',
        description: `${weeklyNoteTitle(monday)} does not exist yet. Create it?`,
        confirmLabel: 'Create',
        cancelLabel: 'Never mind',
      })
      if (ok) await openWeeklyNoteForDate(monday)
    },
    [weeklyEnabled, weeklyByTitle, openWeeklyNoteForDate]
  )

  // --- Hover preview -------------------------------------------------------
  const [hover, setHover] = useState<{ meta: NoteMeta; right: number; top: number } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    setHover(null)
  }, [])
  const armHover = useCallback((el: HTMLElement, meta: NoteMeta | undefined) => {
    if (!meta) return
    const rect = el.getBoundingClientRect()
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => {
      setHover({ meta, right: window.innerWidth - rect.left + 8, top: rect.top })
    }, HOVER_DELAY_MS)
  }, [])
  useEffect(() => clearHover, [clearHover])

  // --- Context menu --------------------------------------------------------
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const trashNote = useCallback(async (meta: NoteMeta) => {
    if (await confirmMoveToTrash(meta.title)) await window.zen.moveToTrash(meta.path)
  }, [])
  const openDayMenu = useCallback(
    (e: React.MouseEvent, day: Date, iso: string) => {
      if (!dailyEnabled) return
      e.preventDefault()
      clearHover()
      const meta = dailyByTitle.get(iso)
      const items: ContextMenuItem[] = meta
        ? [
            { label: 'Open note', onSelect: () => void openDailyNoteForDate(day) },
            { kind: 'separator' },
            { label: 'Move to Trash', danger: true, onSelect: () => void trashNote(meta) },
          ]
        : [{ label: `Create ${iso}`, onSelect: () => void handleDayClick(day, iso) }]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [dailyEnabled, dailyByTitle, openDailyNoteForDate, handleDayClick, trashNote, clearHover]
  )
  const openWeekMenu = useCallback(
    (e: React.MouseEvent, monday: Date, weekIso: string) => {
      if (!weeklyEnabled) return
      e.preventDefault()
      clearHover()
      const meta = weeklyByTitle.get(weekIso)
      const items: ContextMenuItem[] = meta
        ? [
            { label: 'Open note', onSelect: () => void openWeeklyNoteForDate(monday) },
            { kind: 'separator' },
            { label: 'Move to Trash', danger: true, onSelect: () => void trashNote(meta) },
          ]
        : [
            {
              label: `Create ${weeklyNoteTitle(monday)}`,
              onSelect: () => void handleWeekClick(monday, weekIso),
            },
          ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [weeklyEnabled, weeklyByTitle, openWeeklyNoteForDate, handleWeekClick, trashNote, clearHover]
  )

  const atRefMonth =
    anchor.getFullYear() === refDate.getFullYear() && anchor.getMonth() === refDate.getMonth()
  const atTodayMonth =
    anchor.getFullYear() === today.getFullYear() && anchor.getMonth() === today.getMonth()
  const gridCols = showWeekNumbers ? 'grid-cols-[1.75rem_repeat(7,1fr)]' : 'grid-cols-7'

  const renderDots = (count: number, faint: boolean, light: boolean): JSX.Element => (
    <span className="mt-0.5 flex h-1 items-center justify-center gap-0.5">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={[
            'h-1 w-1 rounded-full',
            light ? 'bg-white' : 'bg-ink-400',
            faint ? 'opacity-40' : '',
          ].join(' ')}
        />
      ))}
    </span>
  )

  return (
    <section
      aria-label="Calendar"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/18"
    >
      <PanelResizeHandle onStart={startResize} />

      <div className="border-b border-paper-300/60 px-4 py-4">
        <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-400">
          Calendar
        </div>
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setAnchor((a) => addMonths(a, -1))}
            className="rounded p-1 text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-800"
            aria-label="Previous month"
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setAnchor(new Date(today.getFullYear(), today.getMonth(), 1))}
            title="Go to current month"
            className="rounded px-1.5 py-0.5 text-xs font-medium text-ink-700 transition-colors hover:text-accent"
          >
            {monthLabel(anchor)}
          </button>
          <button
            type="button"
            onClick={() => setAnchor((a) => addMonths(a, 1))}
            className="rounded p-1 text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-800"
            aria-label="Next month"
          >
            <ChevronRightIcon className="h-4 w-4" />
          </button>
        </div>
        {!atTodayMonth && (
          <button
            type="button"
            onClick={() => setAnchor(new Date(today.getFullYear(), today.getMonth(), 1))}
            className="mt-2 w-full rounded px-2 py-1 text-xs text-ink-500 transition-colors hover:bg-paper-200 hover:text-accent"
          >
            Today
          </button>
        )}
        {active && !atRefMonth && (
          <button
            type="button"
            onClick={() => setAnchor(new Date(refDate.getFullYear(), refDate.getMonth(), 1))}
            className="mt-1 w-full rounded px-2 py-1 text-xs text-ink-500 transition-colors hover:bg-paper-200 hover:text-accent"
          >
            Back to {monthLabel(refDate)}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className={`grid ${gridCols} gap-y-1`}>
          {showWeekNumbers && (
            <div className="flex items-center justify-center text-2xs font-medium uppercase text-ink-400">
              W
            </div>
          )}
          {dayLabels.map((label, i) => (
            <div
              key={`${label}-${i}`}
              className="text-center text-2xs font-medium uppercase text-ink-400"
            >
              {label}
            </div>
          ))}

          {rows.map(({ days, monday }, rowIdx) => {
            const weekIso = isoWeekStr(monday)
            const weekNum = getISOWeek(monday)
            const isActiveWeek = weekIso === activeWeekIso
            const weekMeta = weeklyByTitle.get(weekIso)
            const weekDots = dotsFor(weekMeta ? stats.get(weekMeta.path) : undefined)
            const weekTasks = weekMeta ? stats.get(weekMeta.path)?.openTasks ?? 0 : 0

            const weekCell = !showWeekNumbers ? null : weeklyEnabled ? (
              <button
                key={`w${rowIdx}`}
                type="button"
                onClick={() => void handleWeekClick(monday, weekIso)}
                onContextMenu={(e) => openWeekMenu(e, monday, weekIso)}
                onMouseEnter={(e) => armHover(e.currentTarget, weekMeta)}
                onMouseLeave={clearHover}
                title={`Open ${weeklyNoteTitle(monday)}`}
                className={[
                  'relative flex flex-col items-center rounded py-1 text-xs leading-tight transition-colors',
                  isActiveWeek
                    ? 'bg-accent font-semibold text-white'
                    : 'text-ink-400 hover:bg-paper-200',
                ].join(' ')}
              >
                {weekTasks > 0 && (
                  <span
                    className={[
                      'absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full',
                      isActiveWeek ? 'bg-white' : 'bg-accent',
                    ].join(' ')}
                  />
                )}
                <span>{weekNum}</span>
                {weekMeta ? (
                  renderDots(weekDots.count, weekDots.faint, isActiveWeek)
                ) : (
                  <span className="mt-0.5 h-1" />
                )}
              </button>
            ) : (
              <div
                key={`w${rowIdx}`}
                className="flex items-center justify-center text-2xs text-ink-400"
              >
                {weekNum}
              </div>
            )

            const dayCells = days.map((day) => {
              const iso = isoDateStr(day)
              const inMonth = day.getMonth() === anchorMonth
              const isActiveDay = iso === activeDayIso
              const isToday = iso === todayIso
              const dayMeta = dailyByTitle.get(iso)
              const dayStats = dayMeta ? stats.get(dayMeta.path) : undefined
              const dots = dotsFor(dayStats)
              const openTasks = dayStats?.openTasks ?? 0

              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => void handleDayClick(day, iso)}
                  onContextMenu={(e) => openDayMenu(e, day, iso)}
                  onMouseEnter={(e) => armHover(e.currentTarget, dayMeta)}
                  onMouseLeave={clearHover}
                  disabled={!dailyEnabled}
                  title={iso}
                  className={[
                    'relative flex flex-col items-center rounded py-1 text-xs leading-tight transition-colors',
                    !dailyEnabled
                      ? inMonth
                        ? 'cursor-default text-ink-600'
                        : 'cursor-default text-ink-400'
                      : isActiveDay
                        ? 'bg-accent font-semibold text-white'
                        : isToday
                          ? 'font-semibold text-accent ring-1 ring-inset ring-accent/50'
                          : inMonth
                            ? 'text-ink-700 hover:bg-paper-200'
                            : 'text-ink-400 hover:bg-paper-200',
                  ].join(' ')}
                >
                  {openTasks > 0 && (
                    <span
                      title={`${openTasks} open task${openTasks === 1 ? '' : 's'}`}
                      className={[
                        'absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full',
                        isActiveDay ? 'bg-white' : 'bg-accent',
                      ].join(' ')}
                    />
                  )}
                  <span>{day.getDate()}</span>
                  {dayMeta ? (
                    renderDots(dots.count, dots.faint, isActiveDay)
                  ) : (
                    <span className="mt-0.5 h-1" />
                  )}
                </button>
              )
            })

            return showWeekNumbers ? [weekCell, ...dayCells] : dayCells
          })}
        </div>
      </div>

      {hover && (
        <div
          className="fixed z-50 max-w-[260px] rounded-lg border border-paper-300/75 bg-paper-50 p-3 shadow-[0_12px_28px_-18px_rgb(var(--z-shadow)/0.8)]"
          style={{ right: hover.right, top: Math.min(hover.top, window.innerHeight - 140) }}
        >
          <div className="truncate text-xs font-semibold text-ink-900">{hover.meta.title}</div>
          {hover.meta.excerpt ? (
            <div className="mt-1 line-clamp-4 text-xs leading-5 text-ink-500">
              {hover.meta.excerpt}
            </div>
          ) : (
            <div className="mt-1 text-xs italic text-ink-400">Empty note</div>
          )}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </section>
  )
}
