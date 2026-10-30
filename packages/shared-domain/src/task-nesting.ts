/**
 * Which task a task line is a subtask of (#1028), read from the list
 * structure Markdown gives the note.
 *
 * The note's own `2/5` chip (#512, app-core `task-rollup.ts`) counts a
 * parent's subtasks from the parsed Markdown tree: a subtask is a task list
 * item in a list that sits directly inside the parent's list item. The Tasks
 * surfaces never hold that tree (they get flat task records from a scanner,
 * and on a self-hosted vault that scanner is the Go server), so this walks
 * the lines with the few CommonMark rules that decide nesting, and the Kanban
 * card can then show the same fraction the note does:
 *
 * - A list item's content starts after its marker and the spaces that follow
 *   (one to four; more than four, or none, means one). A later line belongs
 *   to the item only when it is indented at least that far, so a one-space
 *   "child" of `- ` is a sibling, and `10. ` needs four columns.
 * - Blank lines never close an item (loose lists); the next non-blank line's
 *   indent does.
 * - A non-task bullet in between owns the task under it: it is that bullet's
 *   child, not the task's above, as the tree has it.
 * - A glued checkbox (`- [x]glued`) is prose to Markdown, so it is a plain
 *   bullet here too: no parent, and nothing nests under it as a subtask.
 * - Blockquotes nest by their own markers: a quoted task's parent is a task
 *   in the same quote, a line with fewer `>` closes the deeper quote, and a
 *   blank line closes them all.
 * - A fence is a block at its own indent; the lines inside it are skipped
 *   by the caller, as the task scan already skips them.
 *
 * Lazy continuation (an unindented line continuing a list item's paragraph)
 * is deliberately not modelled: such a line closes the item here, so a task
 * below it reads as top level. Tabs advance to the next multiple of four.
 *
 * Mirrored by `taskNesting` in the Go server (ZenNotes/znserver,
 * internal/vault/task_nesting.go). Both run the cases in
 * `bridge-contract/fixtures/task-subtasks.json`; change them together.
 */

interface OpenItem {
  /** Blockquote depth the item lives at (0 outside any quote). */
  depth: number
  /** Column a line must reach to stay inside the item. */
  contentCol: number
  /** The task this item is, or null for a plain bullet or a glued checkbox. */
  taskId: string | null
}

const LIST_ITEM_RE = /^([ \t]*)([-+*]|\d+[.)])([ \t]+|$)/
const BLANK_RE = /^\s*$/
const NO_QUOTES: number[] = []

function advance(col: number, ch: string): number {
  return ch === '\t' ? col + 4 - (col % 4) : col + 1
}

/** Columns `text` spans when it starts at column `from`. */
function columnsAfter(text: string, from = 0): number {
  let col = from
  for (let i = 0; i < text.length; i += 1) col = advance(col, text[i])
  return col
}

/** The column of the first character that is not a space or tab. */
function indentOf(text: string): number {
  let col = 0
  for (let i = 0; i < text.length && (text[i] === ' ' || text[i] === '\t'); i += 1) {
    col = advance(col, text[i])
  }
  return col
}

/** The `>` markers in front of a line, each marker's column inside the level
 *  it opens from, and what is left after them (one space or tab after each
 *  `>` belongs to the marker). */
function splitQuotes(line: string): { markers: number[]; rest: string } {
  let markers = NO_QUOTES
  let pos = 0
  for (;;) {
    let i = pos
    let col = 0
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
      col = advance(col, line[i])
      i += 1
    }
    if (line[i] !== '>') break
    if (markers === NO_QUOTES) markers = []
    markers.push(col)
    i += 1
    if (line[i] === ' ' || line[i] === '\t') i += 1
    pos = i
  }
  return { markers, rest: pos === 0 ? line : line.slice(pos) }
}

/** True when the checkbox Markdown would draw: `]` then whitespace or the end
 *  of the line. `tail` is TASK_LINE_RE's group 3, which starts at the `]`. */
export function isMarkdownCheckbox(tail: string): boolean {
  return /^\](?:[ \t]|$)/.test(tail)
}

export interface TaskNesting {
  /**
   * Feed every line outside a fence, in order (an opening fence line too,
   * the lines inside it not). `taskId` is set for a task line Markdown would
   * draw as a checkbox. Returns the id of the task this line's list item sits
   * directly inside, or null.
   */
  visit(line: string, taskId: string | null): string | null
}

export function createTaskNesting(): TaskNesting {
  const open: OpenItem[] = []

  const truncate = (at: number): void => {
    if (at >= 0 && at < open.length) open.length = at
  }

  return {
    visit(line, taskId) {
      const { markers, rest } = splitQuotes(line)
      const depth = markers.length

      // Quotes this line is not inside are over.
      while (open.length > 0 && open[open.length - 1].depth > depth) open.pop()
      // Each `>` closes the items of the level it opens from that it is not
      // indented into: `- [ ] a` then `> quote` at the margin ends `a`.
      for (let d = 0; d < depth; d += 1) {
        truncate(open.findIndex((item) => item.depth === d && item.contentCol > markers[d]))
      }
      if (BLANK_RE.test(rest)) return null

      const item = rest.match(LIST_ITEM_RE)
      const col = item ? columnsAfter(item[1]) : indentOf(rest)
      while (
        open.length > 0 &&
        open[open.length - 1].depth === depth &&
        open[open.length - 1].contentCol > col
      ) {
        open.pop()
      }
      if (!item) return null

      const top = open[open.length - 1]
      const parent = top && top.depth === depth ? top.taskId : null
      const afterMarker = col + item[2].length
      const afterSpaces = columnsAfter(item[3], afterMarker)
      const spaces = afterSpaces - afterMarker
      const contentCol = spaces === 0 || spaces > 4 ? afterMarker + 1 : afterSpaces
      open.push({ depth, contentCol, taskId })
      return taskId === null ? null : parent
    }
  }
}
