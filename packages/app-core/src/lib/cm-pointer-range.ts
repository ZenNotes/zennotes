import type { EditorView } from '@codemirror/view'

/**
 * Whether the pointer actually rests on the rendered glyphs of [from, to].
 * posAtCoords clamps coordinates in the blank space beside a line to the
 * nearest caret, and live preview hides a link's closing syntax, so that
 * caret lands inside a link that merely ends its line; without this check the
 * whole blank stretch after the line hovers and follows like the link (#587).
 */
export function pointerOverRange(
  view: EditorView,
  from: number,
  to: number,
  x: number,
  y: number
): boolean {
  const start = view.coordsAtPos(from, 1)
  const end = view.coordsAtPos(to, -1)
  if (!start || !end) return false
  if (y < start.top || y > end.bottom) return false
  if (y <= start.bottom && x < start.left) return false
  if (y >= end.top && x > end.right) return false
  return true
}
