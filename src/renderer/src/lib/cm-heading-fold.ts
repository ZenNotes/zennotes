/**
 * Obsidian-style heading folding for CodeMirror 6 markdown editors.
 *
 * A fold on a heading hides everything from the end of the heading
 * line up to (but not including) the next heading of equal-or-higher
 * level — or the end of the document when none follows.
 *
 * We register two cooperating extensions:
 *   - `foldService`: tells CodeMirror's folding machinery how to turn
 *     a heading line into a foldable range.
 *   - `foldGutter`: renders clickable ▸/▾ arrows next to the heading
 *     lines (the gutter only shows markers on lines the service can
 *     actually fold, so body lines stay clean).
 *
 * Users can also fold via vim — CodeMirror's built-in `foldCode` /
 * `unfoldCode` are already wired to `z c` / `z o`. `foldAll` / `unfoldAll`
 * correspond to `z M` / `z R`.
 */
import { foldGutter, foldService } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'

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
  if (endLine <= headingLine) return null // nothing to hide
  const from = state.doc.line(headingLine).to
  const to = state.doc.line(endLine).to
  if (to <= from) return null
  return { from, to }
}

export function headingFolding(): Extension {
  const service = foldService.of((state, from, _to) => {
    // CodeMirror asks per line whether it starts a fold. `from` is the
    // start-of-line char offset; line.number is what we want.
    const lineNumber = state.doc.lineAt(from).number
    const level = headingLevelAt(state, lineNumber)
    if (level === null) return null
    return rangeForHeading(state, lineNumber, level)
  })

  return [
    service,
    foldGutter({
      markerDOM: (open) => {
        const el = document.createElement('span')
        el.className = `cm-heading-fold-marker ${open ? 'is-open' : 'is-closed'}`
        el.textContent = open ? '▾' : '▸'
        return el
      }
    })
  ]
}
