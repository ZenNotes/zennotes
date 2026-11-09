import { syntaxTree } from '@codemirror/language'
import type { EditorState, StateCommand, Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { Vim } from '@replit/codemirror-vim'
import { insertNewlineContinueFencedCodeIndent } from './cm-code-fence-indent'
import { lineBelowAnchor } from './cm-fold-line-below'
import { insertNewlineContinueMarkupTight } from './cm-tight-list-enter'
import { listContinuationPrefix } from './list-continuation'

// Enter's markup continuations, in vimAwareMarkdownKeymap's order. The
// frontmatter list one is left out: the frontmatter is never in a quote.
const enterContinuations: readonly StateCommand[] = [
  insertNewlineContinueFencedCodeIndent,
  insertNewlineContinueMarkupTight
]

function lineInQuote(state: EditorState, lineNumber: number): boolean {
  const line = state.doc.line(lineNumber)
  const end = line.from + line.text.trimEnd().length
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(end, -1); node; node = node.parent) {
    if (node.name === 'Blockquote') return true
  }
  return false
}

/** What the caret's line starts with after Enter at the end of line
 *  `lineNumber`, or null when Enter opens no line below it there. */
function enterPrefix(state: EditorState, lineNumber: number): string | null {
  const line = state.doc.line(lineNumber)
  const atEnd = state.update({ selection: { anchor: line.to } }).state
  for (const command of enterContinuations) {
    const out: { tr?: Transaction } = {}
    const handled = command({
      state: atEnd,
      dispatch: (tr) => {
        out.tr = tr
      }
    })
    if (!handled || !out.tr) continue
    const { changes, state: next } = out.tr
    const head = next.selection.main.head
    const landed = next.doc.lineAt(head)
    // An empty item's Enter ends the list and leaves the caret on that
    // line: it is this one, not a new one.
    const own = next.doc.lineAt(changes.mapPos(line.from, 1))
    return landed.number > own.number ? next.sliceDoc(landed.from, head) : null
  }
  return null
}

/**
 * The prefix for a line Vim's `o`/`O` open from line `lineNumber` when it sits
 * in a blockquote or callout, or null outside one.
 *
 * Vim's own open-line copies only leading whitespace, which drops the `>` and
 * puts the new line outside the quote. The prefix is read off Enter's own
 * commands, run on a scratch state, so `o` and Enter cannot disagree:
 * `> - item` opens `> - `, `> 1. a` opens `> 2. `, `>   more` opens `>   `,
 * and a code line in a quoted fence opens `> ` plus its indentation (#961).
 *
 * On an empty list item or a second blank `>` line Enter ends the markup
 * instead; `o` still continues it there, as on an empty list item outside a
 * quote, so the line is read with placeholder content.
 */
export function quotedOpenLinePrefix(state: EditorState, lineNumber: number): string | null {
  if (!lineInQuote(state, lineNumber)) return null
  const prefix = enterPrefix(state, lineNumber)
  if (prefix != null) return prefix
  const line = state.doc.line(lineNumber)
  const filler = /\s$/.test(line.text) ? 'x' : ' x'
  return enterPrefix(state.update({ changes: { from: line.to, insert: filler } }).state, lineNumber)
}

// The handler runs as `actions[name]`, so `this` is Vim's action table.
type VimActionTable = {
  newLineAndEnterInsertMode: (cm: unknown, args: unknown, vim: unknown) => void
  enterInsertMode: (cm: unknown, args: unknown, vim: unknown) => void
}

function zenOpenLineContinuingList(
  this: VimActionTable,
  cm: { cm6?: EditorView },
  actionArgs: { after?: boolean; repeat?: number },
  vim: { insertMode?: boolean }
): void {
  const view = cm.cm6
  const line = view?.state.doc.lineAt(view.state.selection.main.head)
  const prefix =
    view && line
      ? (quotedOpenLinePrefix(view.state, line.number) ?? listContinuationPrefix(line.text))
      : null
  // On a closed fold, `o` opens below the fold's last line, as in Vim (#1066):
  // a folded heading keeps its section, and a folded item gets its next
  // sibling after its children.
  const below = view && line && actionArgs.after ? lineBelowAnchor(view.state, line.number) : null
  if (view && line && below !== null && below !== line.to) {
    vim.insertMode = true
    const insert = `\n${prefix ?? ''}`
    view.dispatch({
      changes: { from: below, insert },
      selection: { anchor: below + insert.length },
      scrollIntoView: true
    })
    this.enterInsertMode(cm, { repeat: actionArgs.repeat }, vim)
    return
  }
  if (!view || !line || prefix == null) {
    this.newLineAndEnterInsertMode(cm, actionArgs, vim)
    return
  }
  vim.insertMode = true
  if (actionArgs.after) {
    view.dispatch({
      changes: { from: line.to, insert: `\n${prefix}` },
      selection: { anchor: line.to + 1 + prefix.length }
    })
  } else {
    view.dispatch({
      changes: { from: line.from, insert: `${prefix}\n` },
      selection: { anchor: line.from + prefix.length }
    })
  }
  this.enterInsertMode(cm, { repeat: actionArgs.repeat }, vim)
}

let openLineRegistered = false

/**
 * `o` / `O` that carry the line's markup forward, like pressing Enter (#320):
 * on a list item bullets repeat, ordered numbers advance (the renumber pass
 * fixes the exact value for both `o` and `O`), indentation is preserved, and a
 * checkbox continues as a fresh unchecked box; inside a quote or callout the
 * new line keeps its `>` (see `quotedOpenLinePrefix`). `o` on a closed fold
 * opens below the fold. Other lines fall back to Vim's built-in open-line.
 * Idempotent, so it is safe on HMR.
 */
export function registerOpenLineContinuation(): void {
  if (openLineRegistered) return
  openLineRegistered = true
  Vim.defineAction(
    'zenOpenLineContinuingList',
    zenOpenLineContinuingList as unknown as Parameters<typeof Vim.defineAction>[1]
  )
  Vim.mapCommand(
    'o',
    'action',
    'zenOpenLineContinuingList',
    { after: true },
    { context: 'normal', isEdit: true, interlaceInsertRepeat: true }
  )
  Vim.mapCommand(
    'O',
    'action',
    'zenOpenLineContinuingList',
    { after: false },
    { context: 'normal', isEdit: true, interlaceInsertRepeat: true }
  )
}
