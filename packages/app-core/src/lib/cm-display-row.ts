import { EditorSelection } from '@codemirror/state'
import type { Command, EditorView, KeyBinding } from '@codemirror/view'

/**
 * The wrap point ending the display row that contains `pos` (forward), or the
 * offset starting that row (backward). Forward returns `line.to` when the
 * cursor sits on the line's last row.
 *
 * Found by binary-searching `coordsAtPos` rows instead of hit-testing an x
 * coordinate at the viewport edge, which is what `goLineRight` does and what
 * #575 broke: under fractional display scaling the x resolution walks
 * sub-pixel glyph rects and lands several characters short of the wrap point,
 * or on a neighboring row entirely. Two positions count as the same row when
 * their vertical ranges overlap, not when their midpoints sit close: an
 * inline widget on the row (a rendered wikilink chip, say) can be taller
 * than the text beside it, and a midpoint tolerance misread that skew as a
 * wrap, which sent `A` and `$` short of a line-ending link (#582). Returns
 * null when coordinates are unavailable (unrendered or widget-only spans);
 * callers fall back structurally.
 *
 * Shared by the Vim display-row motions (`$`, `g0`, `A`, `I`) and the Home/End
 * keys, which are not Vim-specific and had the same mislanding (#591).
 */
export function displayRowEdge(view: EditorView, pos: number, forward: boolean): number | null {
  const line = view.state.doc.lineAt(pos)
  const rowCoords = (offset: number) => {
    const side: 1 | -1 = offset >= line.to ? -1 : 1
    const other: 1 | -1 = side === 1 ? -1 : 1
    return view.coordsAtPos(offset, side) ?? view.coordsAtPos(offset, other)
  }
  const anchorCoords = rowCoords(pos)
  if (!anchorCoords) return null
  const sameRow = (offset: number): boolean | null => {
    const coords = rowCoords(offset)
    if (!coords) return null
    const overlap =
      Math.min(coords.bottom, anchorCoords.bottom) - Math.max(coords.top, anchorCoords.top)
    const shortest = Math.min(
      coords.bottom - coords.top,
      anchorCoords.bottom - anchorCoords.top
    )
    return overlap > Math.max(1, shortest / 4)
  }
  if (forward) {
    let lo = pos
    let hi = line.to
    const atEnd = sameRow(hi)
    if (atEnd == null) return null
    if (atEnd) return line.to
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      const same = sameRow(mid)
      if (same == null) return null
      if (same) lo = mid
      else hi = mid
    }
    return hi
  }
  let lo = line.from
  let hi = pos
  const atStart = sameRow(lo)
  if (atStart == null) return null
  if (atStart) return line.from
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    const same = sameRow(mid)
    if (same == null) return null
    if (same) hi = mid
    else lo = mid
  }
  return hi
}

/** The row boundary, or the logical line's when coordinates are unavailable. */
function rowBoundary(view: EditorView, head: number, assoc: number, forward: boolean): number {
  const line = view.state.doc.lineAt(head)
  // An offset sitting exactly on a wrap point belongs to two rows at once: it
  // ends one and starts the next. A caret that arrived there moving forward
  // carries assoc -1 and renders at the end of the row it came along, so
  // measure the character before it, which is what CodeMirror's own boundary
  // motion does. Without this a second End press walks on to the next row.
  const probe = assoc < 0 && head > line.from ? head - 1 : head
  let edge: number | null = null
  try {
    edge = displayRowEdge(view, probe, forward)
  } catch {
    edge = null
  }
  return edge ?? (forward ? line.to : line.from)
}

/**
 * Home/End on the display row the user can actually see.
 *
 * CodeMirror's own `cursorLineBoundaryForward`/`Backward` find the row edge by
 * hit-testing an x coordinate at the editor's left or right edge
 * (`moveToLineBoundary` in @codemirror/view). That is the same resolution that
 * sent `$` several characters short of the wrap point, or onto a neighboring
 * row, under fractional display scaling (#575), and Home/End inherited it
 * unchanged (#591). ZenNotes gives the hit-test even further to travel: the
 * editor column is centered inside a much wider editor element, so the probed
 * x sits well outside the text.
 *
 * These bindings compute the boundary from row geometry instead, so no x
 * coordinate is resolved at all. The returned cursor keeps CodeMirror's own
 * association (`-1` forward, `1` backward) so a caret landing exactly on a
 * wrap point renders at the end of the row it moved along rather than at the
 * start of the next one.
 */
function displayRowBoundaryCommand(forward: boolean, extend: boolean): Command {
  return (view) => {
    const { selection } = view.state
    const next = EditorSelection.create(
      selection.ranges.map((range) => {
        const target = rowBoundary(view, range.head, range.assoc, forward)
        return extend
          ? EditorSelection.range(range.anchor, target)
          : EditorSelection.cursor(target, forward ? -1 : 1)
      }),
      selection.mainIndex
    )
    // Always report the key as handled, even when the cursor was already on the
    // boundary. Returning false would hand Home/End back to CodeMirror's
    // hit-testing commands, which is the behavior these replace.
    if (!next.eq(selection)) {
      view.dispatch({ selection: next, scrollIntoView: true, userEvent: 'select' })
    }
    return true
  }
}

export const cursorDisplayRowStart = displayRowBoundaryCommand(false, false)
export const cursorDisplayRowEnd = displayRowBoundaryCommand(true, false)
export const selectDisplayRowStart = displayRowBoundaryCommand(false, true)
export const selectDisplayRowEnd = displayRowBoundaryCommand(true, true)

/**
 * Listed ahead of `defaultKeymap`, whose Home/End bindings these replace.
 * `Mod-Home`/`Mod-End` (document start/end) carry a modifier and so still fall
 * through to it.
 */
export const displayRowBoundaryKeymap: readonly KeyBinding[] = [
  {
    key: 'Home',
    run: cursorDisplayRowStart,
    shift: selectDisplayRowStart,
    preventDefault: true
  },
  {
    key: 'End',
    run: cursorDisplayRowEnd,
    shift: selectDisplayRowEnd,
    preventDefault: true
  }
]
