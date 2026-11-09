/**
 * A tap on a folded line puts the caret on that line.
 *
 * On a touch screen the caret goes where the browser's own tap handling puts
 * it, not where CodeMirror's pointer code would. iOS WebKit, tapped in the
 * empty space to the right of a fold's `…`, finds no caret spot after the
 * uneditable placeholder and settles on the next editable text instead: the
 * start of the next heading's words, past its hidden `## `. Anything typed
 * then went into that heading, and Return split it in two ("## " on one
 * line, its title on the next), on the phones and tablets alike.
 *
 * After a tap, when the caret landed past the line block the finger was on
 * and that block holds a closed fold, the caret moves to the spot CodeMirror
 * maps the tap to, which is on the folded line (the end of the fold, for a
 * tap right of the `…`). A tap anywhere else, a drag or a selection is left
 * alone.
 */
import { foldedRanges } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** Whether a caret at `head` is past a tapped line block that holds a closed
 *  fold, so the browser put it on a line the finger was not on. */
export function caretMissedFoldedBlock(
  state: EditorState,
  blockFrom: number,
  blockTo: number,
  head: number
): boolean {
  if (head <= blockTo) return false
  let folded = false
  foldedRanges(state).between(blockFrom, blockTo, (from, to) => {
    if (from >= blockFrom && to <= blockTo) {
      folded = true
      return false
    }
    return undefined
  })
  return folded
}

/** The caret the tap at (x, y) should have left, or null when it is right. */
export function settledTapCaret(view: EditorView, x: number, y: number): number | null {
  const { state } = view
  const main = state.selection.main
  if (state.selection.ranges.length !== 1 || !main.empty) return null
  const block = view.lineBlockAtHeight(y - view.documentTop)
  if (!caretMissedFoldedBlock(state, block.from, block.to, main.head)) return null
  const pos = view.posAtCoords({ x, y })
  if (pos === null || pos < block.from || pos > block.to) return null
  return pos
}

/** Moves of more than this many pixels make a touch a drag or a scroll. */
const TAP_SLOP = 10

export function foldTapCaret(): Extension {
  let start: { x: number; y: number } | null = null
  return EditorView.domEventObservers({
    touchstart(event) {
      const touch = event.touches.length === 1 ? event.touches[0] : null
      start = touch ? { x: touch.clientX, y: touch.clientY } : null
    },
    touchend(event, view) {
      const touch = event.changedTouches.length === 1 ? event.changedTouches[0] : null
      const began = start
      start = null
      if (!touch || !began) return
      if (Math.abs(touch.clientX - began.x) > TAP_SLOP || Math.abs(touch.clientY - began.y) > TAP_SLOP) return
      const { clientX: x, clientY: y } = touch
      // The browser moves the caret after touchend, on its own schedule:
      // look once it has settled, and once more in case it was slow.
      for (const delay of [80, 300]) {
        setTimeout(() => {
          if (!view.dom.isConnected) return
          const head = settledTapCaret(view, x, y)
          if (head !== null) view.dispatch({ selection: { anchor: head }, userEvent: 'select.pointer' })
        }, delay)
      }
    }
  })
}
