/**
 * Obsidian-style heading folding for CodeMirror 6 markdown editors.
 *
 * A fold on a heading hides everything from the end of the heading
 * line up to (but not including) the next heading of equal-or-higher
 * level — or the end of the document when none follows.
 *
 * The exported extension bundles three pieces:
 *   - `foldService`: the semantic range calculator so CodeMirror's
 *     built-in fold commands (vim `z c` / `z o`, the :fold ex command)
 *     know what to collapse.
 *   - A `ViewPlugin` that adds an inline ▾ arrow to each heading's
 *     line start and a line-decoration class marking the cursor line.
 *   - No fold gutter — the full-document gutter would show chevrons
 *     next to every foldable range (lists, code blocks, frontmatter)
 *     which clutters the minimalist editor surface.
 *
 * CSS rules in styles/index.css hide the arrow by default and only
 * reveal it when the heading line is hovered or holds the caret,
 * matching Obsidian's behaviour.
 */
import { foldService, foldable, foldEffect, unfoldEffect, foldedRanges } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view'

const HEADING_RE = /^(#{1,6})\s+/

function headingLevelAt(state: EditorState, lineNumber: number): number | null {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return null
  const text = state.doc.line(lineNumber).text
  const match = text.match(HEADING_RE)
  return match ? match[1].length : null
}

function rangeForHeading(
  state: EditorState,
  headingLine: number,
  level: number
): { from: number; to: number } | null {
  const total = state.doc.lines
  let endLine = total
  for (let i = headingLine + 1; i <= total; i++) {
    const next = headingLevelAt(state, i)
    if (next !== null && next <= level) {
      endLine = i - 1
      break
    }
  }
  if (endLine <= headingLine) return null
  const from = state.doc.line(headingLine).to
  const to = state.doc.line(endLine).to
  if (to <= from) return null
  return { from, to }
}

class HeadingFoldArrow extends WidgetType {
  constructor(
    private readonly line: number,
    private readonly folded: boolean
  ) {
    super()
  }

  eq(other: HeadingFoldArrow): boolean {
    return other.line === this.line && other.folded === this.folded
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span')
    el.className = `cm-heading-fold-arrow ${this.folded ? 'is-folded' : 'is-open'}`
    el.setAttribute('role', 'button')
    el.setAttribute('aria-label', this.folded ? 'Expand heading' : 'Collapse heading')
    el.setAttribute('aria-expanded', String(!this.folded))
    el.textContent = this.folded ? '▸' : '▾'
    el.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      toggleHeadingFold(view, this.line)
    })
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** Toggle the fold at the given heading line by consulting the current
 *  fold state and dispatching fold/unfold effects directly — avoids a
 *  dependency on CodeMirror's `foldCode` command context. */
function toggleHeadingFold(view: EditorView, lineNumber: number): void {
  const { state } = view
  if (lineNumber < 1 || lineNumber > state.doc.lines) return
  const line = state.doc.line(lineNumber)
  const range = foldable(state, line.from, line.to)
  if (!range) return
  const folded = foldedRanges(state)
  let existing: { from: number; to: number } | null = null
  folded.between(range.from, range.to, (from, to) => {
    if (from === range.from && to === range.to) {
      existing = { from, to }
      return false
    }
    return undefined
  })
  view.dispatch({
    effects: existing ? unfoldEffect.of(existing) : foldEffect.of(range)
  })
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const builder: { from: number; to: number; deco: Decoration }[] = []
  const folded = foldedRanges(state)

  for (const { from, to } of view.visibleRanges) {
    const first = state.doc.lineAt(from).number
    const last = state.doc.lineAt(Math.max(from, to - 1)).number
    for (let n = first; n <= last; n++) {
      const level = headingLevelAt(state, n)
      if (level === null) continue
      const range = rangeForHeading(state, n, level)
      if (!range) continue
      const line = state.doc.line(n)

      // Check whether this exact heading range is currently folded.
      let isFolded = false
      folded.between(range.from, range.to, (rf, rt) => {
        if (rf === range.from && rt === range.to) {
          isFolded = true
          return false
        }
        return undefined
      })

      // Line decoration adds `cm-heading-line` to the cm-line div so
      // CSS can target heading rows specifically. The active-line
      // highlight is already provided by the built-in
      // `highlightActiveLine()` extension, which stamps `cm-activeLine`
      // on whichever row the caret is on — we combine the two in CSS.
      const classes = ['cm-heading-line']
      if (isFolded) classes.push('cm-heading-line-folded')
      builder.push({
        from: line.from,
        to: line.from,
        deco: Decoration.line({ class: classes.join(' ') })
      })

      // Widget sits at the very start of the line (side: 1 → just
      // after line.from, which is the first child of the line div).
      builder.push({
        from: line.from,
        to: line.from,
        deco: Decoration.widget({
          side: 1,
          widget: new HeadingFoldArrow(n, isFolded)
        })
      })
    }
  }

  builder.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(builder.map((b) => b.deco.range(b.from, b.to)))
}

const headingArrowPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect))
        )
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations
  }
)

export function headingFolding(): Extension {
  const service = foldService.of((state, from, _to) => {
    const lineNumber = state.doc.lineAt(from).number
    const level = headingLevelAt(state, lineNumber)
    if (level === null) return null
    return rangeForHeading(state, lineNumber, level)
  })

  return [service, headingArrowPlugin]
}
