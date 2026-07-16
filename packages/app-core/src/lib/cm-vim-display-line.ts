import { CodeMirror, Vim } from '@replit/codemirror-vim'
import type { EditorView } from '@codemirror/view'
import { mathBlockLineRanges } from './cm-math-render'

// Minimal shape of the CodeMirror-Vim adapter + state the display-line motion
// touches (the package's own types don't surface these helpers).
type VimMotionCm = {
  firstLine: () => number
  lastLine: () => number
  findPosV: (
    start: { line: number; ch: number },
    amount: number,
    unit: string,
    goalColumn?: number
  ) => { line: number; ch: number }
  charCoords: (pos: { line: number; ch: number }, mode: string) => { left: number }
  /** The underlying CodeMirror 6 view (set by the codemirror-vim adapter). */
  cm6?: EditorView
}
type VimMotionState = {
  visualLine?: boolean
  visualBlock?: boolean
  lastMotion?: unknown
  lastHSPos?: number
  lastHPos?: number
  inputState?: { operator?: unknown }
}

/**
 * `j`/`k` motion that moves by *visual* (display) line through soft-wrapped
 * content instead of skipping to the next logical line (#290). With wrapping on
 * by default, this matches the arrow keys and most GUI editors. Line-wise
 * behavior is preserved where it matters:
 *  - operators (`dj`/`yj`/`cj`) resolve in Vim's `operatorPending` context, so
 *    our normal/visual `j`/`k` mappings never reach them — they keep the default
 *    logical motion;
 *  - line/block visual selections (`Vj`, `<C-v>j`) fall back to whole-logical-
 *    line movement here so the selection grows a logical line at a time;
 *  - an explicit count (`3j`, `5k`) falls back to logical movement so the jump
 *    lands on the line the relativenumber gutter shows — those numbers count
 *    logical lines, so `{count}j` must too, not display rows (#314). This is the
 *    classic `v:count == 0 ? gj : j` idiom; a bare `j`/`k` still moves by display
 *    line;
 *  - a bare `j`/`k` whose next logical line sits inside a *rendered* block-math
 *    widget also falls back to logical movement, stepping the cursor into the
 *    block's source (which cm-math-render then reveals in the same transaction).
 *    The display-line path is pixel-based, and a `block: true` replace widget
 *    has no cursor coordinates, so it would skip clean over the block — and the
 *    reveal-induced height changes made consecutive blocks compound into
 *    multi-line jumps. Inside an already-revealed block (plain source text),
 *    normal display-line movement applies.
 * `gj`/`gk` are untouched. Mirrors codemirror-vim's own `moveByDisplayLines`,
 * including maintaining the horizontal goal column across consecutive presses.
 */
export function zenMoveByDisplayLine(
  cm: VimMotionCm,
  head: { line: number; ch: number },
  motionArgs: { forward?: boolean; repeat?: number; repeatIsExplicit?: boolean },
  vim: VimMotionState
): { line: number; ch: number } {
  const forward = !!motionArgs.forward
  const repeat = motionArgs.repeat || 1
  if (
    vim.visualLine ||
    vim.visualBlock ||
    vim.inputState?.operator ||
    motionArgs.repeatIsExplicit
  ) {
    const target = Math.max(
      cm.firstLine(),
      Math.min(cm.lastLine(), forward ? head.line + repeat : head.line - repeat)
    )
    return new CodeMirror.Pos(target, head.ch)
  }
  // Rendered `$$…$$` blocks break the pixel-based display path: a block-replace
  // widget has no cursor coordinates, so `findPosV` skips clean over it, and the
  // reveal-induced height changes compound into multi-line jumps. Move by
  // logical line around them instead (cm-math-render reveals the block the
  // cursor steps into within the same transaction).
  const mathRanges = cm.cm6 ? mathBlockLineRanges(cm.cm6.state) : []
  const logicalTarget = Math.max(
    cm.firstLine(),
    Math.min(cm.lastLine(), forward ? head.line + repeat : head.line - repeat)
  )
  if (mathRanges.length) {
    // codemirror-vim lines are 0-based; the math ranges are 1-based.
    const block = mathRanges.find(
      (r) => logicalTarget + 1 >= r.fromLine && logicalTarget + 1 <= r.toLine
    )
    const headInside = block && head.line + 1 >= block.fromLine && head.line + 1 <= block.toLine
    if (block && !headInside) {
      return new CodeMirror.Pos(logicalTarget, head.ch)
    }
  }
  // Keep the horizontal goal column stable across consecutive j/k, like gj/gk.
  if (vim.lastMotion !== zenMoveByDisplayLine) {
    vim.lastHSPos = cm.charCoords(head, 'div').left
  }
  const res = cm.findPosV(head, forward ? repeat : -repeat, 'line', vim.lastHSPos)
  if (mathRanges.length && Math.abs(res.line - head.line) > repeat) {
    // The pixel motion overshot (e.g. launched from a line with large CSS
    // margins straight over a block widget). If a math block sits in the
    // skipped span, snap back to the plain logical step so the cursor
    // approaches the block one line at a time instead of leaping past it.
    const lo = Math.min(head.line, res.line) + 1
    const hi = Math.max(head.line, res.line) + 1
    if (mathRanges.some((r) => r.fromLine < hi && r.toLine > lo)) {
      return new CodeMirror.Pos(logicalTarget, head.ch)
    }
  }
  vim.lastHPos = res.ch
  return res
}

let displayLineMotionRegistered = false

/**
 * Register the #290 display-line `j`/`k` motion on the (per-window) global Vim.
 * The main editor (Editor.tsx) and the Quick Note window (QuickCaptureApp) live
 * in separate Electron renderers, each with its own Vim singleton, so both must
 * call this for `j`/`k` to move by visual line in either (#312). Mapped only in
 * normal + visual contexts, so operator-pending motions (dj/yj/cj) keep Vim's
 * default logical movement. Idempotent — safe to call once per renderer / on HMR.
 */
export function registerDisplayLineMotion(): void {
  if (displayLineMotionRegistered) return
  displayLineMotionRegistered = true
  // The package's MotionFn type is looser/different than our precise params; the
  // runtime contract (cm, head, motionArgs, vim) → position is correct.
  Vim.defineMotion(
    'zenMoveByDisplayLine',
    zenMoveByDisplayLine as unknown as Parameters<typeof Vim.defineMotion>[1]
  )
  for (const context of ['normal', 'visual'] as const) {
    Vim.mapCommand(
      'j',
      'motion',
      'zenMoveByDisplayLine',
      { forward: true, linewise: true },
      { context }
    )
    Vim.mapCommand(
      'k',
      'motion',
      'zenMoveByDisplayLine',
      { forward: false, linewise: true },
      { context }
    )
  }
}
