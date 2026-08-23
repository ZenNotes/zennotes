/**
 * Vim-shaped visual-mode selection (#581). codemirror-vim mirrors the visual
 * range into the editor selection, and CM6's selection layer draws multi-row
 * ranges browser-style: every row but the last fills to the content column's
 * right edge, so a short line inside a wide column highlights far past its
 * text, and a wrapped row paints past its last glyph. Vim highlights the text
 * itself. While Vim is in visual mode the native selection layer is hidden
 * (styles in index.css under `.zen-vim-visual-active`) and the ranges are
 * painted with mark decorations instead, which hug the glyphs of every
 * wrapped row by construction. Inert with Vim off or outside visual mode.
 */
import { RangeSetBuilder, type Text } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { getCM } from '@replit/codemirror-vim'

const visualMark = Decoration.mark({ class: 'cm-vim-visual-selection' })

interface VimPosition {
  line: number
  ch: number
}

interface VimVisualState {
  visualMode?: boolean
  visualBlock?: boolean
  sel?: {
    anchor: VimPosition
    head: VimPosition
  }
}

function vimVisualState(view: EditorView): VimVisualState | undefined {
  return getCM(view)?.state.vim as VimVisualState | undefined
}

function vimInVisualMode(view: EditorView): boolean {
  return !!vimVisualState(view)?.visualMode
}

/**
 * CodeMirror-Vim keeps a block's full rectangle in `vim.sel`, but mirrors only
 * the head row into CM6's EditorSelection. Build one inclusive text range per
 * logical row so the custom highlighter paints the complete rectangle.
 */
export function visualBlockMarkRanges(
  doc: Text,
  anchor: VimPosition,
  head: VimPosition
): Array<{ from: number; to: number }> {
  const firstLine = Math.max(0, Math.min(anchor.line, head.line))
  const lastLine = Math.min(doc.lines - 1, Math.max(anchor.line, head.line))
  const firstColumn = Math.max(0, Math.min(anchor.ch, head.ch))
  const lastColumnExclusive = Math.max(anchor.ch, head.ch) + 1
  const ranges: Array<{ from: number; to: number }> = []

  for (let lineIndex = firstLine; lineIndex <= lastLine; lineIndex++) {
    const line = doc.line(lineIndex + 1)
    const from = line.from + Math.min(firstColumn, line.length)
    const to = line.from + Math.min(lastColumnExclusive, line.length)
    if (to > from) ranges.push({ from, to })
  }

  return ranges
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const vim = vimVisualState(view)
  const ranges =
    vim?.visualBlock && vim.sel
      ? visualBlockMarkRanges(view.state.doc, vim.sel.anchor, vim.sel.head)
      : view.state.selection.ranges
  for (const range of ranges) {
    if (range.to <= range.from) continue
    builder.add(range.from, range.to, visualMark)
  }
  return builder.finish()
}

const visualSelectionPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = vimInVisualMode(view) ? buildDecorations(view) : Decoration.none
    }

    update(update: ViewUpdate): void {
      // Mode flips arrive inside the same dispatch that moves the selection
      // (codemirror-vim toggles its state before it re-syncs the selection),
      // so reading the mode here stays in step with what is on screen.
      this.decorations = vimInVisualMode(update.view)
        ? buildDecorations(update.view)
        : Decoration.none
    }
  },
  { decorations: (v) => v.decorations }
)

/** The CSS that hides the native selection layer keys off this class, so the
 *  swap follows the exact same mode read as the decorations. */
const visualClassAttribute = EditorView.editorAttributes.of((view) =>
  vimInVisualMode(view) ? { class: 'zen-vim-visual-active' } : null
)

export const vimVisualHighlightExtension = [visualSelectionPlugin, visualClassAttribute]
