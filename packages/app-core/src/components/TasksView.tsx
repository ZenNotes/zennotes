import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isTasksViewActive, useStore, type TasksViewMode } from '../store'
import { inferDailyTaskDueDates, type VaultTask } from '@shared/tasks'
import { buildDailyNoteDateByPath } from '../lib/vault-layout'
import { computeTasksRender, isOverdue } from '../lib/tasks-filter'
import { TasksRow } from './TasksRow'
import { TasksCalendar } from './TasksCalendar'
import { TasksKanban } from './TasksKanban'
import { CalendarIcon, CheckSquareIcon, KanbanIcon, ListIcon } from './icons'
import { advanceSequence, getKeymapBinding, matchesSequenceToken } from '../lib/keymaps'
import { isImeComposing } from '../lib/ime'
import { isAppOverlayOpen } from '../lib/overlay-open'

type GroupKey = 'today' | 'upcoming' | 'waiting' | 'done'

const GROUP_LABELS: Record<GroupKey, string> = {
  today: 'Today',
  upcoming: 'Upcoming',
  waiting: 'Waiting',
  done: 'Done'
}

const VIEW_BUTTONS: Array<{
  id: TasksViewMode
  label: string
  shortcut: string
  Icon: typeof ListIcon
}> = [
  { id: 'list', label: 'List', shortcut: '1', Icon: ListIcon },
  { id: 'calendar', label: 'Calendar', shortcut: '2', Icon: CalendarIcon },
  { id: 'kanban', label: 'Kanban', shortcut: '3', Icon: KanbanIcon }
]

export function TasksView(): JSX.Element {
  const rawTasks = useStore((s) => s.vaultTasks)
  const notes = useStore((s) => s.notes)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const loading = useStore((s) => s.tasksLoading)
  const filter = useStore((s) => s.tasksFilter)
  const cursorIndex = useStore((s) => s.taskCursorIndex)
  const setFilter = useStore((s) => s.setTasksFilter)
  const setCursorIndex = useStore((s) => s.setTaskCursorIndex)
  const refreshTasks = useStore((s) => s.refreshTasks)
  const openTaskAt = useStore((s) => s.openTaskAt)
  const toggleTaskFromList = useStore((s) => s.toggleTaskFromList)
  const applyTaskMutation = useStore((s) => s.applyTaskMutation)
  const moveTaskToDate = useStore((s) => s.moveTaskToDate)
  const addTaskForDate = useStore((s) => s.addTaskForDate)
  const closeTasksView = useStore((s) => s.closeTasksView)
  const reorderTaskInNote = useStore((s) => s.reorderTaskInNote)

  // Tasks written inside a daily note inherit that note's date as an implicit
  // due date (a clean line, no `due:` token) so they appear on the calendar.
  // Done at the display layer so it works on desktop + web identically and
  // re-derives whenever notes/settings change. Explicit `due:` still wins.
  const dueByPath = useMemo(
    () => buildDailyNoteDateByPath(notes, vaultSettings),
    [notes, vaultSettings]
  )
  const tasks = useMemo(() => inferDailyTaskDueDates(rawTasks, dueByPath), [rawTasks, dueByPath])
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const vimMode = useStore((s) => s.vimMode)
  const viewMode = useStore((s) => s.tasksViewMode)
  const setViewMode = useStore((s) => s.setTasksViewMode)
  // Only the Tasks panel in the *active* pane should listen for j/k/etc.
  // Splits can show Tasks in multiple panes simultaneously; without this
  // gate every keypress would fire once per mounted panel.
  const isActivePanel = useStore(isTasksViewActive)

  // Collapse state is local — survives within a session but not across app
  // restarts. Done is collapsed by default because it's usually noise.
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({
    today: false,
    upcoming: false,
    waiting: false,
    done: true
  })

  const filterRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const exRef = useRef<HTMLInputElement>(null)
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()
  // After a manual reorder the rows re-sort; keep the cursor on the task that
  // moved so repeated Shift+J/K keep nudging the same one.
  const followTaskRef = useRef<string | null>(null)
  // Vim-style command line. Not backed by CodeMirror (Tasks has no CM
  // view) — just a tiny bottom-of-panel input that dispatches a handful
  // of ex commands.
  const [exOpen, setExOpen] = useState(false)
  const [exValue, setExValue] = useState('')

  // "Today" is computed once per render from the clock — stable enough for a
  // single view session. If the user leaves the view past midnight and comes
  // back, reopening the view is sufficient to refresh the anchor.
  const today = useMemo(() => new Date(), [])

  const render = useMemo(
    () => computeTasksRender(tasks, filter, today, collapsed),
    [tasks, filter, today, collapsed]
  )

  // Index-into-rows map for just the 'task' rows (what the cursor navigates).
  const taskRowIndices = useMemo(() => {
    const idxs: number[] = []
    render.rows.forEach((row, i) => {
      if (row.kind === 'task') idxs.push(i)
    })
    return idxs
  }, [render.rows])

  const safeCursor = Math.min(cursorIndex, Math.max(0, taskRowIndices.length - 1))
  const currentRowIdx = taskRowIndices[safeCursor] ?? -1
  const currentTask: VaultTask | undefined =
    currentRowIdx >= 0 && render.rows[currentRowIdx]?.kind === 'task'
      ? render.rows[currentRowIdx].task
      : undefined

  // On first mount, pull fresh if we have nothing yet.
  useEffect(() => {
    if (tasks.length === 0 && !loading) void refreshTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Scroll the cursor row into view when it moves (list mode only).
  useEffect(() => {
    if (viewMode !== 'list') return
    if (!currentTask) return
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-task-row="${cssEscape(currentTask.id)}"]`
    )
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [currentTask, viewMode])

  // Keep the cursor on a task that was just reordered. We match by
  // sourcePath + content, not id: a line move changes the task's index (and
  // therefore its `${path}#${index}` id), but its text stays the same.
  useEffect(() => {
    const key = followTaskRef.current
    if (!key) return
    followTaskRef.current = null
    const rowIdx = render.rows.findIndex(
      (r) => r.kind === 'task' && r.task != null && taskFollowKey(r.task) === key
    )
    if (rowIdx < 0) return
    const ti = taskRowIndices.indexOf(rowIdx)
    if (ti >= 0) setCursorIndex(ti)
  }, [render.rows, taskRowIndices, setCursorIndex])

  const moveCursor = useCallback(
    (delta: number) => {
      if (taskRowIndices.length === 0) return
      const next = Math.max(0, Math.min(taskRowIndices.length - 1, safeCursor + delta))
      setCursorIndex(next)
    },
    [safeCursor, setCursorIndex, taskRowIndices.length]
  )

  // Move the cursored task one slot up/down by swapping with its neighbor in
  // the same note — this rewrites the note's markdown line order, the single
  // source of truth. No-op at a group edge or a note boundary (can't move a
  // task line into a different file).
  const moveSelectedTask = useCallback(
    (delta: -1 | 1) => {
      if (viewMode !== 'list' || !currentTask) return
      const row = render.rows[currentRowIdx]
      if (!row || row.kind !== 'task') return
      const list = render.groups[row.group]
      const from = list.findIndex((t) => t.id === currentTask.id)
      const neighbor = from >= 0 ? list[from + delta] : undefined
      if (!neighbor || neighbor.sourcePath !== currentTask.sourcePath) return
      followTaskRef.current = taskFollowKey(currentTask)
      void reorderTaskInNote(currentTask, neighbor, delta < 0 ? 'before' : 'after')
    },
    [viewMode, currentTask, currentRowIdx, render.rows, render.groups, reorderTaskInNote]
  )

  // Drag-to-reorder: only within the same note (a task line can't move between
  // files), so cross-note drops are ignored.
  const reorderTaskByDrag = useCallback(
    (draggedId: string, targetId: string, position: 'before' | 'after') => {
      if (draggedId === targetId) return
      const keys: GroupKey[] = ['today', 'upcoming', 'waiting', 'done']
      for (const group of keys) {
        const list = render.groups[group]
        const dragged = list.find((t) => t.id === draggedId)
        const target = list.find((t) => t.id === targetId)
        if (dragged && target && dragged.sourcePath === target.sourcePath) {
          followTaskRef.current = taskFollowKey(dragged)
          void reorderTaskInNote(dragged, target, position)
          return
        }
      }
    },
    [render.groups, reorderTaskInNote]
  )

  const toggleGroup = useCallback((g: GroupKey) => {
    setCollapsed((prev) => ({ ...prev, [g]: !prev[g] }))
  }, [])

  const runExCommand = useCallback(
    (raw: string): void => {
      const cmd = raw.trim().replace(/^:/, '').toLowerCase()
      if (!cmd) return
      const store = useStore.getState()
      const path = store.selectedPath
      switch (cmd) {
        case 'q':
        case 'quit':
        case 'wq':
        case 'x':
          closeTasksView()
          return
        case 'w':
        case 'write':
          // Tasks aren't a file — silently succeed so `:w` isn't jarring.
          return
        case 'tasks':
          // Already here; no-op.
          return
        case 'h':
        case 'help':
          void store.openHelpView()
          return
        case 'refresh':
        case 'r':
          void refreshTasks()
          return
        case 'list':
        case 'ls':
          setViewMode('list')
          return
        case 'cal':
        case 'calendar':
          setViewMode('calendar')
          return
        case 'kan':
        case 'kanban':
        case 'board':
          setViewMode('kanban')
          return
        case 'sp':
        case 'split':
          if (path) {
            void store.splitPaneWithTab({
              targetPaneId: store.activePaneId,
              edge: 'bottom',
              path
            })
          }
          return
        case 'vs':
        case 'vsp':
        case 'vsplit':
          if (path) {
            void store.splitPaneWithTab({
              targetPaneId: store.activePaneId,
              edge: 'right',
              path
            })
          }
          return
        default:
          // Unknown command — stay silent rather than popping an alert.
          return
      }
    },
    [closeTasksView, refreshTasks, setViewMode]
  )

  // Window-level handler with two responsibilities:
  //   1. View-switcher shortcuts (1/2/3) — work in every sub-view.
  //   2. List-mode navigation (j/k/Enter/Space/g/G etc.) — only when
  //      the List sub-view is active. Calendar and Kanban have their
  //      own keyboard handlers in those components.
  // Registered in CAPTURE phase + uses `stopImmediatePropagation` so it
  // beats VimNav's global handler.
  useEffect(() => {
    if (!isActivePanel) return
    const handler = (e: KeyboardEvent): void => {
      // A modal/menu owns the keyboard while open — don't fire list shortcuts
      // through it. (songgenqing report)
      if (isAppOverlayOpen()) return
      // While the Vim hint overlay is open it owns the keyboard; don't let
      // task navigation (or Esc closing the view) steal its keys. (#151)
      if (document.querySelector('[data-vim-hint-overlay]')) return
      const active = document.activeElement as HTMLElement | null
      if (active) {
        const tag = active.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const key = e.key
      const overrides = keymapOverrides
      // When Vim mode is off, the single-key Vim shortcuts (j/k/gg/G/o/Space/1-3/…)
      // are disabled — only arrows/Enter/Escape navigate. (songgenqing report)
      const seq = (id: Parameters<typeof matchesSequenceToken>[2]): boolean =>
        vimMode && matchesSequenceToken(e, overrides, id)
      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }

      if (key === 'Escape') {
        // Tasks is a tab like a note tab — Esc clears an active filter but must
        // never close the tab (other tabs don't close on Esc). Close with :q,
        // the header ✕, or ⌘W. (#151)
        consume()
        if (filter) setFilter('')
        return
      }

      // View switcher works regardless of sub-view (Vim mode only).
      if (vimMode && key === '1') {
        consume()
        setViewMode('list')
        return
      }
      if (vimMode && key === '2') {
        consume()
        setViewMode('calendar')
        return
      }
      if (vimMode && key === '3') {
        consume()
        setViewMode('kanban')
        return
      }

      if (seq('nav.filter')) {
        consume()
        filterRef.current?.focus()
        filterRef.current?.select()
        return
      }

      if (seq('nav.localEx')) {
        consume()
        setExValue('')
        setExOpen(true)
        // Focus after the input mounts.
        requestAnimationFrame(() => exRef.current?.focus())
        return
      }

      // List-mode-only navigation. Calendar and Kanban have their own.
      if (viewMode !== 'list') return

      if (seq('nav.moveDown') || key === 'ArrowDown') {
        consume()
        moveCursor(1)
        return
      }
      if (seq('nav.moveUp') || key === 'ArrowUp') {
        consume()
        moveCursor(-1)
        return
      }
      // Task reorder works whether or not Vim mode is on (Shift+J/K are an
      // explicit action chord, not a single-key list shortcut), so match the
      // binding directly rather than through the Vim-gated `seq` helper.
      if (matchesSequenceToken(e, overrides, 'tasks.moveTaskUp')) {
        consume()
        moveSelectedTask(-1)
        return
      }
      if (matchesSequenceToken(e, overrides, 'tasks.moveTaskDown')) {
        consume()
        moveSelectedTask(1)
        return
      }
      if (seq('nav.jumpBottom')) {
        consume()
        setCursorIndex(taskRowIndices.length - 1)
        return
      }
      if (
        vimMode &&
        advanceSequence(
          e,
          getKeymapBinding(overrides, 'nav.jumpTop'),
          gPending,
          gTimer,
          () => setCursorIndex(0),
          consume,
          500
        )
      ) {
        return
      }

      if ((key === 'Enter' || seq('nav.openResult')) && currentTask) {
        consume()
        void openTaskAt(currentTask)
        return
      }
      if (((vimMode && key === ' ') || seq('nav.toggleTask')) && currentTask) {
        consume()
        void toggleTaskFromList(currentTask)
        return
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [
    isActivePanel,
    filter,
    moveCursor,
    moveSelectedTask,
    setCursorIndex,
    taskRowIndices.length,
    currentTask,
    keymapOverrides,
    vimMode,
    openTaskAt,
    toggleTaskFromList,
    closeTasksView,
    setFilter,
    viewMode,
    setViewMode
  ])

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900"
    >
      <div className="flex items-center gap-2 border-b border-paper-300/45 px-4 py-3">
        <CheckSquareIcon width={18} height={18} />
        <h1 className="text-sm font-semibold">Tasks</h1>
        <span className="ml-2 rounded bg-paper-300/60 px-1.5 py-0.5 text-xs text-current/60">
          {tasks.length} total
        </span>
        {loading && <span className="text-xs text-current/50">scanning…</span>}

        <div className="ml-2 flex items-center gap-0.5 rounded-md bg-paper-200/60 p-0.5">
          {VIEW_BUTTONS.map(({ id, label, shortcut, Icon }) => {
            const isActive = viewMode === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setViewMode(id)}
                title={`${label} (${shortcut})`}
                className={[
                  'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
                  isActive
                    ? 'bg-paper-50 text-current/90 shadow-sm'
                    : 'text-current/55 hover:bg-paper-200/60 hover:text-current/85'
                ].join(' ')}
              >
                <Icon width={13} height={13} />
                <span className="hidden sm:inline">{label}</span>
              </button>
            )
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {viewMode === 'list' && (
            <input
              ref={filterRef}
              type="text"
              placeholder="Filter…  /  to focus"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                // While composing (IME), let the input own Enter/Arrows. (#183)
                if (isImeComposing(e)) return
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  if (filter) setFilter('')
                  else e.currentTarget.blur()
                }
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                }
              }}
              className="w-56 rounded-md border border-paper-300/60 bg-paper-200/60 px-2 py-1 text-xs outline-none focus:border-paper-400/70"
            />
          )}
          <button
            type="button"
            onClick={() => void refreshTasks()}
            className="rounded-md px-2 py-1 text-xs text-current/70 hover:bg-paper-200/80"
            title="Rescan vault"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={closeTasksView}
            className="rounded-md px-2 py-1 text-xs text-current/70 hover:bg-paper-200/80"
            title="Close (:q or Esc)"
          >
            Close
          </button>
        </div>
      </div>

      {viewMode === 'list' && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {render.rows.length === 0 && !loading && (
            <div className="px-6 py-10 text-center text-sm text-current/50">
              No tasks found. Add <code className="rounded bg-paper-300/60 px-1">- [ ] …</code> lines in any note to see them here.
            </div>
          )}
          {render.rows.map((row, idx) => {
            if (row.kind === 'header') {
              const key = row.group
              const isCollapsed = collapsed[key]
              return (
                <div key={`hdr-${key}`} className="mt-3 first:mt-1">
                  <button
                    type="button"
                    onClick={() => toggleGroup(key)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-current/60 hover:bg-paper-200/60"
                  >
                    <span className="w-3">{isCollapsed ? '▸' : '▾'}</span>
                    <span>{GROUP_LABELS[key]}</span>
                    <span className="text-current/40">{row.count ?? 0}</span>
                    {key === 'today' && row.overdueCount ? (
                      <span className="ml-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-2xs font-medium text-rose-300">
                        {row.overdueCount} overdue
                      </span>
                    ) : null}
                  </button>
                </div>
              )
            }
            const task = row.task!
            const overdue = isOverdue(task, today)
            return (
              <TasksRow
                key={task.id}
                task={task}
                isOverdue={overdue}
                isCursor={idx === currentRowIdx}
                onToggle={() => void toggleTaskFromList(task)}
                onOpen={() => void openTaskAt(task)}
                onFocusRow={() => {
                  const ti = taskRowIndices.indexOf(idx)
                  if (ti >= 0) setCursorIndex(ti)
                }}
                onReorder={reorderTaskByDrag}
              />
            )
          })}
        </div>
      )}

      {viewMode === 'calendar' && (
        <TasksCalendar
          tasks={tasks}
          today={today}
          onOpenTask={(task) => void openTaskAt(task)}
          onToggleTask={(task) => void toggleTaskFromList(task)}
          onRescheduleTask={(task, dueIso) =>
            void applyTaskMutation(task, { kind: 'set-due', due: dueIso })
          }
          onMoveTask={(task, dateIso) => void moveTaskToDate(task, dateIso)}
          onAddTask={(dateIso, text) => addTaskForDate(dateIso, text)}
          dailyNotesEnabled={vaultSettings.dailyNotes.enabled}
        />
      )}

      {viewMode === 'kanban' && (
        <TasksKanban
          tasks={tasks}
          today={today}
          onOpenTask={(task) => void openTaskAt(task)}
          onToggleTask={(task) => void toggleTaskFromList(task)}
        />
      )}

      {exOpen ? (
        <form
          className="flex items-center gap-1 border-t border-paper-300/45 px-4 py-1.5 font-mono text-xs"
          onSubmit={(e) => {
            e.preventDefault()
            runExCommand(exValue)
            setExOpen(false)
            setExValue('')
          }}
        >
          <span className="text-current/80">:</span>
          <input
            ref={exRef}
            autoFocus
            value={exValue}
            onChange={(e) => setExValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setExOpen(false)
                setExValue('')
              }
            }}
            onBlur={() => {
              setExOpen(false)
              setExValue('')
            }}
            className="flex-1 bg-transparent outline-none"
            spellCheck={false}
            autoComplete="off"
          />
        </form>
      ) : (
        <div className="border-t border-paper-300/45 px-4 py-1.5 text-xs text-current/40">
          {viewMode === 'list'
            ? 'j/k move · J/K reorder · drag to reorder · Enter/o open · Space/x toggle · / filter · :q close'
            : viewMode === 'calendar'
              ? 'h/j/k/l day · [ ] month · gt today · Tab pick · < > reschedule · drag to move · Enter open · :q'
              : 'h/l column · j/k card · Space toggle · Enter open · 1/2/3 view · : command · :q close'}
        </div>
      )}
    </div>
  )
}

/** Stable identity for cursor-follow across a reorder: a task's id encodes its
 *  index (which a line move changes), but sourcePath + content do not. */
function taskFollowKey(task: VaultTask): string {
  return `${task.sourcePath} ${task.content}`
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}
