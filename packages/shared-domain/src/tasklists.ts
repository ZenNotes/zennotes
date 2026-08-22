// Shared markdown task-list primitives used by both the renderer (toggling
// checkboxes in the preview) and the main-process vault-wide task scanner.
// The index convention here MUST stay in lockstep with any parser that wants
// to round-trip a toggle — see `src/shared/tasks.ts`.

export const FENCE_RE = /^(\s*)(```|~~~)/
// Group 2 is the checkbox state char: space (open), x/X (done), `>` (forwarded
// to another note, #316), `-` (cancelled — intentionally abandoned, #450), or
// `/` (in progress: started, not finished, #512).
// The leading `(?:>\s*)*` is a blockquote prefix — a different `>`, unrelated to
// the state char inside the brackets.
export const TASK_LINE_RE = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[)( |x|X|>|-|\/)(\].*)$/

export type TaskPriority = 'high' | 'med' | 'low'

/** Internal: walk to the task line at `taskIndex`, hand its
 *  TASK_LINE_RE match to `mutate`, and splice the result back in.
 *  Returns the markdown unchanged if `mutate` returns null/the same
 *  line, or the index is out of range. */
function editTaskAtIndex(
  markdown: string,
  taskIndex: number,
  mutate: (match: RegExpMatchArray) => string | null
): string {
  if (taskIndex < 0) return markdown

  const lines = markdown.split('\n')
  let currentTaskIndex = 0
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
    if (currentTaskIndex !== taskIndex) {
      currentTaskIndex += 1
      continue
    }

    const next = mutate(taskMatch)
    if (next == null || next === line) return markdown
    lines[i] = next
    return lines.join('\n')
  }
  return markdown
}

/** Line numbers (0-based) of every task line, indexed by task index. Counts
 *  exactly like `editTaskAtIndex` / `parseTasksFromBody` (fence-aware) so the
 *  positions line up with a `VaultTask.taskIndex`. */
function taskLineNumbers(lines: string[]): number[] {
  const out: number[] = []
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
    if (TASK_LINE_RE.test(line)) out.push(i)
  }
  return out
}

/**
 * Relocate the task line at `fromTaskIndex` to just before/after the task line
 * at `targetTaskIndex`, moving the whole markdown line. Used to reorder tasks
 * from the Tasks list (the note's line order is the source of truth). Returns
 * the markdown unchanged if either index is out of range or it's a no-op.
 */
export function moveTaskLine(
  markdown: string,
  fromTaskIndex: number,
  targetTaskIndex: number,
  position: 'before' | 'after'
): string {
  if (fromTaskIndex < 0 || targetTaskIndex < 0 || fromTaskIndex === targetTaskIndex) {
    return markdown
  }
  const lines = markdown.split('\n')
  const taskLines = taskLineNumbers(lines)
  const fromLine = taskLines[fromTaskIndex]
  const targetLine = taskLines[targetTaskIndex]
  if (fromLine == null || targetLine == null) return markdown

  const [content] = lines.splice(fromLine, 1)
  // Removing the source line shifts every later index down by one.
  const shiftedTarget = fromLine < targetLine ? targetLine - 1 : targetLine
  const insertAt = position === 'before' ? shiftedTarget : shiftedTarget + 1
  lines.splice(insertAt, 0, content)
  return lines.join('\n')
}

export function toggleTaskAtIndex(
  markdown: string,
  taskIndex: number,
  checked: boolean
): string {
  return editTaskAtIndex(markdown, taskIndex, (match) => {
    // Unchecking means "not done", and an in-progress `[/]` already is not
    // done: keep the `/` instead of collapsing it to open. Before this, a
    // Kanban drag between live columns (which applies set-checked: false)
    // silently erased the in-progress state. (#599)
    if (!checked && match[2] === '/') return `${match[1]}/${match[3]}`
    return `${match[1]}${checked ? 'x' : ' '}${match[3]}`
  })
}

/** Same as `toggleTaskAtIndex`, with a name that matches the rest of
 *  the `setTask*` mutators. Kept as a separate export for callers that
 *  want the explicit naming. */
export function setTaskCheckedAtIndex(
  markdown: string,
  taskIndex: number,
  checked: boolean
): string {
  return toggleTaskAtIndex(markdown, taskIndex, checked)
}

const WAITING_TOKEN_RE = /(^|\s)@waiting\b/i

/** Add or remove the `@waiting` marker on the task line at
 *  `taskIndex`. Adding inserts at the end of the tail with a single
 *  separating space; removing collapses any extra whitespace it left
 *  behind so the line stays tidy. */
export function setTaskWaitingAtIndex(
  markdown: string,
  taskIndex: number,
  waiting: boolean
): string {
  return editTaskAtIndex(markdown, taskIndex, (match) => {
    const prefix = match[1]
    const checkChar = match[2]
    const tailWithBracket = match[3]
    if (!tailWithBracket.startsWith(']')) return null
    const tail = tailWithBracket.slice(1)
    const has = WAITING_TOKEN_RE.test(tail)
    let nextTail = tail
    if (waiting && !has) {
      nextTail = `${tail.replace(/\s+$/u, '')} @waiting`
    } else if (!waiting && has) {
      nextTail = tail
        .replace(WAITING_TOKEN_RE, '$1')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+$/u, '')
    }
    return `${prefix}${checkChar}]${nextTail}`
  })
}

const PRIORITY_TOKEN_RE = /(^|\s)!(?:high|med|medium|low|h|m|l)\b/i
// Optional whitespace after the colon so a spaced `due: 2026-01-01` token is
// stripped/replaced as one unit when rescheduling, matching the parser. (#343)
const DUE_TOKEN_RE = /(^|\s)due:\s*\S+/i

/** Replace, insert, or remove the priority token (`!high|!med|!low`)
 *  on the task line at `taskIndex`. Pass `null` to clear. */
export function setTaskPriorityAtIndex(
  markdown: string,
  taskIndex: number,
  priority: TaskPriority | null
): string {
  return editTaskAtIndex(markdown, taskIndex, (match) => {
    const prefix = match[1]
    const checkChar = match[2]
    const tailWithBracket = match[3]
    if (!tailWithBracket.startsWith(']')) return null
    const tail = tailWithBracket.slice(1)
    const cleaned = tail.replace(PRIORITY_TOKEN_RE, '$1').replace(/\s{2,}/g, ' ')
    let nextTail: string
    if (priority) {
      // Append at the end so the inline content reads naturally before
      // the metadata token. Trim trailing whitespace so we don't
      // accumulate spaces across repeated mutations.
      nextTail = `${cleaned.replace(/\s+$/u, '')} !${priority}`
    } else {
      nextTail = cleaned.replace(/\s+$/u, '')
    }
    return `${prefix}${checkChar}]${nextTail}`
  })
}

/** Replace, insert, or remove the `due:YYYY-MM-DD` token on the task
 *  line at `taskIndex`. Pass `null` to clear. */
export function setTaskDueAtIndex(
  markdown: string,
  taskIndex: number,
  due: string | null
): string {
  return editTaskAtIndex(markdown, taskIndex, (match) => {
    const prefix = match[1]
    const checkChar = match[2]
    const tailWithBracket = match[3]
    if (!tailWithBracket.startsWith(']')) return null
    const tail = tailWithBracket.slice(1)
    const cleaned = tail.replace(DUE_TOKEN_RE, '$1').replace(/\s{2,}/g, ' ')
    let nextTail: string
    if (due) {
      nextTail = `${cleaned.replace(/\s+$/u, '')} due:${due}`
    } else {
      nextTail = cleaned.replace(/\s+$/u, '')
    }
    return `${prefix}${checkChar}]${nextTail}`
  })
}

// A valid inline-field key is a lowercase slug (mirrors INLINE_FIELD_RE in
// tasks.ts). Guarding here keeps the dynamic RegExp safe and predictable.
const FIELD_KEY_RE = /^[a-z][a-z0-9_-]*$/

/** Replace, insert, or remove an inline `@<key>:<value>` field token on the
 *  task line at `taskIndex`. Pass `value = null` to clear it. Generalizes the
 *  status token so any field (`status`, `sprint`, `area`, …) round-trips the
 *  same way. (#354) */
export function setTaskFieldAtIndex(
  markdown: string,
  taskIndex: number,
  key: string,
  value: string | null
): string {
  if (!FIELD_KEY_RE.test(key)) return markdown
  const tokenRe = new RegExp(`(^|\\s)@${key}:\\S+`, 'i')
  return editTaskAtIndex(markdown, taskIndex, (match) => {
    const prefix = match[1]
    const checkChar = match[2]
    const tailWithBracket = match[3]
    if (!tailWithBracket.startsWith(']')) return null
    const tail = tailWithBracket.slice(1)
    const cleaned = tail.replace(tokenRe, '$1').replace(/\s{2,}/g, ' ')
    const nextTail = value
      ? `${cleaned.replace(/\s+$/u, '')} @${key}:${value}`
      : cleaned.replace(/\s+$/u, '')
    return `${prefix}${checkChar}]${nextTail}`
  })
}

/** Replace, insert, or remove the `@status:<id>` token. Thin wrapper over
 *  {@link setTaskFieldAtIndex} for the default `status` field. (#354) */
export function setTaskStatusAtIndex(
  markdown: string,
  taskIndex: number,
  status: string | null
): string {
  return setTaskFieldAtIndex(markdown, taskIndex, 'status', status)
}

/** Replace everything after the checkbox on the task line at `taskIndex` with
 *  `text` (verbatim — the caller owns any `due:`/`!priority` tokens). Used by
 *  inline task editing. */
export function setTaskTextAtIndex(
  markdown: string,
  taskIndex: number,
  text: string
): string {
  return editTaskAtIndex(markdown, taskIndex, (match) => {
    const prefix = match[1]
    const checkChar = match[2]
    const tailWithBracket = match[3]
    if (!tailWithBracket.startsWith(']')) return null
    const trimmed = text.trim()
    return `${prefix}${checkChar}]${trimmed ? ` ${trimmed}` : ''}`
  })
}

/** Mark the task line at `taskIndex` as forwarded (`[>]`) and append `linkToken`
 *  (a wikilink to the note it was forwarded to) if not already present. Used by
 *  task forwarding (#316). Pass `linkToken = ''` to only flip the state. */
export function setTaskForwardedAtIndex(
  markdown: string,
  taskIndex: number,
  linkToken: string
): string {
  return editTaskAtIndex(markdown, taskIndex, (match) => {
    const prefix = match[1]
    const tailWithBracket = match[3]
    if (!tailWithBracket.startsWith(']')) return null
    const tail = tailWithBracket.slice(1).replace(/\s+$/u, '')
    const nextTail = !linkToken || tail.includes(linkToken) ? tail : `${tail} ${linkToken}`
    return `${prefix}>]${nextTail}`
  })
}

/**
 * Forward the task at `taskIndex` together with its indented subtree (#611).
 *
 * The parent line flips to `[>]` and gains `linkToken`, exactly like
 * {@link setTaskForwardedAtIndex}. Its subtree (the indented block
 * `taskBlockEnd` delimits, the same walk `extractOpenTaskBlocks` uses, loose
 * sub-paragraphs included) becomes part of the forwarded record. Open
 * subtasks (`[ ]` / `[/]`) flip to `[>]` so they stop reading as live work in
 * the source; done and cancelled subtasks keep their state, since that
 * history is what the record preserves. Only the parent carries the link.
 *
 * `childLines` is the subtree as it read BEFORE the flip, a faithful copy of
 * the task's current state, re-based to the parent's indent so the caller can
 * place it under an unindented copy in the destination note.
 *
 * Returns the markdown unchanged (and no child lines) when the index is out of
 * range or the parent line would not change.
 */
export function forwardTaskSubtreeAtIndex(
  markdown: string,
  taskIndex: number,
  linkToken: string
): { body: string; childLines: string[] } {
  const unchanged = { body: markdown, childLines: [] as string[] }
  if (taskIndex < 0) return unchanged
  const lines = markdown.split('\n')
  const parentAt = taskLineNumbers(lines)[taskIndex]
  if (parentAt == null) return unchanged

  const parentLine = lines[parentAt]
  const match = parentLine.match(TASK_LINE_RE)
  if (!match || !match[3].startsWith(']')) return unchanged
  const tail = match[3].slice(1).replace(/\s+$/u, '')
  const nextTail = !linkToken || tail.includes(linkToken) ? tail : `${tail} ${linkToken}`
  const nextParent = `${match[1]}>]${nextTail}`
  if (nextParent === parentLine) return unchanged

  const parentIndent = parentLine.match(/^[ \t]*/u)?.[0] ?? ''
  const end = taskBlockEnd(lines, parentAt, leadingIndentWidth(parentLine))

  // Re-base children to the parent's indent. When a child does not share the
  // parent's exact whitespace prefix (tabs under a space-indented parent),
  // fall back to trimming the same NUMBER of whitespace characters, so the
  // copy still nests under the destination line instead of keeping its
  // absolute depth.
  const childLines = lines.slice(parentAt + 1, end).map((l) => {
    if (l.startsWith(parentIndent)) return l.slice(parentIndent.length)
    return l.replace(/^[ \t]+/u, (ws) => ws.slice(Math.min(ws.length, parentIndent.length)))
  })

  lines[parentAt] = nextParent
  for (let i = parentAt + 1; i < end; i++) {
    const childMatch = lines[i].match(TASK_LINE_RE)
    if (childMatch && (childMatch[2] === ' ' || childMatch[2] === '/')) {
      lines[i] = `${childMatch[1]}>${childMatch[3]}`
    }
  }
  return { body: lines.join('\n'), childLines }
}

/** Mark the task line at `taskIndex` as in progress (`[/]`) when `inProgress`,
 *  or flip it back to open (`[ ]`) when not. In progress = started but not
 *  finished, so it stays an OPEN task everywhere: it keeps its place in Today,
 *  stays on the calendar, and rolls forward with the unfinished work (#512). */
export function setTaskInProgressAtIndex(
  markdown: string,
  taskIndex: number,
  inProgress: boolean
): string {
  return editTaskAtIndex(markdown, taskIndex, (match) => {
    return `${match[1]}${inProgress ? '/' : ' '}${match[3]}`
  })
}

/** Mark the task line at `taskIndex` as cancelled (`[-]`) when `cancelled`, or
 *  flip it back to open (`[ ]`) when not. Cancelled = intentionally abandoned,
 *  distinct from done or forwarded (#450). */
export function setTaskCancelledAtIndex(
  markdown: string,
  taskIndex: number,
  cancelled: boolean
): string {
  return editTaskAtIndex(markdown, taskIndex, (match) => {
    return `${match[1]}${cancelled ? '-' : ' '}${match[3]}`
  })
}

/** Remove the task line at `taskIndex` and return both the removed line and the
 *  remaining body. `line` is null when the index is out of range. Fence-aware,
 *  counting tasks the same way the parser does so the index stays in lockstep.
 *  Used to move a task to another note. */
export function takeTaskLineAtIndex(
  markdown: string,
  taskIndex: number
): { line: string | null; body: string } {
  if (taskIndex < 0) return { line: null, body: markdown }
  const lines = markdown.split('\n')
  let currentTaskIndex = 0
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
    if (!TASK_LINE_RE.test(line)) continue
    if (currentTaskIndex !== taskIndex) {
      currentTaskIndex += 1
      continue
    }
    const removed = lines[i]
    lines.splice(i, 1)
    return { line: removed, body: lines.join('\n') }
  }
  return { line: null, body: markdown }
}

/** Delete the task line at `taskIndex` entirely. */
export function removeTaskAtIndex(markdown: string, taskIndex: number): string {
  return takeTaskLineAtIndex(markdown, taskIndex).body
}

function leadingIndentWidth(line: string): number {
  return line.match(/^[ \t]*/)?.[0].length ?? 0
}

/**
 * The exclusive end index of the indented block belonging to the task line at
 * `start`: wrapped text, children, and loose sub-paragraphs. A blank line does
 * not end the block when the content after it is still deeper-indented than
 * the task, so a loose list travels whole; a dedent, a fence, or the end of
 * the note closes it, and trailing blanks are left behind.
 *
 * Shared by the daily roll-forward and task forwarding so the two carry
 * mechanisms always agree about which lines belong to a task. Stopping at the
 * first blank line used to split loose lists: forwarding carried half a task's
 * children and stranded the rest live in the source (#611 review).
 */
function taskBlockEnd(lines: string[], start: number, baseIndent: number): number {
  let end = start + 1
  while (end < lines.length) {
    const next = lines[end]
    if (next.trim() === '') {
      let j = end + 1
      while (j < lines.length && lines[j].trim() === '') j++
      if (j >= lines.length) break
      if (FENCE_RE.test(lines[j])) break
      if (leadingIndentWidth(lines[j]) <= baseIndent) break
      end = j
      continue
    }
    if (FENCE_RE.test(next)) break
    if (leadingIndentWidth(next) <= baseIndent) break
    end++
  }
  return end
}

/**
 * Pull every OPEN task line — together with its indented continuation / child
 * lines — out of `markdown`. Used to roll unfinished tasks forward from past
 * daily notes into today's note.
 *
 * - Open means `- [ ]` or `- [/]`: work not yet finished. A half-done task is
 *   the likeliest thing to want in front of you tomorrow, so it travels with
 *   its `/` intact rather than being left behind in a note nobody reopens
 *   (#512).
 * - Lines are moved verbatim, so any `due:`/`!priority`/`#tag` tokens travel
 *   with the task unchanged.
 * - The three closed states stay put: checked (`- [x]`) is history, forwarded
 *   (`- [>]`) already has a record pointing where it went, and cancelled
 *   (`- [-]`) was abandoned on purpose. Carrying those forward would undo the
 *   decision the state records.
 * - `- [ ]` inside fenced code blocks is ignored (never a real task).
 * - A task's indented children move with it so sub-bullets aren't orphaned:
 *   deeper-indented following lines, loose sub-paragraphs included, up to a
 *   dedent or a fence (see `taskBlockEnd`).
 *
 * Returns the moved raw lines (in document order) and the remaining body.
 */
export function extractOpenTaskBlocks(markdown: string): {
  moved: string[]
  rest: string
} {
  const lines = markdown.split('\n')
  const consumed = new Array<boolean>(lines.length).fill(false)
  const moved: string[] = []
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
    if (taskMatch[2] !== ' ' && taskMatch[2] !== '/') continue // only open tasks roll over

    const baseIndent = leadingIndentWidth(line)
    moved.push(line)
    consumed[i] = true

    // Carry indented continuation/child lines along with the task, loose
    // sub-paragraphs included (see taskBlockEnd, shared with forwarding).
    const blockEnd = taskBlockEnd(lines, i, baseIndent)
    for (let j = i + 1; j < blockEnd; j++) {
      moved.push(lines[j])
      consumed[j] = true
    }
    i = blockEnd - 1 // skip the consumed block (its children are not new tasks)
  }

  const rest = lines.filter((_, idx) => !consumed[idx]).join('\n')
  return { moved, rest }
}

/** A `# Tasks` … `###### Tasks` heading whose text is exactly "Tasks". */
const TASKS_HEADING_RE = /^ {0,3}(#{1,6})\s+Tasks\s*$/i
/** Any ATX heading; group 1's length is the level (number of `#`). */
const ANY_HEADING_RE = /^ {0,3}(#{1,6})\s+/
/** A CommonMark thematic break: three or more `-`, `*` or `_`, optionally
 *  spaced, on a line of their own. A `- [ ] task` line can't match, since the
 *  line must be nothing but the marker character and whitespace. */
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/

/**
 * Place forwarded / rolled-over task lines into a destination note body.
 *
 * If the note has a dedicated tasks heading (`# Tasks` … `###### Tasks`, whose
 * text is exactly "Tasks"), the lines are inserted at the end of that section —
 * after its last non-blank line, before the next heading of the same or a
 * higher level — so forwarded tasks stay grouped with the section rather than
 * landing at the bottom of the note (#452). Otherwise they are appended to the
 * end of the note, the long-standing behaviour.
 *
 * A horizontal rule closes the section too, not just a heading. Date-based
 * templates commonly separate sections with `---`, and taking only headings as
 * boundaries made the rule itself the section's last line — so forwarded tasks
 * landed *below* the separator, outside the list they belong to (#483).
 *
 * Both heading and rule lines inside fenced code blocks are ignored, so a
 * `## Tasks` or `---` in a code sample can't be mistaken for structure.
 */
export function insertTasksUnderTasksHeading(body: string, taskLines: string[]): string {
  if (taskLines.length === 0) return body

  const lines = body.split('\n')

  // Locate the "Tasks" heading (outside fenced code) and its level.
  let inFence = false
  let fenceMarker: string | null = null
  let headingIdx = -1
  let headingLevel = 0
  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = lines[i].match(FENCE_RE)
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
    const m = lines[i].match(TASKS_HEADING_RE)
    if (m) {
      headingIdx = i
      headingLevel = m[1].length
      break
    }
  }

  const block = taskLines.join('\n')

  // No Tasks heading — append to the end (unchanged behaviour).
  if (headingIdx === -1) {
    const trimmed = body.replace(/\s+$/u, '')
    return trimmed.length ? `${trimmed}\n${block}\n` : `${block}\n`
  }

  // The section runs to the next heading of the same or a higher level (fewer
  // or equal `#`), or to the end of the note.
  let sectionEnd = lines.length
  inFence = false
  fenceMarker = null
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const fenceMatch = lines[i].match(FENCE_RE)
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
    const hm = lines[i].match(ANY_HEADING_RE)
    if (hm && hm[1].length <= headingLevel) {
      sectionEnd = i
      break
    }
    if (THEMATIC_BREAK_RE.test(lines[i])) {
      sectionEnd = i
      break
    }
  }

  // Insert after the section's last non-blank line, so the new tasks join the
  // existing list and any blank line before the next section is preserved. An
  // empty section places them just below the heading (keeping one blank line if
  // the template left one).
  let lastContent = -1
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    if (lines[i].trim() !== '') lastContent = i
  }
  let insertAt: number
  if (lastContent !== -1) {
    insertAt = lastContent + 1
  } else {
    insertAt = headingIdx + 1
    if (insertAt < sectionEnd && lines[insertAt].trim() === '') insertAt += 1
  }

  return [...lines.slice(0, insertAt), ...taskLines, ...lines.slice(insertAt)].join('\n')
}
