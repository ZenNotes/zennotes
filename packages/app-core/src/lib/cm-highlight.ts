/**
 * Markdown highlight, editor side. Mirrors the Preview pipeline
 * (`remarkHighlight` in markdown.ts):
 *   - `==text==`                    → default (yellow) highlight
 *   - `<mark class="hl-X">…</mark>` → a colored highlight
 *
 * Two pieces:
 *   1. Pure wrap/unwrap helpers used by the right-click "Highlight" menu and
 *      the `Shift+Mod+H` shortcut.
 *   2. A WYSIWYG decoration that tints the highlighted text AND hides the
 *      `==` / `<mark>` syntax (revealing it only when the cursor is inside the
 *      highlight), exactly like the live-preview treatment of `**bold**`.
 *      Registered via `wysiwygExtensions()`.
 */
import { syntaxTree } from '@codemirror/language'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'

export type HighlightColorId =
  | 'yellow'
  | 'orange'
  | 'red'
  | 'pink'
  | 'purple'
  | 'blue'
  | 'green'
  | 'gray'

export interface HighlightColor {
  id: HighlightColorId
  label: string
}

/** Yellow is the default (`==`); the rest use a portable `<mark class>`. */
export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { id: 'yellow', label: 'Yellow' },
  { id: 'orange', label: 'Orange' },
  { id: 'red', label: 'Red' },
  { id: 'pink', label: 'Pink' },
  { id: 'purple', label: 'Purple' },
  { id: 'blue', label: 'Blue' },
  { id: 'green', label: 'Green' },
  { id: 'gray', label: 'Gray' }
]

const COLOR_IDS = new Set(HIGHLIGHT_COLORS.map((c) => c.id))

const EQ_WRAP_RE = /^==([\s\S]*)==$/
const MARK_WRAP_RE = /^<mark(?:\s+class="hl-[a-z]+")?\s*>([\s\S]*)<\/mark>$/

/** Strip one layer of `==…==` or `<mark…>…</mark>` from `text`, else return it. */
export function unwrapHighlight(text: string): string {
  const eq = text.match(EQ_WRAP_RE)
  if (eq) return eq[1]
  const mk = text.match(MARK_WRAP_RE)
  if (mk) return mk[1]
  return text
}

/** Wrap `inner` for the given color. Yellow → `==inner==`; others → `<mark>`. */
export function wrapHighlight(inner: string, color: HighlightColorId): string {
  if (color === 'yellow') return `==${inner}==`
  return `<mark class="hl-${color}">${inner}</mark>`
}

/**
 * Apply (or remove) a highlight around the editor selection. Re-coloring works
 * because the existing wrapper is stripped first; the new span is re-selected
 * so the next color choice replaces it cleanly.
 */
export function applyHighlight(view: EditorView, action: HighlightColorId | 'remove'): void {
  const sel = view.state.selection.main
  if (sel.empty) return
  const doc = view.state.doc
  let from = sel.from
  let to = sel.to
  // Absorb `==` markers immediately outside the selection so highlighting the
  // inner word (not the markers) still recolors instead of nesting.
  if (
    from >= 2 &&
    doc.sliceString(from - 2, from) === '==' &&
    doc.sliceString(to, to + 2) === '=='
  ) {
    from -= 2
    to += 2
  }
  const inner = unwrapHighlight(doc.sliceString(from, to))
  const insert = action === 'remove' ? inner : wrapHighlight(inner, action)
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from, head: from + insert.length }
  })
  view.focus()
}

// ---------------------------------------------------------------------------
// Editor decoration (tint + hide syntax with reveal-on-cursor)
// ---------------------------------------------------------------------------

// Mirrors the Preview regexes. `==text==` requires a non-space just inside the
// markers; `<mark>` captures an optional `hl-<color>` class.
const HL_EQ_RE = /==(?=\S)([\s\S]*?\S)==/g
const HL_MARK_RE = /<mark(?:\s+class="hl-([a-z]+)")?\s*>([\s\S]*?)<\/mark>/g
const HIDE = Decoration.replace({})

function colorClass(color: string | undefined): string {
  return color && COLOR_IDS.has(color as HighlightColorId) ? `cm-hl-${color}` : 'cm-hl'
}

/** True when the cursor or a selection overlaps `[from, to]` — reveal the raw
 *  syntax then, like the rest of the live-preview. */
function selectionTouches(state: EditorView['state'], from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.empty) {
      if (range.from >= from && range.from <= to) return true
      continue
    }
    if (Math.max(range.from, from) < Math.min(range.to, to)) return true
  }
  return false
}

/** True when `pos` is inside a code span/block — where `==` isn't a highlight. */
function inCode(state: EditorView['state'], pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1)
  while (node) {
    const n = node.name
    if (n === 'FencedCode' || n === 'CodeBlock' || n === 'InlineCode') return true
    if (!node.parent) break
    node = node.parent
  }
  return false
}

interface HlMatch {
  start: number
  end: number
  innerFrom: number
  innerTo: number
  cls: string
}

function collectMatches(view: EditorView): HlMatch[] {
  const { state } = view
  const matches: HlMatch[] = []
  for (const { from, to } of view.visibleRanges) {
    const firstLine = state.doc.lineAt(from).number
    const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number
    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n)
      const text = line.text
      if (text.includes('==')) {
        HL_EQ_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = HL_EQ_RE.exec(text)) !== null) {
          const start = line.from + m.index
          const innerFrom = start + 2
          if (inCode(state, innerFrom)) continue
          matches.push({ start, end: start + m[0].length, innerFrom, innerTo: innerFrom + m[1].length, cls: 'cm-hl' })
        }
      }
      if (text.includes('<mark')) {
        HL_MARK_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = HL_MARK_RE.exec(text)) !== null) {
          if (m[2].length === 0) continue
          const start = line.from + m.index
          const innerFrom = start + (m[0].length - m[2].length - '</mark>'.length)
          matches.push({ start, end: start + m[0].length, innerFrom, innerTo: innerFrom + m[2].length, cls: colorClass(m[1]) })
        }
      }
    }
  }
  // Drop any match that overlaps an earlier one (e.g. `==` around a `<mark>`),
  // so replacing decorations never overlap (CodeMirror forbids that).
  matches.sort((a, b) => a.start - b.start || a.end - b.end)
  const accepted: HlMatch[] = []
  let lastEnd = -1
  for (const m of matches) {
    if (m.start < lastEnd) continue
    accepted.push(m)
    lastEnd = m.end
  }
  return accepted
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const entries: Array<{ from: number; to: number; deco: Decoration }> = []
  for (const m of collectMatches(view)) {
    entries.push({ from: m.innerFrom, to: m.innerTo, deco: Decoration.mark({ class: m.cls }) })
    // Hide the surrounding syntax unless the cursor is inside this highlight.
    if (!selectionTouches(state, m.start, m.end)) {
      if (m.innerFrom > m.start) entries.push({ from: m.start, to: m.innerFrom, deco: HIDE })
      if (m.end > m.innerTo) entries.push({ from: m.innerTo, to: m.end, deco: HIDE })
    }
  }
  entries.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(
    entries.map((e) => e.deco.range(e.from, e.to)),
    true
  )
}

const highlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  {
    decorations: (p) => p.decorations,
    // Replacing decorations that hide ranges must be declared as atomic so the
    // cursor steps over the hidden markers (reveal happens on entry).
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none)
  }
)

export const highlightExtension = [highlightPlugin]
