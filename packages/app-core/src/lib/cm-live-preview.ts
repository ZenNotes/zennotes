import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateEffect } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { useStore } from '../store'
import {
  classifyLocalAssetHref,
  resolveAssetVaultRelativePath,
  resolveLocalAssetUrl
} from './local-assets'
import { setImageBlockDragPayload } from './image-block-dnd'
import { assetTabPath } from './asset-tabs'

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
const STANDALONE_OBSIDIAN_EMBED_RE = /^\s*!\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]\s*$/
// Anchor-style standalone PDF link: `[Label](file.pdf)` or `[Label](<file with spaces.pdf>)`.
// Same shape as the image regex but without the leading `!`.
const STANDALONE_PDF_RE = /^\s*\[([^\]]*)\]\((?:<([^>]+)>|([^)]+))\)\s*$/

type ParsedImage = {
  alt: string
  href: string
  resolvedUrl: string
}

type ParsedPdf = {
  label: string
  href: string
  resolvedUrl: string
}

function decodeURIComponentSafe(value: string | undefined): string {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

type PendingDecoration = {
  from: number
  to: number
  deco: Decoration
}

type SyntaxNodeLike = {
  name: string
  from: number
  to: number
  parent: SyntaxNodeLike | null
}

type SyntaxNodeRefLike = {
  node: SyntaxNodeLike
}

function selectionTouchesRange(
  state: EditorView['state'],
  from: number,
  to: number
): boolean {
  for (const range of state.selection.ranges) {
    if (range.empty) {
      if (range.from >= from && range.from <= to) return true
      continue
    }
    if (Math.max(range.from, from) < Math.min(range.to, to)) return true
  }
  return false
}

function enclosingLinkRange(ref: SyntaxNodeRefLike): { from: number; to: number } | null {
  let node: SyntaxNodeLike | null = ref.node
  while (node) {
    if (node.name === 'Link' || node.name === 'Image') {
      return { from: node.from, to: node.to }
    }
    if (node.name === 'Paragraph' || node.name === 'Document') break
    node = node.parent
  }
  return null
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
  const state = useStore.getState()
  const fromMarkdown = lineText.match(STANDALONE_IMAGE_RE)
  if (fromMarkdown) {
    const href = (fromMarkdown[2] ?? fromMarkdown[3] ?? '').trim()
    if (classifyLocalAssetHref(href) !== 'image') return null
    const resolvedUrl = resolveLocalAssetUrl(state.vault?.root, state.activeNote?.path, href)
    if (!resolvedUrl) return null
    return {
      alt: (fromMarkdown[1] ?? '').trim(),
      href,
      resolvedUrl
    }
  }

  const fromEmbed = lineText.match(STANDALONE_OBSIDIAN_EMBED_RE)
  if (!fromEmbed) return null
  const href = (fromEmbed[1] ?? '').trim()
  if (classifyLocalAssetHref(href) !== 'image') return null
  const resolvedUrl = resolveLocalAssetUrl(state.vault?.root, state.activeNote?.path, href)
  if (!resolvedUrl) return null
  return {
    alt: (fromEmbed[2] ?? '').trim(),
    href,
    resolvedUrl
  }
}

function parseStandaloneLocalPdf(lineText: string): ParsedPdf | null {
  const state = useStore.getState()
  const fromMarkdown = lineText.match(STANDALONE_PDF_RE)
  if (fromMarkdown) {
    const href = (fromMarkdown[2] ?? fromMarkdown[3] ?? '').trim()
    if (classifyLocalAssetHref(href) !== 'pdf') return null
    const resolvedUrl = resolveLocalAssetUrl(state.vault?.root, state.activeNote?.path, href)
    if (!resolvedUrl) return null
    return {
      label: (fromMarkdown[1] ?? '').trim(),
      href,
      resolvedUrl
    }
  }

  const fromEmbed = lineText.match(STANDALONE_OBSIDIAN_EMBED_RE)
  if (!fromEmbed) return null
  const href = (fromEmbed[1] ?? '').trim()
  if (classifyLocalAssetHref(href) !== 'pdf') return null
  const resolvedUrl = resolveLocalAssetUrl(state.vault?.root, state.activeNote?.path, href)
  if (!resolvedUrl) return null
  return {
    label: (fromEmbed[2] ?? '').trim(),
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
      const previewLabel = this.alt || decodeURIComponentSafe(this.href.split('/').filter(Boolean).pop()) || 'Image'
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
      const state = useStore.getState()
      const root = state.vault?.root
      const notePath = state.activeNote?.path
      const assetPath = root && notePath
        ? resolveAssetVaultRelativePath(root, notePath, this.href)
        : null
      if (assetPath) {
        void state.openNoteInTab(assetTabPath(assetPath))
      }
    })
    bottomControls.append(openButton)

    frame.append(image, topControls, bottomControls)

    const caption = document.createElement('figcaption')
    caption.className = 'local-image-embed-caption'
    caption.textContent = this.alt || decodeURIComponentSafe(this.href.split('/').filter(Boolean).pop()) || 'Image'

    figure.append(frame, caption)
    return figure
  }

  ignoreEvent(): boolean {
    return true
  }
}

class LocalPdfWidget extends WidgetType {
  constructor(
    private readonly notePath: string,
    private readonly lineFrom: number,
    private readonly lineTo: number,
    private readonly label: string,
    private readonly href: string,
    private readonly resolvedUrl: string,
    /** Render the compact card instead of the full iframe. */
    private readonly compact: boolean,
    /** True when this PDF is the active pinned reference — affects
     *  the compact card's primary action ("focus reference" vs
     *  "pin as reference"). */
    private readonly pinnedAsRef: boolean
  ) {
    super()
  }

  eq(other: LocalPdfWidget): boolean {
    return (
      other.notePath === this.notePath &&
      other.lineFrom === this.lineFrom &&
      other.lineTo === this.lineTo &&
      other.label === this.label &&
      other.href === this.href &&
      other.resolvedUrl === this.resolvedUrl &&
      other.compact === this.compact &&
      other.pinnedAsRef === this.pinnedAsRef
    )
  }

  private buildEditButton(): HTMLButtonElement {
    const editButton = document.createElement('button')
    editButton.type = 'button'
    editButton.className = 'local-pdf-embed-action'
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
    return editButton
  }

  toDOM(): HTMLElement {
    const figure = document.createElement('figure')
    figure.className = this.compact
      ? 'local-pdf-embed local-asset-pinned-ref cm-local-pdf-embed'
      : 'local-pdf-embed cm-local-pdf-embed'
    figure.dataset.localAssetUrl = this.resolvedUrl
    figure.dataset.localAssetKind = 'pdf'
    figure.dataset.localAssetHref = this.href

    if (this.compact) {
      // Compact card: clicking either pins this PDF as the reference
      // (if not already) or focuses the existing reference pane.
      const labelText =
        this.label ||
        decodeURIComponentSafe(this.href.split('/').filter(Boolean).pop()) ||
        'PDF'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'local-asset-pinned-ref-button'
      button.title = this.pinnedAsRef
        ? 'Showing in the reference pane — click to focus'
        : 'Open this PDF in the reference pane'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const state = useStore.getState()
        if (this.pinnedAsRef) {
          if (!state.pinnedRefVisible) state.togglePinnedRefVisible()
          return
        }
        const root = state.vault?.root
        const notePath = state.activeNote?.path
        if (!root || !notePath) return
        const abs = resolveAssetVaultRelativePath(root, notePath, this.href)
        // Default to a per-note pin — the PDF stays attached to this
        // note and quietly disappears when the user navigates away.
        if (abs) state.pinAssetReferenceForNote(notePath, abs)
      })

      const icon = document.createElement('span')
      icon.className = 'local-asset-pinned-ref-icon'
      icon.textContent = '↗'

      const text = document.createElement('span')
      text.className = 'local-asset-pinned-ref-text'
      text.textContent = labelText

      const badge = document.createElement('span')
      badge.className = 'local-asset-pinned-ref-badge'
      badge.textContent = this.pinnedAsRef ? 'in reference pane' : 'open as reference'

      // Per-block preview toggle — opens the PDF inline right here in
      // the editor without pinning it as the side reference. Useful
      // when you just want to quickly read a page or two.
      const previewButton = document.createElement('button')
      previewButton.type = 'button'
      previewButton.className = 'local-asset-pinned-ref-preview'
      previewButton.title = 'Show PDF inline (toggle)'
      previewButton.setAttribute('aria-label', 'Show PDF inline')
      previewButton.textContent = 'Preview'
      previewButton.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const view = useStore.getState().editorViewRef
        if (!view) return
        togglePdfExpanded(view, this.href)
      })

      const editButton = this.buildEditButton()
      editButton.classList.add('local-asset-pinned-ref-edit')

      button.append(icon, text, badge)
      figure.append(button, previewButton, editButton)
      return figure
    }

    figure.title = 'Right-click for options'

    const header = document.createElement('div')
    header.className = 'local-pdf-embed-header'

    const title = document.createElement('div')
    title.className = 'local-pdf-embed-title'
    title.textContent = this.label || decodeURIComponentSafe(this.href.split('/').filter(Boolean).pop()) || 'PDF'

    const refButton = document.createElement('button')
    refButton.type = 'button'
    refButton.className = 'local-pdf-embed-action'
    refButton.textContent = 'Open as Reference'
    refButton.title = 'Pin this PDF in the reference pane'
    refButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const state = useStore.getState()
      const root = state.vault?.root
      const notePath = state.activeNote?.path
      if (!root || !notePath) return
      const abs = resolveAssetVaultRelativePath(root, notePath, this.href)
      if (abs) state.pinAssetReferenceForNote(notePath, abs)
    })

    const openButton = document.createElement('button')
    openButton.type = 'button'
    openButton.className = 'local-pdf-embed-action'
    openButton.textContent = 'Open'
    openButton.title = 'Open PDF in a new tab'
    openButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const state = useStore.getState()
      const root = state.vault?.root
      const notePath = state.activeNote?.path
      const assetPath = root && notePath
        ? resolveAssetVaultRelativePath(root, notePath, this.href)
        : null
      if (assetPath) {
        void state.openNoteInTab(assetTabPath(assetPath))
      }
    })

    // Collapse the inline iframe back to the compact card without
    // changing the global "PDFs in edit mode" pref. Mirrors the
    // "Preview" toggle on the compact card so the toggle is round-trip.
    const collapseButton = document.createElement('button')
    collapseButton.type = 'button'
    collapseButton.className = 'local-pdf-embed-action'
    collapseButton.textContent = 'Collapse'
    collapseButton.title = 'Collapse to compact card'
    collapseButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const view = useStore.getState().editorViewRef
      if (!view) return
      togglePdfExpanded(view, this.href)
    })

    header.append(title, refButton, openButton, collapseButton, this.buildEditButton())

    const frame = document.createElement('iframe')
    frame.className = 'local-pdf-embed-frame'
    frame.src = this.resolvedUrl
    frame.title = this.label || 'PDF'

    figure.append(header, frame)
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
      if (replacedLines.has(lineNo)) continue
      // Image / PDF lines still render their preview widget even when
      // the cursor is on the line. We only suppress `imageSourceHide`
      // so the raw markdown text shows alongside the widget — matching
      // Obsidian's live-preview behaviour. The widget is an inline
      // decoration whose CSS forces block layout, so CodeMirror treats
      // the line as one logical row (no phantom blank line beneath).
      const lineActive = activeLines.has(lineNo)
      const line = state.doc.line(lineNo)
      const parsedImage = parseStandaloneLocalImage(line.text)
      if (parsedImage) {
        const notePath = useStore.getState().activeNote?.path
        if (!notePath) continue
        replacedLines.add(lineNo)
        // Anchor the widget at end-of-line with side:1 so the DOM
        // order is [source text][image figure]. When the source is
        // hidden (inactive line) only the widget remains, and when
        // the cursor reveals the source the markdown appears above
        // the preview — Obsidian's live-preview layout.
        pending.push({
          from: line.to,
          to: line.to,
          deco: Decoration.widget({
            side: 1,
            widget: new LocalImageWidget(
              notePath,
              line.from,
              line.to,
              line.text,
              parsedImage.alt,
              parsedImage.href,
              parsedImage.resolvedUrl
            )
          })
        })
        if (!lineActive) {
          pending.push({
            from: line.from,
            to: line.to,
            deco: imageSourceHide
          })
        }
        continue
      }
      if (lineActive) continue
      const parsedPdf = parseStandaloneLocalPdf(line.text)
      if (parsedPdf) {
        const st = useStore.getState()
        const notePath = st.activeNote?.path
        if (!notePath) continue
        const vaultRel = st.vault?.root
          ? resolveAssetVaultRelativePath(st.vault.root, notePath, parsedPdf.href)
          : null
        const noteRef = st.noteRefs[notePath]
        const isPinned =
          vaultRel !== null &&
          ((noteRef && noteRef.kind === 'asset' && noteRef.path === vaultRel) ||
            (st.pinnedRefKind === 'asset' && st.pinnedRefPath === vaultRel))
        // Pinning forces compact (the PDF lives in the reference pane).
        // Otherwise the per-block toggle inverts the global pref, so
        // "Preview" round-trips with "Collapse" no matter which
        // default the user has selected.
        const defaultCompact = st.pdfEmbedInEditMode === 'compact'
        const toggled = isPdfExpanded(view, parsedPdf.href)
        const compact = isPinned ? true : defaultCompact !== toggled
        replacedLines.add(lineNo)
        pending.push({
          from: line.from,
          to: line.from,
          deco: Decoration.widget({
            side: 1,
            widget: new LocalPdfWidget(
              notePath,
              line.from,
              line.to,
              parsedPdf.label,
              parsedPdf.href,
              parsedPdf.resolvedUrl,
              compact,
              isPinned
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
        const isLinkSyntax = name === 'LinkMark' || isUrl

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
        if (replacedLines.has(line)) return
        if (isLinkSyntax) {
          const linkRange = enclosingLinkRange(node)
          if (linkRange && selectionTouchesRange(state, linkRange.from, linkRange.to)) return
        } else if (activeLines.has(line)) return

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

/** Dispatched whenever an external state change should force the live-
 *  preview plugin to recompute its decorations (e.g. the pinned
 *  reference path flipping). The handler below treats any transaction
 *  carrying this effect as a recompute trigger. */
const refreshLivePreviewEffect = StateEffect.define<null>()

/**
 * Per-view set of PDF hrefs the user has manually expanded from the
 * compact card. Lets readers open a PDF inline for a quick read
 * without having to pin it as the side reference. Lives on a WeakMap
 * so the state vanishes with the EditorView (no leaks across panes).
 */
const expandedPdfsByView = new WeakMap<EditorView, Set<string>>()
function isPdfExpanded(view: EditorView | null | undefined, href: string): boolean {
  if (!view) return false
  return expandedPdfsByView.get(view)?.has(href) ?? false
}
function togglePdfExpanded(view: EditorView, href: string): void {
  let set = expandedPdfsByView.get(view)
  if (!set) {
    set = new Set()
    expandedPdfsByView.set(view, set)
  }
  if (set.has(href)) set.delete(href)
  else set.add(href)
  view.dispatch({ effects: refreshLivePreviewEffect.of(null) })
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    unsubscribe: (() => void) | null = null

    constructor(view: EditorView) {
      this.decorations = computeDecorations(view)
      // Recompute decorations whenever the pinned reference changes —
      // PDF widgets need to flip between full-iframe and compact modes
      // without requiring the user to type or scroll first.
      this.unsubscribe = useStore.subscribe((state, prev) => {
        if (
          state.pinnedRefPath !== prev.pinnedRefPath ||
          state.pinnedRefKind !== prev.pinnedRefKind ||
          state.pdfEmbedInEditMode !== prev.pdfEmbedInEditMode ||
          state.noteRefs !== prev.noteRefs ||
          // Asset list arrives async after the editor mounts; without
          // this, an `![[name.png]]` whose target is at the vault root
          // (or anywhere other than the note's own directory) bakes in
          // the wrong URL on the very first decoration pass and stays
          // broken until you re-trigger a recompute by editing.
          state.assetFiles !== prev.assetFiles
        ) {
          view.dispatch({ effects: refreshLivePreviewEffect.of(null) })
        }
      })
    }

    update(update: ViewUpdate): void {
      const externalRefresh = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(refreshLivePreviewEffect))
      )
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        externalRefresh
      ) {
        this.decorations = computeDecorations(update.view)
      }
    }

    destroy(): void {
      this.unsubscribe?.()
      this.unsubscribe = null
    }
  },
  {
    decorations: (v) => v.decorations
  }
)
