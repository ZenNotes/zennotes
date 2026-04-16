import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isTasksViewActive, useStore } from '../store'
import type { VaultTask } from '@shared/tasks'
import { computeTasksRender, isOverdue } from '../lib/tasks-filter'
import { TasksRow } from './TasksRow'
import { CheckSquareIcon } from './icons'
import { advanceSequence, getKeymapBinding, matchesSequenceToken } from '../lib/keymaps'

type GroupKey = 'today' | 'upcoming' | 'waiting' | 'done'

const GROUP_LABELS: Record<GroupKey, string> = {
  today: 'Today',
  upcoming: 'Upcoming',
  waiting: 'Waiting',
  done: 'Done'
}

export function TasksView(): JSX.Element {
  const tasks = useStore((s) => s.vaultTasks)
  const loading = useStore((s) => s.tasksLoading)
  const filter = useStore((s) => s.tasksFilter)
  const cursorIndex = useStore((s) => s.taskCursorIndex)
  const setFilter = useStore((s) => s.setTasksFilter)
  const setCursorIndex = useStore((s) => s.setTaskCursorIndex)
  const refreshTasks = useStore((s) => s.refreshTasks)
  const openTaskAt = useStore((s) => s.openTaskAt)
  const toggleTaskFromList = useStore((s) => s.toggleTaskFromList)
  const closeTasksView = useStore((s) => s.closeTasksView)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
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

  // Scroll the cursor row into view when it moves.
  useEffect(() => {
    if (!currentTask) return
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-task-row="${cssEscape(currentTask.id)}"]`
    )
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [currentTask])

  const moveCursor = useCallback(
    (delta: number) => {
      if (taskRowIndices.length === 0) return
      const next = Math.max(0, Math.min(taskRowIndices.length - 1, safeCursor + delta))
      setCursorIndex(next)
    },
    [safeCursor, setCursorIndex, taskRowIndices.length]
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
    [closeTasksView, refreshTasks]
  )

  // Local keyboard handler — fires only while this Tasks panel is the
  // *active* one (relevant when split into multiple panes). Registered in
  // the CAPTURE phase and uses `stopImmediatePropagation` so it beats
  // VimNav's global handler (which also listens in capture and otherwise
  // hijacks `j`/`k`/`gg`/`G` for sidebar navigation).
  useEffect(() => {
    if (!isActivePanel) return
    const handler = (e: KeyboardEvent): void => {
      const active = document.activeElement as HTMLElement | null
      if (active) {
        const tag = active.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const key = e.key
      const overrides = keymapOverrides
      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }

      if (key === 'Escape') {
        if (filter) {
          consume()
          setFilter('')
          return
        }
        consume()
        closeTasksView()
        return
      }

      if (matchesSequenceToken(e, overrides, 'nav.filter')) {
        consume()
        filterRef.current?.focus()
        filterRef.current?.select()
        return
      }

      if (matchesSequenceToken(e, overrides, 'nav.localEx')) {
        consume()
        setExValue('')
        setExOpen(true)
        // Focus after the input mounts.
        requestAnimationFrame(() => exRef.current?.focus())
        return
      }

      if (matchesSequenceToken(e, overrides, 'nav.moveDown') || key === 'ArrowDown') {
        consume()
        moveCursor(1)
        return
      }
      if (matchesSequenceToken(e, overrides, 'nav.moveUp') || key === 'ArrowUp') {
        consume()
        moveCursor(-1)
        return
      }
      if (matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
        consume()
        setCursorIndex(taskRowIndices.length - 1)
        return
      }
      if (
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

      if ((key === 'Enter' || matchesSequenceToken(e, overrides, 'nav.openResult')) && currentTask) {
        consume()
        void openTaskAt(currentTask)
        return
      }
      if ((key === ' ' || matchesSequenceToken(e, overrides, 'nav.toggleTask')) && currentTask) {
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
    setCursorIndex,
    taskRowIndices.length,
    currentTask,
    keymapOverrides,
    openTaskAt,
    toggleTaskFromList,
    closeTasksView,
    setFilter
  ])

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900"
    >
      <div className="flex items-center gap-2 border-b border-current/10 px-4 py-3">
        <CheckSquareIcon width={18} height={18} />
        <h1 className="text-sm font-semibold">Tasks</h1>
        <span className="ml-2 rounded bg-current/10 px-1.5 py-0.5 text-[11px] text-current/60">
          {tasks.length} total
        </span>
        {loading && <span className="text-[11px] text-current/50">scanning…</span>}
        <div className="ml-auto flex items-center gap-2">
          <input
            ref={filterRef}
            type="text"
            placeholder="Filter…  /  to focus"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                if (filter) setFilter('')
                else e.currentTarget.blur()
              }
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              }
            }}
            className="w-56 rounded-md border border-current/15 bg-current/5 px-2 py-1 text-xs outline-none focus:border-current/30"
          />
          <button
            type="button"
            onClick={() => void refreshTasks()}
            className="rounded-md px-2 py-1 text-xs text-current/70 hover:bg-current/10"
            title="Rescan vault"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={closeTasksView}
            className="rounded-md px-2 py-1 text-xs text-current/70 hover:bg-current/10"
            title="Close (:q or Esc)"
          >
            Close
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {render.rows.length === 0 && !loading && (
          <div className="px-6 py-10 text-center text-sm text-current/50">
            No tasks found. Add <code className="rounded bg-current/10 px-1">- [ ] …</code> lines in any note to see them here.
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
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-current/60 hover:bg-current/5"
                >
                  <span className="w-3">{isCollapsed ? '▸' : '▾'}</span>
                  <span>{GROUP_LABELS[key]}</span>
                  <span className="text-current/40">{row.count ?? 0}</span>
                  {key === 'today' && row.overdueCount ? (
                    <span className="ml-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-300">
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
            />
          )
        })}
      </div>

      {exOpen ? (
        <form
          className="flex items-center gap-1 border-t border-current/10 px-4 py-1.5 font-mono text-xs"
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
        <div className="border-t border-current/10 px-4 py-1.5 text-[11px] text-current/40">
          j/k move · Enter/o open · Space/x toggle · / filter · : command · Esc close
        </div>
      )}
    </div>
  )
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}
