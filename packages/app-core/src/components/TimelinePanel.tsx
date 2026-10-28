/**
 * Right-side Timeline panel (#1007): every open, dated task in the vault on
 * one rail, in date order. Overdue work sits on top in the danger color,
 * today is the accent ring, each later day with work gets a node, and a run
 * of empty days folds into one quiet line. A task tagged `#milestone` draws
 * as a diamond and says how much open work stands before it.
 *
 * The rail itself is pure (lib/timeline-rail) and takes its rules from the
 * Tasks surfaces: the same display filter, the same daily-note date inference
 * the calendar panel uses, the same filter syntax, `groupTasks` for which
 * tasks are live and `isOverdue` for lateness. This file only draws it and
 * gives it a keyboard.
 *
 * Keys: with Vim on, j/k move, gg/G jump, x ticks, m opens the task menu, /
 * focuses the filter; with Vim off only the arrows, Home/End, Enter and
 * Escape act, as in every list. Enter opens the task's line and Escape (or
 * Left) hands the keyboard back to the editor. The handler is the section's
 * own onKeyDown, so it runs after VimNav's window capture handler, which
 * stands down for this panel except for Ctrl+W and the leader.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NoteMeta } from '@shared/ipc'
import { filterTasksForDisplay, inferDailyTaskDueDates, type VaultTask } from '@shared/tasks'
import { useStore } from '../store'
import { buildDailyNoteDateByPath } from '../lib/vault-layout'
import { filterTasks, noteTagsByPath } from '../lib/tasks-filter'
import {
  buildTimelineRail,
  timelineDayLabel,
  type TimelineEntry,
  type TimelineRange,
  type TimelineRow
} from '../lib/timeline-rail'
import {
  getKeymapDisplay,
  getSequenceTokens,
  isChordEvent,
  matchesSequenceToken,
  sequenceTokenFromEvent,
  type KeymapId
} from '../lib/keymaps'
import { listViewBindingMatches, listViewKey, listViewYieldsKey } from '../lib/list-view-keys'
import { isOverlayOrDialogOpen } from '../lib/overlay-open'
import { buildTaskMenuItems } from '../lib/task-context-menu'
import { taskTail } from '../lib/task-tail'
import { priorityClass, priorityLabel } from '../lib/task-priority'
import { InlineMarkdown } from '../lib/inline-markdown'
import { usePanelResize } from '../lib/use-panel-resize'
import { PanelResizeHandle } from './PanelResizeHandle'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { LazyNoteHoverPreview as NoteHoverPreview } from './LazyNoteHoverPreview'
import { TaskStateBox } from './TaskStateBox'
import { CloudTaskConflictIndicator } from './CloudTaskConflictIndicator'
import { Button } from './ui/Button'

const HOVER_DELAY_MS = 280
// Every action the panel answers, so a chord bound to one reaches it.
const TIMELINE_PANEL_ACTIONS: readonly KeymapId[] = [
  'nav.moveDown',
  'nav.moveUp',
  'nav.contextMenu',
  'nav.toggleTask',
  'nav.filter',
  'nav.jumpBottom',
  'nav.jumpTop'
]
/** How long the rail's task list counts as fresh after the panel closes. A
 *  pane remounts its panels while a newly opened note loads, and a full vault
 *  scan on each of those would be waste; past this, edits made while no task
 *  surface was on screen may have been missed, so the panel rescans. */
const RESCAN_AFTER_MS = 5000
let lastShownAt = 0

const RANGE_BUTTONS: ReadonlyArray<{ id: TimelineRange; label: string }> = [
  { id: 'two-weeks', label: '2 weeks' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All' }
]

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** Today, rolled over at midnight, so a panel left open overnight moves its
 *  Today node and recounts what is late. */
function useToday(): Date {
  const [today, setToday] = useState(startOfToday)
  useEffect(() => {
    const now = new Date()
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const timer = setTimeout(() => setToday(startOfToday()), tomorrow.getTime() - now.getTime() + 1000)
    return () => clearTimeout(timer)
  }, [today])
  return today
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function TimelinePanel({
  fitWidth
}: {
  /** Width to render at when the pane has less room than the width the user
   *  chose; see lib/side-panel-fit. (#805) */
  fitWidth?: number
}): JSX.Element {
  const notes = useStore((s) => s.notes)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const vaultTasks = useStore((s) => s.vaultTasks)
  const tasksLoading = useStore((s) => s.tasksLoading)
  const showArchivedTasks = useStore((s) => s.showArchivedTasks)
  const vimMode = useStore((s) => s.vimMode)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const range = useStore((s) => s.timelineRange)
  const setRange = useStore((s) => s.setTimelineRange)
  const filter = useStore((s) => s.timelineFilter)
  const setFilter = useStore((s) => s.setTimelineFilter)
  const toggleTaskFromList = useStore((s) => s.toggleTaskFromList)
  const openTaskAt = useStore((s) => s.openTaskAt)
  const applyTaskMutation = useStore((s) => s.applyTaskMutation)
  const openTasksView = useStore((s) => s.openTasksView)
  const width = useStore((s) => s.panelWidths.timeline)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const { startResize } = usePanelResize(fitWidth ?? width, (px) => setPanelWidth('timeline', px))
  const today = useToday()

  // The same task list every Tasks surface starts from: archived notes out
  // unless asked for, and a daily note's undated tasks due on its date,
  // exactly as the calendar panel infers them.
  const dueByPath = useMemo(
    () => buildDailyNoteDateByPath(notes, vaultSettings),
    [notes, vaultSettings]
  )
  const tasks = useMemo(
    () => inferDailyTaskDueDates(filterTasksForDisplay(vaultTasks, showArchivedTasks), dueByPath),
    [vaultTasks, showArchivedTasks, dueByPath]
  )
  // A file task also matches the tags written in its note's body (#1008).
  const noteTags = useMemo(() => noteTagsByPath(notes), [notes])
  const filtered = useMemo(() => filterTasks(tasks, filter, noteTags), [tasks, filter, noteTags])
  const rail = useMemo(
    () => buildTimelineRail(filtered, { today, range, noteTags }),
    [filtered, today, range, noteTags]
  )
  const notesByPath = useMemo(() => new Map(notes.map((n) => [n.path, n])), [notes])

  // The watcher keeps the task list fresh only while a task surface is on
  // screen (this panel is one), so a panel that has been closed for a while
  // reads the vault again as it opens.
  useEffect(() => {
    const s = useStore.getState()
    const fresh = Date.now() - lastShownAt < RESCAN_AFTER_MS
    if (!s.tasksLoading && (s.vaultTasks.length === 0 || !fresh)) void s.refreshTasks()
    return () => {
      lastShownAt = Date.now()
    }
  }, [])

  const panelRef = useRef<HTMLElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const [cursor, setCursor] = useState(0)
  const cursorIdx = Math.min(cursor, Math.max(0, rail.rows.length - 1))
  const panelFocused = focusedPanel === 'timeline'

  // Keyboard focus follows the Calendar panel's rules (#285): take DOM focus
  // when this becomes the focused panel (pane navigation, leader n), and hand
  // it back to the editor when the panel goes away while it holds it.
  useEffect(() => {
    const panel = panelRef.current
    if (focusedPanel !== 'timeline' || !panel) return
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
  }, [focusedPanel])
  useLayoutEffect(
    () => () => {
      const s = useStore.getState()
      const hadFocus = !!panelRef.current?.contains(document.activeElement)
      if (s.focusedPanel === 'timeline') s.setFocusedPanel('editor')
      if (hadFocus) requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
    },
    []
  )
  // The pane claims focusedPanel 'editor' for any click or focus inside it;
  // claiming it back on the panel's own capture handlers (which run after the
  // pane's) keeps this panel's keys alive after a click.
  const claimFocus = useCallback(() => {
    if (useStore.getState().focusedPanel !== 'timeline') setFocusedPanel('timeline')
  }, [setFocusedPanel])

  useEffect(() => {
    if (!panelFocused) return
    panelRef.current
      ?.querySelector(`[data-timeline-row="${cursorIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursorIdx, panelFocused])

  // --- Hover preview -------------------------------------------------------
  const [hover, setHover] = useState<{
    meta: NoteMeta
    rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>
  } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    setHover(null)
  }, [])
  const armHover = useCallback(
    (el: HTMLElement, task: VaultTask) => {
      const meta = notesByPath.get(task.sourcePath)
      if (!meta) return
      // Beside the panel, level with the row, as the calendar places it, so
      // the preview never covers the rows the pointer moves on to.
      const row = el.getBoundingClientRect()
      const edge = panelRef.current?.getBoundingClientRect().left ?? row.left
      const rect = { left: edge, right: edge, width: 0, top: row.top, bottom: row.bottom, height: row.height }
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      hoverTimer.current = setTimeout(() => setHover({ meta, rect }), HOVER_DELAY_MS)
    },
    [notesByPath]
  )
  useEffect(() => clearHover, [clearHover])

  // --- Inline edit and the task menu ----------------------------------------
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const cancelEditRef = useRef(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const openMenuAt = useCallback(
    (x: number, y: number, task: VaultTask) => {
      clearHover()
      setMenu({
        x,
        y,
        items: buildTaskMenuItems(task, {
          today,
          // Only x of the task keys works here, so the menu names none, as
          // the calendar panel's does.
          showKeyHints: false,
          onEdit: () => {
            setEditingTaskId(task.id)
            setEditValue(taskTail(task))
          }
        })
      })
    },
    [clearHover, today]
  )
  const closeMenu = useCallback(() => setMenu(null), [])

  const focusEditor = useCallback(() => {
    const s = useStore.getState()
    s.setFocusedPanel('editor')
    s.editorViewRef?.focus()
  }, [])

  // --- Keyboard ------------------------------------------------------------
  const gPending = useRef(false)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(gTimer.current), [])

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const panel = panelRef.current
    const target = event.target as HTMLElement
    // Portaled children (the task menu) bubble here through React's tree; only
    // keys aimed at the panel's own DOM are ours.
    if (!panel || !(target instanceof HTMLElement) || !panel.contains(target)) return
    if (event.defaultPrevented) return
    if (isOverlayOrDialogOpen() || document.querySelector('[data-vim-hint-overlay]')) return
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return
    }
    const native = event.nativeEvent
    // A chord gets through only as the key of one of the panel's actions,
    // and never past a global shortcut (#972, lib/list-view-keys.ts).
    if (listViewYieldsKey(native, keymapOverrides, TIMELINE_PANEL_ACTIONS, vimMode)) return
    // Empty for a chord, so the hard-coded keys below never answer one.
    const key = listViewKey(native)
    // A focused control keeps its own Enter and Space.
    const onControl = target !== panel && !!target.closest('button, a, [role="checkbox"]')
    if (onControl && (key === 'Enter' || key === ' ')) return
    // With Vim off the single-character keys are not the panel's: arrows,
    // Home/End, Enter and Escape are universal, the letters belong to Vim. A
    // chord bound to one of the panel's actions works in either mode.
    if (!vimMode && !isChordEvent(native) && key.length === 1) return

    const rows = rail.rows
    const current: TimelineRow | undefined = rows[cursorIdx]
    const consume = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    const move = (to: number): void => {
      if (rows.length === 0) return
      setCursor(Math.max(0, Math.min(rows.length - 1, to)))
    }

    if (key === 'Escape' || key === 'ArrowLeft') {
      consume()
      focusEditor()
      return
    }
    if (key === 'ArrowDown' || listViewBindingMatches(native, keymapOverrides, 'nav.moveDown', vimMode)) {
      consume()
      move(cursorIdx + 1)
      return
    }
    if (key === 'ArrowUp' || listViewBindingMatches(native, keymapOverrides, 'nav.moveUp', vimMode)) {
      consume()
      move(cursorIdx - 1)
      return
    }
    if (key === 'Home' || key === 'End') {
      consume()
      move(key === 'Home' ? 0 : rows.length - 1)
      return
    }
    if (key === 'Enter') {
      consume()
      if (current) void openTaskAt(current.task)
      return
    }
    if (
      (event.shiftKey && key === 'F10') ||
      key === 'ContextMenu' ||
      listViewBindingMatches(native, keymapOverrides, 'nav.contextMenu', vimMode)
    ) {
      consume()
      if (!current) return
      const row = panel.querySelector(`[data-timeline-row="${cursorIdx}"]`)?.getBoundingClientRect()
      openMenuAt(row ? row.left + 24 : 0, row ? row.bottom : 0, current.task)
      return
    }
    if (!vimMode && !isChordEvent(native)) return

    if (matchesSequenceToken(native, keymapOverrides, 'nav.toggleTask')) {
      consume()
      if (current) void toggleTaskFromList(current.task)
      return
    }
    if (matchesSequenceToken(native, keymapOverrides, 'nav.filter')) {
      consume()
      filterRef.current?.focus()
      return
    }
    if (matchesSequenceToken(native, keymapOverrides, 'nav.jumpBottom')) {
      consume()
      move(rows.length - 1)
      return
    }
    // `g g`, or whatever two-key sequence nav.jumpTop is bound to.
    const top = getSequenceTokens(keymapOverrides, 'nav.jumpTop')
    const token = sequenceTokenFromEvent(native)
    if (top.length === 1 && token === top[0]) {
      consume()
      move(0)
      return
    }
    if (top.length === 2) {
      if (gPending.current && token === top[1]) {
        consume()
        gPending.current = false
        clearTimeout(gTimer.current)
        move(0)
        return
      }
      if (token === top[0]) {
        consume()
        gPending.current = true
        clearTimeout(gTimer.current)
        gTimer.current = setTimeout(() => (gPending.current = false), 600)
        return
      }
    }
  }

  // --- Drawing -------------------------------------------------------------
  const toggleKey = vimMode ? getKeymapDisplay(keymapOverrides, 'nav.toggleTask') || null : null
  const rowIndex = useMemo(() => new Map(rail.rows.map((row, i) => [row.task.id, i])), [rail.rows])

  const renderRow = (row: TimelineRow): JSX.Element => {
    const { task } = row
    const index = rowIndex.get(task.id) ?? -1
    if (editingTaskId === task.id) {
      return (
        <div key={task.id} className="flex items-center gap-2 py-1 pl-2 pr-1">
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
              panelRef.current?.focus({ preventScroll: true })
            }}
            className="min-w-0 flex-1 rounded border border-accent/60 bg-paper-100 px-1 py-0.5 text-xs outline-none"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      )
    }
    const isCursor = panelFocused && index === cursorIdx
    return (
      <div
        key={task.id}
        data-timeline-row={index}
        data-timeline-task={task.id}
        data-timeline-milestone={row.milestone ? 'true' : undefined}
        onClick={() => {
          setCursor(index)
          clearHover()
          void openTaskAt(task)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setCursor(index)
          openMenuAt(e.clientX, e.clientY, task)
        }}
        onMouseEnter={(e) => armHover(e.currentTarget, task)}
        onMouseLeave={clearHover}
        className={[
          'flex cursor-pointer items-start gap-2 rounded-md py-1 pl-2 pr-1 transition-colors',
          isCursor ? 'vim-cursor' : row.milestone ? 'bg-accent/5 hover:bg-accent/10' : 'hover:bg-paper-200/60'
        ].join(' ')}
      >
        <TaskStateBox
          task={task}
          onToggle={() => void toggleTaskFromList(task)}
          toggleKey={toggleKey}
          // The muted ink the note title under it uses: the default 40% of
          // the text color all but vanishes on the light themes' paper.
          idleClassName="border border-ink-400 hover:bg-current/10"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <InlineMarkdown
              text={task.content || '(empty task)'}
              interactiveLinks={false}
              className={[
                'min-w-0 flex-1 truncate text-xs',
                row.milestone ? 'font-semibold text-ink-900' : 'text-ink-800'
              ].join(' ')}
            />
            {task.priority && (
              <span className={`shrink-0 text-2xs font-medium ${priorityClass(task.priority)}`}>
                {priorityLabel(task.priority)}
              </span>
            )}
            {row.lateDays > 0 && (
              <span
                data-timeline-late
                className="shrink-0 rounded bg-danger/15 px-1.5 py-px text-2xs font-medium text-danger"
              >
                {row.lateDays}d late
              </span>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-ink-400">
            <span className="truncate">{task.noteTitle}</span>
            {row.before !== null && (
              <span data-timeline-before className="shrink-0">
                · {plural(row.before, 'task', 'tasks')} before it
              </span>
            )}
            <CloudTaskConflictIndicator path={task.sourcePath} />
          </div>
        </div>
      </div>
    )
  }

  // A node sits on the rail line, which runs down the left edge at left-3.
  const node = (className: string): JSX.Element => (
    <span
      aria-hidden
      className={`absolute left-3 top-1/2 -translate-x-1/2 -translate-y-1/2 ${className}`}
    />
  )

  const renderEntry = (entry: TimelineEntry): JSX.Element => {
    if (entry.kind === 'quiet') {
      return (
        <div
          key={`quiet-${entry.afterIso}`}
          data-timeline-quiet={entry.days}
          className="py-1.5 pl-6 text-2xs italic text-ink-400"
        >
          {plural(entry.days, 'quiet day', 'quiet days')}
        </div>
      )
    }
    if (entry.kind === 'overdue') {
      return (
        <div key="overdue" data-timeline-overdue className="pb-1">
          <div className="relative flex h-6 items-center pl-6">
            {node('h-2 w-2 rounded-full bg-danger')}
            <span className="text-2xs font-semibold uppercase tracking-wide text-danger">
              Overdue · {entry.rows.length}
            </span>
          </div>
          <div className="space-y-0.5 pl-4">{entry.rows.map(renderRow)}</div>
        </div>
      )
    }
    const label = timelineDayLabel(entry.iso, today)
    return (
      <div key={entry.iso} data-timeline-day={entry.iso} className="pb-1">
        <div className="relative flex h-6 items-center pl-6">
          {entry.today
            ? node(
                entry.milestone
                  ? 'h-3 w-3 rotate-45 border-2 border-accent bg-paper-50'
                  : 'h-3 w-3 rounded-full border-2 border-accent bg-paper-50'
              )
            : entry.milestone
              ? node('h-2.5 w-2.5 rotate-45 bg-accent')
              : node('h-2 w-2 rounded-full bg-ink-400')}
          <span
            className={[
              'text-2xs font-semibold uppercase tracking-wide',
              entry.today ? 'text-accent' : entry.milestone ? 'text-ink-800' : 'text-ink-500'
            ].join(' ')}
          >
            {entry.today ? `Today · ${label}` : label}
            {entry.milestone && <span className="font-medium normal-case"> · milestone</span>}
          </span>
        </div>
        {entry.rows.length > 0 ? (
          <div className="space-y-0.5 pl-4">{entry.rows.map(renderRow)}</div>
        ) : (
          entry.today && <div className="py-1 pl-6 text-2xs text-ink-400">Nothing due today</div>
        )}
      </div>
    )
  }

  // Vim's keys only, so with Vim off nothing here names a key that does
  // nothing; an unbound action drops out rather than showing an empty chip.
  const display = (id: Parameters<typeof getKeymapDisplay>[1]): string =>
    getKeymapDisplay(keymapOverrides, id)
  const keyHints: Array<[string, string]> = vimMode
    ? (
        [
          [[display('nav.moveDown'), display('nav.moveUp')].filter(Boolean).join('/'), 'move'],
          [display('nav.toggleTask'), 'tick'],
          ['⏎', 'open'],
          [display('nav.contextMenu'), 'menu'],
          [display('nav.filter'), 'filter'],
          ['Esc', 'back']
        ] as Array<[string, string]>
      ).filter(([key]) => key !== '')
    : []
  const loadingFirstScan = tasksLoading && vaultTasks.length === 0

  return (
    <section
      ref={panelRef}
      data-timeline-panel
      aria-label="Timeline"
      tabIndex={0}
      style={{ width: fitWidth ?? width }}
      onMouseDownCapture={claimFocus}
      onFocusCapture={claimFocus}
      onKeyDown={onKeyDown}
      className="relative flex shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/18 outline-none"
    >
      <PanelResizeHandle onStart={startResize} />

      <div className="border-b border-paper-300/60 px-4 py-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-400">Timeline</div>
          <div data-timeline-count className="truncate text-2xs text-ink-500">
            {rail.openCount} open
            {rail.overdueCount > 0 && <span className="text-danger"> · {rail.overdueCount} overdue</span>}
          </div>
        </div>
        <div
          role="group"
          aria-label="How far ahead"
          className="mt-3 flex items-center gap-0.5 rounded-md bg-paper-200/60 p-0.5"
        >
          {RANGE_BUTTONS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              data-timeline-range={id}
              aria-pressed={range === id}
              onClick={() => setRange(id)}
              className={[
                'flex-1 whitespace-nowrap rounded px-2 py-1 text-xs transition-colors',
                range === id
                  ? 'bg-paper-50 text-ink-900 shadow-sm'
                  : 'text-ink-500 hover:bg-paper-200/60 hover:text-ink-800'
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          ref={filterRef}
          type="text"
          data-timeline-filter
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              if (filter) setFilter('')
              else panelRef.current?.focus({ preventScroll: true })
            } else if (e.key === 'Enter') {
              e.preventDefault()
              panelRef.current?.focus({ preventScroll: true })
            }
          }}
          placeholder="Filter: text, #tag, !high, @key:value"
          aria-label="Filter the timeline"
          className="mt-2 w-full rounded-md border border-paper-300/60 bg-paper-200/40 px-2 py-1 text-xs outline-none placeholder:text-ink-400 focus:border-accent/60"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loadingFirstScan ? (
          <div className="px-2 py-1 text-xs text-ink-400">Reading tasks…</div>
        ) : (
          <div className="relative">
            <span
              aria-hidden
              className="absolute bottom-0 left-3 top-3 w-px -translate-x-1/2 bg-paper-300"
            />
            {rail.entries.map(renderEntry)}
          </div>
        )}
      </div>

      {(rail.undatedCount > 0 || rail.laterCount > 0 || keyHints.length > 0) && (
        <div className="space-y-1 border-t border-paper-300/60 px-3 py-2">
          {(rail.undatedCount > 0 || rail.laterCount > 0) && (
            <div className="flex flex-wrap items-center gap-1">
              {rail.laterCount > 0 && rail.rangeEnd && (
                <Button
                  variant="ghost"
                  data-timeline-later
                  title="Show every dated task"
                  onClick={() => setRange('all')}
                >
                  {rail.laterCount} after {shortDate(rail.rangeEnd)}
                </Button>
              )}
              {rail.undatedCount > 0 && (
                <Button
                  variant="ghost"
                  data-timeline-undated
                  title="Open the Tasks view, where tasks with no date are listed"
                  onClick={() => void openTasksView()}
                >
                  {rail.undatedCount} undated in Tasks
                </Button>
              )}
            </div>
          )}
          {keyHints.length > 0 && (
            <div data-timeline-hints className="flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-ink-400">
              {keyHints.map(([key, label]) => (
                <span key={label}>
                  <kbd className="font-mono text-ink-500">{key}</kbd> {label}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {hover && <NoteHoverPreview note={hover.meta} anchorRect={hover.rect} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </section>
  )
}
