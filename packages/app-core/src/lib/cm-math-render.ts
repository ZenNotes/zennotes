/**
 * WYSIWYG KaTeX rendering for the editor's live preview:
 *  - inline `$…$` renders as an inline formula
 *  - block `$$…$$` (whose fences own their lines) renders as a centered display
 *    formula
 *
 * The raw source is revealed on whichever formula the cursor sits in, matching
 * how the rest of live preview reveals the active token. Math inside a code
 * span or fenced code is left literal, mirroring the Preview pipeline (whose
 * remark-math transform never visits code nodes).
 *
 * Block replace decorations must be supplied from a StateField (CodeMirror needs
 * the block structure before the viewport is computed), so inline and block math
 * share one field — which also lets the inline scan skip inside block regions.
 *
 * WYSIWYG-only: registered via `wysiwygExtensions()`.
 */
import { syntaxTree } from '@codemirror/language'
import { Facet, RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import katex from 'katex'
import type { MathRenderer } from '@shared/app-config'
import { peekTypstMathSvg, renderTypstMathToSvg } from './typst-math-render'
import { numberLatexEquationEnvironments } from './latex-equation-numbering'

/** Which typesetter the live-preview widgets use. Supplied by
 *  `mathRenderExtension(renderer)` and re-read whenever the editor reconfigures
 *  it (see the facet check in `mathRenderField.update`). */
const mathRendererFacet = Facet.define<MathRenderer, MathRenderer>({
  combine: (values) => (values.length ? values[values.length - 1] : 'katex')
})

/** The typesetter this editor is configured for. Anything offering LaTeX help
 *  has to ask: a note written for Typst takes different syntax entirely. */
export function mathRendererOf(state: EditorState): MathRenderer {
  return state.facet(mathRendererFacet)
}

/** Tag-driven Typst definitions for the note in this editor, prepended to every
 *  formula it compiles. Rides a facet like the renderer, so changing a note's
 *  tags reconfigures the pane and re-renders its math. Empty for KaTeX and for
 *  notes whose tags match no preamble. (#486) */
const typstPreambleFacet = Facet.define<string, string>({
  combine: (values) => (values.length ? values[values.length - 1] : '')
})

// Inline `$…$`: a single dollar (not `$$`), opening not escaped or space-led,
// closing not space-trailed. Mirrors remark-math so currency like `$5` is left
// alone (see the inline-math handling in markdown.ts).
const INLINE_MATH_RE = /(?<![\\$])\$(?!\s)(?!\$)((?:\\.|[^$\\])+?)(?<!\s)\$(?!\$)/g
// Block `$$…$$`, shortest match, may span lines.
const BLOCK_MATH_RE = /\$\$(?!\$)([\s\S]+?)\$\$/g

function renderKatex(el: HTMLElement, latex: string, display: boolean): void {
  try {
    katex.render(latex.trim(), el, { displayMode: display, throwOnError: false, output: 'html' })
  } catch {
    el.textContent = display ? `$$${latex}$$` : `$${latex}$`
    el.classList.add('cm-math-error')
  }
}

function showTypstError(el: HTMLElement, latex: string, display: boolean, message: string): void {
  el.textContent = display ? `$$${latex}$$` : `$${latex}$`
  el.classList.add('cm-math-error')
  el.title = `Typst error: ${message}`
}

/**
 * Render Typst math into `el`. A cached formula paints synchronously; otherwise
 * the element stays empty for one frame and fills when the WASM compiler
 * resolves (instant after the first render warms it up). The `latex`/`display`
 * captured in the closure are re-checked so a stale async result can't overwrite
 * a widget that has since been recycled to different content.
 */
function renderTypst(
  el: HTMLElement,
  latex: string,
  display: boolean,
  preamble: string
): void {
  const cached = peekTypstMathSvg(latex, display, preamble)
  if (cached) {
    if (cached.ok) el.innerHTML = cached.svg
    else showTypstError(el, latex, display, cached.error)
    return
  }
  void renderTypstMathToSvg(latex, display, preamble).then((result) => {
    if (result.ok) {
      el.innerHTML = result.svg
      el.classList.remove('cm-math-error')
      el.removeAttribute('title')
    } else {
      showTypstError(el, latex, display, result.error)
    }
  })
}

function renderMath(
  el: HTMLElement,
  latex: string,
  display: boolean,
  renderer: MathRenderer,
  preamble: string
): void {
  if (renderer === 'typst') renderTypst(el, latex, display, preamble)
  else renderKatex(el, latex, display)
}

class InlineMathWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly renderer: MathRenderer,
    /** Included in `eq` so retagging a note repaints its formulas. (#486) */
    readonly preamble = ''
  ) {
    super()
  }
  eq(other: InlineMathWidget): boolean {
    return (
      other.latex === this.latex &&
      other.renderer === this.renderer &&
      other.preamble === this.preamble
    )
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-math-inline'
    renderMath(el, this.latex, false, this.renderer, this.preamble)
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

class BlockMathWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly renderer: MathRenderer,
    readonly preamble = ''
  ) {
    super()
  }
  eq(other: BlockMathWidget): boolean {
    return (
      other.latex === this.latex &&
      other.renderer === this.renderer &&
      other.preamble === this.preamble
    )
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-math-block'
    renderMath(el, this.latex, true, this.renderer, this.preamble)
    return el
  }
  // Let CodeMirror handle clicks (like the inline widget) so clicking a rendered
  // block places the cursor in it and reveals the raw source for editing —
  // otherwise the only way in is keyboard navigation.
  ignoreEvent(): boolean {
    return false
  }
}

/** Cursor/selection overlaps (or just touches an edge of) `[from, to]`. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (Math.max(range.from, from) <= Math.min(range.to, to)) return true
  }
  return false
}

function isInsideCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1)
  for (;;) {
    const n = node.name
    if (n === 'FencedCode' || n === 'CodeBlock' || n === 'InlineCode') return true
    if (!node.parent) return false
    node = node.parent
  }
}

/** 1-based doc line range of one block `$$…$$` (fence lines included). */
export interface MathBlockLineRange {
  fromLine: number
  toLine: number
}

interface MathRenderValue {
  decorations: DecorationSet
  /** Every block-math range, whether currently rendered or revealed. */
  blockLines: readonly MathBlockLineRange[]
}

function buildMathRender(state: EditorState): MathRenderValue {
  const pending: Array<{ from: number; to: number; deco: Decoration }> = []
  const consumed: Array<[number, number]> = []
  const blockLines: MathBlockLineRange[] = []
  const doc = state.doc
  const text = doc.toString()
  const renderer = state.facet(mathRendererFacet)
  const preamble = renderer === 'typst' ? state.facet(typstPreambleFacet) : ''
  let equationNumber = 0

  // --- Block math `$$…$$` ------------------------------------------------
  BLOCK_MATH_RE.lastIndex = 0
  let bm: RegExpExecArray | null
  while ((bm = BLOCK_MATH_RE.exec(text)) !== null) {
    const inner = bm[1]
    if (!inner.trim()) continue
    const rawFrom = bm.index
    const rawTo = bm.index + bm[0].length
    if (isInsideCode(state, rawFrom)) continue
    const openLine = doc.lineAt(rawFrom)
    const closeLine = doc.lineAt(rawTo)
    // Only render when the fences own their lines (nothing but whitespace before
    // the opening `$$` and after the closing `$$`), so the whole-line block
    // replace can never swallow surrounding prose.
    const before = openLine.text.slice(0, rawFrom - openLine.from)
    const after = closeLine.text.slice(rawTo - closeLine.from)
    if (before.trim() !== '' || after.trim() !== '') continue
    const numbered =
      renderer === 'katex'
        ? numberLatexEquationEnvironments(inner, equationNumber)
        : { latex: inner, nextNumber: equationNumber }
    equationNumber = numbered.nextNumber
    // Reserve the whole-line span so inline scanning skips inside it, whether the
    // block ends up rendered or revealed.
    consumed.push([openLine.from, closeLine.to])
    blockLines.push({ fromLine: openLine.number, toLine: closeLine.number })
    if (selectionTouches(state, openLine.from, closeLine.to)) continue
    pending.push({
      from: openLine.from,
      to: closeLine.to,
      deco: Decoration.replace({
        block: true,
        widget: new BlockMathWidget(numbered.latex, renderer, preamble)
      })
    })
  }

  const insideBlock = (from: number, to: number): boolean =>
    consumed.some(([a, b]) => from >= a && to <= b)

  // --- Inline math `$…$` -------------------------------------------------
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (!line.text.includes('$')) continue
    INLINE_MATH_RE.lastIndex = 0
    let im: RegExpExecArray | null
    while ((im = INLINE_MATH_RE.exec(line.text)) !== null) {
      const inner = im[1]
      if (!inner.trim()) continue
      const from = line.from + im.index
      const to = from + im[0].length
      if (insideBlock(from, to)) continue
      if (isInsideCode(state, from + 1)) continue
      if (selectionTouches(state, from, to)) continue
      pending.push({ from, to, deco: Decoration.replace({ widget: new InlineMathWidget(inner, renderer, preamble) }) })
    }
  }

  pending.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const p of pending) builder.add(p.from, p.to, p.deco)
  return { decorations: builder.finish(), blockLines }
}

const mathRenderField = StateField.define<MathRenderValue>({
  create: (state) => buildMathRender(state),
  update(value, tr) {
    // Rebuild on edits, on cursor moves (to reveal/hide the active formula), when
    // the parser advances (isInsideCode reads the syntax tree), and when the math
    // engine is switched (the facet is reconfigured via the live-preview
    // compartment; see EditorPane).
    if (
      tr.docChanged ||
      tr.selection ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
      tr.startState.facet(mathRendererFacet) !== tr.state.facet(mathRendererFacet) ||
      tr.startState.facet(typstPreambleFacet) !== tr.state.facet(typstPreambleFacet)
    ) {
      return buildMathRender(tr.state)
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

/**
 * 1-based line ranges of every block `$$…$$` in the document (rendered or
 * revealed), or `[]` when math rendering isn't active in this editor. Used by
 * vertical cursor motion to step *into* a rendered block instead of letting
 * pixel-based movement skip over its widget (see cm-vim-display-line.ts and
 * cm-math-nav.ts).
 */
export function mathBlockLineRanges(state: EditorState): readonly MathBlockLineRange[] {
  return state.field(mathRenderField, false)?.blockLines ?? []
}

/**
 * Live-preview math rendering for the given engine. The `renderer` rides in on a
 * facet so switching KaTeX ⇄ Typst reconfigures cleanly (via the live-preview
 * compartment) without swapping the StateField itself, so `mathBlockLineRanges`
 * keeps its stable field reference.
 */
export function mathRenderExtension(renderer: MathRenderer, typstPreamble = ''): Extension {
  return [mathRendererFacet.of(renderer), typstPreambleFacet.of(typstPreamble), mathRenderField]
}
