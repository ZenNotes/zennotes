import type { NoteMeta } from '@shared/ipc'
import type { VaultTask, VaultTaskGroups } from '@shared/tasks'
import { TASK_FILE_TAG, groupTasks, isOverdue } from '@shared/tasks'

/** Each note's tags by vault path: what `filterTasks` reads for a file task's
 *  body. Built from the note list the Tags view reads, so the two agree. */
export type NoteTagsByPath = ReadonlyMap<string, readonly string[]>

export function noteTagsByPath(notes: readonly Pick<NoteMeta, 'path' | 'tags'>[]): NoteTagsByPath {
  return new Map(notes.map((note) => [note.path, note.tags]))
}

/** Simple substring filter across content, note title, tags, fields, and
 *  priority. Tags match with the leading `#` so `#proj` narrows the way it
 *  reads in a note. `@key:value` fields are stripped from the display content,
 *  so they match against the reassembled token: `@project`, `project:alpha`,
 *  and plain `alpha` all reach a task carrying `@project:alpha`.
 *
 *  A file task (a note with `tags: [task]`) is its whole note, so a `#tag`
 *  written in the note's body narrows to it too, read from `noteTags` (#1008).
 *  Its `tags` hold only the frontmatter list, which is what every parser copy
 *  (MCP, zn, the server) reports, so this widens the filter and nothing else.
 *  A checkbox task keeps to its own line: a tag elsewhere in its note says
 *  nothing about that one task. */
export function filterTasks(
  tasks: VaultTask[],
  query: string,
  noteTags?: NoteTagsByPath | null
): VaultTask[] {
  const q = query.trim().toLowerCase()
  if (!q) return tasks
  const tagMatches = (tag: string): boolean => `#${tag.toLowerCase()}`.includes(q)
  return tasks.filter((task) => {
    if (task.content.toLowerCase().includes(q)) return true
    if (task.noteTitle.toLowerCase().includes(q)) return true
    if (task.priority && `!${task.priority}`.includes(q)) return true
    if (task.tags.some(tagMatches)) return true
    if (task.fields) {
      for (const [key, value] of Object.entries(task.fields)) {
        if (`@${key}:${value}`.toLowerCase().includes(q)) return true
      }
    }
    if (task.kind === 'file' && noteTags) {
      // The `task` marker itself is left out, as parseTaskFile leaves it out
      // of `tags`: "#task" should not narrow to every file task.
      const bodyTags = noteTags.get(task.sourcePath)
      if (bodyTags?.some((t) => t.toLowerCase() !== TASK_FILE_TAG && tagMatches(t))) return true
    }
    return false
  })
}

export interface FlattenedTaskRow {
  kind: 'header' | 'task'
  /** Group the row belongs to — drives the collapse state for 'task' rows. */
  group: 'today' | 'upcoming' | 'undated' | 'waiting' | 'forwarded' | 'done' | 'cancelled'
  /** Only set when kind === 'task'. */
  task?: VaultTask
  /** Only set when kind === 'header'. */
  count?: number
  /** Only set when kind === 'header' (today group). */
  overdueCount?: number
}

/** Flatten grouped tasks into a linear list for cursor navigation. Collapsed
 *  groups still show a header but no task rows. */
export function flattenRows(
  groups: VaultTaskGroups,
  collapsed: {
    today: boolean
    upcoming: boolean
    undated: boolean
    waiting: boolean
    forwarded: boolean
    done: boolean
    cancelled: boolean
  }
): FlattenedTaskRow[] {
  const rows: FlattenedTaskRow[] = []
  const push = (
    group: FlattenedTaskRow['group'],
    tasks: VaultTask[],
    extras?: Partial<FlattenedTaskRow>
  ): void => {
    if (tasks.length === 0 && group !== 'today') return
    rows.push({
      kind: 'header',
      group,
      count: tasks.length,
      ...extras
    })
    if (collapsed[group]) return
    for (const t of tasks) rows.push({ kind: 'task', group, task: t })
  }
  push('today', groups.today, { overdueCount: groups.overdueCount })
  push('upcoming', groups.upcoming)
  push('undated', groups.undated)
  push('waiting', groups.waiting)
  push('forwarded', groups.forwarded)
  push('done', groups.done)
  push('cancelled', groups.cancelled)
  return rows
}

export interface TasksRender {
  rows: FlattenedTaskRow[]
  groups: VaultTaskGroups
  filtered: VaultTask[]
}

/** Order tasks by their note's line order — grouped by note (path), then by
 *  task index within the note. The note's markdown is the single source of
 *  truth for task order, so reordering lines in a note (or from the Tasks list)
 *  is reflected here directly. */
function sortByFileOrder(tasks: VaultTask[]): VaultTask[] {
  return tasks.slice().sort((a, b) => {
    if (a.sourcePath !== b.sourcePath) return a.sourcePath < b.sourcePath ? -1 : 1
    return a.taskIndex - b.taskIndex
  })
}

/** Re-sort every group by file order (see `sortByFileOrder`). */
export function applyFileOrder(groups: VaultTaskGroups): VaultTaskGroups {
  return {
    ...groups,
    today: sortByFileOrder(groups.today),
    upcoming: sortByFileOrder(groups.upcoming),
    undated: sortByFileOrder(groups.undated),
    waiting: sortByFileOrder(groups.waiting),
    forwarded: sortByFileOrder(groups.forwarded),
    done: sortByFileOrder(groups.done),
    cancelled: sortByFileOrder(groups.cancelled)
  }
}

const PRIORITY_RANK: Record<NonNullable<VaultTask['priority']>, number> = { high: 0, med: 1, low: 2 }

/** High, then medium, then low, then none; ties by due date (none last), then
 *  note order, so tasks of one priority keep a stable, readable order. */
function sortByPriority(tasks: VaultTask[]): VaultTask[] {
  const rank = (task: VaultTask) => (task.priority ? PRIORITY_RANK[task.priority] : 3)
  return sortByFileOrder(tasks).sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    const ad = a.due ?? '9999-99-99'
    const bd = b.due ?? '9999-99-99'
    return ad === bd ? 0 : ad < bd ? -1 : 1
  })
}

/** Order by priority, still grouped by date (#989). Only the live groups
 *  re-sort; forwarded, done and cancelled keep note order, since priority no
 *  longer says what to do next there. */
export function applyPriorityOrder(groups: VaultTaskGroups): VaultTaskGroups {
  const byNote = applyFileOrder(groups)
  return {
    ...byNote,
    today: sortByPriority(groups.today),
    upcoming: sortByPriority(groups.upcoming),
    undated: sortByPriority(groups.undated),
    waiting: sortByPriority(groups.waiting)
  }
}

/** One-stop computation used by TasksView: takes raw tasks + filter + today
 *  and returns everything the view needs. Within each group, tasks follow the
 *  note's line order so editor / list reordering is reflected, or priority
 *  when the list's Order says so (#989). */
export function computeTasksRender(
  tasks: VaultTask[],
  filter: string,
  today: Date,
  collapsed: {
    today: boolean
    upcoming: boolean
    undated: boolean
    waiting: boolean
    forwarded: boolean
    done: boolean
    cancelled: boolean
  },
  order: 'note' | 'priority' = 'note',
  noteTags?: NoteTagsByPath | null
): TasksRender {
  const filtered = filterTasks(tasks, filter, noteTags)
  const grouped = groupTasks(filtered, today)
  const groups = order === 'priority' ? applyPriorityOrder(grouped) : applyFileOrder(grouped)
  const rows = flattenRows(groups, collapsed)
  return { rows, groups, filtered }
}

export { isOverdue }
