/**
 * A new line opened below a folded line goes below the fold (#1066).
 *
 * Every fold in the editor starts at the end of a line (a heading, a list
 * item, a callout title, a code fence) and runs to the end of a later line.
 * CodeMirror maps a fold through an insertion at its start by sliding the fold
 * past the new text. So Enter, Vim's `o` or a linewise `p` at the end of a
 * folded heading put the new lines between the heading and its hidden section,
 * and the fold came loose from its heading: it then hung off the last new line,
 * hiding the section under text it does not belong to, while the heading
 * itself showed no fold at all.
 *
 * Vim settles this by treating a closed fold as one line: `o` and `p` on it
 * open below the fold's last line. These rules do the same:
 *
 *  - A typed or pasted insertion that starts with a line break, made exactly
 *    at a fold's start, lands at the fold's end instead. The fold stays on
 *    its line and keeps covering what it covered; the new text shows below it.
 *  - Any other typed or pasted insertion that breaks the line a fold starts on
 *    (Enter in the middle of a folded heading, multi-line text pasted at its
 *    end) opens that fold, since it no longer belongs to the line it hangs on.
 *
 * Only user input moves: a change from a file reload, a workflow or a sync
 * lands exactly where it was made, so the editor never disagrees with the
 * bytes on disk about where text went.
 */
import { foldedRanges, unfoldEffect } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  type Extension,
  type SelectionRange,
  type StateEffect,
  Transaction,
  type TransactionSpec
} from '@codemirror/state'

/** The end of the outermost fold that starts exactly at `pos`, when that fold
 *  starts and ends at line ends, else null. */
export function closedFoldEndAt(state: EditorState, pos: number): number | null {
  let end: number | null = null
  foldedRanges(state).between(pos, pos, (from, to) => {
    if (from !== pos || to <= from) return
    if (state.doc.lineAt(to).to !== to) return
    if (end === null || to > end) end = to
  })
  if (end === null || state.doc.lineAt(pos).to !== pos) return null
  return end
}

/** Where a Vim put or open-line below `lineNumber` belongs: the end of the
 *  last line of the closed fold that starts on that line, else the line's own
 *  end. Folds stacked end to end are followed to the last one. */
export function lineBelowAnchor(state: EditorState, lineNumber: number): number {
  let pos = state.doc.line(lineNumber).to
  for (let guard = 0; guard < 100; guard++) {
    const end = closedFoldEndAt(state, pos)
    if (end === null || end === pos) break
    pos = end
  }
  return pos
}

function singleInsertion(tr: Transaction): { pos: number; text: string } | null {
  let found: { pos: number; text: string } | null = null
  let count = 0
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    count++
    if (fromA === toA) found = { pos: fromA, text: inserted.toString() }
  })
  return count === 1 ? found : null
}

/** A position in the document as the original change left it, carried over
 *  to the document where the same text went in at `end` instead of `pos`. */
function relocatePos(x: number, pos: number, end: number, length: number): number {
  if (x < pos) return x
  if (x <= pos + length) return end + (x - pos)
  const before = x - length
  return before < end ? before : x
}

const moveBelowFold = EditorState.transactionFilter.of((tr): TransactionSpec | Transaction => {
  if (!tr.docChanged || !tr.isUserEvent('input') || tr.effects.length > 0) return tr
  const insertion = singleInsertion(tr)
  if (!insertion || !insertion.text.startsWith('\n')) return tr
  const end = closedFoldEndAt(tr.startState, insertion.pos)
  if (end === null) return tr
  const { pos, text } = insertion
  const length = text.length
  const move = (range: SelectionRange): SelectionRange =>
    EditorSelection.range(
      relocatePos(range.anchor, pos, end, length),
      relocatePos(range.head, pos, end, length)
    )
  const userEvent = tr.annotation(Transaction.userEvent)
  const addToHistory = tr.annotation(Transaction.addToHistory)
  return {
    changes: { from: end, insert: text },
    ...(tr.selection
      ? {
          selection: EditorSelection.create(tr.selection.ranges.map(move), tr.selection.mainIndex)
        }
      : {}),
    scrollIntoView: tr.scrollIntoView,
    ...(userEvent ? { userEvent } : {}),
    ...(addToHistory === false ? { annotations: Transaction.addToHistory.of(false) } : {})
  }
})

const openBrokenFolds = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input')) return null
  const folded = foldedRanges(tr.startState)
  if (folded.size === 0) return null
  const doc = tr.startState.doc
  const effects: StateEffect<unknown>[] = []
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (inserted.lines < 2) return
    // A pure insertion of whole lines at the start of the fold's line leaves
    // that line intact.
    const wholeLinesAtStart = fromA === toA && inserted.line(inserted.lines).length === 0
    folded.between(doc.lineAt(fromA).from, doc.lineAt(toA).to, (from, to) => {
      const first = doc.lineAt(from)
      if (toA < first.from || fromA > from) return
      if (fromA === first.from && wholeLinesAtStart) return
      const mappedFrom = tr.changes.mapPos(from, 1)
      const mappedTo = tr.changes.mapPos(to, -1)
      if (mappedFrom < mappedTo) effects.push(unfoldEffect.of({ from: mappedFrom, to: mappedTo }))
    })
  })
  return effects.length > 0 ? { effects } : null
})

/** Keeps folds on their own lines when a line is opened below one. */
export function foldLineBelow(): Extension {
  return [moveBelowFold, openBrokenFolds]
}
