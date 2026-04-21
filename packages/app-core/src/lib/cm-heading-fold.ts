/**
 * Obsidian-style heading folding for CodeMirror 6 markdown editors.
 *
 * A fold on a heading hides everything from the end of the heading
 * line up to (but not including) the next heading of equal-or-higher
 * level — or the end of the document when none follows.
 *
 * The exported extension bundles three pieces:
 *   - `foldService`: the semantic range calculator so CodeMirror's
 *     fold commands (our vim `zc` / `zo` mappings, the `:fold`
 *     ex command) know what to collapse.
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
import {
  codeFolding,
  foldService,
  foldEffect,
  unfoldEffect,
  foldedRanges
} from '@codemirror/language'
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

function restoreStyleProperty(
  el: HTMLElement,
  key: 'width' | 'min-width' | 'height' | 'max-height' | 'line-height' | 'transform',
  value: string
): void {
  if (value) el.style.setProperty(key, value)
  else el.style.removeProperty(key)
}

function measureNaturalCursorRect(el: HTMLElement): DOMRect | null {
  const prevWidth = el.style.getPropertyValue('width')
  const prevMinWidth = el.style.getPropertyValue('min-width')
  const prevHeight = el.style.getPropertyValue('height')
  const prevMaxHeight = el.style.getPropertyValue('max-height')
  const prevLineHeight = el.style.getPropertyValue('line-height')
  const prevTransform = el.style.getPropertyValue('transform')
  el.style.removeProperty('width')
  el.style.removeProperty('min-width')
  el.style.removeProperty('height')
  el.style.removeProperty('max-height')
  el.style.removeProperty('line-height')
  el.style.removeProperty('transform')
  const rect = el.getBoundingClientRect()
  restoreStyleProperty(el, 'width', prevWidth)
  restoreStyleProperty(el, 'min-width', prevMinWidth)
  restoreStyleProperty(el, 'height', prevHeight)
  restoreStyleProperty(el, 'max-height', prevMaxHeight)
  restoreStyleProperty(el, 'line-height', prevLineHeight)
  restoreStyleProperty(el, 'transform', prevTransform)
  return rect.width > 0 && rect.height > 0 ? rect : null
}

function fixFatCursorHeight(view: EditorView): void {
  const cursors = view.scrollDOM.querySelectorAll<HTMLElement>('.cm-fat-cursor')
  for (const el of cursors) {
    el.style.removeProperty('width')
    el.style.removeProperty('min-width')
    el.style.removeProperty('height')
    el.style.removeProperty('max-height')
    el.style.removeProperty('line-height')
    el.style.removeProperty('transform')

    const pluginHeight = Number.parseFloat(el.style.height)
    const naturalCursorRect = measureNaturalCursorRect(el)
    const targetHeight =
      naturalCursorRect?.height && naturalCursorRect.height > 0
        ? naturalCursorRect.height
        : Number.isFinite(pluginHeight) && pluginHeight > 0
          ? pluginHeight
          : null
    if (!(targetHeight && targetHeight > 0)) continue

    const targetWidth =
      naturalCursorRect?.width && naturalCursorRect.width > 0
        ? naturalCursorRect.width
        : null
    const anchorHeight = Number.isFinite(pluginHeight) && pluginHeight > 0 ? pluginHeight : targetHeight
    const offset = (anchorHeight - targetHeight) / 2
    if (targetWidth) {
      el.style.width = `${targetWidth}px`
      el.style.minWidth = `${targetWidth}px`
    }
    el.style.height = `${targetHeight}px`
    el.style.maxHeight = `${targetHeight}px`
    el.style.lineHeight = `${targetHeight}px`
    el.style.transform = `translateY(${offset}px)`
  }
}

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
    // Eat mousedown so CodeMirror's own handler doesn't interpret the
    // click as a caret position and steal focus before we dispatch
    // the fold effect. The actual toggle fires on the click event so
    // it only runs once per mouse action.
    const swallow = (event: Event): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    el.addEventListener('mousedown', swallow)
    el.addEventListener('pointerdown', swallow)
    el.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      toggleHeadingFold(view, this.line)
    })
    return el
  }

  ignoreEvent(): boolean {
    // Return true so CodeMirror treats the widget as atomic and skips
    // its own click → caret-position logic; our own DOM listeners
    // still fire because they're attached directly to the span.
    return true
  }
}

/** Toggle the fold at the given heading line. We compute the target
 *  range ourselves (same logic the foldService uses) instead of going
 *  through `foldable()` so the click is resilient to fold-service
 *  registration timing and language-extension interactions. */
function toggleHeadingFold(view: EditorView, lineNumber: number): void {
  const { state } = view
  const level = headingLevelAt(state, lineNumber)
  if (level === null) return
  const range = rangeForHeading(state, lineNumber, level)
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
      const classes = ['cm-heading-line', `cm-heading-line-h${level}`]
      if (isFolded) classes.push('cm-heading-line-folded')
      builder.push({
        from: line.from,
        to: line.from,
        deco: Decoration.line({ class: classes.join(' ') })
      })

      // Widget sits at the very start of the line. side: -1 places
      // it before text content in the DOM so the vim fat-cursor at
      // position 0 measures the first # glyph, not the widget.
      builder.push({
        from: line.from,
        to: line.from,
        deco: Decoration.widget({
          side: -1,
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
    private readonly view: EditorView
    decorations: DecorationSet

    private cursorFixFrame = 0

    constructor(view: EditorView) {
      this.view = view
      this.decorations = buildDecorations(view)
      this.cursorFixFrame = requestAnimationFrame(() => fixFatCursorHeight(this.view))
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
      if (update.selectionSet || update.geometryChanged || update.docChanged || update.viewportChanged) {
        cancelAnimationFrame(this.cursorFixFrame)
        this.cursorFixFrame = requestAnimationFrame(() => fixFatCursorHeight(this.view))
      }
    }

    destroy(): void {
      cancelAnimationFrame(this.cursorFixFrame)
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

  // `codeFolding()` is what actually applies fold state — it listens
  // for foldEffect / unfoldEffect and installs the replace-decorations
  // that hide folded ranges. Without it, our dispatches go through
  // with no visible effect.
  return [codeFolding(), service, headingArrowPlugin]
}
