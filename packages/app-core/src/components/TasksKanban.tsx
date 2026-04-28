/**
 * Kanban view for the Tasks tab.
 *
 * Columns are driven by the user's `kanbanGroupBy` choice:
 *   - 'status'  — Today / Upcoming / Waiting / Done   (mirrors list groups)
 *   - 'priority' — High / Med / Low / None
 *   - 'folder'  — Inbox / Quick / Archive            (read-only)
 *
 * Drag-and-drop:
 *   - Status: drop changes `[ ]`/`[x]` and the `@waiting` token on the
 *             source line. Dropping on Today/Upcoming clears
 *             `@waiting` and unchecks; Waiting sets `@waiting`; Done
 *             checks the box.
 *   - Priority: drop replaces / inserts / removes the `!high|!med|!low`
 *               token on the source line.
 *   - Folder: DnD is disabled — moving a task between folders means
 *             moving its source note, which carries other content
 *             with it. Cards still click to open and Space/x still
 *             toggle in place.
 *
 * Vim navigation:
 *   h/l — move between columns
 *   j/k — move between cards within the active column
 *   Enter — open the card's source note
 *   Space / x — toggle the checkbox on the focused card
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteFolder } from '@shared/ipc'
import type { VaultTask } from '@shared/tasks'
import { groupTasks, isOverdue as isTaskOverdue, toIsoDateLocal } from '@shared/tasks'
import { useStore, type KanbanGroupBy, type TaskMutation } from '../store'
import { ArrowUpRightIcon } from './icons'

interface Props {
  tasks: VaultTask[]
  today: Date
  onOpenTask: (task: VaultTask) => void
  onToggleTask: (task: VaultTask) => void
}

/** Map a (groupBy, columnId) drop target to the task-line mutations
 *  that should land. Returns `null` when the drop has no defined
 *  semantics (e.g. when group-by is 'folder'). Returns `[]` when the
 *  task is already in the target column — caller can short-circuit. */
function dropMutationsFor(
  groupBy: KanbanGroupBy,
  columnId: string,
  task: VaultTask
): TaskMutation[] | null {
  if (groupBy === 'status') {
    switch (columnId) {
      case 'today':
      case 'upcoming':
        // "Live" columns — make sure neither @waiting nor [x] keep the
        // task glued to a different bucket.
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: false }
        ]
      case 'waiting':
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: true }
        ]
      case 'done':
        return [{ kind: 'set-checked', checked: true }]
      default:
        return null
    }
  }
  if (groupBy === 'priority') {
    if (columnId === 'high') return [{ kind: 'set-priority', priority: 'high' }]
    if (columnId === 'med') return [{ kind: 'set-priority', priority: 'med' }]
    if (columnId === 'low') return [{ kind: 'set-priority', priority: 'low' }]
    if (columnId === 'none') return [{ kind: 'set-priority', priority: null }]
    return null
  }
  // Folder grouping is read-only — moving the task across folders
  // means moving the source note, which the user does explicitly via
  // the sidebar.
  return null
}

/** Module-scoped state for the active drag. Kept outside React state
 *  because:
 *    - dataTransfer would serialize the task to a string and we'd
 *      have to re-find it on every drop;
 *    - React state queues, so the column's onDragOver closure can lag
 *      behind setState calls fired during dragstart;
 *    - We need a synchronous, always-current "what's being dragged
 *      and over where" so onDragEnd can complete a drop even when
 *      Chromium's `drop` event is eaten by a nested layout.
 *
 *  `lastOverColumn` is updated in onDragEnter/onDragOver and read by
 *  onDragEnd as a fallback when the column-level drop didn't fire. */
let dragPayload: { task: VaultTask } | null = null
let lastOverColumn: string | null = null
let dropAlreadyHandled = false

interface Column {
  id: string
  label: string
  /** Optional secondary label (e.g. count, overdue badge). */
  badge?: { kind: 'overdue' | 'count'; value: number }
  tasks: VaultTask[]
}

function statusColumns(tasks: VaultTask[], today: Date): Column[] {
  const groups = groupTasks(tasks, today)
  return [
    {
      id: 'today',
      label: 'Today',
      tasks: groups.today,
      badge:
        groups.overdueCount > 0
          ? { kind: 'overdue', value: groups.overdueCount }
          : undefined
    },
    { id: 'upcoming', label: 'Upcoming', tasks: groups.upcoming },
    { id: 'waiting', label: 'Waiting', tasks: groups.waiting },
    { id: 'done', label: 'Done', tasks: groups.done }
  ]
}

function priorityColumns(tasks: VaultTask[]): Column[] {
  const high: VaultTask[] = []
  const med: VaultTask[] = []
  const low: VaultTask[] = []
  const none: VaultTask[] = []
  for (const task of tasks) {
    if (task.checked) continue
    if (task.priority === 'high') high.push(task)
    else if (task.priority === 'med') med.push(task)
    else if (task.priority === 'low') low.push(task)
    else none.push(task)
  }
  // Within each column, surface overdue/today first, then by due date.
  const sortByDue = (a: VaultTask, b: VaultTask): number => {
    const ad = a.due ?? '9999-12-31'
    const bd = b.due ?? '9999-12-31'
    if (ad !== bd) return ad < bd ? -1 : 1
    if (a.sourcePath !== b.sourcePath) return a.sourcePath < b.sourcePath ? -1 : 1
    return a.taskIndex - b.taskIndex
  }
  high.sort(sortByDue)
  med.sort(sortByDue)
  low.sort(sortByDue)
  none.sort(sortByDue)
  return [
    { id: 'high', label: 'High', tasks: high },
    { id: 'med', label: 'Medium', tasks: med },
    { id: 'low', label: 'Low', tasks: low },
    { id: 'none', label: 'No priority', tasks: none }
  ]
}

const FOLDER_ORDER: NoteFolder[] = ['inbox', 'quick', 'archive']
const FOLDER_LABEL: Record<NoteFolder, string> = {
  inbox: 'Inbox',
  quick: 'Quick',
  archive: 'Archive',
  trash: 'Trash'
}

function folderColumns(tasks: VaultTask[]): Column[] {
  const map = new Map<NoteFolder, VaultTask[]>()
  for (const task of tasks) {
    if (task.checked) continue
    const list = map.get(task.noteFolder)
    if (list) list.push(task)
    else map.set(task.noteFolder, [task])
  }
  return FOLDER_ORDER.map((folder) => ({
    id: folder,
    label: FOLDER_LABEL[folder],
    tasks: map.get(folder) ?? []
  }))
}

function buildColumns(
  groupBy: KanbanGroupBy,
  tasks: VaultTask[],
  today: Date
): Column[] {
  if (groupBy === 'priority') return priorityColumns(tasks)
  if (groupBy === 'folder') return folderColumns(tasks)
  return statusColumns(tasks, today)
}

export function TasksKanban({ tasks, today, onOpenTask, onToggleTask }: Props): JSX.Element {
  const groupBy = useStore((s) => s.kanbanGroupBy)
  const setGroupBy = useStore((s) => s.setKanbanGroupBy)
  const applyTaskMutation = useStore((s) => s.applyTaskMutation)
  const [colIdx, setColIdx] = useState(0)
  const [cardIdx, setCardIdx] = useState(0)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  const columns = useMemo(() => buildColumns(groupBy, tasks, today), [groupBy, tasks, today])

  const dndEnabled = groupBy !== 'folder'

  // Clamp focus on column/card if the data shifts under us.
  const safeColIdx = Math.min(colIdx, Math.max(0, columns.length - 1))
  const focusedColumn = columns[safeColIdx]
  const safeCardIdx = focusedColumn
    ? Math.min(cardIdx, Math.max(0, focusedColumn.tasks.length - 1))
    : 0
  const focusedTask = focusedColumn?.tasks[safeCardIdx]

  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [safeColIdx, safeCardIdx, focusedTask?.id])

  // Local key handler — capture phase + stopImmediatePropagation so we
  // beat VimNav's global handler (which otherwise hijacks h/j/k/l).
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

      switch (e.key) {
        case 'h':
        case 'ArrowLeft':
          consume()
          setColIdx((i) => Math.max(0, i - 1))
          setCardIdx(0)
          return
        case 'l':
        case 'ArrowRight':
          consume()
          setColIdx((i) => Math.min(columns.length - 1, i + 1))
          setCardIdx(0)
          return
        case 'j':
        case 'ArrowDown':
          consume()
          setCardIdx((i) =>
            focusedColumn ? Math.min(focusedColumn.tasks.length - 1, i + 1) : 0
          )
          return
        case 'k':
        case 'ArrowUp':
          consume()
          setCardIdx((i) => Math.max(0, i - 1))
          return
        case 'Enter':
          if (focusedTask) {
            consume()
            onOpenTask(focusedTask)
          }
          return
        case ' ':
        case 'x':
          if (focusedTask) {
            consume()
            onToggleTask(focusedTask)
          }
          return
        default:
          return
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [columns.length, focusedColumn, focusedTask, onOpenTask, onToggleTask])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-paper-300/45 px-3 py-2">
        <div className="flex items-center gap-1 text-xs text-current/60">
          <span>Group by</span>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as KanbanGroupBy)}
            className="rounded-md border border-paper-300/60 bg-paper-200/60 px-2 py-0.5 text-xs text-current/85 outline-none focus:border-paper-400/70"
          >
            <option value="status">Status</option>
            <option value="priority">Priority</option>
            <option value="folder">Folder</option>
          </select>
        </div>
        <div className="text-[11px] text-current/40">
          {dndEnabled
            ? 'Drag cards to move · h/l column · j/k card · Space toggle · Enter open'
            : 'h/l column · j/k card · Space toggle · Enter open'}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto px-3 py-3">
        {columns.map((column, ci) => {
          const isColumnFocused = ci === safeColIdx
          const isDropTarget = dndEnabled && dragOverColumn === column.id
          return (
            <div
              key={column.id}
              className={[
                'flex w-72 shrink-0 flex-col rounded-lg border bg-paper-100/60',
                isDropTarget
                  ? 'border-accent/60 ring-1 ring-accent/30'
                  : isColumnFocused
                    ? 'border-paper-400/70'
                    : 'border-paper-300/60'
              ].join(' ')}
              onDragEnter={(e) => {
                // Always preventDefault on dragenter / dragover when
                // DnD is enabled: HTML5 requires it to mark the
                // element as a valid drop target. We can't gate on
                // React state here (setDraggingId is queued and the
                // handler closure may still see the old value before
                // the next render), so we let the browser take care
                // of the "is there actually a drag?" check. A spurious
                // preventDefault outside a drag is harmless.
                if (!dndEnabled) return
                e.preventDefault()
                lastOverColumn = column.id
                if (dragOverColumn !== column.id) setDragOverColumn(column.id)
              }}
              onDragOver={(e) => {
                if (!dndEnabled) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                lastOverColumn = column.id
                if (dragOverColumn !== column.id) setDragOverColumn(column.id)
              }}
              onDragLeave={(e) => {
                // Avoid dragleave→dragenter flicker when crossing
                // child elements: only clear if we're leaving the
                // column itself, not entering one of its children.
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                if (dragOverColumn === column.id) setDragOverColumn(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDragOverColumn(null)
                if (!dndEnabled) return
                const payload = dragPayload
                if (!payload) return
                dropAlreadyHandled = true
                const mutations = dropMutationsFor(groupBy, column.id, payload.task)
                if (mutations && mutations.length > 0) {
                  void applyTaskMutation(payload.task, mutations)
                }
              }}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-paper-300/45 px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-current/70">
                  {column.label}
                </span>
                <div className="flex items-center gap-1.5 text-[11px] text-current/50">
                  <span>{column.tasks.length}</span>
                  {column.badge?.kind === 'overdue' && column.badge.value > 0 && (
                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-300">
                      {column.badge.value} overdue
                    </span>
                  )}
                </div>
              </div>
              <div
                onClick={() => setColIdx(ci)}
                className="min-h-0 flex-1 overflow-y-auto p-2"
              >
                {column.tasks.length === 0 ? (
                  <div className="rounded-md border border-dashed border-paper-300/60 px-2 py-3 text-center text-[11px] text-current/40">
                    {isDropTarget ? 'drop to apply' : 'nothing here'}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {column.tasks.map((task, ti) => {
                      const isFocused = isColumnFocused && ti === safeCardIdx
                      const isDragging = draggingId === task.id
                      return (
                        <TaskCard
                          key={task.id}
                          task={task}
                          isOverdue={isTaskOverdue(task, today)}
                          isFocused={isFocused}
                          isDragging={isDragging}
                          draggable={dndEnabled}
                          cardRef={isFocused ? cardRef : null}
                          onClickRow={() => {
                            setColIdx(ci)
                            setCardIdx(ti)
                          }}
                          onOpen={() => onOpenTask(task)}
                          onToggle={() => onToggleTask(task)}
                          onDragStart={(e) => {
                            dragPayload = { task }
                            lastOverColumn = null
                            dropAlreadyHandled = false
                            setDraggingId(task.id)
                            e.dataTransfer.effectAllowed = 'move'
                            // Some renderers refuse to start a drag
                            // without setData; use a stable but
                            // ignorable payload.
                            try {
                              e.dataTransfer.setData('text/plain', task.id)
                            } catch {
                              // ignore — Electron sometimes throws on
                              // setData during synthetic events
                            }
                          }}
                          onDragEnd={() => {
                            // Fallback path: Chromium will sometimes
                            // skip the column-level `drop` event in
                            // nested-flex layouts even when
                            // preventDefault was called on dragover.
                            // dragend always fires, so use it to
                            // complete the drop using the column we
                            // last tracked under the cursor.
                            if (
                              !dropAlreadyHandled &&
                              dragPayload &&
                              lastOverColumn &&
                              dndEnabled
                            ) {
                              const mutations = dropMutationsFor(
                                groupBy,
                                lastOverColumn,
                                dragPayload.task
                              )
                              if (mutations && mutations.length > 0) {
                                void applyTaskMutation(dragPayload.task, mutations)
                              }
                            }
                            dragPayload = null
                            lastOverColumn = null
                            dropAlreadyHandled = false
                            setDraggingId(null)
                            setDragOverColumn(null)
                          }}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {!dndEnabled && (
        <div className="shrink-0 border-t border-paper-300/45 px-3 py-1.5 text-[11px] text-current/40">
          Folder grouping is read-only — move a task across folders by moving its source note in
          the sidebar.
        </div>
      )}
    </div>
  )
}

interface CardProps {
  task: VaultTask
  isOverdue: boolean
  isFocused: boolean
  isDragging: boolean
  draggable: boolean
  cardRef?: React.RefObject<HTMLDivElement> | null
  onClickRow: () => void
  onOpen: () => void
  onToggle: () => void
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}

function formatDue(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function TaskCard({
  task,
  isOverdue,
  isFocused,
  isDragging,
  draggable,
  cardRef,
  onClickRow,
  onOpen,
  onToggle,
  onDragStart,
  onDragEnd
}: CardProps): JSX.Element {
  return (
    <div
      ref={cardRef ?? undefined}
      onClick={onClickRow}
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) {
          e.preventDefault()
          return
        }
        onDragStart(e)
      }}
      onDragEnd={onDragEnd}
      className={[
        'group rounded-md border-l-2 bg-paper-100/85 px-2.5 py-1.5 transition-colors',
        isOverdue ? 'border-rose-500/70' : 'border-paper-300/60',
        isFocused ? 'ring-1 ring-accent/60' : 'hover:bg-paper-200/60',
        isDragging ? 'opacity-40' : '',
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      ].join(' ')}
    >
      <div className="flex items-start gap-2">
        {/* The interactive controls (checkbox, open arrow) are nested
            inside the draggable card. Chromium absorbs mousedown on
            <button> children and refuses to start the parent's drag,
            so the buttons explicitly opt out of being drag sources
            (`draggable={false}`) AND swallow mousedown when the user
            actually wants a drag. The drag is then initiated from the
            non-button content area below. */}
        <button
          type="button"
          role="checkbox"
          aria-checked={task.checked}
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          className={[
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors',
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
        </button>
        {/* The card body. Was a <button> — switched to a div with
            role/tabIndex so the parent's `draggable=true` works
            reliably from the bulk of the card. */}
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onOpen()
            }
          }}
          className={[
            'min-w-0 flex-1 text-left text-sm select-none',
            task.checked ? 'text-current/50 line-through' : 'text-current/90'
          ].join(' ')}
        >
          {task.content || '(empty task)'}
        </div>
        <button
          type="button"
          aria-label={`Open ${task.noteTitle}`}
          title="Open note (Enter)"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          className={[
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors',
            'hover:bg-paper-200/80',
            isFocused ? 'text-current/90' : 'text-current/30 group-hover:text-current/80'
          ].join(' ')}
        >
          <ArrowUpRightIcon width={12} height={12} />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-6 text-[11px] text-current/50">
        <span className="truncate">{task.noteTitle}</span>
        {task.priority && (
          <span
            className={[
              'shrink-0 font-medium',
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
        {task.due && (
          <span
            className={[
              'shrink-0 rounded px-1.5 py-0.5 font-medium',
              isOverdue
                ? 'bg-rose-500/15 text-rose-300'
                : 'bg-paper-300/60 text-current/70'
            ].join(' ')}
          >
            {formatDue(task.due)}
          </span>
        )}
        {task.waiting && (
          <span className="shrink-0 rounded bg-paper-300/60 px-1 py-0.5 text-purple-300">
            @waiting
          </span>
        )}
      </div>
    </div>
  )
}

// Suppress an unused-import lint when the file's used in a preview-less
// build. The constant is referenced via templated routes elsewhere.
void toIsoDateLocal
