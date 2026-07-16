/**
 * WYSIWYG block rendering that the base live-preview plugin doesn't cover:
 * Obsidian-style blockquote bars, unordered-list bullets, and horizontal
 * rules. Like the rest of live preview, the raw source is revealed on the
 * line the cursor is on; everything else renders.
 *
 * WYSIWYG-only: registered via `wysiwygExtensions()`; never loads in Split.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, type EditorState } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { calloutGroupFor } from './callout-types'
/** Line number (1-based) of the closing `---` of leading YAML frontmatter,
 *  or -1 when there is none. Lets us leave the frontmatter fences to the
 *  frontmatter styling rather than rendering them as horizontal rules.
 *  (Inlined: the PR's full frontmatter-properties module isn't ported.) */
function frontmatterEndLine(state: EditorState): number {
  const doc = state.doc
  if (doc.lines < 2 || doc.line(1).text.trim() !== '---') return -1
  for (let i = 2; i <= doc.lines; i++) {
    if (doc.line(i).text.trim() === '---') return i
  }
  return -1
}

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

const bullet = Decoration.replace({ widget: new BulletWidget() })
const hrRule = Decoration.replace({ widget: new HrWidget() })
/** Hide a fence line's ``` ```lang ``` / ``` ``` ``` text (inline, keeps the
 *  line + its card styling) when the cursor is outside the code block. */
const hideInline = Decoration.replace({})

/** Header of an Obsidian-style callout: `> [!type] optional title`. */
const CALLOUT_RE = /^(\s*>\s?)\[!(\w+)\]\s?(.*)$/

/** Collapse callout type aliases onto one color group, mirroring the Preview
 *  renderer (markdown.ts) via the shared `callout-types` table. */
const calloutGroup = calloutGroupFor

/** Default title for a callout with no custom title: the capitalized type. */
function calloutTitle(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()
}

/** Styled label shown in place of a `[!type]` token when the callout has no
 *  custom title (e.g. renders "Note"). */
class CalloutTitleWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly group: string
  ) {
    super()
  }
  eq(other: CalloutTitleWidget): boolean {
    return other.label === this.label && other.group === this.group
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = `cm-callout-title cm-callout-${this.group}`
    span.textContent = this.label
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

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
          const first = state.doc.lineAt(node.from).number
          const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number
          const firstLine = state.doc.line(first)
          const callout = firstLine.text.match(CALLOUT_RE)
          if (callout) {
            // Obsidian-style callout: a colored card with a typed title. Tag
            // each line for the box (head/foot round the top/bottom).
            const group = calloutGroup(callout[2])
            for (let n = first; n <= last; n++) {
              if (quotedLines.has(n)) continue
              quotedLines.add(n)
              const ln = state.doc.line(n)
              let cls = `cm-callout cm-callout-${group}`
              if (n === first) cls += ' cm-callout-head'
              if (n === last) cls += ' cm-callout-foot'
              pending.push({
                from: ln.from,
                to: ln.from,
                deco: Decoration.line({ class: cls }),
                line: true
              })
            }
            // Header: render the title. Off the line, hide the `[!type]` token —
            // the custom title stays (styled), or we show the type name.
            if (!active.has(first)) {
              const bStart = firstLine.from + callout[1].length
              const bEnd = bStart + `[!${callout[2]}]`.length
              if (callout[3].trim()) {
                let to = bEnd
                if (state.doc.sliceString(to, to + 1) === ' ') to += 1
                pending.push({ from: bStart, to, deco: hideInline, line: false })
              } else {
                pending.push({
                  from: bStart,
                  to: bEnd,
                  deco: Decoration.replace({
                    widget: new CalloutTitleWidget(calloutTitle(callout[2]), group)
                  }),
                  line: false
                })
              }
            }
            return
          }
          // Plain blockquote: a left bar on every line it spans.
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
          // Task-list items render a checkbox (from the live-preview plugin) in
          // place of the marker, so HIDE the `-`/`*`/`+` (and its trailing
          // space) rather than bulleting it — the line reads "☐ task" like
          // Obsidian, not "- ☐ task" or "• ☐ task".
          const afterMark = state.doc.sliceString(node.to, state.doc.lineAt(node.from).to)
          if (/^\s*\[[ xX]\]/.test(afterMark)) {
            let to = node.to
            if (state.doc.sliceString(to, to + 1) === ' ') to += 1
            pending.push({ from: node.from, to, deco: hideInline, line: false })
            return
          }
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

export const wysiwygBlocksPlugin = ViewPlugin.fromClass(
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
