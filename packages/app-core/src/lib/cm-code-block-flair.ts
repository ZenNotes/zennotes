/**
 * Code-block "flair" for the WYSIWYG (Edit) editor: a small label pinned to
 * the top-right of each fenced code block showing its language (or "text"
 * when none is given). Clicking the label copies the block's contents — it
 * doubles as the copy button, so there's no separate copy/fold chrome.
 *
 * WYSIWYG-only: this lives in `wysiwygExtensions()` and never loads in the
 * Split (source) editor.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'

const FENCE_RE = /^\s*(?:`{3,}|~{3,})\s*([^\s`]*)/

class CodeFlairWidget extends WidgetType {
  constructor(
    private readonly language: string,
    /** Doc offsets of the block content to copy (fences excluded). */
    private readonly contentFrom: number,
    private readonly contentTo: number
  ) {
    super()
  }

  eq(other: CodeFlairWidget): boolean {
    return (
      other.language === this.language &&
      other.contentFrom === this.contentFrom &&
      other.contentTo === this.contentTo
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-code-flair'
    button.textContent = this.language
    button.title = 'Copy code'
    button.setAttribute('aria-label', `Copy ${this.language} code block`)
    button.setAttribute('contenteditable', 'false')

    // Don't let the editor move the caret / start a selection when the label
    // is pressed — copying shouldn't disturb where the user was typing.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const text =
        this.contentTo > this.contentFrom
          ? view.state.doc.sliceString(this.contentFrom, this.contentTo)
          : ''
      void navigator.clipboard?.writeText(text).then(
        () => {
          button.classList.add('is-copied')
          button.textContent = 'Copied'
          window.setTimeout(() => {
            button.classList.remove('is-copied')
            button.textContent = this.language
          }, 1100)
        },
        () => {
          /* clipboard denied — leave the label as-is */
        }
      )
    })
    return button
  }

  ignoreEvent(): boolean {
    return false
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const tree = syntaxTree(state)
  const seen = new Set<number>()
  const pending: Array<{ at: number; deco: Decoration }> = []

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'FencedCode') return
        const beginLine = state.doc.lineAt(node.from)
        if (seen.has(beginLine.from)) return false
        seen.add(beginLine.from)

        const langMatch = beginLine.text.match(FENCE_RE)
        const language = (langMatch?.[1] || 'text').toLowerCase()

        const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1))
        // Content sits between the opening and closing fence lines. When the
        // block has no body (begin === end), copy nothing.
        const contentFrom =
          beginLine.number < lastLine.number
            ? state.doc.line(beginLine.number + 1).from
            : beginLine.to
        const contentTo =
          lastLine.number > beginLine.number
            ? state.doc.line(lastLine.number - 1).to
            : beginLine.to

        pending.push({
          at: beginLine.to,
          deco: Decoration.widget({
            side: 1,
            widget: new CodeFlairWidget(language, contentFrom, contentTo)
          })
        })
        return false
      }
    })
  }

  pending.sort((a, b) => a.at - b.at)
  const builder = new RangeSetBuilder<Decoration>()
  for (const item of pending) builder.add(item.at, item.at, item.deco)
  return builder.finish()
}

export const codeBlockFlairPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)
