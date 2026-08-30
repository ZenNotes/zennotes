/**
 * Step the cursor across inline markers without leaving the keyboard (#490).
 *
 * The formatting shortcuts drop the cursor *between* a pair — `**|**` — which
 * is right for typing but leaves you stranded once the word is done: getting
 * out means arrow keys, a mouse, or a Vim motion. These two commands hop the
 * cursor to the far side of the next (or previous) run of marker characters on
 * the line, so `**bold|**` → `**bold**|` is one keystroke, and a second hop
 * carries on to the next pair.
 *
 * A "run" is consecutive *identical* marker characters, so `**` is one hop and
 * the `](` between a link's text and its target is two — each landing spot is
 * somewhere you might actually want to type. The scan is line-scoped: inline
 * markers don't span lines, and a motion that could fling the cursor into
 * another paragraph would be worse than no motion at all.
 *
 * Deliberately not a fallback motion: with no marker to cross, the commands
 * return false and the key does whatever else it is bound to, rather than
 * inventing a jump to the end of the line.
 */
import { EditorSelection, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/**
 * Characters treated as inline markers: the six the formatting shortcuts write
 * (`**` bold, `*` italic, `~~` strike, `==` highlight, `` ` `` code, `$` math)
 * plus the bracket pairs, which is what makes the motion useful for links and
 * for anything the auto-pairs setting closes for you.
 *
 * `_` is left out on purpose — it is a valid emphasis marker, but snake_case
 * words are common enough in notes that including it would stop the cursor in
 * the middle of ordinary text.
 */
const MARKER_CHARS = new Set(['*', '~', '=', '`', '$', '(', ')', '[', ']', '{', '}'])

export function isMarkerChar(ch: string): boolean {
  return MARKER_CHARS.has(ch)
}

export interface MarkerHopOptions {
  /**
   * Count straight quotes as markers too. Auto-pair quotes drops the cursor
   * between `"|"` exactly like the formatting shortcuts do, so the hop should
   * carry it out again (#685). Only on where quotes actually auto-pair (the
   * setting, or inside code): in ordinary prose a quote is punctuation, and a
   * stop the user did not ask for is worse than the arrow keys.
   */
  quotes?: boolean
}

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u

/**
 * Whether the character at `i` is a marker. With quotes on, a `'` between two
 * word characters (`don't`, `it's`) is an apostrophe, not a pair, and is
 * skipped; a `"` is always a marker, since it never sits inside a word.
 */
function isMarkerAt(text: string, i: number, quotes: boolean): boolean {
  const ch = text[i]
  if (MARKER_CHARS.has(ch)) return true
  if (!quotes) return false
  if (ch === '"') return true
  if (ch === "'") {
    const before = i > 0 ? text[i - 1] : ''
    const after = i + 1 < text.length ? text[i + 1] : ''
    return !(WORD_CHAR_RE.test(before) && WORD_CHAR_RE.test(after))
  }
  return false
}

/**
 * Column just past the next marker run to the right of `col` (`dir` 1), or just
 * before the previous run to its left (`dir` -1). Null when the line holds no
 * marker in that direction — the caller leaves the cursor alone.
 *
 * Both directions land *outside* the run they cross, which is what makes the
 * motion reversible: hopping right then left returns the cursor to where it
 * started only when it started outside a run, and otherwise walks pair by pair
 * exactly as the issue describes.
 */
export function markerHopTarget(
  text: string,
  col: number,
  dir: 1 | -1,
  options: MarkerHopOptions = {}
): number | null {
  const quotes = options.quotes === true
  if (dir === 1) {
    let i = col
    while (i < text.length && !isMarkerAt(text, i, quotes)) i++
    if (i >= text.length) return null
    const ch = text[i]
    while (i < text.length && text[i] === ch && isMarkerAt(text, i, quotes)) i++
    return i
  }
  let i = col - 1
  while (i >= 0 && !isMarkerAt(text, i, quotes)) i--
  if (i < 0) return null
  const ch = text[i]
  while (i >= 0 && text[i] === ch && isMarkerAt(text, i, quotes)) i--
  return i + 1
}

export interface MarkerHopCommandOptions {
  /** Whether straight quotes count as markers for a cursor at `pos`; the
   *  editor answers with "wherever a quote would auto-pair here". Absent
   *  means never, which keeps the plain commands exactly as they were. */
  quotesAreMarkers?: (state: EditorState, pos: number) => boolean
}

/** Move every cursor across the next/previous marker run on its own line. */
function hopMarker(view: EditorView, dir: 1 | -1, options: MarkerHopCommandOptions): boolean {
  const { state } = view
  let moved = false
  const selection = state.selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.head)
    const quotes = options.quotesAreMarkers?.(state, range.head) ?? false
    const target = markerHopTarget(line.text, range.head - line.from, dir, { quotes })
    if (target == null) return EditorSelection.cursor(range.head)
    moved = true
    return EditorSelection.cursor(line.from + target)
  })
  if (!moved) return false
  view.dispatch({
    selection: EditorSelection.create(selection, state.selection.mainIndex),
    scrollIntoView: true
  })
  return true
}

/** `**bold|**` → `**bold**|`, then on to the next pair on the line. */
export function hopMarkerForward(view: EditorView, options: MarkerHopCommandOptions = {}): boolean {
  return hopMarker(view, 1, options)
}

/** `**bold**|` → `**bold|**`, then out to `|**bold**`. */
export function hopMarkerBackward(view: EditorView, options: MarkerHopCommandOptions = {}): boolean {
  return hopMarker(view, -1, options)
}

/** The two commands bound to the keymap, with the editor's quote rule baked in. */
export function markerHopCommands(options: MarkerHopCommandOptions): {
  forward: (view: EditorView) => boolean
  backward: (view: EditorView) => boolean
} {
  return {
    forward: (view) => hopMarker(view, 1, options),
    backward: (view) => hopMarker(view, -1, options)
  }
}
