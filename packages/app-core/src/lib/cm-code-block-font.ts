/**
 * Tags every line inside a fenced or indented code block with
 * `cm-code-block-line` so the stylesheet can render the whole block in the
 * configured monospace font (`--z-mono-font`).
 *
 * Without this, only inline code (a live-preview chip) and the rendered preview
 * use the mono font — fenced code-block *content* in the editor inherits the
 * body text font, which is often proportional. The syntax-color tokens
 * (`tok-keyword`, …) only set color, so a line-level class is the reliable way
 * to cover tokens *and* the plain whitespace/punctuation between them.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { isClosedFencedCodeBlock } from './cm-code-blocks'
import {
  hasPendingMarkdownBlockSnippet,
  isPendingMarkdownBlockSnippetStart,
  pendingMarkdownBlockSnippetLineFrom
} from './cm-markdown-snippets'

const codeBlockLine = Decoration.line({ class: 'cm-code-block-line' })
const pendingCodeBlockLine = Decoration.line({ class: 'cm-pending-code-block-line' })
// First / last line of each block also carry begin/end classes so the WYSIWYG
// stylesheet can round the top and bottom of the code "card".
const codeBlockBegin = Decoration.line({ class: 'cm-code-block-begin' })
const codeBlockEnd = Decoration.line({ class: 'cm-code-block-end' })

function buildPendingDecorations(state: EditorState): DecorationSet {
  if (!hasPendingMarkdownBlockSnippet(state)) return Decoration.none
  const tree = syntaxTree(state)
  const lines = new Set<number>()

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return
      if (!isPendingMarkdownBlockSnippetStart(state, node.from)) return
      let pos = node.from
      while (pos <= node.to) {
        const line = state.doc.lineAt(pos)
        lines.add(line.from)
        if (line.to >= node.to) break
        pos = line.to + 1
      }
      return false
    }
  })

  const builder = new RangeSetBuilder<Decoration>()
  for (const from of [...lines].sort((a, b) => a - b)) {
    builder.add(from, from, pendingCodeBlockLine)
  }
  return builder.finish()
}

function buildDecorations(view: EditorView): DecorationSet {
  const tree = syntaxTree(view.state)
  // Collect each block's line starts and the first/last line so a block that
  // straddles the viewport gap (visited twice) is deduped before we add to the
  // builder in strictly-ascending order.
  const lineClasses = new Map<number, { line: boolean; begin: boolean; end: boolean }>()
  const mark = (from: number, key: 'line' | 'begin' | 'end'): void => {
    const entry = lineClasses.get(from) ?? { line: false, begin: false, end: false }
    entry[key] = true
    lineClasses.set(from, entry)
  }
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') return
        if (
          node.name === 'FencedCode' &&
          isPendingMarkdownBlockSnippetStart(view.state, node.from)
        ) {
          return false
        }
        if (
          node.name === 'FencedCode' &&
          !isClosedFencedCodeBlock(view.state, node.from, node.to)
        ) {
          return false
        }
        const firstLine = view.state.doc.lineAt(node.from)
        const lastLine = view.state.doc.lineAt(Math.max(node.from, node.to - 1))
        let pos = node.from
        while (pos <= node.to) {
          const line = view.state.doc.lineAt(pos)
          mark(line.from, 'line')
          if (line.to >= node.to) break
          pos = line.to + 1
        }
        mark(firstLine.from, 'begin')
        mark(lastLine.from, 'end')
        return false // whole block handled; skip its children
      },
    })
  }
  const builder = new RangeSetBuilder<Decoration>()
  for (const from of [...lineClasses.keys()].sort((a, b) => a - b)) {
    const entry = lineClasses.get(from)
    if (!entry) continue
    // Order matters: RangeSetBuilder keeps insertion order for equal points,
    // and CodeMirror merges the classes of stacked line decorations.
    if (entry.line) builder.add(from, from, codeBlockLine)
    if (entry.begin) builder.add(from, from, codeBlockBegin)
    if (entry.end) builder.add(from, from, codeBlockEnd)
  }
  return builder.finish()
}

const codeBlockFontViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate): void {
      if (hasPendingMarkdownBlockSnippet(update.state)) {
        if (update.docChanged) this.decorations = this.decorations.map(update.changes)
        return
      }
      const pendingChanged =
        pendingMarkdownBlockSnippetLineFrom(update.startState) !==
        pendingMarkdownBlockSnippetLineFrom(update.state)
      if (update.docChanged || update.viewportChanged || pendingChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

const pendingCodeBlockLineField = StateField.define<DecorationSet>({
  create: (state) => buildPendingDecorations(state),
  update(value, tr) {
    if (hasPendingMarkdownBlockSnippet(tr.state)) return buildPendingDecorations(tr.state)
    if (pendingMarkdownBlockSnippetLineFrom(tr.startState) != null) return Decoration.none
    return tr.docChanged ? value.map(tr.changes) : value
  },
  provide: (field) => EditorView.decorations.from(field)
})

export const codeBlockFontPlugin: Extension = [
  codeBlockFontViewPlugin,
  pendingCodeBlockLineField
]
