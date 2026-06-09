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
const FRONTMATTER_FENCE = Decoration.line({ class: 'cm-frontmatter-line cm-frontmatter-fence' })

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
    builder.add(line.from, line.from, i === 1 || i === endLine ? FRONTMATTER_FENCE : FRONTMATTER_LINE)
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
