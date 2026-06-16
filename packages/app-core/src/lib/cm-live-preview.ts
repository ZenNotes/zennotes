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
import { hasPendingMarkdownBlockSnippet } from './cm-markdown-snippets'

/**
 * Live-preview extension: hides markdown syntax markers unless the focused
 * cursor (or any part of the focused selection) currently lives there.
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

/** The `[ ]` or `[x]` marker inside a GFM task list item. Replaced by an
 *  interactive checkbox widget — see `TaskCheckboxWidget` below. */
const TASK_MARKER_NODE = 'TaskMarker'

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

type ParsedVideo = {
  label: string
  href: string
  resolvedUrl: string
  posterUrl: string | null
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

function parseStandaloneLocalVideo(lineText: string): ParsedVideo | null {
  const state = useStore.getState()
  const fromMarkdown = lineText.match(STANDALONE_PDF_RE)
  if (fromMarkdown) {
    const href = (fromMarkdown[2] ?? fromMarkdown[3] ?? '').trim()
    if (classifyLocalAssetHref(href) !== 'video') return null
    const resolvedUrl = resolveLocalAssetUrl(state.vault?.root, state.activeNote?.path, href)
    if (!resolvedUrl) return null
    return {
      label: (fromMarkdown[1] ?? '').trim() || localAssetDisplayName(href),
      href,
      resolvedUrl,
      posterUrl: localAssetPreviewUrl(href)
    }
  }

  const fromEmbed = lineText.match(STANDALONE_OBSIDIAN_EMBED_RE)
  if (!fromEmbed) return null
  const href = (fromEmbed[1] ?? '').trim()
  if (classifyLocalAssetHref(href) !== 'video') return null
  const resolvedUrl = resolveLocalAssetUrl(state.vault?.root, state.activeNote?.path, href)
  if (!resolvedUrl) return null
  return {
    label: (fromEmbed[2] ?? '').trim() || localAssetDisplayName(href),
    href,
    resolvedUrl,
    posterUrl: localAssetPreviewUrl(href)
  }
}

function localAssetForHref(href: string) {
  const state = useStore.getState()
  const id = href.trim().match(/^asset:([^/]+)$/i)?.[1]
  return id
    ? state.assetFiles.find((entry) => entry.id === id)
    : state.assetFiles.find(
        (entry) =>
          entry.path === href ||
          entry.sourcePath === href ||
          entry.name.toLowerCase() === href.split('/').filter(Boolean).pop()?.toLowerCase()
      )
}

function localAssetDisplayName(href: string): string {
  const asset = localAssetForHref(href)
  return asset?.name ?? ''
}

function localAssetPreviewUrl(href: string): string | null {
  const state = useStore.getState()
  const asset = localAssetForHref(href)
  return state.vault?.root && asset?.previewPath
    ? window.zen.resolveVaultAssetUrl(state.vault.root, asset.previewPath)
    : null
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
      ? 'local-pdf-book-embed'
      : 'local-pdf-embed cm-local-pdf-embed'
    figure.dataset.localAssetUrl = this.resolvedUrl
    figure.dataset.localAssetKind = 'pdf'
    figure.dataset.localAssetHref = this.href

    if (this.compact) {
      const labelText =
        this.label ||
        decodeURIComponentSafe(this.href.split('/').filter(Boolean).pop()) ||
        'PDF'
      const state = useStore.getState()
      const vaultRoot = state.vault?.root
      const vaultRel = vaultRoot
        ? resolveAssetVaultRelativePath(vaultRoot, this.notePath, this.href)
        : null
      const asset = vaultRel
        ? state.assetFiles.find((entry) => entry.path === vaultRel)
        : null
      const previewUrl =
        vaultRoot && asset?.previewPath
          ? window.zen.resolveVaultAssetUrl(vaultRoot, asset.previewPath)
          : null

      const shell = document.createElement('div')
      shell.className = 'local-pdf-book-shell'

      const cover = document.createElement('button')
      cover.type = 'button'
      cover.className = 'local-pdf-book-cover'
      cover.title = this.pinnedAsRef
        ? 'Showing in the reference pane — click to focus'
        : 'Open this PDF in the reference pane'
      cover.addEventListener('click', (event) => {
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

      if (previewUrl) {
        const preview = document.createElement('img')
        preview.className = 'local-pdf-book-thumbnail'
        preview.src = previewUrl
        preview.alt = ''
        preview.draggable = false
        cover.append(preview)
      } else {
        const fallback = document.createElement('div')
        fallback.className = 'local-pdf-book-fallback'
        const mark = document.createElement('span')
        mark.className = 'local-pdf-book-mark'
        mark.textContent = 'PDF'
        fallback.append(mark)
        cover.append(fallback)
      }
      const tag = document.createElement('span')
      tag.className = 'local-pdf-book-tag'
      tag.textContent = 'PDF'
      cover.append(tag)

      // Per-block preview toggle — opens the PDF inline right here in
      // the editor without pinning it as the side reference. Useful
      // when you just want to quickly read a page or two.
      const actions = document.createElement('div')
      actions.className = 'local-pdf-book-actions'
      const previewButton = document.createElement('button')
      previewButton.type = 'button'
      previewButton.className = 'local-pdf-book-action'
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
      editButton.className = 'local-pdf-book-action'

      const caption = document.createElement('figcaption')
      caption.className = 'local-pdf-book-caption'
      caption.textContent = labelText

      actions.append(previewButton, editButton)
      shell.append(cover, actions)
      figure.append(shell, caption)
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

/** Renders a GFM task-list marker (`[ ]` / `[x]` / `[X]`) as a clickable
 *  checkbox. The widget rewrites the underlying markdown when toggled — the
 *  same single-character mutation the Preview pane uses, so the on-disk
 *  source stays in lockstep regardless of which surface toggled it. */
class TaskCheckboxWidget extends WidgetType {
  constructor(
    /** Absolute doc offset of the opening `[`. The marker is always 3
     *  chars (`[ ]`, `[x]`, `[X]`), so the inner state char is at `from + 1`. */
    private readonly from: number,
    private readonly checked: boolean
  ) {
    super()
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.from === this.from && other.checked === this.checked
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-task-checkbox'
    wrap.setAttribute('contenteditable', 'false')

    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = this.checked
    input.className = 'cm-task-checkbox-input'
    input.setAttribute('aria-label', this.checked ? 'Uncheck task' : 'Check task')

    // Stop the editor from moving the selection or losing focus on the
    // pointer-down phase. Toggling on click keeps the cursor wherever
    // the user had it before they reached for the checkbox.
    input.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    input.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      // The state char sits at offset 1 inside the marker. Replace it in
      // place — width stays 3, so no doc positions downstream shift.
      const stateFrom = this.from + 1
      const stateTo = this.from + 2
      view.dispatch({
        changes: { from: stateFrom, to: stateTo, insert: this.checked ? ' ' : 'x' }
      })
    })

    wrap.append(input)
    return wrap
  }

  // `false` lets DOM events bubble to our handler above. CodeMirror's
  // default `ignoreEvent` skips events on widgets entirely, which would
  // also swallow our click.
  ignoreEvent(): boolean {
    return false
  }
}

class LocalVideoWidget extends WidgetType {
  constructor(
    private readonly notePath: string,
    private readonly lineFrom: number,
    private readonly lineTo: number,
    private readonly label: string,
    private readonly href: string,
    private readonly resolvedUrl: string,
    private readonly posterUrl: string | null
  ) {
    super()
  }

  eq(other: LocalVideoWidget): boolean {
    return (
      other.notePath === this.notePath &&
      other.lineFrom === this.lineFrom &&
      other.lineTo === this.lineTo &&
      other.label === this.label &&
      other.href === this.href &&
      other.resolvedUrl === this.resolvedUrl &&
      other.posterUrl === this.posterUrl
    )
  }

  toDOM(): HTMLElement {
    const figure = document.createElement('figure')
    figure.className = 'local-video-embed cm-local-video-embed'
    figure.dataset.localAssetUrl = this.resolvedUrl
    figure.dataset.localAssetKind = 'video'
    figure.dataset.localAssetHref = this.href

    const frame = document.createElement('div')
    frame.className = 'local-video-embed-frame'
    const video = document.createElement('video')
    video.className = 'local-video-embed-video'
    video.src = this.resolvedUrl
    video.controls = true
    video.preload = 'metadata'
    if (this.posterUrl) video.poster = this.posterUrl
    video.addEventListener('loadedmetadata', () => {
      figure.classList.toggle('is-portrait', video.videoHeight > video.videoWidth)
    })
    frame.append(video)

    const caption = document.createElement('figcaption')
    caption.className = 'local-video-embed-caption'
    caption.textContent =
      this.label || decodeURIComponentSafe(this.href.split('/').filter(Boolean).pop()) || 'Video'

    figure.append(frame, caption)
    return figure
  }
}

function computeDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const revealSyntax = view.hasFocus

  // Every line that holds part of a selection range is "active" and
  // therefore keeps its syntax markers visible for editing.
  const activeLines = new Set<number>()
  if (revealSyntax) {
    for (const r of state.selection.ranges) {
      const fromLine = state.doc.lineAt(r.from).number
      const toLine = state.doc.lineAt(r.to).number
      for (let l = fromLine; l <= toLine; l++) activeLines.add(l)
    }
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
      const parsedVideo = parseStandaloneLocalVideo(line.text)
      if (parsedVideo) {
        const notePath = useStore.getState().activeNote?.path
        if (!notePath) continue
        replacedLines.add(lineNo)
        pending.push({
          from: line.to,
          to: line.to,
          deco: Decoration.widget({
            side: 1,
            widget: new LocalVideoWidget(
              notePath,
              line.from,
              line.to,
              parsedVideo.label,
              parsedVideo.href,
              parsedVideo.resolvedUrl,
              parsedVideo.posterUrl
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
          from: line.to,
          to: line.to,
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
        if (!lineActive) {
          pending.push({
            from: line.from,
            to: line.to,
            deco: imageSourceHide
          })
        }
      }
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        // Tables are owned by the live table widget (cm-table.ts), which
        // block-replaces the whole table. Hiding marks inside it here would
        // produce overlapping replace decorations and crash the view, so skip
        // the entire Table subtree.
        if (name === 'Table') return false
        // The inner `[text]` of an Obsidian `[[wikilink]]` parses as a shortcut
        // link; the wikilink render plugin (cm-wikilink-render.ts) owns the
        // whole token, so skip it here to avoid double-hiding / overlap.
        if (name === 'Link') {
          const before = state.doc.sliceString(node.from - 1, node.from)
          const after = state.doc.sliceString(node.to, node.to + 1)
          if (before === '[' && after === ']') return false
        }
        const isPrefix = PREFIX_HIDE_WITH_SPACE.has(name)
        const isSimple = SIMPLE_HIDE.has(name)
        const isUrl = name === URL_NODE
        const isLinkSyntax = name === 'LinkMark' || isUrl

        if (name === TASK_MARKER_NODE) {
          const line = state.doc.lineAt(node.from).number
          if (replacedLines.has(line)) return
          // Reveal the raw `[ ]` / `[x]` so the user can edit it directly
          // when the cursor lands inside the marker. Cursor elsewhere on
          // the line still shows the checkbox — same model headings use
          // for `#` markers.
          if (revealSyntax && selectionTouchesRange(state, node.from, node.to)) return
          const markerText = state.doc.sliceString(node.from, node.to)
          // `markerText` is `[ ]` / `[x]` / `[X]`; default to unchecked if the
          // parser ever hands us something unexpected.
          const checked = markerText.length >= 2 && /[xX]/.test(markerText[1] ?? '')
          pending.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({
              widget: new TaskCheckboxWidget(node.from, checked)
            })
          })
          return
        }

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
          if (
            revealSyntax &&
            linkRange &&
            selectionTouchesRange(state, linkRange.from, linkRange.to)
          ) return
        } else if (activeLines.has(line)) {
          // Obsidian-style: the line the cursor is on reveals its raw source,
          // including the leading `#`/`>` markers, so it reads as the source.
          return
        }

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
      if (hasPendingMarkdownBlockSnippet(update.state) && !externalRefresh) {
        if (update.docChanged) this.decorations = this.decorations.map(update.changes)
        return
      }
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
