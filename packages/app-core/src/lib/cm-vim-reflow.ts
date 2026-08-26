import { CodeMirror, Vim } from '@replit/codemirror-vim'
import type { EditorView } from '@codemirror/view'
import { isInsideFrontmatter } from './cm-frontmatter'
import { reflowChanges } from './cm-reflow'

/**
 * Vim's `gq` / `gw` as reflow (#676). codemirror-vim ships them as a hard
 * wrap at `textwidth` (80 by default), which in a soft-wrapping editor
 * produces exactly the ragged paragraphs the command is reached for to fix.
 * ZenNotes wraps to the pane, so formatting a paragraph means one line per
 * paragraph: `gqip` joins the paragraph, `gqj` two lines, `Vgq` the visual
 * selection. `gq` leaves the cursor on the first formatted line like Vim,
 * `gw` keeps it where it was. There is no `textwidth` to honour: the option
 * cannot express "unlimited" (it refuses anything below 2).
 */

interface VimPos {
  line: number
  ch: number
}

interface VimRange {
  anchor: VimPos
  head: VimPos
}

interface OperatorArgs {
  linewise?: boolean
  keepCursor?: boolean
}

interface CodeMirrorAdapter {
  cm6?: EditorView
}

function zenReflow(
  cm: CodeMirrorAdapter,
  args: OperatorArgs,
  ranges: VimRange[],
  oldAnchor: VimPos
): VimPos {
  const view = cm.cm6
  const range = ranges[0]
  if (!view || !range) return oldAnchor
  const from = Math.min(range.anchor.line, range.head.line)
  let to = Math.max(range.anchor.line, range.head.line)
  // A linewise motion or a visual-line selection hands over an exclusive head
  // at column 0 of the line past the range (`gqip`, `gqj`, `Vjgq`). Step back
  // onto the last line the user meant.
  const exclusiveHead = range.head.line === to && range.head.ch === 0
  if (args.linewise && exclusiveHead && to > from) to -= 1
  const { state } = view
  const lastLine = state.doc.lines - 1
  const fromLine = state.doc.line(Math.min(from, lastLine) + 1)
  const toLine = state.doc.line(Math.min(to, lastLine) + 1)
  if (isInsideFrontmatter(state, fromLine.from)) return oldAnchor
  const changes = reflowChanges(state, fromLine.from, toLine.to, false)
  const oldLine = state.doc.line(Math.min(oldAnchor.line, lastLine) + 1)
  const oldOffset = Math.min(oldLine.from + oldAnchor.ch, oldLine.to)
  if (changes.length === 0) return oldAnchor
  const tr = state.update({ changes, userEvent: 'format.reflow' })
  view.dispatch(tr)
  const posAt = (offset: number): VimPos => {
    const line = tr.state.doc.lineAt(offset)
    return new CodeMirror.Pos(line.number - 1, offset - line.from)
  }
  // `gw` keeps the cursor on the same text (Vim: "puts the cursor back at the
  // same position in the text"); `gq` lands on the first non-blank of the last
  // formatted line, which after a join is the joined line itself.
  if (args.keepCursor) return posAt(tr.changes.mapPos(oldOffset))
  const landing = tr.state.doc.lineAt(tr.changes.mapPos(toLine.to))
  return posAt(landing.from + (landing.text.length - landing.text.trimStart().length))
}

let reflowRegistered = false

/**
 * Register `gq` / `gw` on the (per-window) global Vim, ahead of the built-in
 * hard wrap. Like the display-line motions, every renderer with an editor
 * has its own Vim singleton, so each one calls this. Idempotent, so it is
 * safe on HMR.
 */
export function registerReflowOperator(): void {
  if (reflowRegistered) return
  reflowRegistered = true
  Vim.defineOperator(
    'zenReflow',
    zenReflow as unknown as Parameters<typeof Vim.defineOperator>[1]
  )
  Vim.mapCommand('gq', 'operator', 'zenReflow', {}, {})
  Vim.mapCommand('gw', 'operator', 'zenReflow', { keepCursor: true }, {})
}
