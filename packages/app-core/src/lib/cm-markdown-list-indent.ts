import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'

const LEADING_LIST_MARKER_RE =
  /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)(?:\[[ xX]\](?:[ \t]+|$))?/
const LIST_MARKER_FROM_OFFSET_RE =
  /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)(?:\[[ xX]\](?:[ \t]+|$))?/

function visualColumn(text: string): number {
  let col = 0
  for (const ch of text) col += ch === '\t' ? 4 : 1
  return col
}

export function markdownListHangingIndentCh(
  lineText: string,
  markerOffset = 0
): number | null {
  if (markerOffset < 0 || markerOffset > lineText.length) return null
  const markerText = lineText.slice(markerOffset)
  const match =
    markerOffset === 0
      ? lineText.match(LEADING_LIST_MARKER_RE)
      : markerText.match(LIST_MARKER_FROM_OFFSET_RE)
  if (!match) return null
  return Math.max(1, visualColumn(lineText.slice(0, markerOffset) + match[0]))
}

function listMarkerOffsetForLine(view: EditorView, lineFrom: number, lineTo: number): number | null {
  let offset: number | null = null
  syntaxTree(view.state).iterate({
    from: lineFrom,
    to: lineTo,
    enter: (node) => {
      if (offset != null) return false
      if (node.name !== 'ListMark') return
      offset = node.from - lineFrom
      return false
    }
  })
  return offset
}

function computeDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const decoratedLines = new Set<number>()

  for (const { from, to } of view.visibleRanges) {
    const firstLine = view.state.doc.lineAt(from).number
    const lastLine = view.state.doc.lineAt(Math.max(from, to - 1)).number
    for (let lineNo = firstLine; lineNo <= lastLine; lineNo++) {
      if (decoratedLines.has(lineNo)) continue
      const line = view.state.doc.line(lineNo)
      const markerOffset = listMarkerOffsetForLine(view, line.from, line.to)
      if (markerOffset == null) continue
      const indentCh = markdownListHangingIndentCh(line.text, markerOffset)
      if (indentCh == null) continue
      decoratedLines.add(lineNo)
      builder.add(
        line.from,
        line.from,
        Decoration.line({
          class: 'cm-markdown-list-line',
          attributes: {
            style: `--z-list-hanging-indent: ${indentCh}ch`
          }
        })
      )
    }
  }

  return builder.finish()
}

export const markdownListIndentPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = computeDecorations(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = computeDecorations(update.view)
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations
  }
)
