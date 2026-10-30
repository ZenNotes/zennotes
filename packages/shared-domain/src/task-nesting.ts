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
 *   (one to four; more than four means one; a marker that ends the line, an
 *   empty item, means none). A later line belongs to the item only when it is
 *   indented at least that far, so a one-space "child" of `- ` is a sibling,
 *   and `10. ` needs four columns.
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
 * - Lazy continuation: while an item's text (a paragraph) is open, a line
 *   that cannot start a block of its own continues that text however little
 *   it is indented, so it closes nothing. `- [ ] parent`, then `wraps here`
 *   at the margin, then `  - [ ] child` keeps `child` a subtask, as the chip
 *   does. What may cut the text short is what Lezer's Markdown parser (the
 *   chip's) lets interrupt a paragraph: a blank line, a heading, a fence, a
 *   `>` the text is not inside, a rule, an HTML block, a filled bullet (an
 *   empty one only inside a bulleted list) and a filled `1.` (any number,
 *   filled or not, only inside a numbered list). A setext underline (`===`)
 *   inside the item ends its text too, and an empty item, or a lone `>` that
 *   starts a quote, opens text the next line can continue, as Lezer reads
 *   them (a lone `>` inside an open quote is a blank line).
 * - A line indented four columns past the item it sits in is text while the
 *   item's text is open and code after a blank line: never a list item.
 *
 * Tabs advance to the next multiple of four.
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
  /** A numbered item: what may interrupt text depends on the lists around. */
  ordered: boolean
}

const LIST_ITEM_RE = /^([ \t]*)([-+*]|\d+[.)])([ \t]+|$)/
const BLANK_RE = /^\s*$/
const NO_QUOTES: number[] = []

// Block starts, read from a line's first character that is not a space or a
// tab: Lezer's isAtxHeading, isFencedCode, isBulletList, isOrderedList,
// isHorizontalRule, isSetextUnderline and isHTMLBlock, with [ \t] where its
// regexps say \s. The Go mirror spells the same patterns.
const HEADING_RE = /^#{1,6}(?: |$)/
const FENCE_RE = /^(?:```|~~~)/
const BULLET_RE = /^[-+*](?:[ \t]|$)/
const FILLED_BULLET_RE = /^[-+*][ \t]+[^ \t]/
const NUMBER_RE = /^\d{1,9}[.)](?:[ \t]|$)/
const FILLED_ONE_RE = /^1[.)][ \t]+[^ \t]/
const RULE_RE = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const SETEXT_UNDERLINE_RE = /^(?:=+|-+)[ \t]*$/
/** HTML blocks that may interrupt a paragraph (CommonMark's types 1 to 6). */
const HTML_INTERRUPTING_RES = [
  /^<(?:script|pre|style)(?:[ \t]|>|$)/i,
  /^<!--/,
  /^<\?/,
  /^<![A-Z]/,
  /^<!\[CDATA\[/,
  /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/?>|$)/i
]
/** The HTML block that starts only where no paragraph is open (type 7): a
 *  complete tag alone on its line. */
const HTML_TAG_LINE_RE =
  /^(?:<\/[a-z][\w-]*[ \t]*>|<[a-z][\w-]*(?:[ \t]+[a-z:_][\w.-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*>)[ \t]*$/i

/** Whether a line that opens no paragraph starts some other block that is
 *  not a list item: a heading, a fence, a rule or HTML. */
function startsOtherBlock(text: string): boolean {
  return (
    HEADING_RE.test(text) ||
    FENCE_RE.test(text) ||
    RULE_RE.test(text) ||
    HTML_INTERRUPTING_RES.some((re) => re.test(text)) ||
    HTML_TAG_LINE_RE.test(text)
  )
}

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
  /** The quote depth of the text (paragraph) the lines so far leave open, or
   *  null when none is: after a blank line, a heading, a fence, a rule, code. */
  let paragraph: number | null = null
  /** How many quotes the lines so far leave open. */
  let quotes = 0

  const truncate = (at: number): void => {
    if (at >= 0 && at < open.length) open.length = at
  }

  /** Whether each `>` sits inside the items of the level it opens from; one
   *  that does not starts a quote outside them. */
  const quotesStayInside = (markers: number[]): boolean => {
    for (let d = 0; d < markers.length; d += 1) {
      if (open.some((item) => item.depth === d && item.contentCol > markers[d])) return false
    }
    return true
  }

  /** The items' content column a line at `col` and quote `depth` is still
   *  inside, deepest first (items are open outermost first), or 0. */
  const baseFor = (depth: number, col: number): number => {
    let base = 0
    for (const item of open) {
      if (item.depth !== depth) continue
      if (item.contentCol > col) break
      base = item.contentCol
    }
    return base
  }

  /** Whether `text` may cut an open paragraph short (Lezer's endLeafBlock):
   *  a bullet only when filled or inside a bulleted list, a number only as a
   *  filled `1.` or inside a numbered list. */
  const interrupts = (text: string): boolean => {
    if (HEADING_RE.test(text) || FENCE_RE.test(text) || RULE_RE.test(text)) return true
    if (HTML_INTERRUPTING_RES.some((re) => re.test(text))) return true
    if (BULLET_RE.test(text)) return FILLED_BULLET_RE.test(text) || open.some((i) => !i.ordered)
    if (NUMBER_RE.test(text)) return FILLED_ONE_RE.test(text) || open.some((i) => i.ordered)
    return false
  }

  /** What a non-blank line does to the open paragraph: it goes on with the
   *  text (lazily, when it is indented less than the item holding the text),
   *  underlines it (which ends it), or ends it by starting something else. */
  const meetParagraph = (
    markers: number[],
    col: number,
    text: string
  ): 'continues' | 'underlines' | 'ends' => {
    if (paragraph === null) return 'ends'
    const depth = markers.length
    // A `>` past the text's own quotes, or one outside the items of its
    // level, starts a quote, which interrupts.
    if (depth > paragraph || !quotesStayInside(markers)) return 'ends'
    if (col - baseFor(depth, col) >= 4) return 'continues'
    if (interrupts(text)) return 'ends'
    if (depth === paragraph && SETEXT_UNDERLINE_RE.test(text)) {
      // Only a line inside the item holding the text underlines it; a lazy
      // `===` is more text.
      let holder: OpenItem | undefined
      for (let i = open.length - 1; i >= 0 && !holder; i -= 1) {
        if (open[i].depth === depth) holder = open[i]
      }
      if (!holder || col >= holder.contentCol) return 'underlines'
    }
    return 'continues'
  }

  return {
    visit(line, taskId) {
      const { markers, rest } = splitQuotes(line)
      const depth = markers.length
      const blank = BLANK_RE.test(rest)
      const item = blank ? null : rest.match(LIST_ITEM_RE)
      const col = item ? columnsAfter(item[1]) : indentOf(rest)
      const text = rest.replace(/^[ \t]+/, '')

      if (!blank) {
        const met = meetParagraph(markers, col, text)
        // More text closes nothing and opens nothing, even when it looks like
        // a list item (`2) more`, a line indented deep under the item).
        if (met === 'continues') return null
        if (met === 'underlines') {
          paragraph = null
          return null
        }
      }

      // A `>` past the quotes already open, or outside the items of its
      // level, starts a quote of its own.
      const startsQuote = depth > quotes || !quotesStayInside(markers)
      quotes = depth
      // Quotes this line is not inside are over.
      while (open.length > 0 && open[open.length - 1].depth > depth) open.pop()
      // Each `>` closes the items of the level it opens from that it is not
      // indented into: `- [ ] a` then `> quote` at the margin ends `a`.
      for (let d = 0; d < depth; d += 1) {
        truncate(open.findIndex((item) => item.depth === d && item.contentCol > markers[d]))
      }
      if (blank) {
        // A lone `>` inside an open quote is a blank line in it. One that
        // starts a quote opens its (empty) text, as an empty item does.
        paragraph = startsQuote ? depth : null
        return null
      }

      while (
        open.length > 0 &&
        open[open.length - 1].depth === depth &&
        open[open.length - 1].contentCol > col
      ) {
        open.pop()
      }
      const top = open[open.length - 1]
      const inner = top && top.depth === depth ? top : undefined
      // Four columns past the item it sits in, with no text open: code.
      if (col - (inner ? inner.contentCol : 0) >= 4) {
        paragraph = null
        return null
      }
      if (!item) {
        paragraph = startsOtherBlock(text) ? null : depth
        return null
      }

      const afterMarker = col + item[2].length
      const afterSpaces = columnsAfter(item[3], afterMarker)
      const spaces = afterSpaces - afterMarker
      // A marker ending the line (an empty item) takes content from the
      // column right after it, as Lezer's getListIndent counts.
      const contentCol = spaces > 4 ? afterMarker + 1 : afterSpaces
      open.push({ depth, contentCol, taskId, ordered: /\d/.test(item[2]) })
      // The item's first line opens its text unless it starts another block
      // there, or code (more than four spaces after the marker). An empty
      // item opens text as well: Lezer lets the next line continue it.
      const content = rest.slice(item[0].length)
      const code = spaces > 4 && !BLANK_RE.test(content)
      paragraph = code || startsOtherBlock(content) ? null : depth
      return taskId === null ? null : inner ? inner.taskId : null
    }
  }
}
