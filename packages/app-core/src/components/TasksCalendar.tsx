/**
 * Month-grid Calendar view for the Tasks tab.
 *
 * - Each cell shows a date number plus dots for tasks scheduled that
 *   day. Today's cell is ringed; the focused cell is highlighted.
 * - Tasks without a due date land in the "No date" strip below the
 *   grid so they stay actionable from the calendar surface.
 * - Vim navigation: h/j/k/l moves between days, [ / ] flips the
 *   month, gt jumps to today, Enter opens the source note for the
 *   currently-focused task.
 *
 * Date arithmetic is done in the user's local timezone using `Date`
 * + manual ISO formatting — no external date library, matching the
 * rest of the codebase.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { VaultTask } from '@shared/tasks'
import {
  bucketTasksByDueDate,
  isOverdue as isTaskOverdue,
  toIsoDateLocal
} from '@shared/tasks'
import { useStore } from '../store'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'
import { InlineMarkdown } from '../lib/inline-markdown'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

interface Props {
  tasks: VaultTask[]
  today: Date
  onOpenTask: (task: VaultTask) => void
  onToggleTask: (task: VaultTask) => void
  /** Set a task's due date (keyboard reschedule + the drop "set due" choice). */
  onRescheduleTask: (task: VaultTask, dueIso: string) => void
  /** Physically move a task into the daily note for the given date. */
  onMoveTask: (task: VaultTask, dateIso: string) => void
  /** Add a `- [ ] …` task to the daily note for the given date. */
  onAddTask: (dateIso: string, text: string) => void | Promise<void>
  /** Whether daily notes are enabled — gates the quick-add box, which writes
   *  into the selected day's daily note. */
  dailyNotesEnabled: boolean
}

/** Sunday-first; matches how most US/Western calendars read. The month
 *  grid is 6 weeks (42 cells) so layouts don't reflow when months span
 *  4-vs-5-vs-6 weeks. */
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

function parseIsoLocal(iso: string): Date {
  // Manual parse so we always land in local-time midnight (avoiding
  // the `new Date('YYYY-MM-DD')` UTC quirk).
  const [y, m, dd] = iso.split('-').map((s) => Number.parseInt(s, 10))
  return new Date(y, m - 1, dd)
}

const TASK_PREFIX_RE = /^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s?/

/** Text after the checkbox (content + any tokens) — prefill for inline edit. */
function taskTail(task: VaultTask): string {
  const m = task.rawText.match(TASK_PREFIX_RE)
  return m ? task.rawText.slice(m[0].length) : task.content
}

function buildMonthGrid(anchor: Date): Date[] {
  const first = firstOfMonth(anchor)
  // Walk back to the most recent Sunday (could be in the previous month).
  const start = addDays(first, -first.getDay())
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

function formatMonthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function TasksCalendar({
  tasks,
  today,
  onOpenTask,
  onToggleTask,
  onRescheduleTask,
  onMoveTask,
  onAddTask,
  dailyNotesEnabled
}: Props): JSX.Element {
  const monthAnchorIso = useStore((s) => s.tasksCalendarMonthAnchor)
  const setMonthAnchor = useStore((s) => s.setTasksCalendarMonthAnchor)
  const selectedDateIso = useStore((s) => s.tasksCalendarSelectedDate)
  const setSelectedDate = useStore((s) => s.setTasksCalendarSelectedDate)
  const applyTaskMutation = useStore((s) => s.applyTaskMutation)
  const deleteTaskFromList = useStore((s) => s.deleteTaskFromList)
  const rootRef = useRef<HTMLDivElement>(null)
  // Pointer-based drag-to-reschedule. Native HTML5 DnD is flaky for these rows
  // inside the pane, so (like the Kanban) we grab on pointerdown, float a ghost
  // while moving, detect the day under the cursor via a `data-cal-day` attribute,
  // and offer the move / set-due choice on release.
  const pointerDragRef = useRef<{
    task: VaultTask
    startX: number
    startY: number
    dragging: boolean
  } | null>(null)
  const suppressClickRef = useRef(false)
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const [dragOverIso, setDragOverIso] = useState<string | null>(null)
  // Shared context menu — the drop "move vs set due" choice and the right-click
  // task actions both feed it.
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  // Inline task editing (right-click → Edit).
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const cancelEditRef = useRef(false)
  // Keyboard reschedule: which task in the selected day's list is "active".
  const [activeTaskIndex, setActiveTaskIndex] = useState(0)
  // Keyboard "grab & place": the task picked up with `m`. While set, grid
  // navigation chooses a target day; Enter places it (move/set-due choice).
  const [grabbedTask, setGrabbedTask] = useState<VaultTask | null>(null)
  const dPending = useRef(false)
  const dTimer = useRef<ReturnType<typeof setTimeout>>()
  const addInputRef = useRef<HTMLInputElement>(null)
  // Quick-add box for the selected day.
  const [addValue, setAddValue] = useState('')

  const todayIso = useMemo(() => toIsoDateLocal(today), [today])

  // Initialise anchor + selection lazily — first time the view mounts
  // we land on this month with today selected.
  const monthAnchor = useMemo(
    () => (monthAnchorIso ? firstOfMonth(parseIsoLocal(monthAnchorIso)) : firstOfMonth(today)),
    [monthAnchorIso, today]
  )
  const selectedDate = useMemo(
    () => (selectedDateIso ? parseIsoLocal(selectedDateIso) : today),
    [selectedDateIso, today]
  )
  useEffect(() => {
    if (!monthAnchorIso) setMonthAnchor(toIsoDateLocal(firstOfMonth(today)))
    if (!selectedDateIso) setSelectedDate(todayIso)
    // Run once on mount; the deps cover lazy initialization, not subsequent updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cells = useMemo(() => buildMonthGrid(monthAnchor), [monthAnchor])

  const buckets = useMemo(() => bucketTasksByDueDate(tasks), [tasks])
  const unscheduled = buckets.get('unscheduled') ?? []
  const selectedIso = toIsoDateLocal(selectedDate)
  const selectedTasks = buckets.get(selectedIso) ?? []
  const activeIdx = Math.min(activeTaskIndex, Math.max(0, selectedTasks.length - 1))
  const addLabel = selectedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  const addDaysIso = (n: number): string =>
    toIsoDateLocal(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n))

  const startPointerDrag = (task: VaultTask, e: React.PointerEvent): void => {
    if (e.button !== 0) return
    suppressClickRef.current = false
    pointerDragRef.current = { task, startX: e.clientX, startY: e.clientY, dragging: false }
  }

  // Keep the latest reschedule/move callbacks in a ref so the window listeners
  // can mount once (the parent passes fresh arrows each render).
  const dropCbRef = useRef({ onMoveTask, onRescheduleTask })
  dropCbRef.current = { onMoveTask, onRescheduleTask }

  useEffect(() => {
    const dayUnder = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y)
      const dayEl = el?.closest('[data-cal-day]') as HTMLElement | null
      return dayEl?.dataset.calDay ?? null
    }
    const onMove = (e: PointerEvent): void => {
      const drag = pointerDragRef.current
      if (!drag) return
      if (!drag.dragging) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return
        drag.dragging = true
      }
      setGhost({ x: e.clientX, y: e.clientY, label: drag.task.content || 'task' })
      setDragOverIso(dayUnder(e.clientX, e.clientY))
    }
    const onUp = (e: PointerEvent): void => {
      const drag = pointerDragRef.current
      if (!drag) return
      pointerDragRef.current = null
      setGhost(null)
      setDragOverIso(null)
      if (!drag.dragging) return
      // It was a drag, not a click — keep the row's onClick from firing.
      suppressClickRef.current = true
      const iso = dayUnder(e.clientX, e.clientY)
      if (iso) {
        const { onMoveTask: move, onRescheduleTask: resched } = dropCbRef.current
        setMenu({
          x: e.clientX,
          y: e.clientY,
          items: dropChoiceItems(drag.task, iso, move, resched)
        })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  // Right-click a task: reschedule presets, move into a day's note, inline edit,
  // delete. (Drag still offers the move/set-due choice.)
  const openTaskMenu = (e: React.MouseEvent, task: VaultTask): void => {
    e.preventDefault()
    e.stopPropagation()
    const reschedule = (iso: string | null): void =>
      void applyTaskMutation(task, { kind: 'set-due', due: iso })
    const items: ContextMenuItem[] = [
      { label: 'Due today', hint: addDaysIso(0), onSelect: () => reschedule(addDaysIso(0)) },
      { label: 'Due tomorrow', hint: addDaysIso(1), onSelect: () => reschedule(addDaysIso(1)) },
      { label: 'Due next week', hint: addDaysIso(7), onSelect: () => reschedule(addDaysIso(7)) }
    ]
    if (task.due && !task.dueInferred) {
      items.push({ label: 'Clear due date', onSelect: () => reschedule(null) })
    }
    items.push(
      { kind: 'separator' },
      {
        label: 'Move to its day’s note',
        disabled: !task.due,
        onSelect: () => {
          if (task.due) onMoveTask(task, task.due)
        }
      },
      {
        label: 'Edit',
        onSelect: () => {
          setEditingTaskId(task.id)
          setEditValue(taskTail(task))
        }
      },
      { kind: 'separator' },
      { label: 'Delete', danger: true, onSelect: () => void deleteTaskFromList(task) }
    )
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const renderTask = (
    task: VaultTask,
    extra: { isActive?: boolean; buttonRef?: React.RefObject<HTMLDivElement> | null }
  ): JSX.Element =>
    editingTaskId === task.id ? (
      <div key={task.id} className="flex items-center gap-2 rounded-md px-2 py-1">
        <span className="h-4 w-4 shrink-0 rounded border border-paper-400/70" />
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
          className="min-w-0 flex-1 rounded border border-accent/60 bg-paper-100 px-1 py-0.5 text-sm outline-none"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    ) : (
      <CalendarTaskRow
        key={task.id}
        task={task}
        isOverdue={isTaskOverdue(task, today)}
        isActive={extra.isActive}
        buttonRef={extra.buttonRef ?? null}
        onToggle={() => onToggleTask(task)}
        onOpen={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false
            return
          }
          onOpenTask(task)
        }}
        onContextMenu={(e) => openTaskMenu(e, task)}
        onPointerDownTask={(e) => startPointerDrag(task, e)}
      />
    )

  // Reset the keyboard "active task" cursor whenever the selected day changes.
  useEffect(() => {
    setActiveTaskIndex(0)
  }, [selectedIso])

  // gt sequence (vim "go to today")
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()

  const moveSelection = (deltaDays: number): void => {
    const next = addDays(selectedDate, deltaDays)
    const nextIso = toIsoDateLocal(next)
    setSelectedDate(nextIso)
    // If selection moved out of the visible month, follow it.
    if (next.getMonth() !== monthAnchor.getMonth()) {
      setMonthAnchor(toIsoDateLocal(firstOfMonth(next)))
    }
  }

  const goToMonth = (delta: number): void => {
    const next = addMonths(monthAnchor, delta)
    setMonthAnchor(toIsoDateLocal(next))
    // Keep the selection roughly in the same day-of-month if possible.
    const desiredDay = Math.min(selectedDate.getDate(), 28)
    const newSel = new Date(next.getFullYear(), next.getMonth(), desiredDay)
    setSelectedDate(toIsoDateLocal(newSel))
  }

  const goToToday = (): void => {
    setMonthAnchor(toIsoDateLocal(firstOfMonth(today)))
    setSelectedDate(todayIso)
  }

  // Local key handler. Registers in capture phase + uses
  // stopImmediatePropagation so it beats VimNav's `gg`/`G`/`hjkl`
  // sidebar bindings (same trick TasksView's list mode uses).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // While the Vim hint overlay is open it owns the keyboard; yield to it. (#151)
      if (document.querySelector('[data-vim-hint-overlay]')) return
      const active = document.activeElement as HTMLElement | null
      if (active) {
        const tag = active.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return
      }

      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Grab & place: while a task is picked up, the grid navigation chooses a
      // target day; Enter places it (move / set-due choice), Esc cancels.
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
          setMenu({
            x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
            y: rect ? rect.bottom : window.innerHeight / 2,
            items: dropChoiceItems(grabbedTask, selectedIso, onMoveTask, onRescheduleTask)
          })
          setGrabbedTask(null)
          return
        }
        switch (e.key) {
          case 'h':
          case 'ArrowLeft':
            consume()
            moveSelection(-1)
            return
          case 'l':
          case 'ArrowRight':
            consume()
            moveSelection(1)
            return
          case 'j':
          case 'ArrowDown':
            consume()
            moveSelection(7)
            return
          case 'k':
          case 'ArrowUp':
            consume()
            moveSelection(-7)
            return
          case '[':
            consume()
            goToMonth(-1)
            return
          case ']':
            consume()
            goToMonth(1)
            return
          default:
            consume()
            return
        }
      }

      // `a` focuses the quick-add box for the selected day.
      if (e.key === 'a' && dailyNotesEnabled) {
        consume()
        requestAnimationFrame(() => addInputRef.current?.focus())
        return
      }

      // Two-key `gt` — go to today.
      if (e.key === 't' && gPending.current > 0) {
        consume()
        gPending.current = 0
        if (gTimer.current) clearTimeout(gTimer.current)
        goToToday()
        return
      }
      if (e.key === 'g') {
        consume()
        if (gPending.current > 0) {
          // gg jumps the selection to the first cell in the grid.
          gPending.current = 0
          if (gTimer.current) clearTimeout(gTimer.current)
          const first = cells[0]
          setSelectedDate(toIsoDateLocal(first))
          if (first.getMonth() !== monthAnchor.getMonth()) {
            setMonthAnchor(toIsoDateLocal(firstOfMonth(first)))
          }
          return
        }
        gPending.current = 1
        if (gTimer.current) clearTimeout(gTimer.current)
        gTimer.current = setTimeout(() => (gPending.current = 0), 600)
        return
      }
      if (e.key === 'G') {
        consume()
        const last = cells[cells.length - 1]
        setSelectedDate(toIsoDateLocal(last))
        if (last.getMonth() !== monthAnchor.getMonth()) {
          setMonthAnchor(toIsoDateLocal(firstOfMonth(last)))
        }
        return
      }

      // Task-list actions on the active task (keyboard analogs of the row's
      // drag / right-click menu).
      if (selectedTasks.length > 0) {
        if (e.key === 'Tab') {
          consume()
          const n = selectedTasks.length
          const dir = e.shiftKey ? -1 : 1
          setActiveTaskIndex((i) => (((Math.min(i, n - 1) + dir) % n) + n) % n)
          return
        }
        const active = selectedTasks[Math.min(activeTaskIndex, selectedTasks.length - 1)]
        if (active) {
          if (e.key === '>' || e.key === '<') {
            consume()
            onRescheduleTask(active, toIsoDateLocal(addDays(selectedDate, e.key === '>' ? 1 : -1)))
            return
          }
          if (e.key === 'T') {
            consume()
            onRescheduleTask(active, todayIso)
            return
          }
          if (e.key === 'x' || e.key === ' ') {
            consume()
            onToggleTask(active)
            return
          }
          if (e.key === 'e') {
            consume()
            setEditingTaskId(active.id)
            setEditValue(taskTail(active))
            return
          }
          if (e.key === 'm') {
            consume()
            setGrabbedTask(active)
            return
          }
          if (e.key === 'd') {
            consume()
            if (dPending.current) {
              dPending.current = false
              if (dTimer.current) clearTimeout(dTimer.current)
              void deleteTaskFromList(active)
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
          moveSelection(-1)
          return
        case 'l':
        case 'ArrowRight':
          consume()
          moveSelection(1)
          return
        case 'j':
        case 'ArrowDown':
          consume()
          moveSelection(7)
          return
        case 'k':
        case 'ArrowUp':
          consume()
          moveSelection(-7)
          return
        case '[':
          consume()
          goToMonth(-1)
          return
        case ']':
          consume()
          goToMonth(1)
          return
        case 'Enter':
          consume()
          if (selectedTasks.length > 0) {
            onOpenTask(selectedTasks[Math.min(activeTaskIndex, selectedTasks.length - 1)])
          }
          return
        default:
          return
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
    // We deliberately re-bind on every relevant change so the closure
    // sees the latest selection / month / cells.
  }, [
    cells,
    monthAnchor,
    selectedDate,
    selectedIso,
    selectedTasks,
    activeTaskIndex,
    grabbedTask,
    todayIso,
    dailyNotesEnabled,
    onOpenTask,
    onToggleTask,
    onRescheduleTask,
    onMoveTask,
    deleteTaskFromList
  ])

  const focusedTaskRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    focusedTaskRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIso, activeIdx])

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => goToMonth(-1)}
            title="Previous month ([)"
            className="flex h-7 w-7 items-center justify-center rounded-md text-current/60 hover:bg-paper-200/80 hover:text-current/90"
          >
            <ChevronLeftIcon width={14} height={14} />
          </button>
          <button
            type="button"
            onClick={() => goToMonth(1)}
            title="Next month (])"
            className="flex h-7 w-7 items-center justify-center rounded-md text-current/60 hover:bg-paper-200/80 hover:text-current/90"
          >
            <ChevronRightIcon width={14} height={14} />
          </button>
          <button
            type="button"
            onClick={goToToday}
            title="Today (gt)"
            className="ml-1 rounded-md px-2 py-0.5 text-xs text-current/70 hover:bg-paper-200/80 hover:text-current/90"
          >
            Today
          </button>
        </div>
        <div className="text-sm font-semibold text-current/85">
          {formatMonthLabel(monthAnchor)}
        </div>
        <div className="text-xs text-current/40">
          {grabbedTask
            ? `Moving “${grabbedTask.content || 'task'}” — h/j/k/l pick a day · Enter place · Esc cancel`
            : 'h/j/k/l day · Tab pick · x toggle · e edit · dd del · m move · < > / T due · a add'}
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-7 px-3 pt-2 text-2xs uppercase tracking-wide text-current/40">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="px-1 py-1 text-center">
            {d}
          </div>
        ))}
      </div>

      <div className="grid shrink-0 grid-cols-7 gap-px bg-paper-300/45 px-3 pb-3">
        {cells.map((cell) => {
          const cellIso = toIsoDateLocal(cell)
          const cellTasks = buckets.get(cellIso) ?? []
          const isOtherMonth = cell.getMonth() !== monthAnchor.getMonth()
          const isToday = cellIso === todayIso
          const isSelected = cellIso === selectedIso
          const isDragOver = dragOverIso === cellIso
          const overdueCount = cellTasks.filter((t) => isTaskOverdue(t, today)).length
          return (
            <button
              type="button"
              key={cellIso}
              data-cal-day={cellIso}
              onClick={() => {
                setSelectedDate(cellIso)
                if (isOtherMonth) setMonthAnchor(toIsoDateLocal(firstOfMonth(cell)))
              }}
              className={[
                'flex h-16 flex-col items-stretch gap-1 px-1.5 py-1 text-left text-xs transition-colors',
                isOtherMonth ? 'bg-paper-100/40 text-current/35' : 'bg-paper-100/85 text-current/80',
                isDragOver
                  ? 'bg-accent/10 ring-2 ring-inset ring-accent/80'
                  : isSelected
                    ? 'ring-2 ring-inset ring-accent/60'
                    : isToday
                      ? 'ring-1 ring-inset ring-accent/40'
                      : 'hover:bg-paper-200/60'
              ].join(' ')}
            >
              <div className="flex items-center justify-between">
                <span className={isToday ? 'font-semibold text-accent' : ''}>
                  {cell.getDate()}
                </span>
                {cellTasks.length > 0 && (
                  <span className="rounded bg-paper-300/60 px-1 text-2xs text-current/60">
                    {cellTasks.length}
                  </span>
                )}
              </div>
              {cellTasks.length > 0 && (
                <div className="mt-auto flex flex-wrap gap-0.5">
                  {cellTasks.slice(0, 6).map((task) => (
                    <span
                      key={task.id}
                      className={[
                        'h-1.5 w-1.5 rounded-full',
                        overdueCount > 0 && task.due && task.due < todayIso
                          ? 'bg-rose-400/80'
                          : task.priority === 'high'
                            ? 'bg-rose-300/80'
                            : task.priority === 'med'
                              ? 'bg-amber-300/80'
                              : task.priority === 'low'
                                ? 'bg-sky-300/80'
                                : 'bg-paper-400/80'
                      ].join(' ')}
                    />
                  ))}
                  {cellTasks.length > 6 && (
                    <span className="text-2xs text-current/50">+{cellTasks.length - 6}</span>
                  )}
                </div>
              )}
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-paper-300/45 px-3 py-3">
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-current/60">
            {selectedIso === todayIso
              ? 'Today'
              : selectedDate.toLocaleDateString(undefined, {
                  weekday: 'long',
                  month: 'short',
                  day: 'numeric'
                })}
          </h2>
          <span className="text-xs text-current/40">
            {selectedTasks.length} task{selectedTasks.length === 1 ? '' : 's'}
          </span>
        </div>
        {dailyNotesEnabled && (
          <form
            className="mb-2 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const value = addValue.trim()
              if (!value) return
              void onAddTask(selectedIso, value)
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
              placeholder={`Add a task for ${selectedIso === todayIso ? 'today' : addLabel}…`}
              className="min-w-0 flex-1 rounded-md border border-paper-300/60 bg-paper-200/50 px-2 py-1 text-sm outline-none placeholder:text-current/40 focus:border-accent/60"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={!addValue.trim()}
              className="shrink-0 rounded-md bg-accent/90 px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:bg-accent disabled:opacity-40"
            >
              Add
            </button>
          </form>
        )}
        {selectedTasks.length === 0 ? (
          <div className="rounded-md border border-dashed border-paper-300/60 px-3 py-4 text-center text-xs text-current/50">
            {dailyNotesEnabled ? (
              'Nothing scheduled for this day yet.'
            ) : (
              <>
                Nothing scheduled. Add{' '}
                <code className="rounded bg-paper-300/60 px-1">due:{selectedIso}</code> to a task to
                see it here.
              </>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {selectedTasks.map((task, i) =>
              renderTask(task, {
                isActive: i === activeIdx,
                buttonRef: i === activeIdx ? focusedTaskRef : null
              })
            )}
          </div>
        )}

        {unscheduled.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-current/50 hover:text-current/80">
              {unscheduled.length} task{unscheduled.length === 1 ? '' : 's'} without a due date
            </summary>
            <div className="mt-2 space-y-1">
              {unscheduled.map((task) => renderTask(task, {}))}
            </div>
          </details>
        )}
      </div>

      {ghost && (
        <div
          className="pointer-events-none fixed z-[70] max-w-[220px] truncate rounded-md border border-accent/50 bg-paper-100 px-2 py-1 text-sm text-ink-900 shadow-float"
          style={{ left: ghost.x + 12, top: ghost.y + 12 }}
        >
          {ghost.label}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

/** "Move into that day's note" vs "just set the due date" — the menu shown after
 *  dropping a task on a calendar day. */
function dropChoiceItems(
  task: VaultTask,
  dateIso: string,
  onMoveTask: (task: VaultTask, dateIso: string) => void,
  onRescheduleTask: (task: VaultTask, dueIso: string) => void
): ContextMenuItem[] {
  const label = parseIsoLocal(dateIso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
  return [
    { label: `Move into ${label}'s note`, onSelect: () => onMoveTask(task, dateIso) },
    { label: `Just set due: ${label}`, onSelect: () => onRescheduleTask(task, dateIso) }
  ]
}

interface RowProps {
  task: VaultTask
  isOverdue: boolean
  isActive?: boolean
  buttonRef?: React.RefObject<HTMLDivElement> | null
  onToggle: () => void
  onOpen: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  onPointerDownTask?: (e: React.PointerEvent) => void
}

function CalendarTaskRow({
  task,
  isOverdue,
  isActive,
  buttonRef,
  onToggle,
  onOpen,
  onContextMenu,
  onPointerDownTask
}: RowProps): JSX.Element {
  return (
    // Pointer-based drag (see TasksCalendar) instead of native HTML5 DnD.
    // role/tabIndex/onKeyDown keep it keyboard-accessible.
    <div
      role="button"
      tabIndex={0}
      ref={buttonRef ?? undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      onPointerDown={onPointerDownTask}
      onContextMenu={onContextMenu}
      title="Drag to a day to reschedule · right-click for actions"
      className={[
        'flex w-full cursor-grab select-none items-center gap-2 rounded-md border-l-2 px-2 py-1 text-left text-sm active:cursor-grabbing',
        isOverdue ? 'border-rose-500/70' : 'border-transparent',
        isActive ? 'bg-accent/10 ring-1 ring-inset ring-accent/40' : 'hover:bg-paper-200/60'
      ].join(' ')}
    >
      <span
        role="checkbox"
        aria-checked={task.checked}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        className={[
          'flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded transition-colors',
          task.checked
            ? 'border border-accent bg-accent text-white'
            : 'border border-paper-400/70 hover:bg-paper-200/80'
        ].join(' ')}
      >
        {task.checked && (
          <svg
            viewBox="0 0 24 24"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m5 12 5 5L20 7" />
          </svg>
        )}
      </span>
      <span
        className={[
          'min-w-0 flex-1 truncate',
          task.checked ? 'text-current/50 line-through' : ''
        ].join(' ')}
      >
        {task.content ? (
          <InlineMarkdown text={task.content} interactiveLinks={false} />
        ) : (
          '(empty task)'
        )}
      </span>
      <span className="shrink-0 truncate text-xs text-current/45">{task.noteTitle}</span>
      {task.priority && (
        <span
          className={[
            'shrink-0 text-xs font-medium',
            task.priority === 'high'
              ? 'text-rose-400'
              : task.priority === 'med'
                ? 'text-amber-400'
                : 'text-sky-400'
          ].join(' ')}
        >
          !{task.priority}
        </span>
      )}
    </div>
  )
}
