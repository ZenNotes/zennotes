/**
 * WYSIWYG diagram rendering for the editor's live preview (#530): ```mermaid
 * fences, drawn by Pele, and ```d2 fences, drawn by D2. One widget serves both
 * so the reveal-on-cursor, last-good-drawing and keyboard-entry rules cannot
 * drift apart between languages.
 *
 * A ```mermaid fence draws as the diagram while the cursor is elsewhere, and
 * turns back into its source the moment the cursor lands anywhere in the block,
 * which is the same bargain live preview strikes for math, tables and
 * wikilinks: what you can see is the result, what you can edit is the text.
 *
 * Two things make this cheap enough to run on a hot editor:
 *
 *   1. The renderer (Pele) is imported lazily and only when a fence exists, so
 *      a note without diagrams never pulls diagram code into the renderer.
 *   2. Rendered SVG is cached by (fonts, source) in `mermaid-render`, so a
 *      keystroke elsewhere in the note repaints from the cache, and moving the
 *      cursor in and out of a block costs nothing. Once the renderer has
 *      loaded, a diagram it has not seen draws synchronously in `toDOM`.
 *
 * A diagram mid-edit is usually invalid, so a failed render keeps the LAST good
 * drawing of that block on screen rather than flashing an error at every
 * keystroke. The error only takes over once the block is left alone and still
 * does not parse, which is the difference between a diagram you are typing and
 * one that is wrong.
 *
 * WYSIWYG-only: registered via `wysiwygExtensions()`.
 */
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { Facet, RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { revealedSelectionRanges, sourceRevealChanged } from './cm-source-reveal'

import { peekD2Svg, renderD2Svg, withUniqueD2Ids } from './d2-render'
import { peekMermaidSvg, renderMermaidSvg } from './mermaid-render'

interface DiagramThemeFacetValue {
  mode: 'light' | 'dark'
  key: string
}

/** The theme the widgets were drawn under. Colour no longer needs a redraw (the
 *  SVG paints through CSS variables), but the identity also carries the text
 *  font, and a font change must re-measure every label. A palette-only change
 *  rebuilds the widgets from the cache, which costs an innerHTML each. */
const diagramThemeFacet = Facet.define<DiagramThemeFacetValue, DiagramThemeFacetValue>({
  combine: (values) => values[values.length - 1] ?? { mode: 'light', key: 'light' }
})

type FenceRenderResult = { ok: true; svg: string; ownTheme?: boolean } | { ok: false; error: string }

interface FenceDiagram {
  label: string
  errorLabel: string
  className: string
  peek(source: string): FenceRenderResult | null
  render(source: string): Promise<FenceRenderResult>
  /** Adjust the cached SVG for one insertion (D2: ids of its own). */
  prepare?(svg: string): string
}

const FENCE_DIAGRAMS = {
  mermaid: {
    label: 'Mermaid diagram',
    errorLabel: 'Mermaid error',
    className: 'cm-mermaid-block',
    peek: (source: string) => peekMermaidSvg(source),
    render: (source: string) => renderMermaidSvg(source)
  },
  // D2 always renders in its worker, so a new diagram passes through the
  // pending state once; the cache makes every later paint synchronous.
  d2: {
    label: 'D2 diagram',
    errorLabel: 'D2 error',
    className: 'cm-mermaid-block cm-d2-block',
    peek: peekD2Svg,
    render: renderD2Svg,
    prepare: withUniqueD2Ids
  }
} satisfies Record<string, FenceDiagram>

type FenceLanguage = keyof typeof FENCE_DIAGRAMS

/** The diagram language a fence's info string names: the language token only,
 *  so ```mermaid and ```mermaid title="x" both count. */
function fenceLanguage(info: string): FenceLanguage | null {
  const token = info.trim().split(/\s+/)[0]?.toLowerCase()
  return token === 'mermaid' || token === 'd2' ? token : null
}

/** Paint a finished drawing into a widget. A D2 diagram that chose no theme of
 *  its own takes the app palette from `index.css`. */
function paint(
  el: HTMLElement,
  result: { svg: string; ownTheme?: boolean },
  diagram: FenceDiagram
): void {
  el.innerHTML = diagram.prepare ? diagram.prepare(result.svg) : result.svg
  el.classList.toggle('zen-d2-themed', result.ownTheme === false)
}

/** Cursor/selection overlaps (or just touches an edge of) `[from, to]`. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of revealedSelectionRanges(state)) {
    if (Math.max(range.from, from) <= Math.min(range.to, to)) return true
  }
  return false
}

/** Mutable memory follows one fence through document transactions. It cannot
 * be keyed by source: the whole point is to survive that source being edited
 * into a temporarily invalid value. */
interface MermaidBlockMemory {
  lastGood?: { themeKey: string; svg: string; ownTheme?: boolean }
}

class MermaidBlockWidget extends WidgetType {
  constructor(
    readonly language: FenceLanguage,
    readonly source: string,
    readonly theme: DiagramThemeFacetValue,
    readonly memory: MermaidBlockMemory
  ) {
    super()
  }

  eq(other: MermaidBlockWidget): boolean {
    return (
      other.language === this.language &&
      other.source === this.source &&
      other.theme.key === this.theme.key &&
      other.memory === this.memory
    )
  }

  toDOM(): HTMLElement {
    const diagram: FenceDiagram = FENCE_DIAGRAMS[this.language]
    const el = document.createElement('div')
    el.className = diagram.className
    el.setAttribute('role', 'img')
    el.setAttribute('aria-label', diagram.label)

    const cached = diagram.peek(this.source)
    if (cached?.ok) {
      paint(el, cached, diagram)
      this.memory.lastGood = { themeKey: this.theme.key, svg: cached.svg, ownTheme: cached.ownTheme }
      return el
    }

    // Nothing drawn yet: show the previous good diagram if this block has one,
    // otherwise leave the space empty rather than collapsing the line and
    // making the note jump as diagrams arrive.
    const previous =
      this.memory.lastGood?.themeKey === this.theme.key ? this.memory.lastGood : undefined
    if (previous) paint(el, previous, diagram)
    else el.classList.add('cm-mermaid-pending')

    void diagram.render(this.source).then((result) => {
      // The widget may have been replaced while the renderer loaded (a
      // keystroke, a cursor move). Writing into a detached node is harmless and
      // the live widget renders from the cache, so no check is needed beyond
      // this one for a node that is still ours.
      if (result.ok) {
        paint(el, result, diagram)
        el.classList.remove('cm-mermaid-pending', 'cm-mermaid-error')
        el.removeAttribute('title')
        this.memory.lastGood = { themeKey: this.theme.key, svg: result.svg, ownTheme: result.ownTheme }
        return
      }
      if (this.memory.lastGood?.themeKey === this.theme.key) return
      el.classList.remove('cm-mermaid-pending')
      el.classList.add('cm-mermaid-error')
      el.textContent = `${diagram.errorLabel}: ${result.error}`
    })
    return el
  }

  // Let CodeMirror handle clicks, so clicking a diagram puts the cursor in the
  // block and reveals its source. Without this the only way in is the keyboard.
  ignoreEvent(): boolean {
    return false
  }
}

/** 1-based line span of one rendered block, for the navigation helpers. */
export interface MermaidBlockLineRange {
  fromLine: number
  toLine: number
}

interface MermaidRenderValue {
  decorations: DecorationSet
  /** Every mermaid fence, rendered or revealed, so vertical motion can step
   *  INTO one instead of sailing over a widget with no cursor positions in it. */
  blockLines: readonly MermaidBlockLineRange[]
  /** Block position + stable memory, mapped through edits on the next rebuild. */
  blocks: readonly { from: number; memory: MermaidBlockMemory }[]
}

function buildMermaidDecorations(
  state: EditorState,
  previousBlocks: MermaidRenderValue['blocks'] = [],
  mapPreviousPosition: (position: number) => number = (position) => position
): MermaidRenderValue {
  const theme = state.facet(diagramThemeFacet)
  const builder = new RangeSetBuilder<Decoration>()
  const blockLines: MermaidBlockLineRange[] = []
  const blocks: { from: number; memory: MermaidBlockMemory }[] = []
  const previousMemory = new Map(
    previousBlocks.map((block) => [mapPreviousPosition(block.from), block.memory])
  )
  const tree = syntaxTree(state)

  tree.iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return
      const from = node.from
      const to = node.to
      // The info string lives on the opening line, after the fence marker.
      const openLine = state.doc.lineAt(from)
      const info = openLine.text.replace(/^\s*(?:`{3,}|~{3,})/, '')
      const language = fenceLanguage(info)
      if (!language) return
      const memory = previousMemory.get(openLine.from) ?? {}
      blocks.push({ from: openLine.from, memory })

      const closeLine = state.doc.lineAt(to)
      // Recorded whether or not it is rendered right now: the navigation
      // helpers need to know a block is THERE to step into it, and once the
      // cursor is inside, that it may leave normally.
      blockLines.push({ fromLine: openLine.number, toLine: closeLine.number })

      // Editing it? Then it is text, not a picture.
      if (selectionTouches(state, from, to)) return
      // Body is everything between the fences. A fence with no body has nothing
      // to draw and is left as source so it can be typed into.
      if (closeLine.number - openLine.number < 2) return
      const body = state.doc
        .sliceString(openLine.to + 1, state.doc.line(closeLine.number - 1).to)
        .trim()
      if (body === '') return

      builder.add(
        openLine.from,
        closeLine.to,
        Decoration.replace({ block: true, widget: new MermaidBlockWidget(language, body, theme, memory) })
      )
    }
  })

  // A parse that ran out of time stops partway down the note and finishes on a
  // later, parse-only update. Fences past where it stopped are still in the
  // note, so they keep their memory until a tree reaches them again. (The
  // note's mixed parser pads a cut tree to the note's length, so where it
  // stopped is the end of its last block, not tree.length.)
  if (!syntaxTreeAvailable(state)) {
    const reach = tree.topNode.lastChild?.to ?? 0
    for (const [from, memory] of previousMemory) {
      if (from > reach) blocks.push({ from, memory })
    }
  }

  return { decorations: builder.finish(), blockLines, blocks }
}

const mermaidRenderField = StateField.define<MermaidRenderValue>({
  create: (state) => buildMermaidDecorations(state),
  update(value, tr) {
    // Rebuild on edits, on cursor moves (to reveal or hide the active block),
    // when the parser advances (the fence may only now be recognised), and when
    // the palette changes.
    if (
      tr.docChanged ||
      tr.selection ||
      sourceRevealChanged(tr) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
      tr.startState.facet(diagramThemeFacet).key !== tr.state.facet(diagramThemeFacet).key
    ) {
      return buildMermaidDecorations(tr.state, value.blocks, (position) =>
        tr.changes.mapPos(position, -1)
      )
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

/**
 * 1-based line ranges of every mermaid and d2 fence in the document, or `[]`
 * when diagram rendering is not active in this editor. Read by the arrow-key and
 * Vim `j`/`k` helpers, which otherwise sail straight over a rendered block: it
 * is one widget with no cursor coordinates inside it, so pixel-based vertical
 * motion has nowhere to land and a keyboard-only user could never open the
 * source. (#530)
 */
export function mermaidBlockLineRanges(state: EditorState): readonly MermaidBlockLineRange[] {
  return state.field(mermaidRenderField, false)?.blockLines ?? []
}

/** Live-preview mermaid and d2 rendering, drawn in the given palette. */
export function mermaidRenderExtension(
  mode: 'light' | 'dark',
  themeKey: string = mode
): Extension {
  return [diagramThemeFacet.of({ mode, key: themeKey }), mermaidRenderField]
}
