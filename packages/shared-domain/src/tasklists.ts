// Shared markdown task-list primitives used by both the renderer (toggling
// checkboxes in the preview) and the main-process vault-wide task scanner.
// The index convention here MUST stay in lockstep with any parser that wants
// to round-trip a toggle — see `src/shared/tasks.ts`.

export const FENCE_RE = /^(\s*)(```|~~~)/
export const TASK_LINE_RE = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[)( |x|X)(\].*)$/

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
const DUE_TOKEN_RE = /(^|\s)due:\S+/i

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
 * Pull every UNCHECKED task line — together with its indented continuation /
 * child lines — out of `markdown`. Used to roll unfinished tasks forward from
 * past daily notes into today's note.
 *
 * - Lines are moved verbatim, so any `due:`/`!priority`/`#tag` tokens travel
 *   with the task unchanged.
 * - Checked tasks (`- [x]`) stay put — they're history.
 * - `- [ ]` inside fenced code blocks is ignored (never a real task).
 * - A task's indented children (deeper-indented following lines, up to the
 *   first blank line, dedent, or fence) move with it so sub-bullets aren't
 *   orphaned.
 *
 * Returns the moved raw lines (in document order) and the remaining body.
 */
export function extractUncheckedTaskBlocks(markdown: string): {
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
    if (taskMatch[2] !== ' ') continue // only unchecked tasks roll over

    const baseIndent = leadingIndentWidth(line)
    moved.push(line)
    consumed[i] = true

    // Carry indented continuation/child lines along with the task.
    let j = i + 1
    while (j < lines.length) {
      const next = lines[j]
      if (next.trim() === '') break
      if (FENCE_RE.test(next)) break
      if (leadingIndentWidth(next) <= baseIndent) break
      moved.push(next)
      consumed[j] = true
      j++
    }
    i = j - 1 // skip the consumed block (its children are not new tasks)
  }

  const rest = lines.filter((_, idx) => !consumed[idx]).join('\n')
  return { moved, rest }
}
