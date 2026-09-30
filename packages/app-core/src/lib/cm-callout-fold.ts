/**
 * Foldable callouts (#853), as in Obsidian: `> [!type]-` starts collapsed and
 * `> [!type]+` expanded; a callout with no marker is not foldable by click.
 *
 * The fold range is the callout's whole blockquote below its title line, so
 * the chevron, the fold keys and Fold All close the same span and any of them
 * reopens what another closed. Collapsed callouts fold once each time a note
 * opens in the editor. That rides a state field which a note swap resets (a
 * whole-document replace under `noteEditingSync`) and which outlives the
 * live-preview compartment's reconfigures: a theme switch must not close
 * again what the reader opened.
 */
import { ensureSyntaxTree, foldEffect, syntaxTree, unfoldEffect } from '@codemirror/language'
import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Transaction
} from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import { type FoldRange, foldedExactly } from './cm-list-fold'
import { noteEditingSync } from './note-lifecycle-lock'

/** A callout's title line: `> [!type]`, an optional fold marker, the title. */
export const CALLOUT_HEAD_RE = /^(\s*>\s?)\[!(\w+)\]([-+])?\s?(.*)$/

export type CalloutFoldMarker = '-' | '+'

export interface Callout {
  node: SyntaxNode
  /** `-` collapsed by default, `+` expanded, null for a plain callout. */
  marker: CalloutFoldMarker | null
  /** Everything below the title line; null when there is nothing below. */
  range: FoldRange | null
}

function calloutOf(state: EditorState, node: SyntaxNode): Callout | null {
  if (node.name !== 'Blockquote') return null
  const head = state.doc.lineAt(node.from)
  const match = head.text.match(CALLOUT_HEAD_RE)
  if (!match) return null
  return {
    node,
    marker: (match[3] as CalloutFoldMarker | undefined) ?? null,
    range: node.to > head.to ? { from: head.to, to: node.to } : null
  }
}

/** The callout whose title is on `lineNumber`, marker or not. */
export function calloutAtLine(state: EditorState, lineNumber: number): Callout | null {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return null
  const line = state.doc.line(lineNumber)
  let found: Callout | null = null
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (ref) => {
      if (found) return false
      if (ref.name !== 'Blockquote' || ref.from < line.from || ref.from > line.to) return undefined
      found = calloutOf(state, ref.node)
      return false
    }
  })
  return found
}

/** The innermost foldable callout (one with a marker) holding `pos` below its
 *  title line. */
export function enclosingFoldableCallout(state: EditorState, pos: number): Callout | null {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    const callout = calloutOf(state, node)
    if (callout?.marker && callout.range && pos > callout.range.from && pos <= callout.range.to) {
      return callout
    }
  }
  return null
}

/** Fold ranges of every callout with a marker, or only the collapsed ones.
 *  Pass a fully parsed tree (ensureSyntaxTree) to reach past the viewport. */
export function foldableCalloutRanges(
  state: EditorState,
  tree: Tree = syntaxTree(state),
  only?: CalloutFoldMarker
): FoldRange[] {
  const ranges: FoldRange[] = []
  tree.iterate({
    enter: (ref) => {
      if (ref.name !== 'Blockquote') return undefined
      const callout = calloutOf(state, ref.node)
      if (callout?.marker && callout.range && (!only || callout.marker === only)) {
        ranges.push(callout.range)
      }
      return undefined
    }
  })
  return ranges
}

/** Toggle the callout whose title line holds `pos`. */
export function toggleCalloutFold(view: EditorView, pos: number): boolean {
  const { state } = view
  const callout = calloutAtLine(state, state.doc.lineAt(pos).number)
  if (!callout?.range) return false
  const existing = foldedExactly(state, callout.range)
  view.dispatch({ effects: existing ? unfoldEffect.of(existing) : foldEffect.of(callout.range) })
  return true
}

/**
 * The chevron after a foldable callout's title: ▾ open, ▸ folded. Clicking it
 * toggles the callout; the press is eaten so the caret stays where it was and
 * the title line does not turn into source under the pointer.
 */
export class CalloutFoldChevron extends WidgetType {
  constructor(private readonly folded: boolean) {
    super()
  }

  eq(other: CalloutFoldChevron): boolean {
    return other.folded === this.folded
  }

  toDOM(view: EditorView): HTMLElement {
    const chevron = document.createElement('span')
    chevron.className = `cm-callout-fold ${this.folded ? 'is-folded' : 'is-open'}`
    chevron.setAttribute('role', 'button')
    chevron.setAttribute('aria-label', this.folded ? 'Expand callout' : 'Collapse callout')
    chevron.setAttribute('aria-expanded', String(!this.folded))
    chevron.textContent = this.folded ? '▸' : '▾'
    const swallow = (event: Event): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    chevron.addEventListener('mousedown', swallow)
    chevron.addEventListener('pointerdown', swallow)
    chevron.addEventListener('click', (event) => {
      swallow(event)
      toggleCalloutFold(view, view.posAtDOM(chevron))
    })
    return chevron
  }

  ignoreEvent(): boolean {
    return true
  }
}

const markCalloutDefaultsApplied = StateEffect.define<null>()

function replacesWholeDocument(tr: Transaction): boolean {
  let whole = false
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (fromA === 0 && toA === tr.startState.doc.length) whole = true
  })
  return whole
}

/** Whether this document's collapsed callouts have been folded yet. */
const calloutDefaultsApplied = StateField.define<boolean>({
  create: () => false,
  update(applied, tr) {
    if (tr.effects.some((effect) => effect.is(markCalloutDefaultsApplied))) return true
    // Another note swapped in: its collapsed callouts start folded too.
    if (applied && tr.docChanged && tr.annotation(noteEditingSync) && replacesWholeDocument(tr)) {
      return false
    }
    return applied
  }
})

const applyCalloutDefaults = ViewPlugin.fromClass(
  class {
    private scheduled = false
    private destroyed = false

    constructor(view: EditorView) {
      this.check(view)
    }

    update(update: ViewUpdate): void {
      this.check(update.view)
    }

    destroy(): void {
      this.destroyed = true
    }

    private check(view: EditorView): void {
      if (this.scheduled || view.state.field(calloutDefaultsApplied, false) !== false) return
      this.scheduled = true
      // Not from inside a view update: CodeMirror refuses a dispatch there.
      queueMicrotask(() => {
        this.scheduled = false
        const { state } = view
        if (this.destroyed || state.field(calloutDefaultsApplied, false) !== false) return
        const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state)
        const folds = foldableCalloutRanges(state, tree, '-')
          .filter((range) => !foldedExactly(state, range))
          .map((range) => foldEffect.of(range))
        view.dispatch({ effects: [...folds, markCalloutDefaultsApplied.of(null)] })
      })
    }
  }
)

/** Collapsed callouts start folded when a note opens. Live preview only, with
 *  the chevrons in `cm-wysiwyg-blocks.ts`; folding itself is `codeFolding()`. */
export function calloutFolding(): Extension {
  return [calloutDefaultsApplied, applyCalloutDefaults]
}
