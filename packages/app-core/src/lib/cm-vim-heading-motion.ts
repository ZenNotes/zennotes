import { CodeMirror, Vim } from '@replit/codemirror-vim'
import type { EditorView } from '@codemirror/view'
import { parseOutline, type OutlineItem } from './outline'

// Minimal shape of the CodeMirror-Vim adapter this motion touches.
type VimHeadingCm = {
  firstLine: () => number
  lastLine: () => number
  /** The underlying CodeMirror 6 view (set by the codemirror-vim adapter). */
  cm6?: EditorView
}

/**
 * Headings for a document, keyed by the doc itself. CodeMirror's `Text` is
 * immutable, so an edit produces a new key and the entry for the old one is
 * collected: repeated presses on an unchanged note reuse one scan, and the
 * cache can never go stale.
 */
const headingCache = new WeakMap<object, OutlineItem[]>()

function headingsOf(view: EditorView): OutlineItem[] {
  const doc = view.state.doc
  const cached = headingCache.get(doc)
  if (cached) return cached
  // The same parser the outline panel and `Space p` use, so a heading the
  // outline lists is exactly a heading this motion stops on: fences are
  // tracked by their own marker run and frontmatter is skipped, which keeps
  // a `# comment` inside a code block from being a destination (#249).
  const items = parseOutline(doc.toString())
  headingCache.set(doc, items)
  return items
}

/**
 * `]]` / `[[`: jump to the next or previous markdown heading (#578).
 *
 * Vim's own `]]` and `[[` move between sections, which in a C file means a
 * brace in column one and in a note means a heading; Zed maps them the same
 * way, which is where the request came from. Being a motion rather than a
 * command means it composes: `d]]` deletes to the next heading, `v]]` selects
 * to it, `3]]` skips three, and `Ctrl+O` comes back, all for free.
 *
 * With no heading left in that direction the cursor goes to the end or start
 * of the note, like Vim's section motions do, so the key always moves rather
 * than silently doing nothing.
 */
export function zenMoveToHeading(
  cm: VimHeadingCm,
  head: { line: number; ch: number },
  motionArgs: { forward?: boolean; repeat?: number }
): { line: number; ch: number } {
  const view = cm.cm6
  const forward = !!motionArgs.forward
  const repeat = Math.max(1, motionArgs.repeat || 1)
  if (!view) return new CodeMirror.Pos(head.line, head.ch)

  // codemirror-vim counts lines from 0; the outline counts from 1.
  const current = head.line + 1
  const headings = headingsOf(view)
  const ahead = forward
    ? headings.filter((item) => item.line > current)
    : headings.filter((item) => item.line < current).reverse()

  const target = ahead[Math.min(repeat, ahead.length) - 1]
  if (target) return new CodeMirror.Pos(target.line - 1, 0)
  return new CodeMirror.Pos(forward ? cm.lastLine() : cm.firstLine(), 0)
}

let headingMotionRegistered = false

/**
 * Register `]]` / `[[` on the (per-window) global Vim. Like the display-line
 * motions, every renderer with an editor has its own Vim singleton, so each
 * one calls this. Idempotent, so it is safe on HMR.
 */
export function registerHeadingMotion(): void {
  if (headingMotionRegistered) return
  headingMotionRegistered = true
  Vim.defineMotion(
    'zenMoveToHeading',
    zenMoveToHeading as unknown as Parameters<typeof Vim.defineMotion>[1]
  )
  for (const context of ['normal', 'visual', 'operatorPending'] as const) {
    Vim.mapCommand(
      ']]',
      'motion',
      'zenMoveToHeading',
      { forward: true, toJumplist: true },
      { context }
    )
    Vim.mapCommand(
      '[[',
      'motion',
      'zenMoveToHeading',
      { forward: false, toJumplist: true },
      { context }
    )
  }
}
