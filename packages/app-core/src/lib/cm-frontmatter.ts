/**
 * Render a note's leading YAML frontmatter block (the `---` … `---` at the very
 * top) as compact, muted "properties" instead of full-size body text. This is
 * the in-editor counterpart to how the preview hides frontmatter — and it makes
 * database "record page" notes (whose properties live in frontmatter) read like
 * a property list rather than a wall of big text.
 */
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'

const FRONTMATTER_LINE = Decoration.line({ class: 'cm-frontmatter-line' })
const FRONTMATTER_TOP = Decoration.line({ class: 'cm-frontmatter-line cm-frontmatter-top' })
const FRONTMATTER_BOTTOM = Decoration.line({ class: 'cm-frontmatter-line cm-frontmatter-bottom' })
const FRONTMATTER_KEY = Decoration.mark({ class: 'cm-frontmatter-key' })

function buildFrontmatterDeco(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = view.state.doc
  // Frontmatter must start on line 1 with an exact `---` fence.
  if (doc.lines < 2 || doc.line(1).text.trim() !== '---') return builder.finish()
  let endLine = -1
  for (let i = 2; i <= doc.lines; i++) {
    if (doc.line(i).text.trim() === '---') {
      endLine = i
      break
    }
  }
  if (endLine === -1) return builder.finish()
  for (let i = 1; i <= endLine; i++) {
    const line = doc.line(i)
    // Line decoration first (its start side sorts before any mark at the same
    // offset), then the key mark for property lines.
    builder.add(
      line.from,
      line.from,
      i === 1 ? FRONTMATTER_TOP : i === endLine ? FRONTMATTER_BOTTOM : FRONTMATTER_LINE
    )
    if (i !== 1 && i !== endLine) {
      // Mark the key (text before the first `:`) so it reads as a muted label
      // next to its value — a metadata panel, not a wall of text.
      const colon = line.text.indexOf(':')
      if (colon > 0) builder.add(line.from, line.from + colon, FRONTMATTER_KEY)
    }
  }
  return builder.finish()
}

export const frontmatterStyle = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildFrontmatterDeco(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged) this.decorations = buildFrontmatterDeco(update.view)
    }
  },
  { decorations: (v) => v.decorations }
)
