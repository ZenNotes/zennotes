/**
 * List item folding (#848): a bullet, numbered or task item with indented
 * children folds like a heading, from a disclosure arrow beside its marker.
 *
 * The range is the one @codemirror/lang-markdown already gives a ListItem
 * node (the end of the item's first line to the end of the item), so the
 * arrow, the fold commands and Vim's `zc` all fold the same span and any of
 * them reopens what another closed. Only an item with a child block below
 * its first line counts: a nested list, another paragraph, a code block. A
 * hard-wrapped item with nothing under it gets no arrow.
 *
 * CSS in styles/index.css hides the arrow until its line is hovered or holds
 * the caret, and keeps it visible while the item is folded.
 */
import { foldEffect, foldedRanges, syntaxTree, unfoldEffect } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'

export interface FoldRange {
  from: number
  to: number
}

/** A ListItem's fold range when it has a child block below its first line. */
export function listItemFoldRange(state: EditorState, node: SyntaxNode): FoldRange | null {
  if (node.name !== 'ListItem') return null
  const firstLineEnd = state.doc.lineAt(node.from).to
  let hasChild = false
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > firstLineEnd && child.name !== 'ListMark') {
      hasChild = true
      break
    }
  }
  if (!hasChild || node.to <= firstLineEnd) return null
  return { from: firstLineEnd, to: node.to }
}

/** The outermost foldable list item whose marker sits on `lineNumber`. */
export function listItemAtLine(
  state: EditorState,
  lineNumber: number
): { node: SyntaxNode; range: FoldRange } | null {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return null
  const line = state.doc.line(lineNumber)
  let found: { node: SyntaxNode; range: FoldRange } | null = null
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (ref) => {
      if (found) return false
      if (ref.name !== 'ListItem' || ref.from < line.from || ref.from > line.to) return undefined
      const range = listItemFoldRange(state, ref.node)
      if (range) {
        found = { node: ref.node, range }
        return false
      }
      return undefined
    }
  })
  return found
}

/** The innermost foldable list item that contains `pos` below its first line. */
export function enclosingListItem(
  state: EditorState,
  pos: number
): { node: SyntaxNode; range: FoldRange } | null {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name !== 'ListItem') continue
    const range = listItemFoldRange(state, node)
    if (range && pos > range.from && pos <= range.to) return { node, range }
  }
  return null
}

/** Every foldable list item in the document, nested ones included. Pass a
 *  fully parsed tree (ensureSyntaxTree) to reach past the viewport. */
export function allListItemFoldRanges(
  state: EditorState,
  tree: Tree = syntaxTree(state)
): FoldRange[] {
  const ranges: FoldRange[] = []
  tree.iterate({
    enter: (ref) => {
      if (ref.name !== 'ListItem') return
      const range = listItemFoldRange(state, ref.node)
      if (range) ranges.push(range)
    }
  })
  return ranges
}

export function foldedExactly(state: EditorState, range: FoldRange): FoldRange | null {
  let existing: FoldRange | null = null
  foldedRanges(state).between(range.from, range.to, (from, to) => {
    if (from === range.from && to === range.to) {
      existing = { from, to }
      return false
    }
    return undefined
  })
  return existing
}

function toggleListItemFold(view: EditorView, markerPos: number): void {
  const { state } = view
  const item = listItemAtLine(state, state.doc.lineAt(markerPos).number)
  if (!item) return
  const existing = foldedExactly(state, item.range)
  view.dispatch({ effects: existing ? unfoldEffect.of(existing) : foldEffect.of(item.range) })
}

class ListFoldArrow extends WidgetType {
  constructor(
    private readonly markerPos: number,
    private readonly folded: boolean
  ) {
    super()
  }

  eq(other: ListFoldArrow): boolean {
    return other.markerPos === this.markerPos && other.folded === this.folded
  }

  toDOM(view: EditorView): HTMLElement {
    // A zero-width anchor at the marker, so the arrow sits just left of the
    // bullet, number or checkbox at any depth without shifting the text.
    const anchor = document.createElement('span')
    anchor.className = 'cm-list-fold-anchor'
    const arrow = document.createElement('span')
    arrow.className = `cm-list-fold-arrow ${this.folded ? 'is-folded' : 'is-open'}`
    arrow.setAttribute('role', 'button')
    arrow.setAttribute('aria-label', this.folded ? 'Expand list item' : 'Collapse list item')
    arrow.setAttribute('aria-expanded', String(!this.folded))
    arrow.textContent = this.folded ? '▸' : '▾'
    // Same contract as the heading arrow: eat the press so CodeMirror does
    // not place the caret, and toggle on click.
    const swallow = (event: Event): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    arrow.addEventListener('mousedown', swallow)
    arrow.addEventListener('pointerdown', swallow)
    arrow.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      toggleListItemFold(view, this.markerPos)
    })
    anchor.appendChild(arrow)
    return anchor
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildListArrows(view: EditorView): DecorationSet {
  const { state } = view
  const widgets: { pos: number; deco: Decoration }[] = []
  const seenLines = new Set<number>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (ref) => {
        if (ref.name !== 'ListItem' || ref.from < from || ref.from > to) return
        const range = listItemFoldRange(state, ref.node)
        if (!range) return
        // One arrow per line: the outermost item wins a line two share.
        const lineNumber = state.doc.lineAt(ref.from).number
        if (seenLines.has(lineNumber)) return
        seenLines.add(lineNumber)
        widgets.push({
          pos: ref.from,
          deco: Decoration.widget({
            side: -1,
            widget: new ListFoldArrow(ref.from, foldedExactly(state, range) !== null)
          })
        })
      }
    })
  }
  widgets.sort((a, b) => a.pos - b.pos)
  return Decoration.set(widgets.map((w) => w.deco.range(w.pos)))
}

/** The arrows. Fold state itself comes from `codeFolding()` in headingFolding. */
export function listItemFoldArrows(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildListArrows(view)
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state) ||
          update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect))
          )
        ) {
          this.decorations = buildListArrows(update.view)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}
