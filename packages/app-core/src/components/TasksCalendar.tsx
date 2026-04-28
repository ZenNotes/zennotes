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

interface Props {
  tasks: VaultTask[]
  today: Date
  onOpenTask: (task: VaultTask) => void
  onToggleTask: (task: VaultTask) => void
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

function buildMonthGrid(anchor: Date): Date[] {
  const first = firstOfMonth(anchor)
  // Walk back to the most recent Sunday (could be in the previous month).
  const start = addDays(first, -first.getDay())
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

function formatMonthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function TasksCalendar({ tasks, today, onOpenTask, onToggleTask }: Props): JSX.Element {
  const monthAnchorIso = useStore((s) => s.tasksCalendarMonthAnchor)
  const setMonthAnchor = useStore((s) => s.setTasksCalendarMonthAnchor)
  const selectedDateIso = useStore((s) => s.tasksCalendarSelectedDate)
  const setSelectedDate = useStore((s) => s.setTasksCalendarSelectedDate)
  const rootRef = useRef<HTMLDivElement>(null)

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
      const active = document.activeElement as HTMLElement | null
      if (active) {
        const tag = active.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
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
          if (selectedTasks.length > 0) onOpenTask(selectedTasks[0])
          return
        default:
          return
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
    // We deliberately re-bind on every relevant change so the closure
    // sees the latest selection / month / cells.
  }, [cells, monthAnchor, selectedDate, selectedTasks, onOpenTask])

  const focusedTaskRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    focusedTaskRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIso])

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
        <div className="text-[11px] text-current/40">
          h/j/k/l move · [ ] month · gt today · Enter open
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-7 px-3 pt-2 text-[10px] uppercase tracking-wide text-current/40">
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
          const overdueCount = cellTasks.filter((t) => isTaskOverdue(t, today)).length
          return (
            <button
              type="button"
              key={cellIso}
              onClick={() => {
                setSelectedDate(cellIso)
                if (isOtherMonth) setMonthAnchor(toIsoDateLocal(firstOfMonth(cell)))
              }}
              className={[
                'flex h-16 flex-col items-stretch gap-1 px-1.5 py-1 text-left text-xs transition-colors',
                isOtherMonth ? 'bg-paper-100/40 text-current/35' : 'bg-paper-100/85 text-current/80',
                isSelected
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
                  <span className="rounded bg-paper-300/60 px-1 text-[9px] text-current/60">
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
                    <span className="text-[9px] text-current/50">+{cellTasks.length - 6}</span>
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
          <span className="text-[11px] text-current/40">
            {selectedTasks.length} task{selectedTasks.length === 1 ? '' : 's'}
          </span>
        </div>
        {selectedTasks.length === 0 ? (
          <div className="rounded-md border border-dashed border-paper-300/60 px-3 py-4 text-center text-xs text-current/50">
            Nothing scheduled. Add{' '}
            <code className="rounded bg-paper-300/60 px-1">due:{selectedIso}</code> to a task to see
            it here.
          </div>
        ) : (
          <div className="space-y-1">
            {selectedTasks.map((task, i) => (
              <CalendarTaskRow
                key={task.id}
                task={task}
                isOverdue={isTaskOverdue(task, today)}
                buttonRef={i === 0 ? focusedTaskRef : null}
                onToggle={() => onToggleTask(task)}
                onOpen={() => onOpenTask(task)}
              />
            ))}
          </div>
        )}

        {unscheduled.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-current/50 hover:text-current/80">
              {unscheduled.length} task{unscheduled.length === 1 ? '' : 's'} without a due date
            </summary>
            <div className="mt-2 space-y-1">
              {unscheduled.map((task) => (
                <CalendarTaskRow
                  key={task.id}
                  task={task}
                  isOverdue={false}
                  onToggle={() => onToggleTask(task)}
                  onOpen={() => onOpenTask(task)}
                />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  )
}

interface RowProps {
  task: VaultTask
  isOverdue: boolean
  buttonRef?: React.RefObject<HTMLButtonElement> | null
  onToggle: () => void
  onOpen: () => void
}

function CalendarTaskRow({ task, isOverdue, buttonRef, onToggle, onOpen }: RowProps): JSX.Element {
  return (
    <button
      type="button"
      ref={buttonRef ?? undefined}
      onClick={onOpen}
      className={[
        'flex w-full items-center gap-2 rounded-md border-l-2 px-2 py-1 text-left text-sm',
        isOverdue ? 'border-rose-500/70' : 'border-transparent',
        'hover:bg-paper-200/60'
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
        {task.content || '(empty task)'}
      </span>
      <span className="shrink-0 truncate text-[11px] text-current/45">{task.noteTitle}</span>
      {task.priority && (
        <span
          className={[
            'shrink-0 text-[11px] font-medium',
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
    </button>
  )
}
