import type { EditorState, TransactionSpec } from '@codemirror/state'

// What comes after the caret inside a wikilink, and the one edit that depends
// on nothing else. Kept apart from `cm-wikilinks` because that file reads the
// store, and the completion key handler that needs this must stay free of it.

/**
 * The rest of the wikilink the caret sits in, when that link is already closed
 * on this line: the text between the caret and its `]]`. Null while the link is
 * still being typed (no `]]` ahead, or another `[[` opens before it), which is
 * the case the completion has to close itself.
 */
export function closedLinkTail(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos)
  const after = state.doc.sliceString(pos, line.to)
  const close = after.indexOf(']]')
  if (close < 0) return null
  const tail = after.slice(0, close)
  return tail.includes('[[') ? null : tail
}

/**
 * The edit that starts the display text of the wikilink a pick just filled in,
 * for the picker's `|` key (#804). `pos` is the caret the pick left behind:
 * past the `]]` when the pick closed the link itself, otherwise right after
 * the target inside a link that was already closed.
 *
 * A link that has no display text yet gets its `|` before the `]]`, after any
 * `#section` it carries, with the caret behind it. A link that already has one
 * gets no second `|`: its display text is selected, ready to be typed over.
 */
export function wikilinkDisplayTextEdit(state: EditorState, pos: number): TransactionSpec {
  const inside = state.doc.sliceString(pos - 2, pos) === ']]' ? pos - 2 : pos
  const tail = closedLinkTail(state, inside) ?? ''
  const pipe = tail.indexOf('|')
  if (pipe >= 0) {
    return { selection: { anchor: inside + pipe + 1, head: inside + tail.length } }
  }
  const at = inside + tail.length
  return {
    changes: { from: at, insert: '|' },
    selection: { anchor: at + 1 },
    userEvent: 'input.type'
  }
}

