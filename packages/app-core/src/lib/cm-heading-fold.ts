/**
 * Obsidian-style heading and list folding for CodeMirror 6 markdown editors.
 *
 * A fold on a heading hides everything from the end of the heading
 * line up to (but not including) the next heading of equal-or-higher
 * level, or the end of the document when none follows. A list item
 * with indented children folds the same way (lib/cm-list-fold, #848), and
 * so does a callout below its title line (lib/cm-callout-fold, #853).
 *
 * The exported extension bundles four pieces:
 *   - `foldService`: the semantic range calculator so CodeMirror's
 *     fold commands (our vim `zc` / `zo` mappings, the `:fold`
 *     ex command) know what to collapse.
 *   - A `ViewPlugin` that adds an inline ▾ arrow to each heading's
 *     line start and a line-decoration class marking the cursor line.
 *   - The list item arrows, one beside each foldable item's marker.
 *   - No fold gutter: the full-document gutter would show chevrons
 *     next to every foldable range (paragraphs, code blocks,
 *     frontmatter), which clutters the minimalist editor surface.
 *
 * CSS rules in styles/index.css hide the arrow by default and only
 * reveal it when the heading line is hovered or holds the caret,
 * matching Obsidian's behaviour.
 */
import {
  codeFolding,
  ensureSyntaxTree,
  foldable,
  foldService,
  foldEffect,
  unfoldCode,
  unfoldEffect,
  foldedRanges,
  syntaxTree
} from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import type { EditorState, Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view'
import {
  allListItemFoldRanges,
  enclosingListItem,
  foldedExactly,
  listItemAtLine,
  listItemFoldArrows,
  type FoldRange
} from './cm-list-fold'
import { calloutAtLine, enclosingFoldableCallout, foldableCalloutRanges } from './cm-callout-fold'

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
  el.style.height = 'auto'
  el.style.maxHeight = 'none'
  el.style.lineHeight = 'normal'
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
    const pluginHeight = Number.parseFloat(el.style.height)
    const naturalCursorRect = measureNaturalCursorRect(el)
    const naturalHeight = naturalCursorRect?.height ?? null
    const targetHeight =
      naturalHeight && naturalHeight > 0
        ? Number.isFinite(pluginHeight) && pluginHeight > 0
          ? Math.min(pluginHeight, naturalHeight)
          : naturalHeight
        : Number.isFinite(pluginHeight) && pluginHeight > 0
          ? pluginHeight
          : null
    if (!(targetHeight && targetHeight > 0)) continue

    const targetWidth =
      naturalCursorRect?.width && naturalCursorRect.width > 0
        ? naturalCursorRect.width
        : null
    if (targetWidth) {
      el.style.width = `${targetWidth}px`
      el.style.minWidth = `${targetWidth}px`
    }
    el.style.height = `${targetHeight}px`
    el.style.maxHeight = `${targetHeight}px`
    el.style.lineHeight = 'normal'
    el.style.removeProperty('transform')
  }
}

/**
 * A `#` the markdown parser places inside a fenced or indented code block is
 * not a heading (e.g. a bash `# comment` or shell prompt) — the line-text
 * regex alone can't tell them apart, so heading folding/styling must consult
 * the syntax tree and skip those lines (#83).
 */
function isInsideCodeBlock(state: EditorState, pos: number): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true
  }
  return false
}

function headingLevelAt(state: EditorState, lineNumber: number): number | null {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return null
  const line = state.doc.line(lineNumber)
  const match = line.text.match(HEADING_RE)
  if (!match) return null
  if (isInsideCodeBlock(state, line.from)) return null
  return match[1].length
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

function exactFoldAtRange(
  state: EditorState,
  range: { from: number; to: number }
): { from: number; to: number } | null {
  return foldedExactly(state, range)
}

/**
 * Fold what the cursor is on: the heading or list item its line starts,
 * else anything CodeMirror folds from that line (a code block, a table),
 * else the list item the line sits in, the way Vim's zc closes the fold
 * around the cursor; the caret then moves to that item's marker (#848).
 * Mod+Alt+F, zc, :fold and the palette all run this.
 */
export function foldAtCursor(view: EditorView): boolean {
  const { state } = view
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const level = headingLevelAt(state, line.number)
  let range: FoldRange | null =
    level !== null
      ? rangeForHeading(state, line.number, level)
      : (listItemAtLine(state, line.number)?.range ??
        calloutAtLine(state, line.number)?.range ??
        null)
  let caret: number | null = null
  if (!range) range = foldable(state, line.from, line.to)
  if (!range) {
    // On a line inside a list item or a foldable callout, fold the innermost
    // of the two and bring the caret up to its first line.
    const item = enclosingListItem(state, head)
    const found = enclosingFoldableCallout(state, head)
    const callout = found?.range ? { node: found.node, range: found.range } : null
    const parent = item && callout ? (item.range.from >= callout.range.from ? item : callout) : (item ?? callout)
    if (parent) {
      range = parent.range
      caret = parent.node.from
    }
  }
  if (!range || exactFoldAtRange(state, range)) return false
  view.dispatch({
    effects: foldEffect.of(range),
    ...(caret !== null ? { selection: { anchor: caret } } : {})
  })
  return true
}

/** Unfold the fold that starts on the cursor's line, a heading's or a list
 *  item's alike. */
export function unfoldAtCursor(view: EditorView): boolean {
  return unfoldCode(view)
}

/**
 * Fold every heading section, list item, callout and syntax fold, nested,
 * the way Vim's zM closes every fold: opening a heading then shows its lists
 * still folded, one line per item. CodeMirror's foldAll folds only the
 * outermost ranges, so a heading swallowed the tasks under it (#848), but
 * its syntax folds (code blocks, tables, quotes) must still participate.
 */
export function foldAllOutline(view: EditorView): boolean {
  const { state } = view
  const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state)
  const ranges = new Map<string, FoldRange>()
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    const level = headingLevelAt(state, n)
    const range =
      level === null
        ? foldable(state, line.from, line.to)
        : rangeForHeading(state, n, level)
    if (range) ranges.set(`${range.from}:${range.to}`, range)
  }
  for (const range of [...allListItemFoldRanges(state, tree), ...foldableCalloutRanges(state, tree)]) {
    ranges.set(`${range.from}:${range.to}`, range)
  }
  const fresh = [...ranges.values()].filter((range) => !exactFoldAtRange(state, range))
  if (fresh.length === 0) return false
  // Keep the caret in sight: on the line that opens the outermost fold
  // around it, as zM leaves it in Vim.
  const head = state.selection.main.head
  let outer: FoldRange | null = null
  for (const range of ranges.values()) {
    if (head > range.from && head <= range.to && (!outer || range.from < outer.from)) outer = range
  }
  view.dispatch({
    effects: fresh.map((range) => foldEffect.of(range)),
    ...(outer ? { selection: { anchor: state.doc.lineAt(outer.from).from } } : {})
  })
  return true
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

class HeadingLevelLabel extends WidgetType {
  constructor(private readonly level: number) {
    super()
  }

  eq(other: HeadingLevelLabel): boolean {
    return other.level === this.level
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-heading-level-label'
    el.setAttribute('aria-hidden', 'true')
    el.textContent = `H${this.level}`
    return el
  }

  ignoreEvent(): boolean {
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
  const existing = exactFoldAtRange(state, range)
  view.dispatch({
    effects: existing ? unfoldEffect.of(existing) : foldEffect.of(range)
  })
}

function buildDecorations(view: EditorView, showLevelLabels: boolean): DecorationSet {
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

      if (showLevelLabels) {
        builder.push({
          from: line.from,
          to: line.from,
          deco: Decoration.widget({
            side: -2,
            widget: new HeadingLevelLabel(level)
          })
        })
      }

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

function headingArrowPlugin(showLevelLabels: boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly view: EditorView
      decorations: DecorationSet

      private cursorFixFrame = 0

      constructor(view: EditorView) {
        this.view = view
        this.decorations = buildDecorations(view, showLevelLabels)
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
          this.decorations = buildDecorations(update.view, showLevelLabels)
        }
        if (
          update.selectionSet ||
          update.geometryChanged ||
          update.docChanged ||
          update.viewportChanged
        ) {
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
}

export interface HeadingFoldingOptions {
  showLevelLabels?: boolean
}

export function headingFolding(options: HeadingFoldingOptions = {}): Extension {
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
  const showLevelLabels = options.showLevelLabels ?? false
  return [
    codeFolding(),
    service,
    headingArrowPlugin(showLevelLabels),
    listItemFoldArrows(),
    // The level chips sit LEFT of the arrow slot, wider than .cm-content's
    // default 32px padding. The centered column's auto margin cannot host
    // them: it is zero whenever the pane is narrower than the column cap,
    // and anything positioned beyond the content box lands under the
    // sidebar. This class makes the content box reserve the chip gutter.
    ...(showLevelLabels
      ? [EditorView.editorAttributes.of({ class: 'zen-heading-level-labels' })]
      : [])
  ]
}
