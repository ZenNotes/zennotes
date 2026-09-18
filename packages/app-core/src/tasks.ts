import { captureNavigationContext } from './lib/navigation-context'
import { useSyncExternalStore } from 'react'
import type { VaultTask } from '@bridge-contract/tasks'
import { useStore, type KanbanGroupBy } from './store'
import { filterTasksForDisplay } from '@shared/tasks'
import { computeTasksRender } from './lib/tasks-filter'
import { dropMutationsFor } from './lib/task-column-mutations'

export type { KanbanGroupBy } from './store'
export interface TaskActionHost { isCurrent(): boolean }
export type TaskSnapshot = Readonly<Omit<VaultTask, 'tags' | 'fields'>> & {
  readonly tags: readonly string[]
  readonly fields?: Readonly<Record<string, string>>
}
export interface TasksSnapshot {
  readonly tasks: readonly TaskSnapshot[]
  readonly loading: boolean
  readonly showArchived: boolean
  readonly groupBy: KanbanGroupBy
}
let source: readonly VaultTask[] | undefined
let tasks: readonly TaskSnapshot[] = Object.freeze([])
let snapshot: TasksSnapshot | undefined

export function getTasksSnapshot(): TasksSnapshot {
  const state = useStore.getState()
  if (source !== state.vaultTasks) {
    source = state.vaultTasks
    tasks = Object.freeze(source.map(task => Object.freeze({ ...task,
      tags: Object.freeze([...task.tags]),
      ...(task.fields ? { fields: Object.freeze({ ...task.fields }) } : {})
    })))
  }
  if (!snapshot || snapshot.tasks !== tasks || snapshot.loading !== state.tasksLoading || snapshot.groupBy !== state.kanbanGroupBy || snapshot.showArchived !== state.showArchivedTasks)
    snapshot = Object.freeze({ tasks, loading: state.tasksLoading, showArchived: state.showArchivedTasks, groupBy: state.kanbanGroupBy })
  return snapshot
}
export function subscribeTasks(listener: (next: TasksSnapshot, previous: TasksSnapshot) => void): () => void {
  let previous = getTasksSnapshot()
  return useStore.subscribe(() => {
    const next = getTasksSnapshot()
    if (next === previous) return
    const before = previous; previous = next; listener(next, before)
  })
}
function subscribeReact(notify: () => void): () => void { return subscribeTasks(() => notify()) }
export function useTasksSnapshot(): TasksSnapshot {
  return useSyncExternalStore(subscribeReact, getTasksSnapshot, getTasksSnapshot)
}
export function refreshTasks(path?: string): Promise<void> {
  return path ? useStore.getState().rescanTasksForPath(path) : useStore.getState().refreshTasks()
}
export async function openTask(id: string): Promise<boolean> {
  const isCurrent = captureNavigationContext()
  if (!isCurrent()) return false
  const state = useStore.getState()
  const task = state.vaultTasks.find(task => task.id === id)
  if (!task) return false
  await state.openTaskAt(task)
  return isCurrent() && useStore.getState().selectedPath === task.sourcePath
}

/** Dispatch through the same queued task writer as desktop. Errors use core's toast UI. */
export async function moveTaskToColumn(
  host: TaskActionHost,
  taskId: string,
  groupBy: KanbanGroupBy,
  columnId: string
): Promise<boolean> {
  try { if (!host.isCurrent()) return false } catch { return false }
  const state = useStore.getState()
  if (!state.vault || state.kanbanGroupBy !== groupBy) return false
  const task = state.vaultTasks.find(task => task.id === taskId)
  if (!task) return false
  const mutations = dropMutationsFor(groupBy, columnId, task, new Date())
  if (!mutations) return false
  if (mutations.length) await state.applyTaskMutation(task, mutations)
  return true
}

/** Today/overdue groups use core's filtering and file order, including file tasks. */
export function getTodayTasks(now = new Date()): { readonly tasks: readonly TaskSnapshot[]; readonly overdueCount: number } {
  const state = useStore.getState()
  const livePaths = new Set(state.notes.filter(note => note.folder !== 'trash').map(note => note.path))
  const live = filterTasksForDisplay(state.vaultTasks, state.showArchivedTasks).filter(task => livePaths.has(task.sourcePath))
  const render = computeTasksRender(live, '', now, { today: false, upcoming: false, waiting: false, forwarded: false, done: false, cancelled: false })
  const publicTasks = new Map(getTasksSnapshot().tasks.map(task => [task.id, task]))
  return Object.freeze({ tasks: Object.freeze(render.groups.today.map(task => publicTasks.get(task.id)!)), overdueCount: render.groups.overdueCount ?? 0 })
}
