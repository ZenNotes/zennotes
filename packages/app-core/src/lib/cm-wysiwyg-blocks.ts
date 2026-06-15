/**
 * WYSIWYG block rendering that the base live-preview plugin doesn't cover:
 * Obsidian-style blockquote bars, unordered-list bullets, and horizontal
 * rules. Like the rest of live preview, the raw source is revealed on the
 * line the cursor is on; everything else renders.
 *
 * WYSIWYG-only: registered via `wysiwygExtensions()`; never loads in Split.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { isClosedFencedCodeBlock } from './cm-code-blocks'
import { frontmatterEndLine } from './cm-properties'

const quoteLine = Decoration.line({ class: 'cm-wq-quote' })

/** A round bullet that replaces a `-` / `*` / `+` list marker. */
class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-wq-bullet'
    span.textContent = '•'
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** A horizontal rule rendered in place of `---` / `***` / `___`. */
class HrWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-wq-hr'
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

class CodeBlockGapWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const div = document.createElement('div')
    div.className = 'cm-code-block-gap'
    div.setAttribute('aria-hidden', 'true')
    return div
  }
  ignoreEvent(): boolean {
    return true
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() })
const hrRule = Decoration.replace({ widget: new HrWidget() })
/** Hide a fence line's ``` ```lang ``` / ``` ``` ``` text (inline, keeps the
 *  line + its card styling) when the cursor is outside the code block. */
const hideInline = Decoration.replace({})
const codeBlockGap = Decoration.widget({
  block: true,
  side: -1,
  widget: new CodeBlockGapWidget()
})

function activeLineSet(view: EditorView): Set<number> {
  const lines = new Set<number>()
  for (const r of view.state.selection.ranges) {
    const from = view.state.doc.lineAt(r.from).number
    const to = view.state.doc.lineAt(r.to).number
    for (let l = from; l <= to; l++) lines.add(l)
  }
  return lines
}

type Pending = { from: number; to: number; deco: Decoration; line: boolean }

function buildCodeBlockGapDecorations(state: EditorState): DecorationSet {
  const pending: Array<{ from: number; deco: Decoration }> = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return
      if (!isClosedFencedCodeBlock(state, node.from, node.to)) return false
      const firstLine = state.doc.lineAt(node.from)
      const hasLeadingBlank =
        firstLine.number > 1 &&
        state.doc.line(firstLine.number - 1).text.trim() === ''
      if (!hasLeadingBlank) {
        pending.push({ from: firstLine.from, deco: codeBlockGap })
      }
      return false
    }
  })

  const builder = new RangeSetBuilder<Decoration>()
  for (const p of pending) builder.add(p.from, p.from, p.deco)
  return builder.finish()
}

const codeBlockGapField = StateField.define<DecorationSet>({
  create: (state) => buildCodeBlockGapDecorations(state),
  update(value, tr) {
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return buildCodeBlockGapDecorations(tr.state)
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field)
})

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const active = activeLineSet(view)
  const pending: Pending[] = []
  const quotedLines = new Set<number>()
  // The properties widget owns the leading frontmatter (its `---` fences parse
  // as HorizontalRule); skip that range so we don't emit an overlapping
  // replace decoration over the same lines.
  const fmEnd = frontmatterEndLine(state)

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === 'Blockquote') {
          // Tag every line the blockquote spans for the left bar.
          const first = state.doc.lineAt(node.from).number
          const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number
          for (let n = first; n <= last; n++) {
            if (quotedLines.has(n)) continue
            quotedLines.add(n)
            const line = state.doc.line(n)
            pending.push({ from: line.from, to: line.from, deco: quoteLine, line: true })
          }
          return
        }
        if (node.name === 'HorizontalRule') {
          const lineNo = state.doc.lineAt(node.from).number
          if (fmEnd >= 1 && lineNo <= fmEnd) return // leave frontmatter to the properties widget
          if (active.has(lineNo)) return // reveal `---` source on the active line
          pending.push({ from: node.from, to: node.to, deco: hrRule, line: false })
          return
        }
        if (node.name === 'FencedCode') {
          if (!isClosedFencedCodeBlock(state, node.from, node.to)) return false
          // Hide the ``` fence lines when the cursor is outside the block, so
          // it reads as a clean card (the language flair still shows the lang).
          // Clicking into the block reveals the fences for editing.
          const firstLine = state.doc.lineAt(node.from)
          const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1))
          let blockActive = false
          for (let n = firstLine.number; n <= lastLine.number; n++) {
            if (active.has(n)) {
              blockActive = true
              break
            }
          }
          if (!blockActive) {
            if (firstLine.to > firstLine.from) {
              pending.push({ from: firstLine.from, to: firstLine.to, deco: hideInline, line: false })
            }
            // Only hide the last line if it's actually a closing fence — an
            // unclosed block at EOF ends on a content line we must keep.
            const closesWithFence = /^\s*(?:`{3,}|~{3,})\s*$/.test(lastLine.text)
            if (
              closesWithFence &&
              lastLine.number !== firstLine.number &&
              lastLine.to > lastLine.from
            ) {
              pending.push({ from: lastLine.from, to: lastLine.to, deco: hideInline, line: false })
            }
          }
          return false // don't descend into the code content
        }
        if (node.name === 'ListMark') {
          const lineNo = state.doc.lineAt(node.from).number
          if (active.has(lineNo)) return
          const text = state.doc.sliceString(node.from, node.to)
          // Only unordered bullets become a •; ordered markers (`1.`) stay.
          if (!/^[-*+]$/.test(text)) return
          pending.push({ from: node.from, to: node.to, deco: bullet, line: false })
        }
      }
    })
  }

  // RangeSetBuilder needs ascending order; line decorations sort before
  // content decorations at the same position.
  pending.sort((a, b) => a.from - b.from || (a.line === b.line ? 0 : a.line ? -1 : 1))
  const builder = new RangeSetBuilder<Decoration>()
  for (const p of pending) builder.add(p.from, p.to, p.deco)
  return builder.finish()
}

const wysiwygInlineBlocksPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (p) => p.decorations }
)

export const wysiwygBlocksPlugin: Extension = [codeBlockGapField, wysiwygInlineBlocksPlugin]
