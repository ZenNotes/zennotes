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
  // Folder grouping is read-only — moving the task across folders
  // means moving the source note, which the user does explicitly via
  // the sidebar.
  return null
}

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

function sameTaskIdentity(a: VaultTask, b: VaultTask): boolean {
  return a.sourcePath === b.sourcePath && a.taskIndex === b.taskIndex
}

function taskIdentityKey(task: VaultTask): string {
  return `${task.sourcePath}\0${task.taskIndex}`
}

function sameBoardPlacement(a: VaultTask, b: VaultTask): boolean {
  return (
    a.checked === b.checked &&
    a.waiting === b.waiting &&
    a.priority === b.priority &&
    a.due === b.due
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
  const applyTaskMutation = useStore((s) => s.applyTaskMutation)
  const [colIdx, setColIdx] = useState(0)
  const [cardIdx, setCardIdx] = useState(0)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const [displayTasks, setDisplayTasks] = useState(tasks)
  const [columnOrderVersion, setColumnOrderVersion] = useState(0)
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const latestTasksRef = useRef(tasks)
  const displayTasksRef = useRef(tasks)
  const pendingTaskMovesRef = useRef(new Map<string, VaultTask>())
  const columnOrderRef = useRef(new Map<string, string[]>())
  const columnsRef = useRef<Column[]>([])
  const columnTitleInputRef = useRef<HTMLInputElement | null>(null)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const pointerDragRef = useRef<ActivePointerDrag | null>(null)
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
        buildColumns(groupBy, displayTasks, today),
        columnOrderRef.current
      )
      return orderedColumns.map((column) => ({
        ...column,
        label: kanbanColumnTitles[columnOrderKey(groupBy, column.id)] ?? column.label
      }))
    },
    [columnOrderVersion, groupBy, displayTasks, kanbanColumnTitles, today]
  )
  columnsRef.current = columns

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

      <div ref={boardRef} className="flex min-h-0 flex-1 gap-2 overflow-x-auto px-3 py-3">
        {columns.map((column, ci) => {
          const isColumnFocused = ci === safeColIdx
          return (
            <div
              key={column.id}
              data-kanban-column-id={column.id}
              className={[
                'task-kanban-column flex w-72 shrink-0 flex-col rounded-lg border bg-paper-100/60',
                isColumnFocused ? 'border-paper-400/70' : 'border-paper-300/60'
              ].join(' ')}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-paper-300/45 px-3 py-2">
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
                        beginColumnRename(column)
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="group/title flex max-w-full items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                    >
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
                </div>
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
                data-kanban-column-body
                className="min-h-0 flex-1 overflow-y-auto p-2"
              >
                {column.tasks.length === 0 ? (
                  <div className="rounded-md border border-dashed border-paper-300/60 px-2 py-3 text-center text-[11px] text-current/40">
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
        <div className="shrink-0 border-t border-paper-300/45 px-3 py-1.5 text-[11px] text-current/40">
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
        'group rounded-md border-l-2 bg-paper-100/85 px-2.5 py-1.5 transition-colors select-none',
        isOverdue ? 'border-rose-500/70' : 'border-paper-300/60',
        isFocused ? 'ring-1 ring-accent/60' : 'hover:bg-paper-200/60',
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
          {task.content || '(empty task)'}
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
