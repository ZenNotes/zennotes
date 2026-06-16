/**
 * WYSIWYG block rendering that the base live-preview plugin doesn't cover:
 * Obsidian-style blockquote bars, unordered-list bullets, and horizontal
 * rules. Like the rest of live preview, the raw source is revealed on the
 * line the cursor is on; everything else renders.
 *
 * Enabled wherever `wysiwygExtensions()` is loaded.
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
import {
  hasPendingMarkdownBlockSnippet,
  isPendingMarkdownBlockSnippetStart
} from './cm-markdown-snippets'
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

/** A block-level spacer inserted before a block that has no blank line above
 *  it, so the Edit pane's block rhythm matches Preview's collapsed margins. */
class BlockGapWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const div = document.createElement('div')
    div.className = 'cm-wysiwyg-block-gap'
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
const blockGap = Decoration.widget({
  block: true,
  side: -1,
  widget: new BlockGapWidget()
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

function selectionTouchesRange(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.empty) {
      if (range.from >= from && range.from <= to) return true
      continue
    }
    if (Math.max(range.from, from) < Math.min(range.to, to)) return true
  }
  return false
}

function taskMarkerAfterListMark(
  state: EditorState,
  listMarkFrom: number,
  listMarkTo: number
): { from: number; to: number } | null {
  const line = state.doc.lineAt(listMarkFrom)
  if (state.doc.lineAt(listMarkTo).number !== line.number) return null
  const tail = state.doc.sliceString(listMarkTo, line.to)
  const match = tail.match(/^([ \t]+)\[[ xX]\](?:[ \t]|$)/)
  if (!match) return null
  const from = listMarkTo + match[1].length
  return { from, to: from + 3 }
}

/**
 * Insert a block-level gap before every top-level block (heading, paragraph,
 * list, blockquote, code, table…) that isn't already separated from the block
 * above it by a blank line. Preview collapses source blank lines into uniform
 * block margins; this reproduces that rhythm in the Edit pane without touching
 * the source. Iterating only the Document's direct children means list items
 * and nested blocks never get an internal gap.
 */
function buildBlockGapDecorations(state: EditorState): DecorationSet {
  const fmEnd = frontmatterEndLine(state)
  const pending: number[] = []
  let prevName: string | null = null
  let child = syntaxTree(state).topNode.firstChild
  while (child) {
    const node = child
    const next = node.nextSibling
    if (node.name === 'FencedCode' && isPendingMarkdownBlockSnippetStart(state, node.from)) {
      child = next
      continue
    }
    const firstLine = state.doc.lineAt(node.from)
    // The first block (and the block opening / immediately after frontmatter)
    // gets no top gap — Preview's `:first-child` has margin-top: 0.
    const isLeading = firstLine.number <= 1 || (fmEnd >= 1 && firstLine.number <= fmEnd + 1)
    if (!isLeading) {
      const prevBlank = state.doc.line(firstLine.number - 1).text.trim() === ''
      // The H1 title already carries its own rhythm spacer (the underline gap),
      // so the block after it is separated — don't stack a second gap.
      const prevIsH1 = prevName === 'ATXHeading1' || prevName === 'SetextHeading1'
      if (!prevBlank && !prevIsH1) pending.push(firstLine.from)
    }
    prevName = node.name
    child = next
  }

  const builder = new RangeSetBuilder<Decoration>()
  for (const from of pending) builder.add(from, from, blockGap)
  return builder.finish()
}

const blockGapField = StateField.define<DecorationSet>({
  create: (state) => buildBlockGapDecorations(state),
  update(value, tr) {
    if (hasPendingMarkdownBlockSnippet(tr.state)) {
      return tr.docChanged ? value.map(tr.changes) : value
    }
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return buildBlockGapDecorations(tr.state)
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
          if (isPendingMarkdownBlockSnippetStart(state, node.from)) return false
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
          const taskMarker = taskMarkerAfterListMark(state, node.from, node.to)
          if (taskMarker) {
            if (selectionTouchesRange(state, node.from, taskMarker.to)) return
            pending.push({ from: node.from, to: taskMarker.from, deco: hideInline, line: false })
            return
          }
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
      if (hasPendingMarkdownBlockSnippet(update.state)) {
        if (update.docChanged) this.decorations = this.decorations.map(update.changes)
        return
      }
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (p) => p.decorations }
)

export const wysiwygBlocksPlugin: Extension = [blockGapField, wysiwygInlineBlocksPlugin]
