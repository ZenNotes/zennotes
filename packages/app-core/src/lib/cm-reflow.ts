import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { ChangeSpec, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { isInsideFrontmatter } from './cm-frontmatter'

/**
 * Reflow: join the hard-wrapped lines of a Markdown paragraph back into one
 * line. Prose pasted from a terminal, a mail client or a model reply arrives
 * wrapped at 80 or so columns; the preview treats those newlines as soft
 * breaks and reflows them (#656), but the editor shows the file as written,
 * so every source line spills a word or two onto a second visual row (#676).
 * The editor wraps to the pane on its own, so one line per paragraph is the
 * shape that looks right in both surfaces. The command changes the file:
 * that is the point, and it is one undo away.
 *
 * Paragraph structure comes from the syntax tree, so headings, list and
 * quote markers, tables, fenced and indented code, HTML blocks and links
 * across lines are never joined: a paragraph is only ever joined with
 * itself. Inside a paragraph, a line ending in two spaces, a backslash or a
 * `<br>` is an explicit break and keeps its newline, and `$$` display math
 * (which the parser reads as plain paragraph text) is left alone.
 */

const HARD_BREAK_RE = /(?: {2,}|\\|<br\s*\/?>)$/i
const MATH_FENCE_RE = /^\s*\$\$|\$\$\s*$/
const CONTINUATION_PREFIX_RE = /^[ \t]*(?:>[ \t]*)*/

interface LineJoin {
  from: number
  to: number
}

function collectJoins(
  state: EditorState,
  paragraphFrom: number,
  paragraphTo: number,
  clipFrom: number,
  clipTo: number,
  joins: LineJoin[]
): void {
  const first = state.doc.lineAt(paragraphFrom)
  const last = state.doc.lineAt(paragraphTo)
  let mathOpen = false
  for (let n = first.number; n < last.number; n += 1) {
    const line = state.doc.line(n)
    const next = state.doc.line(n + 1)
    const fences = line.text.split('$$').length - 1
    if (fences % 2 === 1) mathOpen = !mathOpen
    if (mathOpen || MATH_FENCE_RE.test(line.text) || MATH_FENCE_RE.test(next.text)) continue
    if (HARD_BREAK_RE.test(line.text)) continue
    // The newline itself must lie inside the requested range.
    if (line.to < clipFrom || line.to >= clipTo) continue
    const trailing = line.text.length - line.text.replace(/[ \t]+$/, '').length
    const lead = next.text.match(CONTINUATION_PREFIX_RE)?.[0].length ?? 0
    joins.push({ from: line.to - trailing, to: next.from + lead })
  }
}

/**
 * The changes that join every paragraph overlapping `from`..`to`. With
 * `wholeParagraphs` each touched paragraph is joined end to end; otherwise
 * only the newlines inside the range are joined, which is what a Vim motion
 * asks for (`gqj` formats two lines, not the paragraph around them).
 */
export function reflowChanges(
  state: EditorState,
  from: number,
  to: number,
  wholeParagraphs: boolean
): ChangeSpec[] {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, to + 1), 200) ?? syntaxTree(state)
  const joins: LineJoin[] = []
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.name !== 'Paragraph') return undefined
      collectJoins(
        state,
        node.from,
        node.to,
        wholeParagraphs ? node.from : from,
        wholeParagraphs ? node.to : to,
        joins
      )
      return false
    }
  })
  return joins.map((join) => ({ from: join.from, to: join.to, insert: ' ' }))
}

/**
 * Editor command: join the hard-wrapped lines of the paragraph under the
 * cursor, or of every paragraph a selection touches (line-wise, so a partial
 * selection still means whole lines). False when there is nothing to join,
 * so the key falls through.
 */
export function reflowParagraph(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (isInsideFrontmatter(state, sel.from)) return false
  const fromLine = state.doc.lineAt(sel.from)
  const toLine = state.doc.lineAt(sel.to)
  const changes = sel.empty
    ? reflowChanges(state, fromLine.from, fromLine.to, true)
    : reflowChanges(state, fromLine.from, toLine.to, false)
  if (changes.length === 0) return false
  view.dispatch({ changes, userEvent: 'format.reflow' })
  return true
}
