/**
 * Kanban view for the Tasks tab.
 *
 * Columns are driven by the user's `kanbanGroupBy` choice:
 *   - 'status'  — Today / Upcoming / Waiting / Done   (mirrors list groups)
 *   - 'priority' — High / Med / Low / None
 *   - 'folder'  — Inbox / Quick / Archive            (read-only)
 *
 * Drag-and-drop:
 *   - Status: drop changes `[ ]`/`[x]`, `@waiting`, and due-date tokens
 *             on the source line. Dropping on Today sets `due:` to
 *             today; Upcoming preserves a future due date or sets
 *             tomorrow; Waiting sets `@waiting`; Done checks the box.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { NoteFolder } from '@shared/ipc'
import type { VaultTask } from '@shared/tasks'
import { groupTasks, isOverdue as isTaskOverdue, toIsoDateLocal } from '@shared/tasks'
import { useStore, type KanbanGroupBy, type TaskMutation } from '../store'
import { ArrowUpRightIcon, PencilIcon } from './icons'
import { InlineMarkdown } from '../lib/inline-markdown'
import { isImeComposing } from '../lib/ime'

interface Props {
  tasks: VaultTask[]
  today: Date
  onOpenTask: (task: VaultTask) => void
  onToggleTask: (task: VaultTask) => void
}

// Sentinel column id for the "No status" bucket on the custom-status board.
// Starts with `_`, which the status-id grammar (`[\p{L}\d]…`) forbids, so it can
// never collide with a real `@status:<id>`. (#354)
export const NO_VALUE_COLUMN_ID = '__none__'

// Stable auto-assigned accent per field-value column, so a discovery-first board
// still reads as distinct columns with zero color config. The No-value column is
// intentionally neutral (null).
const COLUMN_ACCENTS = ['#e0a34a', '#57a55a', '#4a9ec0', '#b57edc', '#d9788f', '#7f8c9a', '#c4a63a']
function columnAccent(id: string): string | null {
  if (id === NO_VALUE_COLUMN_ID) return null
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return COLUMN_ACCENTS[hash % COLUMN_ACCENTS.length]
}

/** Map a (groupBy, columnId) drop target to the task-line mutations
 *  that should land. Returns `null` when the drop has no defined
 *  semantics (e.g. when group-by is 'folder'). Returns `[]` when the
 *  task is already in the target column — caller can short-circuit. */
function dropMutationsFor(
  groupBy: KanbanGroupBy,
  columnId: string,
  task: VaultTask,
  today: Date
): TaskMutation[] | null {
  if (groupBy === 'status') {
    const todayIso = toIsoDateLocal(today)
    switch (columnId) {
      case 'today':
        // "Live" columns — make sure neither @waiting nor [x] keep the
        // task glued to a different bucket.
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: false },
          { kind: 'set-due', due: todayIso }
        ]
      case 'upcoming': {
        const tomorrow = new Date(today)
        tomorrow.setDate(tomorrow.getDate() + 1)
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: false },
          {
            kind: 'set-due',
            due: task.due && task.due > todayIso ? task.due : toIsoDateLocal(tomorrow)
          }
        ]
      }
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
  if (groupBy.startsWith('field:')) {
    // Drop sets the `@<key>:<value>` token; the No-<key> column clears it.
    const key = groupBy.slice('field:'.length)
    return [{ kind: 'set-field', key, value: columnId === NO_VALUE_COLUMN_ID ? null : columnId }]
  }
  // Folder grouping is read-only — moving the task across folders
  // means moving the source note, which the user does explicitly via
  // the sidebar.
  return null
}

export interface Column {
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

/** Title-case a field value for its default column label; users can still
 *  override status column titles via `[kanban_column_titles]`. */
function prettifyFieldValue(id: string): string {
  const words = id.replace(/[_/-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id
}

/** The `field:<key>` part of a group-by, or null for the static boards. */
function fieldKeyOf(groupBy: KanbanGroupBy): string | null {
  return groupBy.startsWith('field:') ? groupBy.slice('field:'.length) : null
}

/** Columns for a free-form `@<key>:<value>` field board. Configured values come
 *  first in order, then any value found on tasks but not configured (sorted, so
 *  nothing is hidden), then a trailing "No <key>" column. Completed and
 *  forwarded tasks are left off, matching the priority/folder boards. (#354) */
function fieldColumns(tasks: VaultTask[], fieldKey: string, order: string[]): Column[] {
  const byValue = new Map<string, VaultTask[]>()
  const noValue: VaultTask[] = []
  for (const task of tasks) {
    if (task.checked || task.forwarded) continue
    const value = task.fields?.[fieldKey]
    if (value) {
      const list = byValue.get(value)
      if (list) list.push(task)
      else byValue.set(value, [task])
    } else {
      noValue.push(task)
    }
  }

  const ordered: string[] = []
  const seen = new Set<string>()
  for (const id of order) {
    if (!seen.has(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }
  // Discovery-first: values used on tasks but not in the config still appear,
  // sorted for a stable order, so a freshly-tagged value shows up immediately.
  for (const id of [...byValue.keys()].sort()) {
    if (!seen.has(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }

  const sortByDue = (a: VaultTask, b: VaultTask): number => {
    const ad = a.due ?? '9999-12-31'
    const bd = b.due ?? '9999-12-31'
    if (ad !== bd) return ad < bd ? -1 : 1
    if (a.sourcePath !== b.sourcePath) return a.sourcePath < b.sourcePath ? -1 : 1
    return a.taskIndex - b.taskIndex
  }

  const columns: Column[] = ordered.map((id) => ({
    id,
    label: prettifyFieldValue(id),
    tasks: (byValue.get(id) ?? []).sort(sortByDue)
  }))
  columns.push({
    id: NO_VALUE_COLUMN_ID,
    label: `No ${fieldKey}`,
    tasks: noValue.sort(sortByDue)
  })
  return columns
}

function buildColumns(
  groupBy: KanbanGroupBy,
  tasks: VaultTask[],
  today: Date,
  statuses: string[]
): Column[] {
  if (groupBy === 'priority') return priorityColumns(tasks)
  if (groupBy === 'folder') return folderColumns(tasks)
  const fieldKey = fieldKeyOf(groupBy)
  if (fieldKey) {
    // The status field keeps its friendly `kanban_statuses` order; other fields
    // use discovery order.
    return fieldColumns(tasks, fieldKey, fieldKey === 'status' ? statuses : [])
  }
  return statusColumns(tasks, today)
}

function sameTaskIdentity(a: VaultTask, b: VaultTask): boolean {
  return a.sourcePath === b.sourcePath && a.taskIndex === b.taskIndex
}

function taskIdentityKey(task: VaultTask): string {
  return `${task.sourcePath}\0${task.taskIndex}`
}

function sameFields(a: Record<string, string> = {}, b: Record<string, string> = {}): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  return ak.every((k) => a[k] === b[k])
}

function sameBoardPlacement(a: VaultTask, b: VaultTask): boolean {
  return (
    a.checked === b.checked &&
    a.waiting === b.waiting &&
    a.priority === b.priority &&
    a.due === b.due &&
    sameFields(a.fields, b.fields)
  )
}

function applyTaskMutationsForBoard(task: VaultTask, mutations: TaskMutation[]): VaultTask {
  let next = task
  for (const m of mutations) {
    switch (m.kind) {
      case 'set-checked':
        if (next.checked !== m.checked) next = { ...next, checked: m.checked }
        break
      case 'set-waiting':
        if (next.waiting !== m.waiting) next = { ...next, waiting: m.waiting }
        break
      case 'set-priority': {
        const priority = m.priority ?? undefined
        if (next.priority !== priority) next = { ...next, priority }
        break
      }
      case 'set-due': {
        const due = m.due ?? undefined
        if (next.due !== due) next = { ...next, due }
        break
      }
      case 'set-field': {
        const value = m.value ?? undefined
        const fields = { ...next.fields }
        if (value == null) delete fields[m.key]
        else fields[m.key] = value
        next = { ...next, fields }
        if (m.key === 'status') next = { ...next, status: value }
        break
      }
    }
  }
  return next
}

function columnOrderKey(groupBy: KanbanGroupBy, columnId: string): string {
  return `${groupBy}:${columnId}`
}

function applyColumnOrder(
  groupBy: KanbanGroupBy,
  columns: Column[],
  orderMap: Map<string, string[]>
): Column[] {
  return columns.map((column) => {
    const order = orderMap.get(columnOrderKey(groupBy, column.id))
    if (!order?.length) return column

    const rank = new Map(order.map((key, index) => [key, index] as const))
    const originalIndex = new Map(
      column.tasks.map((task, index) => [taskIdentityKey(task), index] as const)
    )
    const tasks = [...column.tasks].sort((a, b) => {
      const aKey = taskIdentityKey(a)
      const bKey = taskIdentityKey(b)
      const aRank = rank.get(aKey)
      const bRank = rank.get(bKey)
      if (aRank != null && bRank != null) return aRank - bRank
      if (aRank != null) return -1
      if (bRank != null) return 1
      return (originalIndex.get(aKey) ?? 0) - (originalIndex.get(bKey) ?? 0)
    })

    return { ...column, tasks }
  })
}

/** Reorder built columns by the user's saved arrangement (`kanbanColumnOrder`).
 *  Columns not in the saved order keep their built position after the saved
 *  ones (stable), so newly-discovered values still appear. The No-value bucket
 *  is always pinned last and is never user-movable. */
export function arrangeColumns(columns: Column[], order: string[]): Column[] {
  if (order.length === 0) return columns
  const rank = new Map(order.map((id, index) => [id, index] as const))
  const noValue = columns.filter((c) => c.id === NO_VALUE_COLUMN_ID)
  const rest = columns.filter((c) => c.id !== NO_VALUE_COLUMN_ID)
  const sorted = rest
    .map((column, index) => ({ column, index }))
    .sort((a, b) => {
      const ar = rank.get(a.column.id)
      const br = rank.get(b.column.id)
      if (ar != null && br != null) return ar - br
      if (ar != null) return -1
      if (br != null) return 1
      return a.index - b.index
    })
    .map((entry) => entry.column)
  return [...sorted, ...noValue]
}

interface ActiveColumnDrag {
  columnId: string
  pointerId: number
  startX: number
  startY: number
  dragging: boolean
  /** Column the pointer is currently over, and which side to insert on. */
  targetId: string | null
  insertAfter: boolean
}

interface ActivePointerDrag {
  task: VaultTask
  pointerId: number
  sourceColumnId: string | null
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  width: number
  height: number
  dragging: boolean
  lastColumnId: string | null
  lastInsertionIndex: number | null
}

interface DragPreview {
  task: VaultTask
  isOverdue: boolean
  width: number
  height: number
  x: number
  y: number
}

const POINTER_DRAG_THRESHOLD = 5

export function TasksKanban({ tasks, today, onOpenTask, onToggleTask }: Props): JSX.Element {
  const groupBy = useStore((s) => s.kanbanGroupBy)
  const setGroupBy = useStore((s) => s.setKanbanGroupBy)
  const kanbanColumnTitles = useStore((s) => s.kanbanColumnTitles)
  const setKanbanColumnTitle = useStore((s) => s.setKanbanColumnTitle)
  const kanbanColumnOrder = useStore((s) => s.kanbanColumnOrder)
  const setKanbanColumnOrder = useStore((s) => s.setKanbanColumnOrder)
  const kanbanStatuses = useStore((s) => s.kanbanStatuses)
  const applyTaskMutation = useStore((s) => s.applyTaskMutation)
  const [colIdx, setColIdx] = useState(0)
  const [cardIdx, setCardIdx] = useState(0)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const [displayTasks, setDisplayTasks] = useState(tasks)
  const [columnOrderVersion, setColumnOrderVersion] = useState(0)
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [draggingColumnId, setDraggingColumnId] = useState<string | null>(null)
  const [columnDropTarget, setColumnDropTarget] = useState<{ id: string; after: boolean } | null>(
    null
  )
  const latestTasksRef = useRef(tasks)
  const displayTasksRef = useRef(tasks)
  const pendingTaskMovesRef = useRef(new Map<string, VaultTask>())
  const columnOrderRef = useRef(new Map<string, string[]>())
  const columnsRef = useRef<Column[]>([])
  const columnTitleInputRef = useRef<HTMLInputElement | null>(null)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const pointerDragRef = useRef<ActivePointerDrag | null>(null)
  const columnDragRef = useRef<ActiveColumnDrag | null>(null)
  const suppressColumnClickUntilRef = useRef(0)
  const dragPreviewRef = useRef<HTMLDivElement | null>(null)
  const dragPreviewFrameRef = useRef<number | null>(null)
  const dragPreviewPointRef = useRef<{ x: number; y: number } | null>(null)
  const dropIndicatorRef = useRef<HTMLDivElement | null>(null)
  const dropIndicatorFrameRef = useRef<number | null>(null)
  const dropIndicatorRectRef = useRef<{ x: number; y: number; width: number } | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const dragOverColumnRef = useRef<string | null>(null)
  const dragOverElementRef = useRef<HTMLElement | null>(null)
  const suppressCardClickUntilRef = useRef(0)

  const mergeTasksWithPendingMoves = useCallback((incomingTasks: VaultTask[]) => {
    const pending = pendingTaskMovesRef.current
    if (pending.size === 0) return incomingTasks

    for (const [key, pendingTask] of pending) {
      const incoming = incomingTasks.find((task) => taskIdentityKey(task) === key)
      if (incoming && sameBoardPlacement(incoming, pendingTask)) {
        pending.delete(key)
      }
    }

    if (pending.size === 0) return incomingTasks
    return incomingTasks.map((task) => pending.get(taskIdentityKey(task)) ?? task)
  }, [])

  useEffect(() => {
    latestTasksRef.current = tasks
    const mergedTasks = mergeTasksWithPendingMoves(tasks)
    displayTasksRef.current = mergedTasks
    setDisplayTasks(mergedTasks)
  }, [mergeTasksWithPendingMoves, tasks])

  const columns = useMemo(
    () => {
      const orderedColumns = applyColumnOrder(
        groupBy,
        arrangeColumns(
          buildColumns(groupBy, displayTasks, today, kanbanStatuses),
          kanbanColumnOrder[groupBy] ?? []
        ),
        columnOrderRef.current
      )
      return orderedColumns.map((column) => ({
        ...column,
        label: kanbanColumnTitles[columnOrderKey(groupBy, column.id)] ?? column.label
      }))
    },
    [
      columnOrderVersion,
      groupBy,
      displayTasks,
      kanbanColumnOrder,
      kanbanColumnTitles,
      kanbanStatuses,
      today
    ]
  )
  columnsRef.current = columns

  // Group-by options: the three static boards, the default custom-status field,
  // then one option per `@key:` field discovered across the current tasks. This
  // is what makes any inline field a board with zero configuration. (#354)
  const groupByOptions = useMemo(() => {
    const opts: { value: KanbanGroupBy; label: string }[] = [
      { value: 'status', label: 'Status' },
      { value: 'priority', label: 'Priority' },
      { value: 'folder', label: 'Folder' },
      { value: 'field:status', label: 'Custom status' }
    ]
    const keys = new Set<string>()
    for (const t of tasks) if (t.fields) for (const k of Object.keys(t.fields)) keys.add(k)
    keys.delete('status')
    for (const k of [...keys].sort()) {
      opts.push({ value: `field:${k}` as KanbanGroupBy, label: `By @${k}` })
    }
    // Keep the current selection visible even if nothing currently uses it.
    const currentKey = fieldKeyOf(groupBy)
    if (currentKey && !opts.some((o) => o.value === groupBy)) {
      opts.push({
        value: groupBy,
        label: currentKey === 'status' ? 'Custom status' : `By @${currentKey}`
      })
    }
    return opts
  }, [tasks, groupBy])

  const dndEnabled = groupBy !== 'folder'

  const beginColumnRename = useCallback((column: Column) => {
    setEditingColumnId(column.id)
    setEditingTitle(column.label)
  }, [])

  const commitColumnRename = useCallback(
    (columnId: string) => {
      setKanbanColumnTitle(groupBy, columnId, editingTitle)
      setEditingColumnId(null)
      setEditingTitle('')
    },
    [editingTitle, groupBy, setKanbanColumnTitle]
  )

  const cancelColumnRename = useCallback(() => {
    setEditingColumnId(null)
    setEditingTitle('')
  }, [])

  // ---- Column reordering: drag a header, or Shift+`<` / Shift+`>` ----------
  // A click that started a header drag must not also fire the rename button.
  const shouldSuppressColumnRename = useCallback(
    () => Date.now() < suppressColumnClickUntilRef.current,
    []
  )

  const moveFocusedColumn = useCallback(
    (dir: -1 | 1): void => {
      const cols = columnsRef.current
      const movable = cols.filter((c) => c.id !== NO_VALUE_COLUMN_ID).map((c) => c.id)
      if (movable.length < 2) return
      const from = Math.min(colIdx, cols.length - 1)
      if (from < 0 || from >= movable.length) return // pinned No-value column can't move
      const to = from + dir
      if (to < 0 || to >= movable.length) return
      const [moved] = movable.splice(from, 1)
      movable.splice(to, 0, moved)
      setKanbanColumnOrder(groupBy, movable)
      setColIdx(to)
      setCardIdx(0)
    },
    [colIdx, groupBy, setKanbanColumnOrder]
  )

  const beginColumnDrag = useCallback(
    (columnId: string, e: React.PointerEvent<HTMLElement>): void => {
      if (e.button !== 0 || columnId === NO_VALUE_COLUMN_ID || editingColumnId) return
      columnDragRef.current = {
        columnId,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        targetId: null,
        insertAfter: false
      }
    },
    [editingColumnId]
  )

  const finishColumnDrag = useCallback(
    (drag: ActiveColumnDrag): void => {
      if (!drag.targetId || drag.targetId === drag.columnId) return
      const ids = columnsRef.current.map((c) => c.id).filter((id) => id !== NO_VALUE_COLUMN_ID)
      const fromIdx = ids.indexOf(drag.columnId)
      if (fromIdx < 0) return
      ids.splice(fromIdx, 1)
      const targetIdx = ids.indexOf(drag.targetId)
      if (targetIdx < 0) return
      ids.splice(drag.insertAfter ? targetIdx + 1 : targetIdx, 0, drag.columnId)
      setKanbanColumnOrder(groupBy, ids)
    },
    [groupBy, setKanbanColumnOrder]
  )

  useEffect(() => {
    const handleMove = (e: PointerEvent): void => {
      const drag = columnDragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      if (
        !drag.dragging &&
        Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < POINTER_DRAG_THRESHOLD
      ) {
        return
      }
      if (!drag.dragging) {
        drag.dragging = true
        suppressColumnClickUntilRef.current = Number.POSITIVE_INFINITY
        setDraggingColumnId(drag.columnId)
        document.body.style.userSelect = 'none'
      }
      e.preventDefault()
      const columnEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(
        '[data-kanban-column-id]'
      )
      const targetId = columnEl?.dataset.kanbanColumnId ?? null
      if (!targetId || targetId === NO_VALUE_COLUMN_ID || targetId === drag.columnId) {
        drag.targetId = null
        setColumnDropTarget(null)
        return
      }
      const rect = columnEl!.getBoundingClientRect()
      const after = e.clientX > rect.left + rect.width / 2
      drag.targetId = targetId
      drag.insertAfter = after
      setColumnDropTarget({ id: targetId, after })
    }
    const handleUp = (e: PointerEvent): void => {
      const drag = columnDragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      columnDragRef.current = null
      if (drag.dragging) {
        e.preventDefault()
        finishColumnDrag(drag)
        suppressColumnClickUntilRef.current = Date.now() + 140
      }
      setDraggingColumnId(null)
      setColumnDropTarget(null)
      document.body.style.userSelect = ''
    }
    const handleCancel = (e: PointerEvent): void => {
      const drag = columnDragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      columnDragRef.current = null
      setDraggingColumnId(null)
      setColumnDropTarget(null)
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', handleMove, { passive: false })
    window.addEventListener('pointerup', handleUp, { passive: false })
    window.addEventListener('pointercancel', handleCancel)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleCancel)
    }
  }, [finishColumnDrag])

  useEffect(() => {
    if (!editingColumnId) return
    const id = window.requestAnimationFrame(() => {
      columnTitleInputRef.current?.focus()
      columnTitleInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(id)
  }, [editingColumnId])

  useEffect(() => {
    cancelColumnRename()
  }, [cancelColumnRename, groupBy])

  const clearDropTarget = useCallback(() => {
    dragOverElementRef.current?.classList.remove('is-drop-target')
    dragOverElementRef.current = null
    dragOverColumnRef.current = null
  }, [])

  const hideDropIndicator = useCallback(() => {
    if (dropIndicatorFrameRef.current != null) {
      window.cancelAnimationFrame(dropIndicatorFrameRef.current)
      dropIndicatorFrameRef.current = null
    }
    dropIndicatorRectRef.current = null
    const el = dropIndicatorRef.current
    if (el) {
      el.style.opacity = '0'
      el.style.transform = 'translate3d(-9999px, -9999px, 0)'
      el.style.width = '0px'
    }
  }, [])

  const markDropTarget = useCallback(
    (columnId: string, element: HTMLElement) => {
      if (
        dragOverColumnRef.current === columnId &&
        dragOverElementRef.current === element
      ) {
        return
      }
      clearDropTarget()
      dragOverColumnRef.current = columnId
      dragOverElementRef.current = element
      element.classList.add('is-drop-target')
    },
    [clearDropTarget]
  )

  const shouldSuppressCardClick = useCallback(
    () => Date.now() < suppressCardClickUntilRef.current,
    []
  )

  const persistTaskMutationAfterPaint = useCallback(
    (task: VaultTask, mutations: TaskMutation[]) => {
      const pendingKey = taskIdentityKey(task)
      const run = (): void => {
        void applyTaskMutation(task, mutations).finally(() => {
          window.setTimeout(() => {
            const pending = pendingTaskMovesRef.current
            if (pending.has(pendingKey)) {
              pending.delete(pendingKey)
              const mergedTasks = mergeTasksWithPendingMoves(latestTasksRef.current)
              displayTasksRef.current = mergedTasks
              setDisplayTasks(mergedTasks)
            }
          }, 1200)
        })
      }

      if (
        typeof window.requestAnimationFrame === 'function' &&
        document.visibilityState === 'visible'
      ) {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            window.setTimeout(run, 0)
          })
        })
      } else {
        window.setTimeout(run, 0)
      }
    },
    [applyTaskMutation, mergeTasksWithPendingMoves]
  )

  const placeTaskInColumnOrder = useCallback(
    (task: VaultTask, targetColumnId: string, targetIndex: number | null) => {
      if (targetIndex == null) return

      const movingKey = taskIdentityKey(task)
      const nextOrderMap = new Map(columnOrderRef.current)

      for (const column of columnsRef.current) {
        const keys = column.tasks
          .map((columnTask) => taskIdentityKey(columnTask))
          .filter((key) => key !== movingKey)

        if (column.id === targetColumnId) {
          const boundedIndex = Math.max(0, Math.min(targetIndex, keys.length))
          keys.splice(boundedIndex, 0, movingKey)
        }

        nextOrderMap.set(columnOrderKey(groupBy, column.id), keys)
      }

      columnOrderRef.current = nextOrderMap
      setColumnOrderVersion((version) => version + 1)
    },
    [groupBy]
  )

  const applyTaskToBoard = useCallback(
    (task: VaultTask, mutations: TaskMutation[]) => {
      if (mutations.length === 0) return
      flushSync(() => {
        setDisplayTasks((current) => {
          let movedTask: VaultTask | null = null
          const next = current.map((candidate) => {
            if (!sameTaskIdentity(candidate, task)) return candidate
            movedTask = applyTaskMutationsForBoard(candidate, mutations)
            return movedTask
          })

          if (movedTask) {
            pendingTaskMovesRef.current.set(taskIdentityKey(task), movedTask)
          }
          displayTasksRef.current = next
          return next
        })
      })
    },
    []
  )

  const moveTaskOnBoard = useCallback(
    (
      task: VaultTask,
      mutations: TaskMutation[],
      targetColumnId: string | null,
      targetIndex: number | null
    ) => {
      if (targetColumnId) {
        placeTaskInColumnOrder(task, targetColumnId, targetIndex)
      }
      if (mutations.length === 0) return
      applyTaskToBoard(task, mutations)
      persistTaskMutationAfterPaint(task, mutations)
    },
    [applyTaskToBoard, persistTaskMutationAfterPaint, placeTaskInColumnOrder]
  )

  // Keyboard equivalent of dragging: move the focused card to a target column,
  // applying that column's drop mutation. Works on every drag-enabled board
  // (status, priority, any field). Drives Shift+H/L (relative) and 1-9
  // (absolute). (#354)
  const moveFocusedCardTo = useCallback(
    (toIdx: number): void => {
      if (!dndEnabled) return
      const cols = columnsRef.current
      if (cols.length === 0) return
      const fromIdx = Math.min(colIdx, cols.length - 1)
      const clamped = Math.max(0, Math.min(cols.length - 1, toIdx))
      if (clamped === fromIdx) return
      const fromColumn = cols[fromIdx]
      const task = fromColumn?.tasks[Math.min(cardIdx, fromColumn.tasks.length - 1)]
      if (!task) return
      const targetColumn = cols[clamped]
      const mutations = dropMutationsFor(groupBy, targetColumn.id, task, today)
      if (!mutations || mutations.length === 0) return
      moveTaskOnBoard(task, mutations, targetColumn.id, null)
      setColIdx(clamped)
      setCardIdx(0)
    },
    [cardIdx, colIdx, dndEnabled, groupBy, moveTaskOnBoard, today]
  )
  const moveFocusedCard = useCallback(
    (dir: -1 | 1): void => {
      const cols = columnsRef.current
      const fromIdx = Math.min(colIdx, Math.max(0, cols.length - 1))
      moveFocusedCardTo(fromIdx + dir)
    },
    [colIdx, moveFocusedCardTo]
  )
  // Cycle the group-by dimension from the keyboard (g), so switching boards
  // never needs the mouse. (#354)
  const cycleGroupBy = useCallback(() => {
    if (groupByOptions.length === 0) return
    const i = groupByOptions.findIndex((o) => o.value === groupBy)
    const next = groupByOptions[(i + 1) % groupByOptions.length]
    setGroupBy(next.value)
    setColIdx(0)
    setCardIdx(0)
  }, [groupBy, groupByOptions, setGroupBy])

  const scheduleDropIndicatorPosition = useCallback((x: number, y: number, width: number) => {
    dropIndicatorRectRef.current = { x, y, width }
    if (dropIndicatorFrameRef.current != null) return
    dropIndicatorFrameRef.current = window.requestAnimationFrame(() => {
      dropIndicatorFrameRef.current = null
      const rect = dropIndicatorRectRef.current
      const el = dropIndicatorRef.current
      if (!rect || !el) return
      el.style.width = `${Math.max(24, Math.round(rect.width))}px`
      el.style.opacity = '1'
      el.style.transform = `translate3d(${Math.round(rect.x)}px, ${Math.round(rect.y)}px, 0)`
    })
  }, [])

  const clearDragPreview = useCallback(() => {
    if (dragPreviewFrameRef.current != null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current)
      dragPreviewFrameRef.current = null
    }
    dragPreviewPointRef.current = null
    setDragPreview(null)
  }, [])

  const scheduleDragPreviewPosition = useCallback((drag: ActivePointerDrag, e: PointerEvent) => {
    dragPreviewPointRef.current = {
      x: e.clientX - drag.offsetX,
      y: e.clientY - drag.offsetY
    }
    if (dragPreviewFrameRef.current != null) return
    dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
      dragPreviewFrameRef.current = null
      const point = dragPreviewPointRef.current
      const el = dragPreviewRef.current
      if (!point || !el) return
      el.style.transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0) rotate(0.35deg)`
    })
  }, [])

  const columnAtPoint = useCallback((clientX: number, clientY: number) => {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    const columnEl = el?.closest<HTMLElement>('[data-kanban-column-id]')
    if (!columnEl || !boardRef.current?.contains(columnEl)) return null
    return { id: columnEl.dataset.kanbanColumnId ?? null, element: columnEl }
  }, [])

  const updateDropIndicator = useCallback(
    (
      drag: ActivePointerDrag,
      target: { id: string | null; element: HTMLElement } | null,
      clientY: number
    ): number | null => {
      if (!target?.id) {
        hideDropIndicator()
        return null
      }

      const mutations =
        target.id === drag.sourceColumnId
          ? []
          : dropMutationsFor(groupBy, target.id, drag.task, today)
      if (!mutations) {
        hideDropIndicator()
        return null
      }

      const bodyEl = target.element.querySelector<HTMLElement>('[data-kanban-column-body]')
      if (!bodyEl) {
        hideDropIndicator()
        return null
      }

      const bodyRect = bodyEl.getBoundingClientRect()
      const cards = Array.from(
        target.element.querySelectorAll<HTMLElement>('[data-kanban-task-id]')
      ).filter((card) => card.dataset.kanbanTaskId !== drag.task.id)
      const insertionIndex = cards.findIndex((card) => {
        const rect = card.getBoundingClientRect()
        return clientY < rect.top + rect.height / 2
      })
      const boundedIndex = insertionIndex === -1 ? cards.length : insertionIndex

      let y: number
      if (boundedIndex < cards.length) {
        y = cards[boundedIndex].getBoundingClientRect().top - 4
      } else if (cards.length > 0) {
        y = cards[cards.length - 1].getBoundingClientRect().bottom + 5
      } else {
        y = bodyRect.top + 14
      }

      scheduleDropIndicatorPosition(bodyRect.left + 12, y, bodyRect.width - 24)
      return boundedIndex
    },
    [groupBy, hideDropIndicator, scheduleDropIndicatorPosition, today]
  )

  const finishPointerDrag = useCallback(
    (drag: ActivePointerDrag): void => {
      const columnId = drag.lastColumnId
      if (!columnId || !dndEnabled) return
      const mutations =
        columnId === drag.sourceColumnId
          ? []
          : dropMutationsFor(groupBy, columnId, drag.task, today)
      if (mutations) {
        moveTaskOnBoard(drag.task, mutations, columnId, drag.lastInsertionIndex)
      }
    },
    [dndEnabled, groupBy, moveTaskOnBoard, today]
  )

  const beginPointerDrag = useCallback(
    (task: VaultTask, e: React.PointerEvent<HTMLDivElement>): void => {
      if (!dndEnabled || e.button !== 0) return
      const rect = e.currentTarget.getBoundingClientRect()
      const sourceColumnId =
        columnsRef.current.find((column) =>
          column.tasks.some((candidate) => sameTaskIdentity(candidate, task))
        )?.id ?? null
      pointerDragRef.current = {
        task,
        pointerId: e.pointerId,
        sourceColumnId,
        startX: e.clientX,
        startY: e.clientY,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        dragging: false,
        lastColumnId: null,
        lastInsertionIndex: null
      }
    },
    [dndEnabled]
  )

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent): void => {
      const drag = pointerDragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return

      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.dragging && Math.hypot(dx, dy) < POINTER_DRAG_THRESHOLD) return

      if (!drag.dragging) {
        drag.dragging = true
        suppressCardClickUntilRef.current = Number.POSITIVE_INFINITY
        setDraggingId(drag.task.id)
        setDragPreview({
          task: drag.task,
          isOverdue: isTaskOverdue(drag.task, today),
          width: drag.width,
          height: drag.height,
          x: e.clientX - drag.offsetX,
          y: e.clientY - drag.offsetY
        })
        document.body.style.userSelect = 'none'
      }

      e.preventDefault()
      scheduleDragPreviewPosition(drag, e)
      const target = columnAtPoint(e.clientX, e.clientY)
      if (target?.id && dndEnabled) {
        drag.lastColumnId = target.id
        markDropTarget(target.id, target.element)
        drag.lastInsertionIndex = updateDropIndicator(drag, target, e.clientY)
      } else {
        drag.lastColumnId = null
        drag.lastInsertionIndex = null
        clearDropTarget()
        hideDropIndicator()
      }
    }

    const handlePointerUp = (e: PointerEvent): void => {
      const drag = pointerDragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return

      pointerDragRef.current = null
      if (drag.dragging) {
        e.preventDefault()
        setDraggingId(null)
        finishPointerDrag(drag)
        suppressCardClickUntilRef.current = Date.now() + 140
      } else {
        setDraggingId(null)
      }
      document.body.style.userSelect = ''
      clearDropTarget()
      hideDropIndicator()
      clearDragPreview()
    }

    const handlePointerCancel = (e: PointerEvent): void => {
      const drag = pointerDragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      pointerDragRef.current = null
      setDraggingId(null)
      document.body.style.userSelect = ''
      clearDropTarget()
      hideDropIndicator()
      clearDragPreview()
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerUp, { passive: false })
    window.addEventListener('pointercancel', handlePointerCancel, { passive: false })
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      document.body.style.userSelect = ''
      hideDropIndicator()
      clearDragPreview()
    }
  }, [
    clearDragPreview,
    clearDropTarget,
    columnAtPoint,
    dndEnabled,
    finishPointerDrag,
    hideDropIndicator,
    markDropTarget,
    scheduleDragPreviewPosition,
    today,
    updateDropIndicator
  ])

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

  useEffect(() => clearDropTarget, [clearDropTarget])

  // Local key handler — capture phase + stopImmediatePropagation so we
  // beat VimNav's global handler (which otherwise hijacks h/j/k/l).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // While the Vim hint overlay is open it owns the keyboard; yield to it. (#151)
      if (document.querySelector('[data-vim-hint-overlay]')) return
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
        case 'g':
          consume()
          cycleGroupBy()
          return
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
        case 'H':
          if (dndEnabled && focusedTask) {
            consume()
            moveFocusedCard(-1)
          }
          return
        case 'L':
          if (dndEnabled && focusedTask) {
            consume()
            moveFocusedCard(1)
          }
          return
        case '<':
          consume()
          moveFocusedColumn(-1)
          return
        case '>':
          consume()
          moveFocusedColumn(1)
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
  }, [
    columns.length,
    cycleGroupBy,
    dndEnabled,
    focusedColumn,
    focusedTask,
    moveFocusedCard,
    moveFocusedColumn,
    onOpenTask,
    onToggleTask
  ])

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
            {groupByOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="text-xs text-current/40">
          {dndEnabled
            ? 'Drag or Shift+H·L move card · drag header or </> reorder columns · h/l · j/k · g group-by · Space · Enter'
            : 'Drag header or </> reorder columns · h/l column · j/k card · g group-by · Space · Enter'}
        </div>
      </div>

      {groupBy === 'field:status' && kanbanStatuses.length === 0 && (
        <div className="shrink-0 border-b border-paper-300/45 bg-paper-100/40 px-3 py-2 text-xs text-current/55">
          No custom statuses configured yet. Add an ordered list to your{' '}
          <code className="rounded bg-paper-300/50 px-1">config.toml</code> under{' '}
          <code className="rounded bg-paper-300/50 px-1">[view]</code>, e.g.{' '}
          <code className="rounded bg-paper-300/50 px-1">
            kanban_statuses = ["backlog", "in_progress", "review", "done"]
          </code>
          , then tag tasks like{' '}
          <code className="rounded bg-paper-300/50 px-1">- [ ] Ship it @status:review</code>. Drag a
          card or press Shift+H/L to change a task's status.
        </div>
      )}

      <div ref={boardRef} className="flex min-h-0 flex-1 gap-2 overflow-x-auto px-3 py-3">
        {columns.map((column, ci) => {
          const isColumnFocused = ci === safeColIdx
          const fieldKey = fieldKeyOf(groupBy)
          const accent = fieldKey ? columnAccent(column.id) : null
          const isMovableColumn = column.id !== NO_VALUE_COLUMN_ID
          const isColumnDragging = draggingColumnId === column.id
          const isColumnDropTarget = columnDropTarget?.id === column.id
          // Reveal the underlying field value when a custom title would otherwise
          // hide it, so a renamed column can't masquerade as the stored value. (#389)
          const rawValueHint =
            fieldKey && isMovableColumn && kanbanColumnTitles[columnOrderKey(groupBy, column.id)]
              ? column.id
              : null
          return (
            <div
              key={column.id}
              data-kanban-column-id={column.id}
              className={[
                'task-kanban-column flex w-72 shrink-0 flex-col rounded-lg border bg-paper-100/60 transition-opacity',
                isColumnFocused ? 'border-paper-400/70' : 'border-paper-300/60',
                isColumnDragging ? 'opacity-40' : '',
                isColumnDropTarget ? 'ring-2 ring-accent/70' : ''
              ].join(' ')}
            >
              <div
                onPointerDown={(e) => beginColumnDrag(column.id, e)}
                className={[
                  'flex shrink-0 select-none items-center justify-between gap-2 border-b border-paper-300/45 px-3 py-2',
                  isMovableColumn && editingColumnId !== column.id
                    ? 'cursor-grab active:cursor-grabbing'
                    : ''
                ].join(' ')}
              >
                <div className="min-w-0 flex-1">
                  {editingColumnId === column.id ? (
                    <input
                      ref={columnTitleInputRef}
                      value={editingTitle}
                      aria-label={`Rename ${column.label} column`}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => commitColumnRename(column.id)}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        // While composing (IME), let the input own Enter/Arrows. (#183)
                        if (isImeComposing(e)) return
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitColumnRename(column.id)
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelColumnRename()
                        }
                      }}
                      className="h-6 w-full min-w-0 rounded border border-accent/60 bg-paper-200/80 px-1.5 text-xs font-semibold text-current/90 outline-none ring-1 ring-accent/25"
                    />
                  ) : (
                    <button
                      type="button"
                      aria-label={`Rename ${column.label} column`}
                      title="Rename column"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (shouldSuppressColumnRename()) return
                        beginColumnRename(column)
                      }}
                      className="group/title flex max-w-full items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                    >
                      {accent && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: accent }}
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate text-xs font-semibold uppercase tracking-wide text-current/70">
                        {column.label}
                      </span>
                      <PencilIcon
                        width={12}
                        height={12}
                        className="shrink-0 text-current/45 opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100"
                      />
                    </button>
                  )}
                  {rawValueHint && editingColumnId !== column.id && (
                    <span
                      className="mt-0.5 block truncate font-mono text-2xs lowercase text-current/40"
                      title={`Tasks in this column are tagged @${fieldKey}:${rawValueHint}`}
                    >
                      @{fieldKey}:{rawValueHint}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-current/50">
                  <span>{column.tasks.length}</span>
                  {column.badge?.kind === 'overdue' && column.badge.value > 0 && (
                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-2xs font-medium text-rose-300">
                      {column.badge.value} overdue
                    </span>
                  )}
                </div>
              </div>
              <div
                onClick={() => setColIdx(ci)}
                data-kanban-column-body
                className="min-h-0 flex-1 overflow-y-auto p-2"
              >
                {column.tasks.length === 0 ? (
                  <div className="rounded-md border border-dashed border-paper-300/60 px-2 py-3 text-center text-xs text-current/40">
                    nothing here
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {column.tasks.map((task, ti) => {
                      const isFocused = isColumnFocused && ti === safeCardIdx
                      const isDragging = draggingId === task.id
                      return (
                        <TaskCard
                          key={task.id}
                          taskDomId={task.id}
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
                          shouldSuppressClick={shouldSuppressCardClick}
                          onToggle={() => onToggleTask(task)}
                          onPointerDown={(e) => beginPointerDrag(task, e)}
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
        <div className="shrink-0 border-t border-paper-300/45 px-3 py-1.5 text-xs text-current/40">
          Folder grouping is read-only — move a task across folders by moving its source note in
          the sidebar.
        </div>
      )}
      {dragPreview && (
        <div
          ref={dragPreviewRef}
          className="task-kanban-drag-preview pointer-events-none fixed left-0 top-0 z-[1000]"
          style={{
            width: dragPreview.width,
            minHeight: dragPreview.height,
            transform: `translate3d(${Math.round(dragPreview.x)}px, ${Math.round(dragPreview.y)}px, 0) rotate(0.35deg)`
          }}
        >
          <TaskCard
            taskDomId={dragPreview.task.id}
            task={dragPreview.task}
            isOverdue={dragPreview.isOverdue}
            isFocused={false}
            isDragging={false}
            draggable={false}
            cardRef={null}
            onClickRow={() => {}}
            onOpen={() => {}}
            shouldSuppressClick={() => true}
            onToggle={() => {}}
            onPointerDown={() => {}}
          />
        </div>
      )}
      <div
        ref={dropIndicatorRef}
        className="task-kanban-drop-indicator pointer-events-none fixed left-0 top-0 z-[999]"
        aria-hidden="true"
      />
    </div>
  )
}

interface CardProps {
  taskDomId: string
  task: VaultTask
  isOverdue: boolean
  isFocused: boolean
  isDragging: boolean
  draggable: boolean
  cardRef?: React.RefObject<HTMLDivElement> | null
  onClickRow: () => void
  onOpen: () => void
  shouldSuppressClick: () => boolean
  onToggle: () => void
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
}

function formatDue(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function TaskCard({
  taskDomId,
  task,
  isOverdue,
  isFocused,
  isDragging,
  draggable,
  cardRef,
  onClickRow,
  onOpen,
  shouldSuppressClick,
  onToggle,
  onPointerDown
}: CardProps): JSX.Element {
  return (
    <div
      ref={cardRef ?? undefined}
      hidden={isDragging}
      data-kanban-task-id={taskDomId}
      onClick={() => {
        if (shouldSuppressClick()) return
        onClickRow()
        onOpen()
      }}
      onPointerDown={(e) => {
        if (!draggable) return
        onPointerDown(e)
      }}
      className={[
        // Soft full border so each card reads as its own surface; the left edge
        // stays a touch heavier and turns rose for overdue tasks.
        'group rounded-md border border-l-2 border-paper-300/50 bg-paper-100/85 px-2.5 py-1.5 transition-colors select-none',
        isOverdue ? 'border-l-rose-500/70' : '',
        isFocused ? 'ring-1 ring-accent/60' : 'hover:border-paper-300/75 hover:bg-paper-200/60',
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      ].join(' ')}
    >
      <div className="flex items-start gap-2">
        {/* Interactive controls stop pointerdown so they do not start a card drag. */}
        <button
          type="button"
          role="checkbox"
          aria-checked={task.checked}
          draggable={false}
          onPointerDown={(e) => e.stopPropagation()}
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
        {/* The card body stays focusable so clicks open the note and drags move it. */}
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            if (shouldSuppressClick()) return
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
          {task.content ? <InlineMarkdown text={task.content} /> : '(empty task)'}
        </div>
        <button
          type="button"
          aria-label={`Open ${task.noteTitle}`}
          title="Open note (Enter)"
          draggable={false}
          onPointerDown={(e) => e.stopPropagation()}
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
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-current/50">
        <span className="max-w-full truncate">{task.noteTitle}</span>
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
        {task.fields &&
          Object.entries(task.fields).map(([k, v]) => {
            const accent = columnAccent(v) ?? '#7f8c9a'
            return (
              <span
                key={k}
                className="shrink-0 rounded px-1.5 py-0.5 font-medium"
                style={{ backgroundColor: `${accent}22`, color: accent }}
              >
                @{k}:{v}
              </span>
            )
          })}
      </div>
    </div>
  )
}
