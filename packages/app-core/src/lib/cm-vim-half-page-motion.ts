import { EditorSelection, type SelectionRange } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { CodeMirror, Vim } from '@replit/codemirror-vim'
import { pixelMotionFallback } from './cm-vim-display-line'
import { getKeymapBinding } from './keymaps'
import { toVimSequence } from './vim-key-sequence'

/**
 * The parts of the CM6 view the motion reads and writes. Narrow on purpose so
 * the unit test can stand in a fake with known geometry: jsdom has no layout,
 * and the real layout is checked by driving the built app.
 */
export type HalfPageView = {
  scrollDOM: { clientHeight: number; scrollHeight: number; scrollTop: number }
  contentDOM: { getBoundingClientRect: () => { left: number } }
  defaultLineHeight: number
  state: { doc: EditorView['state']['doc'] }
  coordsAtPos: (pos: number) => { left: number } | null
  moveVertically: (start: SelectionRange, forward: boolean) => SelectionRange
}

// Minimal shape of the CodeMirror-Vim adapter this motion touches.
type VimHalfPageCm = {
  firstLine: () => number
  lastLine: () => number
  /** The underlying CodeMirror 6 view (set by the codemirror-vim adapter). */
  cm6?: HalfPageView
}

type VimHalfPageMotionArgs = {
  forward?: boolean
  /** The typed count. With `explicitRepeat` on the mapping this is 0 when
   *  no count was typed, unlike most motions where it defaults to 1. */
  repeat?: number
  repeatIsExplicit?: boolean
}

type VimHalfPageState = {
  lastMotion?: unknown
  lastHSPos?: number
}

/**
 * How far one press goes. Without a count: half the visible editor, in
 * display lines for the cursor and in pixels for the viewport, the same
 * distance Vim's `scroll` option defaults to. `N<C-d>` moves N lines and
 * scrolls the viewport by N line heights, as Vim does with a count.
 */
export function halfPageDistance(
  clientHeight: number,
  lineHeight: number,
  count: number
): { lines: number; pixels: number } {
  const rowHeight = lineHeight > 0 ? lineHeight : 18
  if (count > 0) return { lines: count, pixels: count * rowHeight }
  const pixels = Math.max(1, Math.round(clientHeight / 2))
  return { lines: Math.max(1, Math.round(pixels / rowHeight)), pixels }
}

/**
 * `<C-d>` / `<C-u>` as a Vim motion: move the cursor by half a page of
 * display lines and scroll the viewport the same distance, both clamped to
 * the note (#825).
 *
 * Replaces CodeMirror-Vim's built-in `moveByScroll`, which derives its
 * scroll target from the cursor's pixel coordinates before and after the
 * move. With live-preview decorations and folded headings shifting block
 * heights, a position without coordinates reads as the top of the window,
 * so that math could resolve to a negative offset and snap the cursor and
 * viewport back to line 1 from the end of a note. Here the viewport moves by
 * a fixed half-viewport (or N line heights with a count) and the cursor by
 * display lines through `moveVertically`, which never wraps at either end.
 * Mirrors the clamped preview scroll (`scrollPreviewBy`) in VimNav.
 *
 * This used to be an action mapped in normal mode only, which is why the
 * keys did nothing useful with a selection: an action leaves Vim's own
 * `vim.sel` untouched, so it cannot extend a visual selection, and the
 * unmapped visual context left the key to CodeMirror's search and history
 * keymaps on Linux and Windows (add a cursor, undo a selection). As a motion
 * Vim itself moves the head, so `v` + `<C-d>` grows the selection exactly as
 * far as normal-mode `<C-d>` moves, `V` grows it by whole lines, and a count
 * works in both modes.
 *
 * The pixel path runs inside `pixelMotionFallback` (#574): if a coordinate
 * query throws, the cursor still moves by logical lines and the viewport
 * still scrolls, and the pressed key never lands in the note as text.
 */
export function zenMoveByHalfPage(
  cm: VimHalfPageCm,
  head: { line: number; ch: number },
  motionArgs: VimHalfPageMotionArgs,
  vim: VimHalfPageState
): { line: number; ch: number } {
  const forward = !!motionArgs.forward
  const count = motionArgs.repeatIsExplicit ? Math.max(0, motionArgs.repeat || 0) : 0
  const view = cm.cm6
  if (!view) {
    const step = count || 1
    return new CodeMirror.Pos(
      clampLine(cm, forward ? head.line + step : head.line - step),
      head.ch
    )
  }

  const scroller = view.scrollDOM
  const { lines, pixels } = halfPageDistance(
    scroller.clientHeight,
    view.defaultLineHeight,
    count
  )
  const logicalTarget = clampLine(cm, forward ? head.line + lines : head.line - lines)

  const target = pixelMotionFallback(
    () => {
      const doc = view.state.doc
      const line = doc.line(Math.max(1, Math.min(doc.lines, head.line + 1)))
      const from = Math.min(line.to, line.from + Math.max(0, head.ch))
      // Keep the horizontal goal column stable across consecutive presses,
      // like j/k do, so passing a short line does not lose the column.
      if (vim.lastMotion !== zenMoveByHalfPage || vim.lastHSPos == null) {
        const coords = view.coordsAtPos(from)
        vim.lastHSPos = coords
          ? coords.left - view.contentDOM.getBoundingClientRect().left
          : undefined
      }
      let range = EditorSelection.cursor(from, 1, undefined, vim.lastHSPos)
      for (let i = 0; i < lines; i++) {
        const next = view.moveVertically(range, forward)
        // The first or last display line: stop, never wrap.
        if (next.head === range.head) break
        range = next
      }
      const landed = doc.lineAt(range.head)
      return new CodeMirror.Pos(landed.number - 1, range.head - landed.from)
    },
    () => new CodeMirror.Pos(logicalTarget, head.ch)
  )

  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  scroller.scrollTop = Math.max(
    0,
    Math.min(maxTop, scroller.scrollTop + (forward ? pixels : -pixels))
  )
  return target
}

function clampLine(cm: VimHalfPageCm, line: number): number {
  return Math.max(cm.firstLine(), Math.min(cm.lastLine(), line))
}

export const HALF_PAGE_MOTION = 'zenMoveByHalfPage'

/**
 * The mapping arguments for one direction. `explicitRepeat` hands the motion
 * the typed count as is, 0 when none was typed, so `N<C-d>` moves N lines
 * while a bare press moves half a page.
 */
export function halfPageMotionArgs(forward: boolean): { forward: boolean; explicitRepeat: true } {
  return { forward, explicitRepeat: true }
}

let halfPageMotionRegistered = false

/**
 * Define the half-page motion on the (per-window) global Vim. Like the
 * display-line motions, every renderer with an editor has its own Vim
 * singleton, so each one calls this. Idempotent, so it is safe on HMR. The
 * key mapping is separate: the main editor's keymap sync maps the user's
 * configured `nav.halfPageDown` / `nav.halfPageUp` bindings, the other
 * windows map the defaults through `mapDefaultHalfPageKeys`.
 */
export function registerHalfPageMotion(): void {
  if (halfPageMotionRegistered) return
  halfPageMotionRegistered = true
  Vim.defineMotion(
    HALF_PAGE_MOTION,
    zenMoveByHalfPage as unknown as Parameters<typeof Vim.defineMotion>[1]
  )
}

let defaultHalfPageKeysMapped = false

/**
 * Map the default half-page chords (Ctrl+D / Ctrl+U) to the motion in normal
 * and visual context, for the windows that build their own editor and have
 * no keymap overrides to consult (floating note, Quick Note, external file).
 * Without this they were left with codemirror-vim's stock `moveByScroll`,
 * and where Mod is Ctrl the search and history keymaps took the keys before
 * Vim saw them at all: Ctrl+D selected the word under the cursor in normal
 * mode and added a cursor per press in visual mode (#825). Pair with
 * `vimHalfPageKeymap` in the window's CodeMirror keymap so the chords reach
 * Vim first. Idempotent: each `Vim.mapCommand` call prepends a mapping.
 */
export function mapDefaultHalfPageKeys(): void {
  if (defaultHalfPageKeysMapped) return
  defaultHalfPageKeysMapped = true
  const directions = [
    ['nav.halfPageDown', true],
    ['nav.halfPageUp', false]
  ] as const
  for (const [id, forward] of directions) {
    const sequence = toVimSequence(getKeymapBinding(null, id))
    if (!sequence) continue
    for (const context of ['normal', 'visual'] as const) {
      Vim.mapCommand(sequence, 'motion', HALF_PAGE_MOTION, halfPageMotionArgs(forward), {
        context
      })
    }
  }
}
