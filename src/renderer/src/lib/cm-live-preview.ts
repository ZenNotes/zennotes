import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { useStore } from '../store'
import { classifyLocalAssetHref, resolveLocalAssetUrl } from './local-assets'
import { setImageBlockDragPayload } from './image-block-dnd'

/**
 * Live-preview extension: hides markdown syntax markers on lines where
 * the cursor (or any part of the selection) does not currently live.
 *
 * Obsidian-style WYSIWYG feel. When you move off a line the `#`, `**`,
 * `[`, `](url)`, backticks, etc. fade away and the heading/bold/link
 * renders cleanly. When you land on that line again, the markers come
 * back so you can edit them.
 */

/** Node names from @lezer/markdown that correspond to syntax markers. */
const SIMPLE_HIDE = new Set([
  'EmphasisMark',
  'CodeMark',
  'LinkMark',
  'StrikethroughMark',
  'CodeInfo'
])

/** URL nodes need special handling: only hide when they are a link
 *  target `(url)`, not when they are autolinked text or appear inside
 *  a link label `[url](...)`. */
const URL_NODE = 'URL'

/** Marks that typically have a trailing space we also want to hide. */
const PREFIX_HIDE_WITH_SPACE = new Set(['HeaderMark', 'QuoteMark'])

const hide = Decoration.replace({})
const imageSourceHide = Decoration.replace({})
const STANDALONE_IMAGE_RE = /^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^)]+))\)\s*$/

type ParsedImage = {
  alt: string
  href: string
  resolvedUrl: string
}

type PendingDecoration = {
  from: number
  to: number
  deco: Decoration
}

function createImageDragPreview(title: string): HTMLDivElement {
  const chip = document.createElement('div')
  chip.style.position = 'fixed'
  chip.style.top = '-9999px'
  chip.style.left = '-9999px'
  chip.style.pointerEvents = 'none'
  chip.style.zIndex = '9999'
  chip.style.display = 'flex'
  chip.style.flexDirection = 'column'
  chip.style.gap = '2px'
  chip.style.maxWidth = '260px'
  chip.style.padding = '8px 10px'
  chip.style.borderRadius = '10px'
  chip.style.border = '1px solid rgba(255,255,255,0.08)'
  chip.style.background = 'rgba(20,19,18,0.94)'
  chip.style.boxShadow = '0 12px 28px rgba(0,0,0,0.28)'
  chip.style.backdropFilter = 'blur(12px)'
  chip.style.setProperty('-webkit-backdrop-filter', 'blur(12px)')
  chip.style.color = 'rgba(255,255,255,0.96)'
  chip.style.fontFamily =
    "var(--z-mono-font, 'SF Mono', 'SFMono-Regular', ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace)"
  chip.style.lineHeight = '1.2'

  const titleEl = document.createElement('div')
  titleEl.style.fontSize = '11px'
  titleEl.style.fontWeight = '700'
  titleEl.style.whiteSpace = 'nowrap'
  titleEl.style.overflow = 'hidden'
  titleEl.style.textOverflow = 'ellipsis'
  titleEl.textContent = title

  const subtitleEl = document.createElement('div')
  subtitleEl.style.fontSize = '10px'
  subtitleEl.style.opacity = '0.72'
  subtitleEl.textContent = 'Move image block'

  chip.append(titleEl, subtitleEl)
  document.body.append(chip)
  return chip
}

function parseStandaloneLocalImage(lineText: string): ParsedImage | null {
  const match = lineText.match(STANDALONE_IMAGE_RE)
  if (!match) return null
  const href = (match[2] ?? match[3] ?? '').trim()
  if (classifyLocalAssetHref(href) !== 'image') return null
  const state = useStore.getState()
  const resolvedUrl = resolveLocalAssetUrl(state.vault?.root, state.activeNote?.path, href)
  if (!resolvedUrl) return null
  return {
    alt: (match[1] ?? '').trim(),
    href,
    resolvedUrl
  }
}

class LocalImageWidget extends WidgetType {
  constructor(
    private readonly notePath: string,
    private readonly lineFrom: number,
    private readonly lineTo: number,
    private readonly lineText: string,
    private readonly alt: string,
    private readonly href: string,
    private readonly resolvedUrl: string
  ) {
    super()
  }

  eq(other: LocalImageWidget): boolean {
    return (
      other.notePath === this.notePath &&
      other.lineFrom === this.lineFrom &&
      other.lineTo === this.lineTo &&
      other.lineText === this.lineText &&
      other.alt === this.alt &&
      other.href === this.href &&
      other.resolvedUrl === this.resolvedUrl
    )
  }

  toDOM(): HTMLElement {
    const figure = document.createElement('figure')
    figure.className = 'local-image-embed cm-local-image-embed'
    figure.draggable = true
    figure.title = 'Drag to move. Use </> to edit this block.'

    figure.addEventListener('dragstart', (event) => {
      const dataTransfer = event.dataTransfer
      if (!dataTransfer) return
      const previewLabel = this.alt || this.href.split('/').filter(Boolean).pop() || 'Image'
      const dragPreview = createImageDragPreview(previewLabel)
      setImageBlockDragPayload(dataTransfer, {
        kind: 'image-block',
        notePath: this.notePath,
        from: this.lineFrom,
        to: this.lineTo,
        text: this.lineText
      })
      dataTransfer.setDragImage(dragPreview, 18, 14)
      requestAnimationFrame(() => {
        dragPreview.remove()
      })
      figure.classList.add('is-dragging')
    })

    figure.addEventListener('dragend', () => {
      figure.classList.remove('is-dragging')
    })

    const frame = document.createElement('div')
    frame.className = 'local-image-embed-frame'

    const image = document.createElement('img')
    image.className = 'local-image-embed-image'
    image.src = this.resolvedUrl
    image.alt = this.alt
    image.loading = 'lazy'
    image.draggable = false

    const topControls = document.createElement('div')
    topControls.className = 'local-image-embed-controls local-image-embed-controls-top'
    const editButton = document.createElement('button')
    editButton.type = 'button'
    editButton.className = 'local-image-embed-action local-image-embed-action-edit'
    editButton.textContent = '</>'
    editButton.title = 'Edit this block'
    editButton.setAttribute('aria-label', 'Edit this block')
    editButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const view = useStore.getState().editorViewRef
      if (!view) return
      view.dispatch({ selection: { anchor: this.lineFrom }, scrollIntoView: true })
      view.focus()
    })
    topControls.append(editButton)

    const bottomControls = document.createElement('div')
    bottomControls.className = 'local-image-embed-controls local-image-embed-controls-bottom'
    const openButton = document.createElement('button')
    openButton.type = 'button'
    openButton.className = 'local-image-embed-action local-image-embed-action-open'
    openButton.textContent = '+'
    openButton.title = 'Open image'
    openButton.setAttribute('aria-label', 'Open image')
    openButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      window.open(this.resolvedUrl, '_blank')
    })
    bottomControls.append(openButton)

    frame.append(image, topControls, bottomControls)

    const caption = document.createElement('figcaption')
    caption.className = 'local-image-embed-caption'
    caption.textContent = this.alt || this.href.split('/').filter(Boolean).pop() || 'Image'

    figure.append(frame, caption)
    return figure
  }

  ignoreEvent(): boolean {
    return true
  }
}

function computeDecorations(view: EditorView): DecorationSet {
  const { state } = view

  // Every line that holds part of a selection range is "active" and
  // therefore keeps its syntax markers visible for editing.
  const activeLines = new Set<number>()
  for (const r of state.selection.ranges) {
    const fromLine = state.doc.lineAt(r.from).number
    const toLine = state.doc.lineAt(r.to).number
    for (let l = fromLine; l <= toLine; l++) activeLines.add(l)
  }

  const pending: PendingDecoration[] = []
  const replacedLines = new Set<number>()

  for (const { from, to } of view.visibleRanges) {
    const firstLine = state.doc.lineAt(from).number
    const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number
    for (let lineNo = firstLine; lineNo <= lastLine; lineNo++) {
      if (activeLines.has(lineNo) || replacedLines.has(lineNo)) continue
      const line = state.doc.line(lineNo)
      const parsed = parseStandaloneLocalImage(line.text)
      if (!parsed) continue
      const notePath = useStore.getState().activeNote?.path
      if (!notePath) continue
      replacedLines.add(lineNo)
      pending.push({
        from: line.from,
        to: line.from,
        deco: Decoration.widget({
          side: 1,
          widget: new LocalImageWidget(
            notePath,
            line.from,
            line.to,
            line.text,
            parsed.alt,
            parsed.href,
            parsed.resolvedUrl
          )
        })
      })
      pending.push({
        from: line.from,
        to: line.to,
        deco: imageSourceHide
      })
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        const isPrefix = PREFIX_HIDE_WITH_SPACE.has(name)
        const isSimple = SIMPLE_HIDE.has(name)
        const isUrl = name === URL_NODE

        // Only hide URL nodes that are link targets — preceded by `(`
        if (isUrl) {
          const prevChar = state.doc.sliceString(node.from - 1, node.from)
          if (prevChar !== '(') return // autolink or label URL → keep visible
        }

        if (!isPrefix && !isSimple && !isUrl) return

        // Don't hide fenced code block delimiters (```) or language tags —
        // only hide inline code backticks. Hiding fence markers collapses
        // the entire code block.
        if ((name === 'CodeMark' || name === 'CodeInfo') &&
            node.node.parent?.name === 'FencedCode') return

        const line = state.doc.lineAt(node.from).number
        if (activeLines.has(line) || replacedLines.has(line)) return

        let start = node.from
        let end = node.to
        if (end === start) return

        if (isPrefix) {
          // Swallow the whitespace that follows the marker so the
          // rendered line doesn't start with a visible leading space.
          const next = state.doc.sliceString(end, end + 1)
          if (next === ' ' || next === '\t') end += 1
        }

        pending.push({ from: start, to: end, deco: hide })
      }
    })
  }

  pending.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from
    if (a.to !== b.to) return a.to - b.to
    return 0
  })

  const builder = new RangeSetBuilder<Decoration>()
  for (const item of pending) {
    builder.add(item.from, item.to, item.deco)
  }
  return builder.finish()
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = computeDecorations(view)
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged
      ) {
        this.decorations = computeDecorations(update.view)
      }
    }
  },
  {
    decorations: (v) => v.decorations
  }
)
