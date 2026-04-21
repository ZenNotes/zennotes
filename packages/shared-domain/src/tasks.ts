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
  /** ISO YYYY-MM-DD, validated via Date round-trip. */
  due?: string
  priority?: TaskPriority
  /** True if `@waiting` appears anywhere on the line. */
  waiting: boolean
  /** Inline `#tags` found on the line. */
  tags: string[]
}

export interface VaultTaskGroups {
  today: VaultTask[]
  upcoming: VaultTask[]
  waiting: VaultTask[]
  done: VaultTask[]
  overdueCount: number
}

// ---------------------------------------------------------------------------
// Frontmatter (minimal — only due/priority/status)
// ---------------------------------------------------------------------------

interface NoteDefaults {
  due?: string
  priority?: TaskPriority
  status?: string
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/

function unquote(v: string): string {
  const trimmed = v.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function normalizePriority(raw: string | undefined): TaskPriority | undefined {
  if (!raw) return undefined
  const v = raw.toLowerCase().trim()
  if (v === 'high' || v === 'h') return 'high'
  if (v === 'med' || v === 'medium' || v === 'm') return 'med'
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

/** Extract just the three keys we care about. Unparseable lines are ignored. */
function parseNoteDefaults(body: string): { defaults: NoteDefaults; fmEndOffset: number } {
  const m = body.match(FRONTMATTER_RE)
  if (!m) return { defaults: {}, fmEndOffset: 0 }
  const block = m[1]
  const defaults: NoteDefaults = {}
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
    }
  }
  return { defaults, fmEndOffset: m[0].length }
}

// ---------------------------------------------------------------------------
// Inline token extraction
// ---------------------------------------------------------------------------

// Word-boundary anchored so `due:` inside a URL-ish blob won't match.
const INLINE_DUE_RE = /(?:^|\s)due:(\S+)/i
const INLINE_PRIORITY_RE = /(?:^|\s)!(high|med|medium|low|h|m|l)\b/i
const INLINE_WAITING_RE = /(?:^|\s)@waiting\b/i
// Match #tag-like tokens but only when preceded by start-of-string/whitespace.
const INLINE_TAG_RE = /(?:^|\s)#([a-z0-9][a-z0-9/_-]*)/gi

interface ExtractedTokens {
  due?: string
  priority?: TaskPriority
  waiting: boolean
  tags: string[]
  /** Tail with matched tokens stripped, for clean display. */
  stripped: string
}

function extractTokens(tail: string): ExtractedTokens {
  let due: string | undefined
  let priority: TaskPriority | undefined
  let waiting = false
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

/** Parse every checkbox in `body`, skipping fenced code. Index counting is
 *  byte-for-byte identical to `toggleTaskAtIndex` so round-trip edits stay
 *  stable.  */
export function parseTasksFromBody(body: string, ctx: ParseTasksContext): VaultTask[] {
  const normalized = body.replace(/\r\n/g, '\n')
  const { defaults } = parseNoteDefaults(normalized)
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
      due: tokens.due ?? defaults.due,
      priority: tokens.priority ?? defaults.priority,
      waiting: tokens.waiting,
      tags: tokens.tags
    })

    taskIndex += 1
  }

  return tasks
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

/** Group using a "today" anchor — caller supplies it so tests are stable and
 *  the user's timezone is respected. Waiting overrides everything except Done.
 *  Tasks without a due date land in Today. */
export function groupTasks(tasks: VaultTask[], today: Date): VaultTaskGroups {
  const todayIso = toIsoDate(today)
  const today_: VaultTask[] = []
  const upcoming: VaultTask[] = []
  const waiting: VaultTask[] = []
  const done: VaultTask[] = []
  let overdueCount = 0

  for (const task of tasks) {
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

  return { today: today_, upcoming, waiting, done, overdueCount }
}

/** Helper for UIs that need to know whether a task is overdue relative to now. */
export function isOverdue(task: VaultTask, today: Date): boolean {
  if (task.checked || task.waiting || !task.due) return false
  return task.due < toIsoDate(today)
}
