/**
 * Indent sections under headings (Settings → Typography → Headings): every
 * heading and everything under it, text, lists, tasks, tables, embeds, sits
 * one step further in per level, the way the outline draws it. A note's
 * shallowest heading level is depth 0, so a note that starts at H2 is not
 * pushed in for a missing H1.
 *
 * The editor always carries each line's depth; the stylesheet only indents
 * while `<html data-indent-sections>` is set, so turning the setting on or off
 * needs no editor reconfigure. Lines take a class (line decorations). Block
 * widgets (tables, embeds, diagrams, display math) are not lines, so their
 * root element gets a `data-zn-depth` attribute after each update instead.
 * Indentation is a margin, not padding, because list lines already own their
 * padding and text-indent for the hanging indent.
 */
import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { sectionDepthsFromHeadings, type SectionHeading } from './section-depth'

// Same shape the heading folds use, so a line that folds as a heading also
// indents as one.
const HEADING_RE = /^(#{1,6})\s+/

function insideCode(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'Frontmatter') return true
  }
  return false
}

function headingsOf(state: EditorState): SectionHeading[] {
  // One pass over the text (it runs on every edit, setting on or off); only a
  // line that starts with `#` pays for the regex and the code-block check.
  const out: SectionHeading[] = []
  let n = 0
  let from = 0
  for (const text of state.doc.iterLines()) {
    n += 1
    if (text.charCodeAt(0) === 35 /* # */) {
      const match = HEADING_RE.exec(text)
      if (match && !insideCode(state, from)) out.push({ line: n, level: match[1].length })
    }
    from += text.length + 1
  }
  return out
}

/** The note's headings, recomputed when the text or its parse changes (a
 *  fence that is still being parsed can turn a `#` line into code). */
const sectionHeadings = StateField.define<SectionHeading[]>({
  create: headingsOf,
  update(value, tr) {
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return headingsOf(tr.state)
    return value
  }
})

/** Deepest step the stylesheet indents; deeper sections stay at this one. */
export const MAX_SECTION_DEPTH = 5

function lineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const depthOf = sectionDepthsFromHeadings(view.state.field(sectionHeadings))
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      const depth = Math.min(MAX_SECTION_DEPTH, depthOf(line.number))
      if (depth > 0) {
        builder.add(line.from, line.from, Decoration.line({ class: `cm-section-depth-${depth}` }))
      }
      pos = line.to + 1
    }
  }
  return builder.finish()
}

/** Stamps each block widget's root with the depth of the line it stands on. */
function markBlockWidgets(view: EditorView): void {
  const depthOf = sectionDepthsFromHeadings(view.state.field(sectionHeadings))
  for (const child of Array.from(view.contentDOM.children)) {
    if (!(child instanceof HTMLElement) || child.classList.contains('cm-line')) continue
    let pos: number
    try {
      pos = view.posAtDOM(child)
    } catch {
      continue
    }
    const depth = Math.min(MAX_SECTION_DEPTH, depthOf(view.state.doc.lineAt(pos).number))
    const next = depth > 0 ? String(depth) : null
    if (child.getAttribute('data-zn-depth') === next) continue
    if (next) child.setAttribute('data-zn-depth', next)
    else child.removeAttribute('data-zn-depth')
  }
}

const sectionIndentPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = lineDecorations(view)
      this.schedule(view)
    }
    update(update: ViewUpdate): void {
      const headingsChanged =
        update.startState.field(sectionHeadings) !== update.state.field(sectionHeadings)
      if (update.docChanged || update.viewportChanged || headingsChanged) {
        this.decorations = lineDecorations(update.view)
      }
      this.schedule(update.view)
    }
    schedule(view: EditorView): void {
      view.requestMeasure({ read: () => null, write: () => markBlockWidgets(view) })
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

/** The heading scan, exposed for its unit test. */
export const sectionHeadingsForTest = headingsOf

export function sectionIndent(): Extension {
  return [sectionHeadings, sectionIndentPlugin]
}
