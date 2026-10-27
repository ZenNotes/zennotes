import { captureNavigationContext } from './lib/navigation-context'
import { useSyncExternalStore } from 'react'
import type { VaultTask } from '@bridge-contract/tasks'
import { useStore, type KanbanGroupBy } from './store'
import { filterTasksForDisplay, inferDailyTaskDueDates, parseTasksFromBody } from '@shared/tasks'
import { TASK_LINE_RE } from '@shared/tasklists'
import { computeTasksRender } from './lib/tasks-filter'
import { buildDailyNoteDateByPath } from './lib/vault-layout'
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

/** 'retry': nothing was written and asking again later may work (the note
 *  is open with a buffer the app has yet to reload from disk, a read or the
 *  write failed, another file operation held the writer). */
export type SetTaskCheckedResult = 'applied' | 'unchanged' | 'stale' | 'retry'

/** A task line with its checkbox state blanked, so a line matches itself
 *  ticked or not. */
function lineShape(line: string): string {
  return line.replace(/\r$/, '').replace(TASK_LINE_RE, '$1 $3')
}

/** The body `toggleTaskFromList` will edit: the open buffer, else the file.
 *  Null when that is not safe to decide now: a clean buffer that differs
 *  from disk is one the foreground resync has yet to reload, and editing it
 *  would mark it dirty and save it over whatever changed on disk. */
async function bodyToEdit(path: string): Promise<string | null> {
  try {
    const open = useStore.getState().noteContents[path]
    if (!open) return (await window.zen.readNote(path)).body
    if (useStore.getState().noteDirty[path]) return open.body
    const disk = (await window.zen.readNote(path)).body
    const now = useStore.getState().noteContents[path]
    return now && now.body === disk && !useStore.getState().noteDirty[path] ? disk : null
  } catch {
    return null
  }
}

/**
 * Tick or untick a task something outside the app saw (the phones'
 * home-screen widget), through the same queued writer as a checkbox in the
 * app. `raw` is the line as that caller saw it. The task is looked up in the
 * very body the toggle will edit, by id, or by the same line elsewhere in
 * that note when lines above it moved; with neither it is left alone
 * ('stale'): the note changed since, and a tick guessed onto another line is
 * worse than a lost one. A cancelled or forwarded task is never ticked: that
 * would erase the record of the cancel or the move.
 */
export async function setTaskChecked(id: string, raw: string, checked: boolean): Promise<SetTaskCheckedResult> {
  const hash = id.lastIndexOf('#')
  const path = hash > 0 ? id.slice(0, hash) : ''
  const meta = useStore.getState().notes.find(note => note.path === path)
  if (!path || !useStore.getState().vault || !meta || meta.folder === 'trash') return 'stale'
  try { await useStore.getState().rescanTasksForPath(path) } catch { return 'retry' }

  // A file task's state is its frontmatter, not a line; it has no index to drift.
  const fileTask = useStore.getState().vaultTasks.find(task => task.id === id && task.kind === 'file')
  if (fileTask) {
    if (fileTask.checked === checked) return 'unchanged'
    if (checked && (fileTask.cancelled || fileTask.forwarded)) return 'stale'
    await useStore.getState().toggleTaskFromList(fileTask)
    const after = useStore.getState().vaultTasks.find(task => task.id === id)
    return after?.checked === checked ? 'applied' : 'retry'
  }

  const body = await bodyToEdit(path)
  if (body == null) return 'retry'
  const ctx = { path, title: meta.title, folder: meta.folder }
  const shape = lineShape(raw)
  const same = parseTasksFromBody(body, ctx).filter(task => lineShape(task.rawText) === shape)
  const task = same.find(task => task.id === id) ?? (same.length === 1 ? same[0] : undefined)
  if (!task) return 'stale'
  if (task.checked === checked) return 'unchanged'
  if (checked && (task.cancelled || task.forwarded)) return 'stale'
  await useStore.getState().toggleTaskFromList(task)

  // The writer reports nothing when it declines or fails; read back.
  const written = await bodyToEdit(path)
  const now = written == null ? undefined : parseTasksFromBody(written, ctx)[task.taskIndex]
  return now && lineShape(now.rawText) === shape && now.checked === checked ? 'applied' : 'retry'
}

/** Today/overdue groups use core's filtering and file order, including file tasks. */
export function getTodayTasks(now = new Date()): { readonly tasks: readonly TaskSnapshot[]; readonly overdueCount: number } {
  const state = useStore.getState()
  const livePaths = new Set(state.notes.filter(note => note.folder !== 'trash').map(note => note.path))
  const live = filterTasksForDisplay(state.vaultTasks, state.showArchivedTasks).filter(task => livePaths.has(task.sourcePath))
  const dated = inferDailyTaskDueDates(live, buildDailyNoteDateByPath(state.notes, state.vaultSettings))
  const render = computeTasksRender(dated, '', now, { today: false, upcoming: false, undated: false, waiting: false, forwarded: false, done: false, cancelled: false })
  const publicTasks = new Map(getTasksSnapshot().tasks.map(task => [task.id, task]))
  return Object.freeze({ tasks: Object.freeze(render.groups.today.map(task => publicTasks.get(task.id)!)), overdueCount: render.groups.overdueCount ?? 0 })
}
