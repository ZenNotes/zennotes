import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { NoteMeta } from '@shared/ipc'
import type { VaultTask } from '@shared/tasks'
import { useStore } from '../store'
import { computeTasksRender } from '../lib/tasks-filter'
import {
  ArrowUpRightIcon,
  CalendarIcon,
  CheckSquareIcon,
  DatabaseIcon,
  DocumentTextIcon,
  ExcalidrawIcon,
  NotePlusIcon,
  PanelLeftIcon,
  ZapIcon
} from './icons'

const MAX_RECENT = 5
const MAX_TASKS = 6

const NO_COLLAPSE = { today: false, upcoming: false, waiting: false, done: false }

function greetingFor(date: Date): string {
  const h = date.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

/** Compact "edited 3h ago" style stamp; falls back to a short date past a week. */
function timeAgo(ts: number, now: number): string {
  const mins = Math.round((now - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A light landing view shown when no note is open: the few most recently
 *  edited notes plus the open tasks for today. Keyboard: ↑/↓ (and j/k in vim
 *  mode) move between rows, Enter opens. */
export function HomeView({
  sidebarOpen,
  onShowSidebar
}: {
  sidebarOpen: boolean
  onShowSidebar: () => void
}): JSX.Element {
  const notes = useStore((s) => s.notes)
  const vaultTasks = useStore((s) => s.vaultTasks)
  const tasksLoading = useStore((s) => s.tasksLoading)
  const vimMode = useStore((s) => s.vimMode)
  const selectNote = useStore((s) => s.selectNote)
  const openTaskAt = useStore((s) => s.openTaskAt)
  const toggleTaskFromList = useStore((s) => s.toggleTaskFromList)
  const refreshTasks = useStore((s) => s.refreshTasks)
  const openTasksView = useStore((s) => s.openTasksView)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const createAndOpen = useStore((s) => s.createAndOpen)
  const createDatabase = useStore((s) => s.createDatabase)
  const createDrawingAndOpen = useStore((s) => s.createDrawingAndOpen)
  const openTodayDailyNote = useStore((s) => s.openTodayDailyNote)
  const openWeeklyNoteForDate = useStore((s) => s.openWeeklyNoteForDate)

  const containerRef = useRef<HTMLDivElement>(null)

  // Quick-create actions. Daily/weekly only appear when enabled in settings
  // (they default off), matching the command palette's gating.
  const actions = useMemo<Array<{ label: string; icon: JSX.Element; run: () => void }>>(() => {
    const list: Array<{ label: string; icon: JSX.Element; run: () => void }> = [
      {
        label: 'New note',
        icon: <NotePlusIcon width={15} height={15} />,
        run: () => void createAndOpen('inbox', '')
      },
      {
        label: 'Database',
        icon: <DatabaseIcon width={15} height={15} />,
        run: () => void createDatabase('inbox', '')
      },
      {
        label: 'Drawing',
        icon: <ExcalidrawIcon width={15} height={15} />,
        run: () => void createDrawingAndOpen('inbox', '')
      }
    ]
    if (vaultSettings?.dailyNotes?.enabled) {
      list.push({
        label: 'Daily note',
        icon: <CalendarIcon width={15} height={15} />,
        run: () => void openTodayDailyNote()
      })
    }
    if (vaultSettings?.weeklyNotes?.enabled) {
      list.push({
        label: 'Weekly note',
        icon: <CalendarIcon width={15} height={15} />,
        run: () => void openWeeklyNoteForDate(new Date())
      })
    }
    return list
  }, [
    vaultSettings?.dailyNotes?.enabled,
    vaultSettings?.weeklyNotes?.enabled,
    createAndOpen,
    createDatabase,
    createDrawingAndOpen,
    openTodayDailyNote,
    openWeeklyNoteForDate
  ])

  // Tasks are scanned lazily (normally on first Tasks-view open), so the home
  // view kicks off its own scan when it has nothing yet. The view re-renders
  // from the store once `vaultTasks` lands.
  useEffect(() => {
    if (vaultTasks.length === 0 && !tasksLoading) void refreshTasks()
    // Intentionally mount-only: re-running on every task change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One clock read per mount drives both the greeting and the relative stamps.
  const now = useMemo(() => Date.now(), [])

  const recent = useMemo<NoteMeta[]>(
    () =>
      notes
        .filter((n) => n.folder !== 'trash' && n.folder !== 'archive')
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_RECENT),
    [notes]
  )

  const { today, overdueCount } = useMemo(() => {
    const render = computeTasksRender(vaultTasks, '', new Date(now), NO_COLLAPSE)
    return { today: render.groups.today, overdueCount: render.groups.overdueCount }
  }, [vaultTasks, now])

  const visibleTasks = today.slice(0, MAX_TASKS)
  const hiddenTaskCount = today.length - visibleTasks.length

  // Focus the view on mount so keyboard navigation works without a click.
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  // Roving focus across the recent-note + task rows (`[data-home-item]`).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const down = e.key === 'ArrowDown' || (vimMode && e.key === 'j')
      const up = e.key === 'ArrowUp' || (vimMode && e.key === 'k')
      if (!down && !up) return
      const items = Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>('[data-home-item]') ?? []
      )
      if (items.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      const current = items.indexOf(document.activeElement as HTMLElement)
      let next: number
      if (current < 0) next = 0
      else if (down) next = Math.min(current + 1, items.length - 1)
      else next = Math.max(current - 1, 0)
      items[next]?.focus()
    },
    [vimMode]
  )

  const dateLine = new Date(now).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })

  return (
    <div
      ref={containerRef}
      data-home-nav
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto outline-none"
    >
      <div className="mx-auto w-full max-w-2xl px-6 py-14">
        <header className="mb-10 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
              {greetingFor(new Date(now))}
            </h1>
            <p className="mt-1 text-sm text-ink-400">{dateLine}</p>
          </div>
          {!sidebarOpen && (
            <button
              type="button"
              onClick={onShowSidebar}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-paper-300 bg-paper-100 px-3 py-1.5 text-xs font-medium text-ink-600 transition-colors hover:bg-paper-200"
            >
              <PanelLeftIcon width={14} height={14} />
              <span>Sidebar</span>
              <span className="font-mono text-ink-400">⌘1</span>
            </button>
          )}
        </header>

        <div className="mb-10 flex flex-wrap gap-2">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.run}
              className="inline-flex items-center gap-2 rounded-lg border border-paper-300/70 bg-paper-100/60 px-3 py-1.5 text-sm text-ink-700 transition-colors hover:border-paper-300 hover:bg-paper-200 hover:text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span className="text-ink-400">{action.icon}</span>
              {action.label}
            </button>
          ))}
        </div>

        <section className="mb-9">
          <SectionLabel icon={<ZapIcon width={13} height={13} />} text="Recent" />
          {recent.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5">
              {recent.map((note) => (
                <li key={note.path}>
                  <button
                    type="button"
                    data-home-item
                    onClick={() => void selectNote(note.path)}
                    className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-paper-200/60 focus:bg-paper-200/70 focus:outline-none"
                  >
                    <DocumentTextIcon
                      width={16}
                      height={16}
                      className="shrink-0 text-ink-400 group-hover:text-ink-600"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-800">
                      {note.title || 'Untitled'}
                    </span>
                    <span className="shrink-0 text-xs text-ink-400">
                      {timeAgo(note.updatedAt, now)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyHint text="No notes yet — create one to start writing." />
          )}
        </section>

        <section>
          <SectionLabel
            icon={<CheckSquareIcon width={13} height={13} />}
            text="Today"
            trailing={
              overdueCount > 0 ? (
                <span className="rounded-md bg-danger/10 px-1.5 py-0.5 text-xs font-medium text-danger">
                  {overdueCount} overdue
                </span>
              ) : null
            }
          />
          {visibleTasks.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5">
              {visibleTasks.map((task) => (
                <li
                  key={task.id}
                  className="group flex items-center gap-2.5 rounded-lg px-3 py-2 transition-colors hover:bg-paper-200/60"
                >
                  <button
                    type="button"
                    aria-label={task.checked ? 'Mark not done' : 'Mark done'}
                    onClick={() => void toggleTaskFromList(task)}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-paper-400 text-accent transition-colors hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    {task.checked && <CheckSquareIcon width={12} height={12} />}
                  </button>
                  <button
                    type="button"
                    data-home-item
                    onClick={() => void openTaskAt(task)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left focus:outline-none"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-800">
                      {task.content || task.rawText}
                    </span>
                    <span className="shrink-0 truncate text-xs text-ink-400">{task.noteTitle}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : tasksLoading ? (
            <EmptyHint text="Loading tasks…" />
          ) : (
            <EmptyHint text="No open tasks. All clear." />
          )}
          {hiddenTaskCount > 0 && (
            <button
              type="button"
              data-home-item
              onClick={() => void openTasksView()}
              className="mt-2 inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs text-ink-400 transition-colors hover:text-ink-700 focus:text-ink-700 focus:outline-none"
            >
              <span>
                +{hiddenTaskCount} more {hiddenTaskCount === 1 ? 'task' : 'tasks'}
              </span>
              <ArrowUpRightIcon width={12} height={12} />
            </button>
          )}
        </section>
      </div>
    </div>
  )
}

function SectionLabel({
  icon,
  text,
  trailing
}: {
  icon: React.ReactNode
  text: string
  trailing?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3">
      <span className="text-ink-400">{icon}</span>
      <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">{text}</span>
      {trailing && <span className="ml-auto">{trailing}</span>}
    </div>
  )
}

function EmptyHint({ text }: { text: string }): JSX.Element {
  return <p className="mt-1.5 px-3 py-2 text-sm text-ink-400">{text}</p>
}
