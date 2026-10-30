/**
 * Auto-renumber ordered Markdown lists whenever the document changes.
 *
 * When a user moves, deletes, inserts, or pastes lines that touch an
 * ordered list, the literal numeric markers (`1.`, `2.`, `3.`) move
 * with their text and end up out of sequence in the source. This
 * extension fixes that by walking ordered-list regions touched by a
 * transaction and rewriting the markers so they stay contiguous.
 *
 * Marker punctuation (`.` vs `)`) is preserved per-list from the
 * first item.
 *
 * Choice of starting number:
 *   - If the first item's marker was touched as part of a *multi-line*
 *     edit (line move, paste, deletion of the prior first item), the
 *     list is renumbered starting from 1. The marker landing in slot
 *     #1 was likely just moved into place, not authored, so its
 *     literal value isn't a meaningful start.
 *   - Otherwise, the first item's existing number is preserved (so a
 *     list deliberately authored as `5. … 6. … 7. …` keeps the start
 *     when later items get edited).
 *
 * Right-aligned lists. Some people pad the shorter numbers so every
 * marker ends in one column (` 9.` above `10.`). When a list was padded
 * that way before the edit, the pass keeps it padded: a marker that
 * widens gives up its leading space (` 9.` becomes `10.`), one that
 * narrows takes a space (`10.` becomes ` 9.`), and every marker gains a
 * space when the widest number outgrows the column (99 to 100), so the
 * item text keeps one start column. Enter and `o`/`O` copy the leading
 * space of the item they continue (` 9.` gives ` 10.`); this pass is
 * what puts the new marker in line. A list nobody padded keeps today's
 * spacing: only its digits change. See `paddedMarkerEnd` for how
 * padding is told apart from indentation.
 *
 * The renumber is appended to the same transaction (via a
 * `transactionFilter` returning the original plus a sequential
 * change spec), so the move and the renumber land as a single
 * undo step.
 *
 * Programmatic edits (note swap, external file watcher) and history
 * traversal (undo / redo) opt out — programmatic loads via the
 * exported `skipOrderedListRenumber` annotation, undo/redo via the
 * CodeMirror `userEvent` they carry.
 */
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import {
  Annotation,
  EditorState,
  type ChangeSpec,
  type Extension,
  type Transaction
} from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'

/**
 * Annotation that opts a transaction out of automatic renumbering.
 * Set this on programmatic doc replacements (note switching, file
 * watcher syncs) so the user's stored content isn't rewritten on load.
 */
export const skipOrderedListRenumber = Annotation.define<boolean>()

const ORDERED_MARK_RE = /^(\d{1,9})([.)])$/

type Range = readonly [number, number]

function rangesOverlap(a: Range, b: Range): boolean {
  return a[0] <= b[1] && b[0] <= a[1]
}

/**
 * Force a complete parse so we can rely on `OrderedList` / `ListItem`
 * / `ListMark` nodes covering the changed regions. With a mounted
 * editor view this is usually a no-op (the language ViewPlugin keeps
 * the tree current); without a view (tests, programmatic dispatch
 * before the view has driven a parse) the cached tree may be empty.
 * Falls back to whatever partial tree we have if the parse budget
 * runs out — renumbering is best-effort.
 */
function getReadyTree(state: EditorState, upto = state.doc.length): Tree {
  return ensureSyntaxTree(state, upto, 50) ?? syntaxTree(state)
}

function collectOrderedLists(
  state: EditorState,
  ranges: ReadonlyArray<Range>
): SyntaxNode[] {
  const tree = getReadyTree(state)
  const found = new Map<string, SyntaxNode>()

  const record = (node: SyntaxNode): void => {
    if (node.name !== 'OrderedList') return
    const key = `${node.from}:${node.to}`
    if (!found.has(key)) found.set(key, node)
  }

  for (const [from, to] of ranges) {
    // Walk ancestors of the change start to catch lists that fully
    // contain the change region — `iterate` would only descend into
    // the deepest subtree at that position.
    let cur: SyntaxNode | null = tree.resolveInner(from, 1)
    while (cur) {
      record(cur)
      cur = cur.parent
    }
    // Then iterate down through the range to catch sibling and nested
    // lists touched by a multi-line change.
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === 'OrderedList') record(node.node)
      }
    })
  }

  return [...found.values()]
}

interface OrderedItem {
  /** Start of the `ListItem`: the column its container's content starts at. */
  from: number
  markFrom: number
  markTo: number
  /** What sits between `from` and the marker: padding, or indentation. */
  lead: string
  mark: string
  number: number
  punctuation: '.' | ')'
}

function orderedItems(state: EditorState, list: SyntaxNode): OrderedItem[] {
  const items: OrderedItem[] = []
  for (let child = list.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'ListItem') continue
    const mark = child.firstChild
    if (!mark || mark.name !== 'ListMark') continue
    const text = state.doc.sliceString(mark.from, mark.to)
    const match = ORDERED_MARK_RE.exec(text)
    if (!match) continue
    items.push({
      from: child.from,
      markFrom: mark.from,
      markTo: mark.to,
      lead: state.doc.sliceString(child.from, mark.from),
      mark: text,
      number: Number(match[1]),
      punctuation: match[2] as '.' | ')'
    })
  }
  return items
}

function insideListItem(node: SyntaxNode): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.name === 'ListItem') return true
  }
  return false
}

// A list marker sits 0 to 3 spaces past its container's content column;
// four would make the line indented code or a lazy continuation.
const MAX_PADDING = 3

/**
 * The column (counted from the list's base) every marker ends at when the
 * list is right-aligned by hand, or null when it is not.
 *
 * `lead` is measured from the `ListItem`'s start, which Lezer puts at the
 * container's content column, so the indentation that nests a list under
 * its parent item is never counted. What is left is padding only where it
 * cannot be indentation:
 *   - In a top-level list (in the document or a quote), any leading
 *     space counts. CommonMark ignores up to three there and no editor
 *     route writes them, so ` 1.` to ` 9.` is padding waiting for `10.`.
 *   - In a nested list, a uniform lead is indentation: Tab writes four
 *     spaces under `1. ` (one past its content column) and under `- `
 *     (two past). Only markers of different widths that still end in
 *     one column (`   9.` above `  10.`) prove padding there.
 * A lead holding a tab is indentation either way.
 */
function paddedMarkerEnd(
  items: ReadonlyArray<OrderedItem>,
  nested: boolean
): number | null {
  if (items.length === 0) return null
  if (items.some((item) => !/^ *$/.test(item.lead))) return null
  const end = items[0].lead.length + items[0].mark.length
  if (items.some((item) => item.lead.length + item.mark.length !== end)) {
    return null
  }
  const leads = items.map((item) => item.lead.length)
  const most = Math.max(...leads)
  if (most === 0) return null
  if (nested && Math.min(...leads) === most) return null
  return end
}

function appendRenumberChanges(
  items: ReadonlyArray<OrderedItem>,
  paddedEnd: number | null,
  keepsLead: (item: OrderedItem) => boolean,
  multiLineRanges: ReadonlyArray<Range>,
  out: ChangeSpec[]
): void {
  const first = items[0]
  const firstMark: Range = [first.markFrom, first.markTo]
  const touchedByMultiLine = multiLineRanges.some((r) =>
    rangesOverlap(r, firstMark)
  )
  const firstNumber = touchedByMultiLine ? 1 : first.number
  const marks = items.map((_, i) => `${firstNumber + i}${first.punctuation}`)

  // Numbers only grow down the list, so the last marker is the widest and
  // the first the narrowest.
  const widest = marks[marks.length - 1].length
  let end = paddedEnd == null ? null : Math.max(paddedEnd, widest)
  if (end != null && end - marks[0].length > MAX_PADDING) end = null

  items.forEach((item, i) => {
    const expected = marks[i]
    if (end == null || keepsLead(item) || !/^ *$/.test(item.lead)) {
      if (item.mark !== expected) {
        out.push({ from: item.markFrom, to: item.markTo, insert: expected })
      }
      return
    }
    const padded = ' '.repeat(end - expected.length) + expected
    if (item.lead + item.mark !== padded) {
      out.push({ from: item.from, to: item.markTo, insert: padded })
    }
  })
}

/**
 * The list `items` belong to as it stood before `tr`, found through an item
 * `tr` left alone. Padding is judged on that list, not on `tr`'s result,
 * because Enter and `o` copy ` 9.`'s space onto the ` 10.` they write and
 * so leave every padded list misaligned for a moment.
 */
function listBefore(
  tr: Transaction,
  list: SyntaxNode,
  items: ReadonlyArray<OrderedItem>,
  ranges: ReadonlyArray<Range>
): SyntaxNode | null {
  const anchor = items.find(
    (item) => !ranges.some((r) => rangesOverlap(r, [item.from, item.markTo]))
  )
  if (!anchor) return null
  const back = tr.changes.invertedDesc
  const pos = back.mapPos(anchor.markFrom)
  // Parse the old state only as far as the list reaches.
  const tree = getReadyTree(tr.startState, back.mapPos(list.to))
  let cur: SyntaxNode | null = tree.resolveInner(pos, 1)
  while (cur && cur.name !== 'OrderedList') cur = cur.parent
  return cur
}

export const orderedListRenumber: Extension = EditorState.transactionFilter.of(
  (tr) => {
    if (!tr.docChanged) return tr
    if (tr.annotation(skipOrderedListRenumber)) return tr
    if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr

    const oldDoc = tr.startState.doc
    const newDoc = tr.state.doc
    const ranges: Range[] = []
    const multiLineRanges: Range[] = []
    // Single-line edits that only add or remove blanks: someone padding or
    // unpadding a marker by hand, which the pass must not undo.
    const blankEdits: Range[] = []

    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      ranges.push([fromB, toB])
      const crossedLineInOld =
        oldDoc.lineAt(fromA).number !== oldDoc.lineAt(toA).number
      const crossedLineInNew =
        newDoc.lineAt(fromB).number !== newDoc.lineAt(toB).number
      if (crossedLineInOld || crossedLineInNew) {
        multiLineRanges.push([fromB, toB])
      } else if (
        /^[ \t]*$/.test(oldDoc.sliceString(fromA, toA)) &&
        /^[ \t]*$/.test(inserted.toString())
      ) {
        blankEdits.push([fromB, toB])
      }
    })

    if (ranges.length === 0) return tr

    const lists = collectOrderedLists(tr.state, ranges)
    if (lists.length === 0) return tr

    const keepsLead = (item: OrderedItem): boolean =>
      blankEdits.some(([from, to]) => from >= item.from && to <= item.markFrom)

    const changes: ChangeSpec[] = []
    for (const list of lists) {
      const items = orderedItems(tr.state, list)
      if (items.length === 0) continue
      const before = listBefore(tr, list, items, ranges)
      const paddedEnd = before
        ? paddedMarkerEnd(
            orderedItems(tr.startState, before),
            insideListItem(before)
          )
        : paddedMarkerEnd(
            items.filter((item) => !keepsLead(item)),
            insideListItem(list)
          )
      appendRenumberChanges(
        items,
        paddedEnd,
        keepsLead,
        multiLineRanges,
        changes
      )
    }
    if (changes.length === 0) return tr

    // `sequential: true` makes the extra changes apply on top of `tr`'s
    // resulting doc; CodeMirror composes the two ChangeSets into one
    // ChangeSet on a single Transaction so undo treats it as one step.
    return [
      tr,
      {
        changes,
        sequential: true,
        annotations: skipOrderedListRenumber.of(true)
      }
    ]
  }
)
