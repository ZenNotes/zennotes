import { parseFrontmatterFields, unquote } from './frontmatter'
import type { NoteFolder } from './ipc'
import { FENCE_RE, TASK_LINE_RE } from './tasklists'

/**
 * Virtual path used to identify the vault-wide Tasks view as a tab in the
 * pane layout. Starts with `zen://` so it can never collide with a real
 * vault-relative path (which is always POSIX folder/file.md).
 */
export const TASKS_TAB_PATH = 'zen://tasks'

/** True when `path` is the virtual Tasks tab. */
export function isTasksTabPath(path: string | null | undefined): boolean {
  return path === TASKS_TAB_PATH
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskPriority = 'high' | 'med' | 'low'

export interface VaultTask {
  /** Stable-ish id: `${sourcePath}#${taskIndex}`. Task index shifts only when
   *  tasks are added/removed above it in the same file, so this is stable
   *  across plain content edits. */
  id: string
  /** Vault-relative POSIX path of the note containing this task. */
  sourcePath: string
  /** File name without extension (for display). */
  noteTitle: string
  /** Top-level vault folder the source note lives in. */
  noteFolder: NoteFolder
  /** 0-based line number in the full file body (frontmatter included). */
  lineNumber: number
  /** Must match `toggleTaskAtIndex` counting for round-trip edits. */
  taskIndex: number
  /** Raw line as it appears on disk. */
  rawText: string
  /** Display content (checkbox prefix + metadata tokens stripped). */
  content: string
  checked: boolean
  /** True for a `[>]` task forwarded to another note (#316). Mutually
   *  exclusive with `checked`; kept out of the today/upcoming/done buckets. */
  forwarded: boolean
  /** True for a `[-]` task cancelled — intentionally abandoned (#450). Mutually
   *  exclusive with `checked`/`forwarded`; kept out of the active buckets and
   *  collected under its own group. */
  cancelled: boolean
  /** True for a `[/]` task in progress: started, not finished (#512). Unlike
   *  the other non-empty state chars this one is still OPEN work, so it stays
   *  in Today/Upcoming, on the calendar, and on the board. It marks *how* an
   *  open task is going, not that it left the active set. */
  inProgress: boolean
  /** ISO YYYY-MM-DD, validated via Date round-trip. */
  due?: string
  /** True when `due` was *derived* from the containing daily note's date
   *  rather than written on the line. Lets UIs tell an implicit due apart
   *  from an explicit `due:` token. See `inferDailyTaskDueDates`. */
  dueInferred?: boolean
  priority?: TaskPriority
  /** True if `@waiting` appears anywhere on the line. */
  waiting: boolean
  /** All inline `@key:value` fields on the line (lower-cased), e.g.
   *  `@status:review @sprint:24`. Any key can drive a Kanban group-by. Optional
   *  so hand-built task fixtures stay terse; the parser always sets it. (#354) */
  fields?: Record<string, string>
  /** Convenience accessor for `fields.status`, falling back to the note's
   *  `status:` frontmatter. The default Kanban custom field. (#354) */
  status?: string
  /** Inline `#tags` found on the line. */
  tags: string[]
  /** How this task is stored. `'file'` is a whole-note task (TaskNotes-style:
   *  a `.md` file tagged `#task`, metadata in frontmatter); `'inline'` (the
   *  default when absent) is a classic `- [ ]` checkbox line. File-tasks
   *  round-trip through frontmatter, not the checkbox, so mutators branch on
   *  this. */
  kind?: 'inline' | 'file'
  /** ISO YYYY-MM-DD start/scheduled date (frontmatter `scheduled`). File-tasks. */
  scheduled?: string
  /** ISO YYYY-MM-DD completion date (frontmatter `completedDate`). File-tasks. */
  completedDate?: string
}

export interface VaultTaskGroups {
  today: VaultTask[]
  upcoming: VaultTask[]
  waiting: VaultTask[]
  done: VaultTask[]
  forwarded: VaultTask[]
  cancelled: VaultTask[]
  overdueCount: number
}

// ---------------------------------------------------------------------------
// Frontmatter (minimal — only due/priority/status)
// ---------------------------------------------------------------------------

interface NoteDefaults {
  due?: string
  priority?: TaskPriority
  status?: string
  tasksMode: NoteTasksMode
}

/**
 * How a note participates in the Tasks system, from its frontmatter `tasks:`
 * key (#458). `'all'` (the default, and the fallback for any unrecognized
 * value): file task plus inline checkboxes, the behavior every vault had
 * before the key existed. `'none'` (`tasks: false` or `tasks: off`): the note
 * feeds nothing to any Tasks surface; its checkboxes stay plain checkboxes.
 * `'note-only'` (`tasks: note`): the note's own file task (frontmatter
 * `tags: [task]`) stays visible, but inline checkboxes are not tasks: a
 * project note that belongs on the board without its checklist spilling onto
 * it.
 *
 * No runtime in this app types YAML scalars, so `tasks: false` arrives as the
 * string "false"; matching is exact string comparison after lower-casing.
 * Mirrored in the MCP and Go parsers; keep the accepted values identical.
 */
export type NoteTasksMode = 'all' | 'note-only' | 'none'

export function noteTasksMode(value: string | string[] | undefined): NoteTasksMode {
  const scalar = Array.isArray(value) ? value[0] : value
  const v = scalar?.trim().toLowerCase()
  if (v === 'false' || v === 'off') return 'none'
  if (v === 'note') return 'note-only'
  return 'all'
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/

function normalizePriority(raw: string | undefined): TaskPriority | undefined {
  if (!raw) return undefined
  const v = raw.toLowerCase().trim()
  if (v === 'high' || v === 'h') return 'high'
  // `normal` is the TaskNotes default priority; map it onto ZenNotes' `med`.
  if (v === 'med' || v === 'medium' || v === 'normal' || v === 'm') return 'med'
  if (v === 'low' || v === 'l') return 'low'
  return undefined
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(t)
}

function normalizeDueDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const cleaned = unquote(raw.trim())
  return isValidIsoDate(cleaned) ? cleaned : undefined
}

/** Extract just the keys we care about. Unparseable lines are ignored. */
function parseNoteDefaults(body: string): { defaults: NoteDefaults; fmEndOffset: number } {
  const m = body.match(FRONTMATTER_RE)
  if (!m) return { defaults: { tasksMode: 'all' }, fmEndOffset: 0 }
  const block = m[1]
  const defaults: NoteDefaults = { tasksMode: 'all' }
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon < 1) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = unquote(line.slice(colon + 1))
    if (key === 'due') {
      const d = normalizeDueDate(value)
      if (d) defaults.due = d
    } else if (key === 'priority') {
      const p = normalizePriority(value)
      if (p) defaults.priority = p
    } else if (key === 'status') {
      defaults.status = value.toLowerCase()
    } else if (key === 'tasks') {
      defaults.tasksMode = noteTasksMode(value)
    }
  }
  return { defaults, fmEndOffset: m[0].length }
}

// ---------------------------------------------------------------------------
// Inline token extraction
// ---------------------------------------------------------------------------

// Word-boundary anchored so `due:` inside a URL-ish blob won't match. Optional
// whitespace after the colon so a `due: 2026-01-01` written (or inserted by the
// @-date completion) with a space parses the same as `due:2026-01-01`. (#343)
const INLINE_DUE_RE = /(?:^|\s)due:\s*(\S+)/i
const INLINE_PRIORITY_RE = /(?:^|\s)!(high|med|medium|low|h|m|l)\b/i
const INLINE_WAITING_RE = /(?:^|\s)@waiting\b/i
// Inline free-form task fields: `@<key>:<value>`, e.g. `@status:review` or
// `@sprint:24`. The colon distinguishes them from `@waiting` and the
// `@today`/`@tomorrow` date helpers (which have no colon). Any field can drive a
// Kanban group-by; `status` is simply the default one. Global so a line can
// carry several fields. (#354)
const INLINE_FIELD_RE = /(?:^|\s)@([a-z][a-z0-9_-]*):([\p{L}\d][\p{L}\d/_-]*)/giu
// Match #tag-like tokens but only when preceded by start-of-string/whitespace.
// Letters in any script (Cyrillic/CJK/…) plus digits, `_`, `-`, `/` (#205).
const INLINE_TAG_RE = /(?:^|\s)#([\p{L}\d][\p{L}\d/_-]*)/gu

interface ExtractedTokens {
  due?: string
  priority?: TaskPriority
  waiting: boolean
  fields: Record<string, string>
  tags: string[]
  /** Tail with matched tokens stripped, for clean display. */
  stripped: string
}

function extractTokens(tail: string): ExtractedTokens {
  let due: string | undefined
  let priority: TaskPriority | undefined
  let waiting = false
  const fields: Record<string, string> = {}
  const tags: string[] = []
  let stripped = tail

  const dueMatch = stripped.match(INLINE_DUE_RE)
  if (dueMatch) {
    const candidate = dueMatch[1]
    if (isValidIsoDate(candidate)) due = candidate
    stripped = stripped.replace(INLINE_DUE_RE, ' ')
  }

  const priMatch = stripped.match(INLINE_PRIORITY_RE)
  if (priMatch) {
    priority = normalizePriority(priMatch[1])
    stripped = stripped.replace(INLINE_PRIORITY_RE, ' ')
  }

  if (INLINE_WAITING_RE.test(stripped)) {
    waiting = true
    stripped = stripped.replace(INLINE_WAITING_RE, ' ')
  }

  INLINE_FIELD_RE.lastIndex = 0
  let fieldMatch: RegExpExecArray | null
  while ((fieldMatch = INLINE_FIELD_RE.exec(stripped))) {
    const key = fieldMatch[1].toLowerCase()
    const value = fieldMatch[2].toLowerCase()
    if (!(key in fields)) fields[key] = value
  }
  if (Object.keys(fields).length > 0) {
    stripped = stripped.replace(INLINE_FIELD_RE, ' ')
  }

  INLINE_TAG_RE.lastIndex = 0
  let tm: RegExpExecArray | null
  while ((tm = INLINE_TAG_RE.exec(tail))) {
    const tag = tm[1].toLowerCase()
    if (!tags.includes(tag)) tags.push(tag)
  }

  return {
    due,
    priority,
    waiting,
    fields,
    tags,
    stripped: stripped.replace(/\s+/g, ' ').trim()
  }
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export interface ParseTasksContext {
  /** Vault-relative POSIX path. */
  path: string
  /** File name without extension — used for the noteTitle field. */
  title: string
  folder: NoteFolder
}

export interface ParseTasksOptions {
  /** Scan past the note-level `tasks:` opt-out (#458): the CLI/MCP/HTTP
   *  "include excluded" escape hatch. UI surfaces never set this. */
  includeExcluded?: boolean
}

/** Parse every checkbox in `body`, skipping fenced code. Index counting is
 *  byte-for-byte identical to `toggleTaskAtIndex` so round-trip edits stay
 *  stable.  */
export function parseTasksFromBody(
  body: string,
  ctx: ParseTasksContext,
  opts?: ParseTasksOptions
): VaultTask[] {
  const normalized = body.replace(/\r\n/g, '\n')
  const { defaults } = parseNoteDefaults(normalized)

  // A note opted out via frontmatter `tasks:` contributes no inline tasks;
  // both 'none' and 'note-only' suppress checkboxes (#458). Index counting
  // below is untouched, so task ids stay stable when includeExcluded
  // re-reveals them.
  if (defaults.tasksMode !== 'all' && !opts?.includeExcluded) return []
  const lines = normalized.split('\n')
  const tasks: VaultTask[] = []

  let taskIndex = 0
  let inFence = false
  let fenceMarker: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fenceMatch = line.match(FENCE_RE)
    if (fenceMatch) {
      const marker = fenceMatch[2]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
        fenceMarker = null
      }
      continue
    }
    if (inFence) continue

    const taskMatch = line.match(TASK_LINE_RE)
    if (!taskMatch) continue

    const checkedChar = taskMatch[2]
    const tail = taskMatch[3].replace(/^\]/, '') // drop the closing `]` of the checkbox
    const checked = checkedChar === 'x' || checkedChar === 'X'
    const forwarded = checkedChar === '>'
    const cancelled = checkedChar === '-'
    const inProgress = checkedChar === '/'

    const tokens = extractTokens(tail)

    tasks.push({
      id: `${ctx.path}#${taskIndex}`,
      sourcePath: ctx.path,
      noteTitle: ctx.title,
      noteFolder: ctx.folder,
      lineNumber: i,
      taskIndex,
      rawText: line,
      content: tokens.stripped || tail.trim(),
      checked,
      forwarded,
      cancelled,
      inProgress,
      due: tokens.due ?? defaults.due,
      priority: tokens.priority ?? defaults.priority,
      waiting: tokens.waiting,
      // Fold the note's frontmatter `status:` default into the fields map so the
      // board can group by `fields.status` uniformly.
      fields:
        defaults.status && !tokens.fields.status
          ? { ...tokens.fields, status: defaults.status }
          : tokens.fields,
      status: tokens.fields.status ?? defaults.status,
      tags: tokens.tags
    })

    taskIndex += 1
  }

  return tasks
}

// ---------------------------------------------------------------------------
// File tasks (TaskNotes-style: one task per note, metadata in frontmatter)
// ---------------------------------------------------------------------------

/** The frontmatter tag that marks a whole note as a task (TaskNotes
 *  convention, interoperable with TaskForge / Obsidian TaskNotes). */
export const TASK_FILE_TAG = 'task'

/** Frontmatter `status:` values treated as complete (checked). */
const DONE_STATUSES = new Set(['done', 'complete', 'completed', 'x'])

/** Frontmatter `status:` values treated as cancelled — intentionally abandoned
 *  (#450). Kept out of the active/done buckets, collected under Cancelled. */
export const CANCELLED_STATUSES = new Set(['cancelled', 'canceled'])

/** Frontmatter `status:` values treated as in progress (#512), the file-task
 *  equivalent of a `- [/]` checkbox. `in-progress` is what TaskNotes writes;
 *  the rest are what people type by hand. These stay OPEN, so a file task
 *  someone started still shows up in Today. */
export const IN_PROGRESS_STATUSES = new Set([
  'in-progress',
  'in progress',
  'inprogress',
  'doing',
  'started',
  'wip'
])

function asArray(v: string | string[] | undefined): string[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function firstScalar(v: string | string[] | undefined): string | undefined {
  if (v == null) return undefined
  return Array.isArray(v) ? v[0] : v
}

/**
 * Parse a whole-note "file task" from `body`, or return null when the note is
 * not a task file (its frontmatter `tags` don't include `task`). All metadata
 * comes from frontmatter; the note body is free-form notes about the task. This
 * is emitted *in addition* to any inline `- [ ]` checkboxes in the same body
 * (which act as subtasks), each keeping its own id.
 */
export function parseTaskFile(
  body: string,
  ctx: ParseTasksContext,
  opts?: ParseTasksOptions
): VaultTask | null {
  const normalized = body.replace(/\r\n/g, '\n')
  const m = normalized.match(FRONTMATTER_RE)
  if (!m) return null
  const fm = parseFrontmatterFields(m[1])

  // `tasks: false` wins over `tags: [task]`: the note stops being a task on
  // every surface. `tasks: note` deliberately falls through: it suppresses
  // only the inline checkboxes (in parseTasksFromBody), keeping this file
  // task on the board. (#458)
  if (noteTasksMode(fm.tasks) === 'none' && !opts?.includeExcluded) return null

  const tags = asArray(fm.tags).map((t) => t.replace(/^#/, '').toLowerCase())
  if (!tags.includes(TASK_FILE_TAG)) return null

  // `open` is the effective state of a note that says nothing (unchecked, not
  // cancelled), not a custom status the author chose. Only an explicit
  // `status:` reaches `fields`, so the note sits in the board's "No status"
  // column, wears no phantom `@status:open` chip, and a drop into that column
  // (which clears the key) survives the next rescan (#672).
  const explicitStatus = firstScalar(fm.status)?.toLowerCase()
  const status = explicitStatus ?? 'open'
  const title = firstScalar(fm.title)?.trim() || ctx.title

  return {
    id: `${ctx.path}#task`,
    sourcePath: ctx.path,
    noteTitle: ctx.title,
    noteFolder: ctx.folder,
    lineNumber: 0,
    taskIndex: -1,
    rawText: '',
    content: title,
    checked: DONE_STATUSES.has(status),
    forwarded: false,
    cancelled: CANCELLED_STATUSES.has(status),
    inProgress: IN_PROGRESS_STATUSES.has(status),
    due: normalizeDueDate(firstScalar(fm.due)),
    priority: normalizePriority(firstScalar(fm.priority)),
    waiting: status === 'waiting',
    fields: explicitStatus ? { status: explicitStatus } : {},
    status,
    tags: tags.filter((t) => t !== TASK_FILE_TAG),
    kind: 'file',
    scheduled: normalizeDueDate(firstScalar(fm.scheduled)),
    completedDate: normalizeDueDate(firstScalar(fm.completeddate))
  }
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function toIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Tasks the live Tasks surfaces show. Archived notes keep their tasks in the
 * markdown, but by default those tasks retire from the list, boards, and
 * calendars together with the note; `showArchived` (Settings, mirrored by the
 * `show_archived_tasks` config key) brings them back. Trash never appears,
 * which the scanners on every surface already guarantee. (#540)
 */
export function filterTasksForDisplay(tasks: VaultTask[], showArchived: boolean): VaultTask[] {
  if (showArchived) return tasks
  return tasks.filter((task) => task.noteFolder !== 'archive')
}

/** Group using a "today" anchor — caller supplies it so tests are stable and
 *  the user's timezone is respected. Waiting overrides everything except Done.
 *  Tasks without a due date land in Today. */
export function groupTasks(tasks: VaultTask[], today: Date): VaultTaskGroups {
  const todayIso = toIsoDate(today)
  const today_: VaultTask[] = []
  const upcoming: VaultTask[] = []
  const waiting: VaultTask[] = []
  const done: VaultTask[] = []
  const forwarded: VaultTask[] = []
  const cancelled: VaultTask[] = []
  let overdueCount = 0

  for (const task of tasks) {
    if (task.cancelled) {
      cancelled.push(task)
      continue
    }
    if (task.forwarded) {
      forwarded.push(task)
      continue
    }
    if (task.checked) {
      done.push(task)
      continue
    }
    if (task.waiting) {
      waiting.push(task)
      continue
    }
    if (!task.due) {
      today_.push(task)
      continue
    }
    if (task.due < todayIso) {
      today_.push(task)
      overdueCount += 1
      continue
    }
    if (task.due === todayIso) {
      today_.push(task)
      continue
    }
    upcoming.push(task)
  }

  // Sort each bucket for stable, useful ordering.
  const byDueThenPath = (a: VaultTask, b: VaultTask): number => {
    const ad = a.due ?? '9999-99-99'
    const bd = b.due ?? '9999-99-99'
    if (ad !== bd) return ad < bd ? -1 : 1
    if (a.sourcePath !== b.sourcePath) return a.sourcePath < b.sourcePath ? -1 : 1
    return a.taskIndex - b.taskIndex
  }
  const priorityRank: Record<TaskPriority, number> = { high: 0, med: 1, low: 2 }
  const byPriorityThenDue = (a: VaultTask, b: VaultTask): number => {
    const ap = a.priority ? priorityRank[a.priority] : 3
    const bp = b.priority ? priorityRank[b.priority] : 3
    if (ap !== bp) return ap - bp
    return byDueThenPath(a, b)
  }

  today_.sort(byPriorityThenDue)
  upcoming.sort(byDueThenPath)
  waiting.sort(byPriorityThenDue)
  done.sort((a, b) => {
    if (a.sourcePath !== b.sourcePath) return a.sourcePath < b.sourcePath ? -1 : 1
    return a.taskIndex - b.taskIndex
  })
  forwarded.sort(byDueThenPath)
  cancelled.sort((a, b) => {
    if (a.sourcePath !== b.sourcePath) return a.sourcePath < b.sourcePath ? -1 : 1
    return a.taskIndex - b.taskIndex
  })

  return { today: today_, upcoming, waiting, done, forwarded, cancelled, overdueCount }
}

/** Helper for UIs that need to know whether a task is overdue relative to now. */
export function isOverdue(task: VaultTask, today: Date): boolean {
  if (task.checked || task.waiting || !task.due) return false
  return task.due < toIsoDate(today)
}

/** Convert a Date to its `YYYY-MM-DD` representation in the user's local
 *  timezone — same encoding the parser produces for `due:`. Re-exported
 *  for UIs that need to align with task `due` strings. */
export function toIsoDateLocal(d: Date): string {
  return toIsoDate(d)
}

/**
 * True when a task still counts as open on the calendar surfaces: not done and
 * not cancelled. `@waiting` tasks stay open — they keep their date (#236) — and
 * so does a forwarded `[>]` origin: its copy in the target note is written
 * without the `due:` token, so dropping the origin would take the task off the
 * calendar entirely. A `[-]` cancelled task is abandoned outright, so it has no
 * business sitting next to actionable ones. (#450, #476)
 */
export function isTaskOpen(task: VaultTask): boolean {
  return !task.checked && !task.cancelled
}

/** Tasks scheduled for the given local date (ISO YYYY-MM-DD). Excludes done
 *  (checked) and cancelled tasks but KEEPS `@waiting` tasks, so a waiting task
 *  with a due date still appears on its date — matching `bucketTasksByDueDate`
 *  and the Tasks calendar. Without this the sidepanel calendar under-counted
 *  `@waiting` tasks the Tasks calendar showed. (#311, complementing #236) */
export function tasksDueOn(tasks: VaultTask[], iso: string): VaultTask[] {
  return tasks.filter((t) => isTaskOpen(t) && t.due === iso)
}

/**
 * Give undated tasks that live in a daily note an *implicit* due date equal to
 * that note's own date, using a precomputed `sourcePath -> ISO date` map (built
 * in app-core from the daily-note pattern). An explicit `due:` token always
 * wins, so only tasks with no `due` are touched; the result is flagged
 * `dueInferred` so UIs can distinguish it. Returns the same array instance when
 * nothing changed (cheap to call from a memo).
 *
 * Forwarded (`[>]`) records are exempt: the work left this note, so the note's
 * date no longer says anything about when it is due. Inferring it anyway put
 * the record back on the calendar and, for a task carried across daily notes,
 * stamped every hop with a different date, so one task read as several (#610).
 * An explicit `due:` on a forwarded record still shows, since the author wrote
 * that date on the line (the case the calendar deliberately keeps, see
 * `isTaskOpen`).
 */
export function inferDailyTaskDueDates(
  tasks: VaultTask[],
  dueByPath: ReadonlyMap<string, string>
): VaultTask[] {
  if (dueByPath.size === 0) return tasks
  let changed = false
  const out = tasks.map((task) => {
    if (task.due || task.forwarded) return task
    const iso = dueByPath.get(task.sourcePath)
    if (!iso) return task
    changed = true
    return { ...task, due: iso, dueInferred: true }
  })
  return changed ? out : tasks
}

/** Bucket tasks by `due` ISO date. Done (checked) and cancelled tasks are
 *  skipped (see `isTaskOpen`); waiting tasks are kept so a `@waiting` task with
 *  a due date still appears on the calendar on its date (#236). Tasks without a
 *  due date land in the special `'unscheduled'` key. A forwarded record only
 *  buckets when it carries an explicit date: dated, it keeps its calendar slot
 *  (the copy is written without the `due:` token, see `isTaskOpen`); undated,
 *  it is a record of a move, not unscheduled work, and listing it beside the
 *  live copy made one task read as two (#610). */
export function bucketTasksByDueDate(
  tasks: VaultTask[]
): Map<string, VaultTask[]> {
  const map = new Map<string, VaultTask[]>()
  for (const task of tasks) {
    if (!isTaskOpen(task)) continue
    if (task.forwarded && !task.due) continue
    const key = task.due ?? 'unscheduled'
    const list = map.get(key)
    if (list) list.push(task)
    else map.set(key, [task])
  }
  return map
}
