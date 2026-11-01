import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown'
import { ChangeSet, type ChangeSpec, type StateCommand, type Transaction } from '@codemirror/state'

// Off, Enter on an empty second item ends the list the way it already does on
// an empty third one, instead of pushing the item down under a blank line.
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false })

/**
 * The markdown Enter command, without the blank lines CodeMirror gives a
 * "loose" list.
 *
 * CodeMirror calls a list loose when a blank line separates its first two
 * items, and from then on opens every new item in it under a blank line of its
 * own. So one Shift+Enter between the first two bullets spaced out every bullet
 * typed after it (SLP on Discord, 2026-10-31). Here Enter opens the next item
 * right below, as Vim's `o` already did; a blank line the writer typed stays
 * where it is, and nothing adds more.
 *
 * Upstream inserts that blank line, and no other, as a line break, a line of
 * nothing but indentation and `>` marks, then the line break before the new
 * marker. It is taken out of the finished transaction, so ordered-list
 * renumbering and the rest of the edit stay upstream's.
 *
 * A state command, like the fence one: Vim's `o`/`O` run it on a scratch state.
 */
export const insertNewlineContinueMarkupTight: StateCommand = ({ state, dispatch }) => {
  const out: { tr?: Transaction } = {}
  const handled = continueMarkup({
    state,
    dispatch: (tr) => {
      out.tr = tr
    }
  })
  if (!handled || !out.tr) return handled
  const { tr } = out
  const gaps: ChangeSpec[] = []
  tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
    if (inserted.lines !== 3 || inserted.line(1).length > 0) return
    const blank = inserted.line(2)
    if (/^[\s>]*$/.test(blank.text)) gaps.push({ from: fromB + 1, to: fromB + blank.length + 2 })
  })
  if (gaps.length === 0) {
    dispatch(tr)
    return true
  }
  const drop = ChangeSet.of(gaps, tr.newDoc.length)
  dispatch(
    state.update({
      changes: tr.changes.compose(drop),
      selection: tr.newSelection.map(drop),
      scrollIntoView: true,
      userEvent: 'input'
    })
  )
  return true
}
