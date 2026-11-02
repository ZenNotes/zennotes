import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown'
import { ChangeSet, type ChangeSpec, type StateCommand, type Transaction } from '@codemirror/state'

// Off, Enter on an empty second item ends the list the way it already does on
// an empty third one, instead of pushing the item down under a blank line.
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false })

/** A list item with nothing after its marker (and its task box), outside a
 *  quote: a quoted list keeps upstream's exit. */
const EMPTY_ITEM = /^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX/>-]\]\s*)?$/

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
  const sel = state.selection.main
  const line = state.doc.lineAt(sel.head)
  const onEmptyItem = sel.empty && sel.head === line.to && EMPTY_ITEM.test(line.text)
  const out: { tr?: Transaction } = {}
  const handled = continueMarkup({
    state,
    dispatch: (tr) => {
      out.tr = tr
    }
  })
  if (!handled || !out.tr) return handled
  const { tr } = out
  // Enter on an empty bullet ends the list and leaves the caret on the line
  // right under it, where Markdown still reads a typed line as part of the
  // last item ("- Bread" then "Done by Saturday." renders as one bullet). A
  // blank line goes between, so the next text starts a paragraph of its own
  // (the Android walk of 2.81.0). A nested empty item outdents instead, which
  // leaves its marker and ends nothing.
  if (onEmptyItem) {
    const head = tr.newSelection.main.head
    const now = tr.newDoc.lineAt(head)
    if (now.text === '' && now.number > 1 && tr.newDoc.line(now.number - 1).text.trim() !== '') {
      const blank = ChangeSet.of([{ from: head, insert: '\n' }], tr.newDoc.length)
      dispatch(
        state.update({
          changes: tr.changes.compose(blank),
          selection: { anchor: head + 1 },
          scrollIntoView: true,
          userEvent: 'input'
        })
      )
      return true
    }
  }
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
