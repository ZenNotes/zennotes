/**
 * Subtasks on the Kanban board (#1028).
 *
 * A task's indented subtasks fold into its card instead of standing as cards
 * of their own: the card lists them (checkable) and shows how far along they
 * are. The parent links come from the task scan (`VaultTask.parentId`, read
 * from the note's list structure in shared-domain `task-nesting.ts`), so this
 * module only groups records and counts.
 *
 * The count is the note's own `2/5` chip (#512): direct subtasks only, with
 * cancelled and forwarded ones out of the total and in-progress ones not yet
 * done, through the same helpers in `task-rollup.ts`. The card lists the
 * whole subtree, deeper subtasks indented under their own parent, so every
 * checkbox folded into it stays reachable; only the fraction stops at the
 * first level, which keeps a parent's numbers identical in the note and on
 * the board.
 */
import type { VaultTask } from '@shared/tasks'
import { filterTasks, type NoteTagsByPath } from './tasks-filter'
import {
  rollupChildDone,
  rollupCountsChild,
  type ChildTaskState,
  type TaskRollup
} from './task-rollup'

export interface CardSubtask {
  task: VaultTask
  /** 1 for a subtask of the card's task, 2 for a subtask of that, and on. */
  depth: number
}

export interface FoldedTasks {
  /** Tasks that stand as cards: no parent, or one the list does not hold. */
  cards: VaultTask[]
  /** Everything folded under a card, by the card's id, in note order. */
  subtasksByCard: ReadonlyMap<string, CardSubtask[]>
}

/**
 * Split tasks into board cards and the subtasks folded into them. A task
 * whose parent is not in `tasks` (an older server that sends no links, a
 * parent the scan left out) stands as a card, so nothing ever disappears
 * from the board because of a link it cannot follow.
 */
export function foldSubtasks(tasks: readonly VaultTask[]): FoldedTasks {
  const byId = new Map(tasks.map((task) => [task.id, task] as const))
  const cards: VaultTask[] = []
  const subtasksByCard = new Map<string, CardSubtask[]>()

  for (const task of tasks) {
    let root = task
    let depth = 0
    const seen = new Set<string>([task.id])
    let looped = false
    while (root.parentId) {
      const parent = byId.get(root.parentId)
      if (!parent) break
      if (seen.has(parent.id)) {
        looped = true
        break
      }
      seen.add(parent.id)
      root = parent
      depth += 1
    }
    if (depth === 0 || looped) {
      cards.push(task)
      continue
    }
    const list = subtasksByCard.get(root.id)
    if (list) list.push({ task, depth })
    else subtasksByCard.set(root.id, [{ task, depth }])
  }

  // A subtree lives in one note, so its task index is its note order.
  for (const list of subtasksByCard.values()) {
    list.sort((a, b) => a.task.taskIndex - b.task.taskIndex)
  }
  return { cards, subtasksByCard }
}

/** A task's checkbox state in the rollup's vocabulary. */
export function taskRollupState(
  task: Pick<VaultTask, 'checked' | 'inProgress' | 'cancelled' | 'forwarded'>
): ChildTaskState {
  if (task.checked) return 'done'
  if (task.cancelled) return 'cancelled'
  if (task.forwarded) return 'forwarded'
  if (task.inProgress) return 'in-progress'
  return 'open'
}

/** Done over total for the card's direct subtasks, or null when none counts. */
export function subtaskProgress(
  card: Pick<VaultTask, 'id'>,
  subtasks: readonly CardSubtask[]
): TaskRollup | null {
  let done = 0
  let total = 0
  for (const { task } of subtasks) {
    if (task.parentId !== card.id) continue
    const state = taskRollupState(task)
    if (!rollupCountsChild(state)) continue
    total += 1
    if (rollupChildDone(state)) done += 1
  }
  return total > 0 ? { done, total } : null
}

/** Rounded down, so the bar never reads 100% while a subtask is open. */
export function progressPercent(progress: TaskRollup): number {
  if (progress.total <= 0) return 0
  return Math.floor((progress.done / progress.total) * 100)
}

/**
 * Where `Tab` (dir 1) or `Shift+Tab` (dir -1) takes the cursor inside a card:
 * null is the card itself, a number is that subtask. The walk wraps from the
 * last subtask back to the card, like the calendar's Tab through a day.
 */
export function nextSubtaskFocus(current: number | null, count: number, dir: 1 | -1): number | null {
  if (count <= 0) return null
  const from = current == null || current < 0 || current >= count ? -1 : current
  if (current != null && from === -1) return null
  const next = (((from + 1 + dir) % (count + 1)) + count + 1) % (count + 1)
  return next === 0 ? null : next - 1
}

/**
 * The cards the Tasks filter leaves on the board: a card stays when it or any
 * subtask folded into it matches, so a query that used to find a subtask's
 * own card still finds the card that now holds it.
 */
export function cardsMatchingFilter(
  cards: VaultTask[],
  subtasksByCard: ReadonlyMap<string, readonly CardSubtask[]>,
  query: string,
  noteTags: NoteTagsByPath | null | undefined
): VaultTask[] {
  if (!query.trim()) return cards
  const candidates: VaultTask[] = []
  for (const card of cards) {
    candidates.push(card)
    for (const { task } of subtasksByCard.get(card.id) ?? []) candidates.push(task)
  }
  const matched = new Set(filterTasks(candidates, query, noteTags).map((task) => task.id))
  return cards.filter(
    (card) =>
      matched.has(card.id) ||
      (subtasksByCard.get(card.id) ?? []).some(({ task }) => matched.has(task.id))
  )
}
