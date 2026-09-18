import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { tags } from '@lezer/highlight'

type MarkdownNode = ReturnType<typeof syntaxTree>['topNode']
const referenceLabels = new WeakMap<ReturnType<typeof syntaxTree>, Set<string>>()

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toUpperCase().toLowerCase()
}

function definedLabels(state: EditorState): Set<string> {
  const tree = syntaxTree(state)
  const cached = referenceLabels.get(tree)
  if (cached) return cached
  const labels = new Set<string>()
  tree.iterate({
    enter(node) {
      if (node.name !== 'LinkReference') return
      const label = node.node.getChild('LinkLabel')
      if (label) labels.add(normalizeLabel(state.doc.sliceString(label.from + 1, label.to - 1)))
      return false
    }
  })
  referenceLabels.set(tree, labels)
  return labels
}

/** Spaced local destinations are accepted by navigation even when the Markdown
 * parser stops the Link at its closing bracket. Keep their rendering aligned. */
export function terminatedLinkTailEnd(state: EditorState, linkTo: number): number | null {
  if (state.doc.sliceString(linkTo, linkTo + 1) !== '(') return null
  const rest = state.doc.sliceString(linkTo, state.doc.lineAt(linkTo).to)
  let depth = 0
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i > 1 ? linkTo + i + 1 : null
    }
  }
  return null
}

/** Lezer emits Link/Image for shortcut references before resolving definitions.
 * Ordinary brackets such as [EE] must keep their text and prose styling. */
export function isResolvedMarkdownLink(state: EditorState, node: MarkdownNode): boolean {
  const marks = node.getChildren('LinkMark')
  if (marks.some((mark) => state.doc.sliceString(mark.from, mark.to) === '(')) return true
  if (terminatedLinkTailEnd(state, node.to) !== null) return true

  const explicit = node.getChild('LinkLabel')
  const reference = explicit ? state.doc.sliceString(explicit.from + 1, explicit.to - 1) : ''
  const label =
    reference || (marks.length >= 2 ? state.doc.sliceString(marks[0].to, marks[1].from) : '')
  return definedLabels(state).has(normalizeLabel(label))
}

const linkMark = Decoration.mark({ class: 'tok-link' })
function linkDecorations(view: EditorView) {
  const ranges: ReturnType<typeof linkMark.range>[] = []
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        // Wikilinks have their own resolver in Live Preview. Preserve the
        // parser's label highlighting in source mode too.
        const wikiLabel =
          node.name === 'Link' &&
          view.state.doc.sliceString(node.from - 1, node.from) === '[' &&
          view.state.doc.sliceString(node.to, node.to + 1) === ']'
        if (
          (node.name === 'Link' || node.name === 'Image') &&
          (wikiLabel || isResolvedMarkdownLink(view.state, node.node))
        ) {
          ranges.push(linkMark.range(node.from, node.to))
        }
      }
    })
  }
  return Decoration.set(ranges, true)
}

export const markdownLinkExtension = [
  // Claim the parser's broad link tag so the fallback highlighter cannot style
  // unresolved references. Only resolved links receive the visible tok-link class.
  syntaxHighlighting(HighlightStyle.define([{ tag: tags.link, class: 'tok-link-syntax' }])),
  ViewPlugin.fromClass(
    class {
      decorations
      constructor(view: EditorView) {
        this.decorations = linkDecorations(view)
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = linkDecorations(update.view)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
]
