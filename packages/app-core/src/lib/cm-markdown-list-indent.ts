import { syntaxTree } from '@codemirror/language'
import { Facet, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { DEFAULT_EDITOR_TAB_SIZE, normalizeEditorTabSize } from './editor-tab-size'

// The checkbox part covers every task state (`[ ]`, `[x]`, `[>]`, `[-]`, `[/]`)
// so Tab/Shift-Tab indents a started or cancelled task like any other. (#512)
const LEADING_LIST_MARKER_RE =
  /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)(?:\[[ xX>/-]\](?:[ \t]+|$))?/
const LIST_MARKER_FROM_OFFSET_RE =
  /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)(?:\[[ xX>/-]\](?:[ \t]+|$))?/

/**
 * How list indentation renders (#491). `width` is the visual step per nesting
 * level in ch, fed by the Tab size setting so one knob governs what Tab
 * inserts AND how deep a level looks; `guides` draws a vertical line per
 * ancestor level. Combined here so panes can provide the two halves from
 * separate settings through one compartment.
 */
export interface ListIndentConfig {
  width: number
  guides: boolean
}

export const listIndentConfig = Facet.define<Partial<ListIndentConfig>, ListIndentConfig>({
  combine: (values) => ({
    width: values.find((v) => v.width != null)?.width ?? DEFAULT_EDITOR_TAB_SIZE,
    guides: values.find((v) => v.guides != null)?.guides ?? true
  })
})

/** Provide the guides half of the config. */
export function listIndentGuides(enabled: boolean): ReturnType<typeof listIndentConfig.of> {
  return listIndentConfig.of({ guides: enabled })
}

/** Provide the width half, normalized exactly like the Tab size setting. */
export function listIndentWidth(value: unknown): ReturnType<typeof listIndentConfig.of> {
  return listIndentConfig.of({ width: normalizeEditorTabSize(value) })
}

function visualColumn(text: string, tabWidth: number): number {
  let col = 0
  for (const ch of text) col += ch === '\t' ? tabWidth : 1
  return col
}

export function markdownListHangingIndentCh(
  lineText: string,
  markerOffset = 0,
  tabWidth = DEFAULT_EDITOR_TAB_SIZE
): number | null {
  if (markerOffset < 0 || markerOffset > lineText.length) return null
  const markerText = lineText.slice(markerOffset)
  const match =
    markerOffset === 0
      ? lineText.match(LEADING_LIST_MARKER_RE)
      : markerText.match(LIST_MARKER_FROM_OFFSET_RE)
  if (!match) return null
  return Math.max(1, visualColumn(lineText.slice(0, markerOffset) + match[0], tabWidth))
}

/**
 * The extra left padding (ch) that widens a nested line's indent to
 * `depth * width`, whatever the source spacing. A source already indented at
 * least that far gets 0, so notes written with the configured width never
 * shift, and top-level lines never shift.
 */
export function listIndentPadCh(
  lineText: string,
  markerOffset: number,
  depth: number,
  width: number
): number {
  const markerCol = visualColumn(lineText.slice(0, markerOffset), width)
  return Math.max(0, (depth - 1) * width - markerCol)
}

/**
 * Background layers for the guide lines of a line at `depth`: one 1px column
 * per ancestor level, at that level's marker column plus a small inset so the
 * line sits under the bullet, not the left edge. Positions are in ch, so they
 * track the editor font. Empty at depth <= 1.
 */
export function listGuideStyle(depth: number, width: number): string {
  if (depth <= 1) return ''
  const images: string[] = []
  const positions: string[] = []
  for (let level = 1; level < depth; level++) {
    images.push('linear-gradient(to bottom, var(--z-list-guide-color) 0, var(--z-list-guide-color) 100%)')
    positions.push(`calc(${(level - 1) * width}ch + 0.45ch) 0`)
  }
  return (
    `background-image: ${images.join(', ')}; ` +
    `background-position: ${positions.join(', ')}; ` +
    'background-size: 1px 100%; background-repeat: no-repeat;'
  )
}

/**
 * The width in ch of each character of a list line's prefix, leading
 * whitespace first, then the marker and its spaces (#952). The hanging indent
 * and the guides are measured in ch, so with a monospace font the source
 * already matches them; with a proportional font a space is about half a ch,
 * and the bullet sat left of its guide and of its parent's wrapped text. Each
 * character is boxed to at least its width (a tab to `tabWidth`, as the hanging
 * indent counts it), so a monospace line renders exactly as before.
 *
 * Null for a line whose prefix is not pure whitespace (a list in a quote or a
 * callout, where `>` has rendering of its own). A task's marker gets no cells:
 * live preview hides its `- ` and draws a checkbox narrower than the six
 * columns the hanging indent counts, a separate mismatch this does not touch.
 */
export function listPrefixCells(
  lineText: string,
  markerOffset: number,
  tabWidth = DEFAULT_EDITOR_TAB_SIZE
): number[] | null {
  const indent = lineText.slice(0, markerOffset)
  if (!/^[ \t]*$/.test(indent)) return null
  const marker = lineText.slice(markerOffset).match(LIST_MARKER_FROM_OFFSET_RE)?.[0]
  if (marker == null) return null
  const boxed = /\[[ xX>/-]\]/.test(marker) ? indent : indent + marker
  return [...boxed].map((ch) => (ch === '\t' ? tabWidth : 1))
}

interface ListLineFacts {
  markerOffset: number
  /** 1-based nesting level: ListItem ancestors of the marker. */
  depth: number
}

function listLineFactsFor(view: EditorView, lineFrom: number, lineTo: number): ListLineFacts | null {
  let facts: ListLineFacts | null = null
  syntaxTree(view.state).iterate({
    from: lineFrom,
    to: lineTo,
    enter: (node) => {
      if (facts != null) return false
      if (node.name !== 'ListMark') return
      let depth = 0
      for (let p = node.node.parent; p; p = p.parent) {
        if (p.name === 'ListItem') depth++
      }
      facts = { markerOffset: node.from - lineFrom, depth: Math.max(1, depth) }
      return false
    }
  })
  return facts
}

function computeDecorations(view: EditorView): DecorationSet {
  const { width, guides } = view.state.facet(listIndentConfig)
  const builder = new RangeSetBuilder<Decoration>()
  const decoratedLines = new Set<number>()

  for (const { from, to } of view.visibleRanges) {
    const firstLine = view.state.doc.lineAt(from).number
    const lastLine = view.state.doc.lineAt(Math.max(from, to - 1)).number
    for (let lineNo = firstLine; lineNo <= lastLine; lineNo++) {
      if (decoratedLines.has(lineNo)) continue
      const line = view.state.doc.line(lineNo)
      const facts = listLineFactsFor(view, line.from, line.to)
      if (facts == null) continue
      const indentCh = markdownListHangingIndentCh(line.text, facts.markerOffset, width)
      if (indentCh == null) continue
      decoratedLines.add(lineNo)
      const padCh = listIndentPadCh(line.text, facts.markerOffset, facts.depth, width)
      const style = [
        `--z-list-hanging-indent: ${indentCh}ch`,
        padCh > 0 ? `--z-list-indent-pad: ${padCh}ch` : '',
        guides ? listGuideStyle(facts.depth, width) : ''
      ]
        .filter(Boolean)
        .join('; ')
      const cells = listPrefixCells(line.text, facts.markerOffset, width)
      const boxedMarker = cells != null && cells.length > facts.markerOffset
      builder.add(
        line.from,
        line.from,
        Decoration.line({
          class: boxedMarker ? 'cm-markdown-list-line cm-list-boxed-marker' : 'cm-markdown-list-line',
          attributes: { style }
        })
      )
      // One box per character, not one for the run: the fold arrow is a
      // widget anchored where the parser starts the item, often inside the
      // indent, and a mark split around it gave each piece the full width; the
      // bullet widget is not wrapped at all. The column keeps CodeMirror from
      // merging neighbours back into one span.
      for (const [col, cellCh] of (cells ?? []).entries()) {
        builder.add(
          line.from + col,
          line.from + col + 1,
          Decoration.mark({
            class: 'cm-list-prefix-cell',
            attributes: { style: `min-width: ${cellCh}ch`, 'data-list-col': String(col) }
          })
        )
      }
    }
  }

  return builder.finish()
}

/** The text node holding a collapsed caret in this editor, if there is one. */
function caretTextNode(view: EditorView): Node | null {
  const selection = view.dom.ownerDocument.getSelection()
  const node = selection?.isCollapsed ? selection.focusNode : null
  return node?.nodeType === Node.TEXT_NODE && view.contentDOM.contains(node) ? node : null
}

/**
 * Puts Chromium's caret back where the page says it is, after a redraw moved
 * the text node it was in (#1012).
 *
 * The prefix cells give an indent one single-space text node per column. On
 * an empty task the caret sits after the `- [ ] ` marker's trailing space,
 * itself a lone space, so when Tab indents that line, CodeMirror's redraw
 * reuses the caret's node for one of the new indent cells. getSelection()
 * then reports the line's end, which CodeMirror takes as already right and
 * leaves alone, but Chromium keeps its own caret in the moved node, and the
 * next keystroke lands before the marker. CodeMirror's guard for this Chrome
 * behavior only notices a node that was rewritten or removed, not one moved
 * intact. Collapsing the selection onto the position it already reports
 * brings Chromium's caret back to it.
 */
function resyncMovedCaret(view: EditorView, before: Node): void {
  if (view.composing || !view.contentDOM.contains(before)) return
  const selection = view.dom.ownerDocument.getSelection()
  if (!selection?.isCollapsed || !selection.focusNode || selection.focusNode === before) return
  if (!view.contentDOM.contains(selection.focusNode)) return
  selection.collapse(selection.focusNode, selection.focusOffset)
}

export const markdownListIndentPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    /** The caret's text node before this update's redraw (see resyncMovedCaret). */
    caretBefore: Node | null = null

    constructor(view: EditorView) {
      this.decorations = computeDecorations(view)
    }

    update(update: ViewUpdate): void {
      // Plugins update before CodeMirror redraws, so the DOM is still the old one.
      this.caretBefore = update.docChanged ? caretTextNode(update.view) : null
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.state.facet(listIndentConfig) !== update.startState.facet(listIndentConfig) ||
        // A parse cut short by its time budget finishes in a later update
        // that changes nothing else.
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = computeDecorations(update.view)
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    // Update listeners run after the redraw and after CodeMirror has placed
    // the DOM selection.
    provide: (plugin) =>
      EditorView.updateListener.of((update) => {
        const value = update.view.plugin(plugin)
        const before = value?.caretBefore
        if (!value || !before) return
        value.caretBefore = null
        resyncMovedCaret(update.view, before)
      })
  }
)
