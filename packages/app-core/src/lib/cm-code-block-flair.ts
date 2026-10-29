/**
 * Code-block "flair" for the WYSIWYG (Edit) editor, pinned to the top-right
 * of each fenced code block (#1014):
 *
 * - a language button reading "typescript ▾" (or "text ▾" when the fence
 *   names none) that opens the code block language picker. An unlabeled block
 *   whose language was guessed reads "python · detected", muted, with a
 *   dashed border: the guess colours the block but is not in the file.
 * - a copy button beside it, which copies the block's contents.
 *
 * Pressing either leaves the caret where it was. WYSIWYG-only: this lives in
 * `wysiwygExtensions()` and never loads in the Split (source) editor.
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
import { codeLanguageGuessesChanged, detectedCodeLanguage } from './cm-code-language-detect'
import { codeFenceFromNode } from './code-language-menu'
import { requestCodeLanguagePicker } from './code-language-request'

const SVG_NS = 'http://www.w3.org/2000/svg'

function icon(paths: string[], size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

const CHEVRON = ['m6 9 6 6 6-6']
const COPY = ['M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1z', 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3']
const CHECK = ['M20 6 9 17l-5-5']

/** Keep a press on the flair from moving the caret or starting a selection:
 *  picking a language or copying should not disturb where the user was. */
function holdCaret(button: HTMLElement): void {
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
}

class CodeFlairWidget extends WidgetType {
  constructor(
    /** The language as the label shows it: the fence's, or the guess. */
    private readonly language: string,
    private readonly detected: boolean,
    /** Where the block's opening fence starts. */
    private readonly fenceFrom: number,
    /** Doc offsets of the block content to copy (fences excluded). */
    private readonly contentFrom: number,
    private readonly contentTo: number
  ) {
    super()
  }

  eq(other: CodeFlairWidget): boolean {
    return (
      other.language === this.language &&
      other.detected === this.detected &&
      other.fenceFrom === this.fenceFrom &&
      other.contentFrom === this.contentFrom &&
      other.contentTo === this.contentTo
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('span')
    bar.className = 'cm-code-flair-bar'
    bar.setAttribute('contenteditable', 'false')
    bar.dataset.codeFenceFrom = String(this.fenceFrom)

    const label = document.createElement('button')
    label.type = 'button'
    label.className = this.detected ? 'cm-code-flair is-detected' : 'cm-code-flair'
    label.setAttribute('aria-haspopup', 'menu')
    const name = document.createElement('span')
    name.textContent = this.detected ? `${this.language} · detected` : this.language
    label.append(name, icon(CHEVRON, 11))
    label.title = this.detected
      ? 'Detected language, not saved in the note. Choose a language'
      : 'Choose a language'
    label.setAttribute(
      'aria-label',
      this.detected
        ? `Code block language: ${this.language}, detected. Choose a language`
        : `Code block language: ${this.language}. Choose a language`
    )
    holdCaret(label)
    label.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      requestCodeLanguagePicker({
        view,
        fenceFrom: this.fenceFrom,
        anchor: label.getBoundingClientRect()
      })
    })

    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'cm-code-copy'
    copy.title = 'Copy code'
    copy.setAttribute('aria-label', 'Copy code')
    copy.append(icon(COPY, 13))
    holdCaret(copy)
    copy.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const text =
        this.contentTo > this.contentFrom
          ? view.state.doc.sliceString(this.contentFrom, this.contentTo)
          : ''
      void navigator.clipboard?.writeText(text).then(
        () => {
          copy.classList.add('is-copied')
          copy.replaceChildren(icon(CHECK, 13))
          copy.title = 'Copied'
          copy.setAttribute('aria-label', 'Copied')
          window.setTimeout(() => {
            copy.classList.remove('is-copied')
            copy.replaceChildren(icon(COPY, 13))
            copy.title = 'Copy code'
            copy.setAttribute('aria-label', 'Copy code')
          }, 1100)
        },
        () => {
          /* clipboard denied: leave the button as it is */
        }
      )
    })

    bar.append(label, copy)
    return bar
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
        const fence = codeFenceFromNode(state, node.node)
        if (!fence) return false
        const beginLine = state.doc.lineAt(fence.markEnd)
        if (seen.has(beginLine.from)) return false
        seen.add(beginLine.from)

        const written = fence.language?.toLowerCase() ?? null
        const guess = written === null ? detectedCodeLanguage(state, fence.from) : null
        const language = written ?? guess ?? 'text'

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
            widget: new CodeFlairWidget(language, guess !== null, fence.from, contentFrom, contentTo)
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
      if (
        update.docChanged ||
        update.viewportChanged ||
        codeLanguageGuessesChanged(update) ||
        // A parse cut short by its time budget finishes in a later update
        // that changes nothing else.
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)
