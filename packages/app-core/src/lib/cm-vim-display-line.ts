import { CodeMirror, Vim } from '@replit/codemirror-vim'
import type { EditorView } from '@codemirror/view'
import { displayRowEdge } from './cm-display-row'
import { mathBlockLineRanges } from './cm-math-render'
import { embedBlockLineRanges } from './cm-embed-render'
import { mermaidBlockLineRanges } from './cm-mermaid-render'

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

type VimDisplayBoundaryCm = {
  firstLine?: () => number
  lastLine?: () => number
  execCommand: (command: string) => void
  getCursor: () => { line: number; ch: number; sticky?: string }
  charCoords?: (
    position: { line: number; ch: number },
    mode: string
  ) => { left: number; top: number; bottom: number }
  coordsChar?: (
    coords: { left: number; top: number },
    mode: string
  ) => { line: number; ch: number }
  /** The underlying CodeMirror 6 view (set by the codemirror-vim adapter). */
  cm6?: EditorView
}

type VimViewportCm = {
  firstLine: () => number
  lastLine: () => number
  getScrollInfo: () => { top: number; clientHeight: number }
  coordsChar: (
    coords: { left: number; top: number },
    mode: string
  ) => { line: number; ch: number }
  getLine: (line: number) => string
  findPosV: (
    start: { line: number; ch: number },
    amount: number,
    unit: string
  ) => { line: number; ch: number }
}
type VimMotionState = {
  visualLine?: boolean
  visualBlock?: boolean
  lastMotion?: unknown
  lastHSPos?: number
  lastHPos?: number
  inputState?: { operator?: unknown }
}

let pixelMotionFailureWarned = false

function warnPixelMotionFailure(err: unknown): void {
  if (pixelMotionFailureWarned) return
  pixelMotionFailureWarned = true
  console.warn(
    '[zen:vim] display-line measurement failed; using logical movement for this press',
    err
  )
}

/**
 * Run a pixel-measurement-based motion, falling back to a logical position if
 * it throws (#574). codemirror-vim rethrows a motion exception after clearing
 * its state, which skips the keydown's preventDefault, so the pressed key
 * would land in the note as a literal character: a normal-mode `j` typed
 * "j" into the text. CM6's coordinate queries do throw on some geometries
 * (seen on Linux fractional display scaling at certain zoom levels once a
 * line soft-wraps into 5+ display rows), so no exception may escape a motion.
 * The fallback keeps the cursor moving and the next press re-measures.
 */
function pixelMotionFallback(
  run: () => { line: number; ch: number },
  fallback: () => { line: number; ch: number }
): { line: number; ch: number } {
  try {
    return run()
  } catch (err) {
    warnPixelMotionFailure(err)
    return fallback()
  }
}

/**
 * True when `offset` sits exactly on a soft-wrap point: simultaneously past
 * the end of one display row and at the start of the next. The codemirror-vim
 * adapter reads such an offset with a hardcoded forward association, so a
 * cursor resting there acts from the next row on the following press; whether
 * that is correct depends on which reading of the offset the motion meant
 * (#580). `zenMoveByDisplayLine` disambiguates by goal column.
 */
function isWrapPoint(view: EditorView, offset: number): boolean {
  const line = view.state.doc.lineAt(offset)
  if (offset <= line.from || offset >= line.to) return false
  const before = view.coordsAtPos(offset, -1)
  const after = view.coordsAtPos(offset, 1)
  if (!before || !after) return false
  return after.top - before.top > (before.bottom - before.top) / 2
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
 * The whole pixel path runs inside `pixelMotionFallback` (#574): if any CM6
 * coordinate query throws, the motion degrades to the plain logical step
 * instead of letting the exception escape, which would type the pressed key
 * into the note. Soft-wrap points are never used as the motion's origin or
 * destination (#580); see `isWrapPoint`.
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
  const mathRanges = cm.cm6
    ? [
        ...mathBlockLineRanges(cm.cm6.state),
        ...embedBlockLineRanges(cm.cm6.state),
        ...mermaidBlockLineRanges(cm.cm6.state)
      ]
    : []
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
  return pixelMotionFallback(
    () => {
      // Keep the horizontal goal column stable across consecutive j/k, like gj/gk.
      if (vim.lastMotion !== zenMoveByDisplayLine) {
        vim.lastHSPos = cm.charCoords(head, 'div').left
      }
      const res = cm.findPosV(head, forward ? repeat : -repeat, 'line', vim.lastHSPos)
      // A landing exactly ON a soft-wrap point is ambiguous: the offset is
      // both "end of row N" and "start of row N+1". With a left-side goal
      // column it means the next row's start and everything is consistent.
      // With a right-edge goal it means row N's end, but findPosV's
      // hardcoded forward association makes the NEXT press act from row
      // N+1 (skipping a row down, bouncing in place up), and the cursor
      // renders past the row's last character (#580). When the goal column
      // sits closer to the row-end reading, rest ON that last character,
      // like the display-row $ does.
      const view = cm.cm6
      if (view && vim.lastHSPos != null && res.ch > 0 && res.line + 1 <= view.state.doc.lines) {
        const line = view.state.doc.line(res.line + 1)
        const offset = Math.min(line.to, line.from + res.ch)
        if (isWrapPoint(view, offset)) {
          const rowEnd = view.coordsAtPos(offset, -1)
          const rowStart = view.coordsAtPos(offset, 1)
          if (rowEnd && rowStart) {
            const goalX = view.contentDOM.getBoundingClientRect().left + vim.lastHSPos
            if (Math.abs(goalX - rowEnd.left) <= Math.abs(goalX - rowStart.left)) {
              res.ch -= 1
            }
          }
        }
      }
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
      // The pixel-based `findPosV` can fail to advance across a soft-wrap boundary
      // when `coordsAtPos`/`posAtCoords` are sub-pixel-imprecise — e.g. under a
      // compositor's fractional display scaling — which left `k` (and in principle
      // `j`) stuck even though there were more lines that way (#423). If the motion
      // didn't move in the requested direction but a logical line IS available that
      // way, step there so the cursor always makes progress. In a pixel-accurate
      // environment this never fires (the display-line motion advances every press),
      // so wrapped-row movement is unchanged.
      const advanced = forward
        ? res.line > head.line || (res.line === head.line && res.ch > head.ch)
        : res.line < head.line || (res.line === head.line && res.ch < head.ch)
      if (!advanced && logicalTarget !== head.line) {
        return new CodeMirror.Pos(logicalTarget, head.ch)
      }
      vim.lastHPos = res.ch
      return res
    },
    () => new CodeMirror.Pos(logicalTarget, head.ch)
  )
}

/**
 * Move to a wrapped display-row boundary. A counted `$` keeps Vim's logical
 * line behavior, while a bare `$` and the insert actions built on this helper
 * stay on the row the user can currently see (#536). The boundary itself
 * comes from `displayRowEdge` when the CM6 view is reachable; the
 * goLineRight/goLineLeft commands are only the fallback, because their
 * viewport-edge hit-testing mislands under fractional display scaling (#575).
 */
export function zenMoveToDisplayLineBoundary(
  cm: VimDisplayBoundaryCm,
  head: { line: number; ch: number },
  motionArgs: { forward?: boolean; repeat?: number }
): { line: number; ch: number } {
  const repeat = motionArgs.repeat || 1
  if (motionArgs.forward && repeat > 1) {
    const first = cm.firstLine?.() ?? 0
    const last = cm.lastLine?.() ?? head.line + repeat - 1
    const line = Math.max(first, Math.min(last, head.line + repeat - 1))
    return new CodeMirror.Pos(line, Infinity)
  }

  // Preferred path: find the wrap point from row coordinates (#575). The
  // goLineRight/goLineLeft commands below locate it by hit-testing an x
  // coordinate at the viewport edge, which under fractional display scaling
  // lands several characters short of the row end, or on a neighboring row.
  const view = cm.cm6
  if (view) {
    try {
      const doc = view.state.doc
      if (head.line + 1 <= doc.lines) {
        const line = doc.line(head.line + 1)
        const pos = Math.min(line.to, line.from + Math.max(0, head.ch))
        const edge = displayRowEdge(view, pos, !!motionArgs.forward)
        if (edge != null) {
          // Forward lands ON the row's last character, mirroring Vim's
          // inclusive `$`; backward lands on the row's first.
          return motionArgs.forward
            ? new CodeMirror.Pos(head.line, Math.max(0, edge - line.from - 1))
            : new CodeMirror.Pos(head.line, edge - line.from)
        }
        // No usable coordinates. Vim's plain logical `$` beats hit-testing an
        // x coordinate here: goLineRight resolves the rightmost VISIBLE glyph,
        // and with live preview hiding a line-ending token (a wikilink's
        // closing brackets), that landed the cursor inside the link (#582).
        if (motionArgs.forward) {
          return new CodeMirror.Pos(head.line, Infinity)
        }
      }
    } catch (err) {
      warnPixelMotionFailure(err)
    }
  }

  const { charCoords, coordsChar } = cm
  if (!motionArgs.forward && charCoords && coordsChar) {
    return pixelMotionFallback(
      () => {
        const row = charCoords(head, 'div')
        return coordsChar({ left: 0, top: (row.top + row.bottom) / 2 }, 'div')
      },
      () => new CodeMirror.Pos(head.line, 0)
    )
  }

  return pixelMotionFallback(
    () => {
      cm.execCommand(motionArgs.forward ? 'goLineRight' : 'goLineLeft')
      const target = cm.getCursor()
      const ch = motionArgs.forward && target.sticky === 'before' ? target.ch - 1 : target.ch
      return new CodeMirror.Pos(target.line, Math.max(0, ch))
    },
    () =>
      motionArgs.forward
        ? new CodeMirror.Pos(head.line, Infinity)
        : new CodeMirror.Pos(head.line, 0)
  )
}

function firstNonWhitespace(text: string): number {
  const index = text.search(/\S/)
  return index < 0 ? text.length : index
}

/**
 * Preserve Vim's first press of H/L, then let another press at the same edge
 * step beyond the viewport. CodeMirror scrolls that returned position into
 * view, so the key can keep moving through the note instead of becoming a
 * no-op at the top or bottom visible line (#513).
 */
export function zenMoveToViewportEdge(
  cm: VimViewportCm,
  head: { line: number; ch: number },
  motionArgs: { forward?: boolean; repeat?: number }
): { line: number; ch: number } {
  const forward = !!motionArgs.forward
  const repeat = motionArgs.repeat || 1
  return pixelMotionFallback(
    () => {
      const scroll = cm.getScrollInfo()
      const visibleTop = cm.coordsChar({ left: 0, top: scroll.top + 6 }, 'local').line
      const visibleBottom = cm.coordsChar(
        { left: 0, top: scroll.top + Math.max(0, scroll.clientHeight - 10) },
        'local'
      ).line
      const rawLine = forward ? visibleBottom - repeat + 1 : visibleTop + repeat - 1
      const line = Math.max(cm.firstLine(), Math.min(cm.lastLine(), rawLine))
      const edge = new CodeMirror.Pos(line, firstNonWhitespace(cm.getLine(line)))

      if (head.line !== edge.line || head.ch !== edge.ch) return edge

      const stepped = cm.findPosV(edge, forward ? 1 : -1, 'line')
      if (stepped.line === edge.line && stepped.ch === edge.ch) return edge
      if (stepped.line === edge.line) return new CodeMirror.Pos(stepped.line, stepped.ch)
      return new CodeMirror.Pos(stepped.line, firstNonWhitespace(cm.getLine(stepped.line)))
    },
    () => new CodeMirror.Pos(head.line, head.ch)
  )
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
  Vim.defineMotion(
    'zenMoveToDisplayLineBoundary',
    zenMoveToDisplayLineBoundary as unknown as Parameters<typeof Vim.defineMotion>[1]
  )
  Vim.defineMotion(
    'zenMoveToViewportEdge',
    zenMoveToViewportEdge as unknown as Parameters<typeof Vim.defineMotion>[1]
  )
  type VimActionTable = {
    enterInsertMode: (
      cm: unknown,
      args: {
        head: { line: number; ch: number }
        insertAt: 'inplace'
        repeat?: number
      },
      vim: unknown
    ) => void
  }
  Vim.defineAction(
    'zenEnterInsertAtDisplayLineBoundary',
    function (
      this: VimActionTable,
      cm: VimDisplayBoundaryCm,
      actionArgs: { forward?: boolean; repeat?: number },
      vim: unknown
    ) {
      let target: { line: number; ch: number }
      if (actionArgs.forward) {
        // Insert at the raw display boundary. The normal-mode `$` motion
        // backs up to the last visible character, but `A` belongs after it.
        target = pixelMotionFallback(
          () => {
            const view = cm.cm6
            const cursor = cm.getCursor()
            if (view && cursor.line + 1 <= view.state.doc.lines) {
              const line = view.state.doc.line(cursor.line + 1)
              const pos = Math.min(line.to, line.from + Math.max(0, cursor.ch))
              const edge = displayRowEdge(view, pos, true)
              if (edge != null) return new CodeMirror.Pos(cursor.line, edge - line.from)
              // No usable coordinates: append at the LOGICAL line end, like
              // plain Vim, rather than goLineRight's rightmost visible glyph,
              // which live preview's hidden closing tokens pull short (#582).
              return new CodeMirror.Pos(cursor.line, line.length)
            }
            cm.execCommand('goLineRight')
            return cm.getCursor()
          },
          () => cm.getCursor()
        )
      } else {
        target = zenMoveToDisplayLineBoundary(cm, cm.getCursor(), { forward: false })
      }
      this.enterInsertMode(
        cm,
        { head: target, insertAt: 'inplace', repeat: actionArgs.repeat },
        vim
      )
    } as unknown as Parameters<typeof Vim.defineAction>[1]
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
  for (const context of ['normal', 'visual', 'operatorPending'] as const) {
    Vim.mapCommand(
      '$',
      'motion',
      'zenMoveToDisplayLineBoundary',
      { forward: true, inclusive: true },
      { context }
    )
    Vim.mapCommand(
      'H',
      'motion',
      'zenMoveToViewportEdge',
      { forward: false, linewise: true, toJumplist: true },
      { context }
    )
    Vim.mapCommand(
      'L',
      'motion',
      'zenMoveToViewportEdge',
      { forward: true, linewise: true, toJumplist: true },
      { context }
    )
    Vim.mapCommand(
      'g0',
      'motion',
      'zenMoveToDisplayLineBoundary',
      { forward: false },
      { context }
    )
  }
  Vim.mapCommand(
    'A',
    'action',
    'zenEnterInsertAtDisplayLineBoundary',
    { forward: true },
    { context: 'normal', isEdit: true }
  )
  Vim.mapCommand(
    'I',
    'action',
    'zenEnterInsertAtDisplayLineBoundary',
    { forward: false },
    { context: 'normal', isEdit: true }
  )
}
