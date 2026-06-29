/**
 * Styles Obsidian-style inline hashtags (`#tag`) as pills in the WYSIWYG
 * editor, mirroring how the Preview pipeline (`remarkHashtags`) renders them.
 * The `#tag` text stays editable — we only add a `cm-hashtag` mark — so this
 * needs no active-line handling. Matches in code spans/blocks and headings are
 * skipped, same as Preview.
 *
 * WYSIWYG-only: registered via `wysiwygExtensions()`.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { useStore } from '../store'

// Same shape as the Preview regex: a `#`, preceded by start-of-text or
// whitespace, then any Unicode letter (Cyrillic/CJK/… included, #205) followed
// by letters, digits, `_`, `-`, or `/`.
const HASHTAG_RE = /(^|\s)#(\p{L}[\p{L}\d_/-]*)/gu

/** True when `pos` sits inside a code span/block or a heading — contexts where
 *  a `#` isn't a tag (`#include`, `# Heading`, …). */
function skipContext(state: EditorView['state'], pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1)
  while (node) {
    const n = node.name
    if (
      n === 'FencedCode' ||
      n === 'CodeBlock' ||
      n === 'InlineCode' ||
      n.startsWith('ATXHeading') ||
      n.startsWith('SetextHeading')
    ) {
      return true
    }
    if (!node.parent) break
    node = node.parent
  }
  return false
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    const firstLine = state.doc.lineAt(from).number
    const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number
    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n)
      if (!line.text.includes('#')) continue
      HASHTAG_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = HASHTAG_RE.exec(line.text)) !== null) {
        const tagStart = line.from + m.index + m[1].length
        const tagEnd = tagStart + 1 + m[2].length
        if (skipContext(state, tagStart)) continue
        // Per-match so the tag name rides along for the click handler.
        builder.add(
          tagStart,
          tagEnd,
          Decoration.mark({ class: 'cm-hashtag', attributes: { 'data-tag': m[2] } })
        )
      }
    }
  }
  return builder.finish()
}

const hashtagPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (p) => p.decorations }
)

// Clicking a hashtag opens the tag view (Obsidian-style). We intercept on
// mousedown so CodeMirror doesn't first drop the caret into the tag.
const hashtagClick = EditorView.domEventHandlers({
  mousedown: (event) => {
    const target = event.target as HTMLElement | null
    const el = target?.closest<HTMLElement>('.cm-hashtag')
    const tag = el?.dataset.tag
    if (!tag) return false
    event.preventDefault()
    void useStore.getState().openTagView(tag)
    return true
  }
})

export const hashtagExtension = [hashtagPlugin, hashtagClick]
