import type { NoteFolder } from './ipc.js'

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
  /** True for a `[-]` task cancelled, intentionally abandoned (#450). Mutually
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
