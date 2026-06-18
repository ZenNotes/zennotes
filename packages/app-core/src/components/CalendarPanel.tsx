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
import {
  inferDailyTaskDueDates,
  parseTasksFromBody,
  tasksDueOn,
  type VaultTask,
} from '@shared/tasks'
import { useStore } from '../store'
import {
  buildDailyNoteDateByPath,
  buildDateNoteIndexes,
  classifyDateNote,
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

/** Parse a `YYYY-MM-DD` string back to a local-midnight Date. */
function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map((s) => Number.parseInt(s, 10))
  return new Date(y, m - 1, d)
}

const TASK_PREFIX_RE = /^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s?/

/** The raw text after the checkbox (content + any `due:`/`!priority` tokens) —
 *  what an inline edit field prefills with so editing is lossless. */
function taskTail(task: VaultTask): string {
  const m = task.rawText.match(TASK_PREFIX_RE)
  return m ? task.rawText.slice(m[0].length) : task.content
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
  const vaultTasks = useStore((s) => s.vaultTasks)
  const tasksLoading = useStore((s) => s.tasksLoading)
  const refreshTasks = useStore((s) => s.refreshTasks)
  const addTaskForDate = useStore((s) => s.addTaskForDate)
  const toggleTaskFromList = useStore((s) => s.toggleTaskFromList)
  const openTaskAt = useStore((s) => s.openTaskAt)
  const applyTaskMutation = useStore((s) => s.applyTaskMutation)
  const moveTaskToDate = useStore((s) => s.moveTaskToDate)
  const deleteTaskFromList = useStore((s) => s.deleteTaskFromList)
  const width = useStore((s) => s.panelWidths.calendar)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const weekStart = useStore((s) => s.calendarWeekStart)
  const showWeekNumbers = useStore((s) => s.calendarShowWeekNumbers)
  const { startResize } = usePanelResize(width, (px) => setPanelWidth('calendar', px))

  const settings = useMemo(() => normalizeVaultSettings(vaultSettings), [vaultSettings])
  const dailyEnabled = settings.dailyNotes.enabled
  const weeklyEnabled = settings.weeklyNotes.enabled

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

  // Calendar key -> NoteMeta for the daily/weekly notes that exist on disk.
  const { dailyByDate, weeklyByWeek } = useMemo(
    () => buildDateNoteIndexes(notes, settings),
    [notes, settings]
  )

  // The day the user has clicked to inspect (tasks + actions shown below the
  // grid). Defaults to the active daily note's date, else today; follows the
  // active note as it changes.
  const [selectedIso, setSelectedIso] = useState<string>(() => activeDayIso ?? todayIso)
  useEffect(() => {
    setSelectedIso(activeDayIso ?? todayIso)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.path])
  const selectedDate = useMemo(() => parseIsoDate(selectedIso), [selectedIso])

  // Tasks scheduled for the selected day. Tasks written in a daily note inherit
  // that note's date (implicit due) just like the full Tasks calendar, so we run
  // the same inference over the vault-wide index. Load it lazily the first time.
  const dueByPath = useMemo(
    () => buildDailyNoteDateByPath(notes, vaultSettings),
    [notes, vaultSettings]
  )
  const inferredTasks = useMemo(
    () => inferDailyTaskDueDates(vaultTasks, dueByPath),
    [vaultTasks, dueByPath]
  )
  // The 7 days of the selected day's week (respecting the week-start setting),
  // shown as an agenda under the calendar.
  const weekDays = useMemo(() => {
    const offset = (selectedDate.getDay() - firstDay + 7) % 7
    const start = new Date(
      selectedDate.getFullYear(),
      selectedDate.getMonth(),
      selectedDate.getDate() - offset
    )
    return Array.from(
      { length: 7 },
      (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    )
  }, [selectedDate, firstDay])
  const weekRangeLabel = useMemo(() => {
    const start = weekDays[0]
    const end = weekDays[6]
    const startStr = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const endStr =
      end.getMonth() === start.getMonth()
        ? end.toLocaleDateString(undefined, { day: 'numeric' })
        : end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return `${startStr} – ${endStr}`
  }, [weekDays])
  useEffect(() => {
    if (dailyEnabled && vaultTasks.length === 0 && !tasksLoading) void refreshTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyEnabled])

  const [addValue, setAddValue] = useState('')
  // Drag-to-reschedule: dragged task held in a ref (drop handlers read it
  // synchronously); the hovered day is highlighted while dragging.
  const dragTaskRef = useRef<VaultTask | null>(null)
  const [dragOverIso, setDragOverIso] = useState<string | null>(null)
  // Inline task editing (right-click → Edit).
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // Set just before blurring on Escape so the blur handler cancels instead of commits.
  const cancelEditRef = useRef(false)
  // Keyboard control (active only while the panel has focus, so it never steals
  // keys from the editor). Mirrors the big calendar.
  const panelRef = useRef<HTMLElement>(null)
  const addInputRef = useRef<HTMLInputElement>(null)
  const focusedTaskRef = useRef<HTMLDivElement | null>(null)
  const [activeTaskIndex, setActiveTaskIndex] = useState(0)
  const [grabbedTask, setGrabbedTask] = useState<VaultTask | null>(null)
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()
  const dPending = useRef(false)
  const dTimer = useRef<ReturnType<typeof setTimeout>>()

  // The selected day's tasks drive the keyboard "active task" cursor.
  const selectedDayTasks = useMemo(
    () => tasksDueOn(inferredTasks, selectedIso),
    [inferredTasks, selectedIso]
  )
  const activeIdx = Math.min(activeTaskIndex, Math.max(0, selectedDayTasks.length - 1))
  useEffect(() => {
    setActiveTaskIndex(0)
  }, [selectedIso])
  useEffect(() => {
    focusedTaskRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIso, activeIdx])

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
    for (const d of grid) push(dailyByDate.get(isoDateStr(d)))
    for (const { monday } of rows) push(weeklyByWeek.get(isoWeekStr(monday)))
    return list
  }, [grid, rows, dailyByDate, weeklyByWeek])

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

  // Open the daily note for a day, creating it (with a prompt) if missing.
  // Single-click now just *selects* a day (see the grid); this runs on
  // double-click, the "Open/Create note" action, and the context menu.
  const openOrCreateDay = useCallback(
    async (day: Date, iso: string) => {
      if (!dailyEnabled) return
      if (dailyByDate.has(iso)) {
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
    [dailyEnabled, dailyByDate, openDailyNoteForDate]
  )

  const addDaysIso = useCallback(
    (n: number) =>
      isoDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n)),
    [today]
  )

  const handleWeekClick = useCallback(
    async (monday: Date, weekIso: string) => {
      if (!weeklyEnabled) return
      if (weeklyByWeek.has(weekIso)) {
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
    [weeklyEnabled, weeklyByWeek, openWeeklyNoteForDate]
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
      const meta = dailyByDate.get(iso)
      const items: ContextMenuItem[] = meta
        ? [
            { label: 'Open note', onSelect: () => void openDailyNoteForDate(day) },
            { kind: 'separator' },
            { label: 'Move to Trash', danger: true, onSelect: () => void trashNote(meta) },
          ]
        : [{ label: `Create ${iso}`, onSelect: () => void openOrCreateDay(day, iso) }]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [dailyEnabled, dailyByDate, openDailyNoteForDate, openOrCreateDay, trashNote, clearHover]
  )
  const openWeekMenu = useCallback(
    (e: React.MouseEvent, monday: Date, weekIso: string) => {
      if (!weeklyEnabled) return
      e.preventDefault()
      clearHover()
      const meta = weeklyByWeek.get(weekIso)
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
    [weeklyEnabled, weeklyByWeek, openWeeklyNoteForDate, handleWeekClick, trashNote, clearHover]
  )

  // Right-click a task in the detail panel: reschedule presets, inline edit, or
  // delete. Arbitrary dates are assigned by dragging the task onto a day.
  const openTaskMenu = useCallback(
    (e: React.MouseEvent, task: VaultTask) => {
      e.preventDefault()
      e.stopPropagation()
      clearHover()
      const reschedule = (iso: string | null): void =>
        void applyTaskMutation(task, { kind: 'set-due', due: iso })
      const items: ContextMenuItem[] = [
        { label: 'Due today', hint: addDaysIso(0), onSelect: () => reschedule(addDaysIso(0)) },
        {
          label: 'Due tomorrow',
          hint: addDaysIso(1),
          onSelect: () => reschedule(addDaysIso(1)),
        },
        {
          label: 'Due next week',
          hint: addDaysIso(7),
          onSelect: () => reschedule(addDaysIso(7)),
        },
      ]
      if (task.due && !task.dueInferred) {
        items.push({ label: 'Clear due date', onSelect: () => reschedule(null) })
      }
      items.push(
        { kind: 'separator' },
        {
          label: 'Edit',
          onSelect: () => {
            setEditingTaskId(task.id)
            setEditValue(taskTail(task))
          },
        },
        { kind: 'separator' },
        { label: 'Delete', danger: true, onSelect: () => void deleteTaskFromList(task) }
      )
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [clearHover, applyTaskMutation, deleteTaskFromList, addDaysIso]
  )

  // After dropping a task on a day (calendar cell or week-agenda row), offer to
  // move it into that day's note or just set its due date.
  const openDropMenu = useCallback(
    (clientX: number, clientY: number, task: VaultTask, iso: string, day: Date) => {
      const dropLabel = day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      setMenu({
        x: clientX,
        y: clientY,
        items: [
          {
            label: `Move into ${dropLabel}'s note`,
            onSelect: () => void moveTaskToDate(task, iso),
          },
          {
            label: `Just set due: ${dropLabel}`,
            onSelect: () => void applyTaskMutation(task, { kind: 'set-due', due: iso }),
          },
        ],
      })
    },
    [moveTaskToDate, applyTaskMutation]
  )

  const moveSelectedDay = useCallback(
    (deltaDays: number): void => {
      const next = new Date(
        selectedDate.getFullYear(),
        selectedDate.getMonth(),
        selectedDate.getDate() + deltaDays
      )
      setSelectedIso(isoDateStr(next))
      if (next.getMonth() !== anchor.getMonth() || next.getFullYear() !== anchor.getFullYear()) {
        setAnchor(new Date(next.getFullYear(), next.getMonth(), 1))
      }
    },
    [selectedDate, anchor]
  )

  // Vim keyboard control — active only while focus is inside the panel, so it
  // never intercepts keys meant for the editor. Mirrors the big calendar.
  useEffect(() => {
    if (!dailyEnabled) return
    const handler = (e: KeyboardEvent): void => {
      const panel = panelRef.current
      const active = document.activeElement as HTMLElement | null
      if (!panel || !active || !panel.contains(active)) return
      if (document.querySelector('[data-vim-hint-overlay]')) return
      const tag = active.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return

      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      const tasks = selectedDayTasks
      const cur = tasks[Math.min(activeTaskIndex, Math.max(0, tasks.length - 1))]

      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (grabbedTask) {
        if (e.key === 'Escape') {
          consume()
          setGrabbedTask(null)
          return
        }
        if (e.key === 'Enter') {
          consume()
          const cell = document.querySelector(`[data-cal-day="${selectedIso}"]`)
          const rect = cell?.getBoundingClientRect()
          openDropMenu(
            rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
            rect ? rect.bottom : window.innerHeight / 2,
            grabbedTask,
            selectedIso,
            selectedDate
          )
          setGrabbedTask(null)
          return
        }
        switch (e.key) {
          case 'h':
          case 'ArrowLeft':
            consume()
            moveSelectedDay(-1)
            return
          case 'l':
          case 'ArrowRight':
            consume()
            moveSelectedDay(1)
            return
          case 'j':
          case 'ArrowDown':
            consume()
            moveSelectedDay(7)
            return
          case 'k':
          case 'ArrowUp':
            consume()
            moveSelectedDay(-7)
            return
          case '[':
            consume()
            setAnchor((a) => addMonths(a, -1))
            return
          case ']':
            consume()
            setAnchor((a) => addMonths(a, 1))
            return
          default:
            consume()
            return
        }
      }

      if (e.key === 'a') {
        consume()
        requestAnimationFrame(() => addInputRef.current?.focus())
        return
      }
      if (e.key === 't' && gPending.current > 0) {
        consume()
        gPending.current = 0
        if (gTimer.current) clearTimeout(gTimer.current)
        setSelectedIso(todayIso)
        setAnchor(new Date(today.getFullYear(), today.getMonth(), 1))
        return
      }
      if (e.key === 'g') {
        consume()
        if (gPending.current > 0) {
          gPending.current = 0
          if (gTimer.current) clearTimeout(gTimer.current)
          setSelectedIso(isoDateStr(grid[0]))
          return
        }
        gPending.current = 1
        if (gTimer.current) clearTimeout(gTimer.current)
        gTimer.current = setTimeout(() => (gPending.current = 0), 600)
        return
      }
      if (e.key === 'G') {
        consume()
        setSelectedIso(isoDateStr(grid[grid.length - 1]))
        return
      }

      if (tasks.length > 0) {
        if (e.key === 'Tab') {
          consume()
          const n = tasks.length
          const dir = e.shiftKey ? -1 : 1
          setActiveTaskIndex((i) => (((Math.min(i, n - 1) + dir) % n) + n) % n)
          return
        }
        if (cur) {
          if (e.key === '>' || e.key === '<') {
            consume()
            const d = new Date(
              selectedDate.getFullYear(),
              selectedDate.getMonth(),
              selectedDate.getDate() + (e.key === '>' ? 1 : -1)
            )
            void applyTaskMutation(cur, { kind: 'set-due', due: isoDateStr(d) })
            return
          }
          if (e.key === 'T') {
            consume()
            void applyTaskMutation(cur, { kind: 'set-due', due: todayIso })
            return
          }
          if (e.key === 'x' || e.key === ' ') {
            consume()
            void toggleTaskFromList(cur)
            return
          }
          if (e.key === 'e') {
            consume()
            setEditingTaskId(cur.id)
            setEditValue(taskTail(cur))
            return
          }
          if (e.key === 'm') {
            consume()
            setGrabbedTask(cur)
            return
          }
          if (e.key === 'd') {
            consume()
            if (dPending.current) {
              dPending.current = false
              if (dTimer.current) clearTimeout(dTimer.current)
              void deleteTaskFromList(cur)
            } else {
              dPending.current = true
              if (dTimer.current) clearTimeout(dTimer.current)
              dTimer.current = setTimeout(() => (dPending.current = false), 600)
            }
            return
          }
        }
      }

      switch (e.key) {
        case 'h':
        case 'ArrowLeft':
          consume()
          moveSelectedDay(-1)
          return
        case 'l':
        case 'ArrowRight':
          consume()
          moveSelectedDay(1)
          return
        case 'j':
        case 'ArrowDown':
          consume()
          moveSelectedDay(7)
          return
        case 'k':
        case 'ArrowUp':
          consume()
          moveSelectedDay(-7)
          return
        case '[':
          consume()
          setAnchor((a) => addMonths(a, -1))
          return
        case ']':
          consume()
          setAnchor((a) => addMonths(a, 1))
          return
        case 'Enter':
          consume()
          if (cur) void openTaskAt(cur)
          else void openOrCreateDay(selectedDate, selectedIso)
          return
        default:
          return
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [
    dailyEnabled,
    selectedDayTasks,
    activeTaskIndex,
    grabbedTask,
    selectedIso,
    selectedDate,
    anchor,
    grid,
    todayIso,
    today,
    moveSelectedDay,
    openDropMenu,
    applyTaskMutation,
    toggleTaskFromList,
    deleteTaskFromList,
    openTaskAt,
    openOrCreateDay
  ])

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

  // One task row in the week agenda: draggable to a calendar day (move / set
  // due), click to open, right-click for actions, inline-editable.
  const renderTaskRow = (
    task: VaultTask,
    dayIso: string,
    opts?: { isActive?: boolean; rowRef?: React.RefObject<HTMLDivElement> | null }
  ): JSX.Element =>
    editingTaskId === task.id ? (
      <div key={task.id} className="flex items-center gap-2 px-1.5 py-1">
        <span className="h-3.5 w-3.5 shrink-0 rounded-sm border border-paper-400/70" />
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              cancelEditRef.current = true
              e.currentTarget.blur()
            }
          }}
          onBlur={() => {
            if (cancelEditRef.current) {
              cancelEditRef.current = false
            } else {
              const text = editValue.trim()
              if (text && text !== taskTail(task)) {
                void applyTaskMutation(task, { kind: 'set-text', text })
              }
            }
            setEditingTaskId(null)
          }}
          className="min-w-0 flex-1 rounded border border-accent/60 bg-paper-100 px-1 py-0.5 text-xs outline-none"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    ) : (
      // Draggable <div> (not <button>) — Chromium/Electron won't fire dragstart
      // on a native button.
      <div
        key={task.id}
        ref={opts?.rowRef ?? undefined}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', task.id)
          dragTaskRef.current = task
        }}
        onDragEnd={() => {
          dragTaskRef.current = null
          setDragOverIso(null)
        }}
        onClick={() => void openTaskAt(task)}
        onContextMenu={(e) => openTaskMenu(e, task)}
        title={`${task.content} — drag to a day to reschedule, right-click for more`}
        className={[
          'flex w-full cursor-grab items-center gap-2 rounded px-1.5 py-1 text-left text-xs text-ink-700 transition-colors active:cursor-grabbing',
          opts?.isActive
            ? 'bg-accent/10 ring-1 ring-inset ring-accent/40'
            : 'hover:bg-paper-200',
          grabbedTask?.id === task.id ? 'opacity-50' : ''
        ].join(' ')}
      >
        <span
          role="checkbox"
          aria-checked={false}
          onClick={(e) => {
            e.stopPropagation()
            void toggleTaskFromList(task)
          }}
          className="flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-paper-400/70 transition-colors hover:bg-paper-300/60"
        />
        <span className="min-w-0 flex-1 truncate">{task.content || '(empty task)'}</span>
        {task.sourcePath !== (dailyByDate.get(dayIso)?.path ?? '') && (
          <span className="shrink-0 truncate text-2xs text-ink-400">{task.noteTitle}</span>
        )}
      </div>
    )

  return (
    <section
      ref={panelRef}
      aria-label="Calendar"
      tabIndex={0}
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/18 outline-none"
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

      <div className="shrink-0 px-3 py-3">
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
            const weekMeta = weeklyByWeek.get(weekIso)
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
              const isSelected = iso === selectedIso
              const isToday = iso === todayIso
              const isDragOver = dragOverIso === iso
              const dayMeta = dailyByDate.get(iso)
              const dayStats = dayMeta ? stats.get(dayMeta.path) : undefined
              const dots = dotsFor(dayStats)
              const openTasks = dayStats?.openTasks ?? 0

              return (
                <button
                  key={iso}
                  type="button"
                  data-cal-day={iso}
                  onClick={() => dailyEnabled && setSelectedIso(iso)}
                  onDoubleClick={() => void openOrCreateDay(day, iso)}
                  onContextMenu={(e) => openDayMenu(e, day, iso)}
                  onMouseEnter={(e) => armHover(e.currentTarget, dayMeta)}
                  onMouseLeave={clearHover}
                  onDragOver={(e) => {
                    if (!dragTaskRef.current || !dailyEnabled) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (dragOverIso !== iso) setDragOverIso(iso)
                  }}
                  onDragLeave={() => {
                    if (dragOverIso === iso) setDragOverIso(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const dragged = dragTaskRef.current
                    dragTaskRef.current = null
                    setDragOverIso(null)
                    if (dragged) openDropMenu(e.clientX, e.clientY, dragged, iso, day)
                  }}
                  disabled={!dailyEnabled}
                  title={`${iso} — click to view, double-click to open`}
                  className={[
                    'relative flex flex-col items-center rounded py-1 text-xs leading-tight transition-colors',
                    !dailyEnabled
                      ? inMonth
                        ? 'cursor-default text-ink-600'
                        : 'cursor-default text-ink-400'
                      : isDragOver
                        ? 'bg-accent/25 font-semibold text-ink-900 ring-2 ring-inset ring-accent/80'
                        : isActiveDay
                          ? 'bg-accent font-semibold text-white'
                          : isSelected
                            ? 'bg-paper-200 font-semibold text-ink-900 ring-1 ring-inset ring-accent/60'
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

      {dailyEnabled && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-paper-300/60 px-3 py-3">
          {grabbedTask && (
            <div className="mb-2 rounded bg-accent/10 px-2 py-1 text-2xs text-accent">
              Moving “{grabbedTask.content || 'task'}” — h/j/k/l pick a day · Enter place · Esc cancel
            </div>
          )}
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0 truncate text-xs font-semibold text-ink-800">
              Week of {weekRangeLabel}
            </div>
            <button
              type="button"
              onClick={() => void openOrCreateDay(selectedDate, selectedIso)}
              className="shrink-0 rounded px-1.5 py-0.5 text-2xs text-ink-500 transition-colors hover:bg-paper-200 hover:text-accent"
            >
              {dailyByDate.has(selectedIso) ? 'Open note →' : 'Create note'}
            </button>
          </div>

          <form
            className="mb-2"
            onSubmit={(e) => {
              e.preventDefault()
              const value = addValue.trim()
              if (!value) return
              void addTaskForDate(selectedIso, value)
              setAddValue('')
            }}
          >
            <input
              ref={addInputRef}
              type="text"
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  if (addValue) setAddValue('')
                  else e.currentTarget.blur()
                }
              }}
              placeholder={`Add a task for ${selectedDate.toLocaleDateString(undefined, {
                weekday: 'short',
                day: 'numeric',
              })}…`}
              className="w-full rounded-md border border-paper-300/60 bg-paper-200/40 px-2 py-1 text-xs outline-none placeholder:text-ink-400 focus:border-accent/60"
              spellCheck={false}
              autoComplete="off"
            />
          </form>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            {weekDays.map((day) => {
              const iso = isoDateStr(day)
              const dayTasks = tasksDueOn(inferredTasks, iso)
              const isSel = iso === selectedIso
              const isDragOver = dragOverIso === iso
              return (
                <div
                  key={iso}
                  onDragOver={(e) => {
                    if (!dragTaskRef.current) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (dragOverIso !== iso) setDragOverIso(iso)
                  }}
                  onDragLeave={() => {
                    if (dragOverIso === iso) setDragOverIso(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const dragged = dragTaskRef.current
                    dragTaskRef.current = null
                    setDragOverIso(null)
                    if (dragged) openDropMenu(e.clientX, e.clientY, dragged, iso, day)
                  }}
                  className={[
                    'rounded',
                    isDragOver ? 'bg-accent/5 ring-1 ring-inset ring-accent/50' : '',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedIso(iso)}
                    className={[
                      'flex w-full items-center justify-between rounded px-1.5 py-0.5 text-left text-2xs font-semibold uppercase tracking-wide transition-colors',
                      isSel ? 'text-ink-900' : 'text-ink-400 hover:text-ink-700',
                    ].join(' ')}
                  >
                    <span>
                      {day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
                      {iso === todayIso && (
                        <span className="ml-1.5 rounded bg-accent/15 px-1 py-px text-2xs font-medium normal-case text-accent">
                          Today
                        </span>
                      )}
                    </span>
                    {dayTasks.length > 0 && <span className="text-ink-400">{dayTasks.length}</span>}
                  </button>
                  {dayTasks.length > 0 && (
                    <div className="mt-0.5 space-y-0.5">
                      {dayTasks.map((task, ti) => {
                        const isActive = iso === selectedIso && ti === activeIdx
                        return renderTaskRow(task, iso, {
                          isActive,
                          rowRef: isActive ? focusedTaskRef : null
                        })
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

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
