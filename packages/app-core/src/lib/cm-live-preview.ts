import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateEffect, type EditorState } from '@codemirror/state'
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
  buildAttachmentChip,
  classifyLocalAssetHref,
  hrefFragment,
  resolveAssetVaultRelativePath,
  resolveLocalAssetUrl
} from './local-assets'
import { parseBlockAnchors } from './block-anchors'
import { setImageBlockDragPayload } from './image-block-dnd'
import { imageCacheKey, rememberImageOnLoad, takeCachedImage } from './image-element-cache'
import { attachImageResizeHandle, setImageWidthOnLine } from './image-resize'
import { assetTabPath } from './asset-tabs'
import { openVaultAssetExternally } from './external-file-link'
import {
  getExcalidrawPreview,
  parseEmbedSizeHint,
  splitEmbedLabel,
  resolveExcalidrawEmbedPath
} from './excalidraw-preview'

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
// Marks the text of a completed task (`- [x] …`) so CSS can strike/gray it,
// gated by the `data-completed-task-style` setting on the document root.
const taskDoneMark = Decoration.mark({ class: 'cm-task-done' })
// Marks the text of a cancelled task (`- [-] …`) so CSS can strike/mute it.
// Always applied (not gated by a setting) — cancelled always reads as struck. (#450)
const taskCancelledMark = Decoration.mark({ class: 'cm-task-cancelled' })
// Stamped on an image line only while its raw source is hidden, so the host
// line stops reserving a blank text row above/below the block figure (#261).
const imageEmbedLine = Decoration.line({ class: 'cm-image-embed-line' })
// A markdown destination may carry a title: `![alt](path "title")`. Zettlr
// writes one on every image it inserts, and reading the title into the href
// turned such pictures into attachment chips in edit mode while the preview
// (remark) drew them fine (#199). The bare form stays lazy so a path with a
// space (`![](my image.png)`) still parses when no title follows.
const MD_LINK_TITLE = String.raw`(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?`
const STANDALONE_IMAGE_RE = new RegExp(
  String.raw`^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^)]+?))` + MD_LINK_TITLE + String.raw`\s*\)\s*$`
)
const STANDALONE_OBSIDIAN_EMBED_RE = /^\s*!\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]\s*$/
// Anchor-style standalone PDF link: `[Label](file.pdf)` or `[Label](<file with spaces.pdf>)`.
// Same shape as the image regex but without the leading `!`.
const STANDALONE_PDF_RE = new RegExp(
  String.raw`^\s*\[([^\]]*)\]\((?:<([^>]+)>|([^)]+?))` + MD_LINK_TITLE + String.raw`\s*\)\s*$`
)

/** The `alt` and `href` of a standalone markdown image line, title dropped;
 *  null when the line is not one. Exported for tests. */
export function parseStandaloneImageLine(lineText: string): { alt: string; href: string } | null {
  const m = lineText.match(STANDALONE_IMAGE_RE)
  if (!m) return null
  return { alt: m[1] ?? '', href: (m[2] ?? m[3] ?? '').trim() }
}

type ParsedImage = {
  alt: string
  href: string
  resolvedUrl: string
  /** Asset mtime, part of the image cache key so an edited file reloads. (#472) */
  version: number
  /** Obsidian-style `|600` / `|600x400` size hint from the label. (#570) */
  width?: number
  height?: number
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

/**
 * True when a `Link`/`Image` node that ends at `linkTo` is immediately
 * followed by a `(` whose matching `)` hasn't been typed yet, i.e. the
 * link target is still being written. (#471)
 *
 * The parser ends the `Link` node at the `]` in that state (`[Example](`
 * gives `Link[0,9]`), so its brackets would otherwise be hidden and the
 * label would render as `Example(` mid-edit. Parens nest, matching
 * CommonMark's balanced-paren destinations, so a URL like
 * `https://en.wikipedia.org/wiki/Foo_(bar` still counts as unterminated.
 */
/**
 * The end offset of a balanced `(target)` sitting immediately after a `Link`
 * node, or null when there is none. This is the parser-rejected-destination
 * case (#617): CommonMark refuses an unescaped space in `[text](My Note.md)`,
 * so the `Link` node ends at `]` and the target trails as plain text. The
 * click/gd path (`markdownLinkAt`) accepts those targets, so rendering must
 * treat the whole span as one link too.
 */
function terminatedLinkTailEnd(state: EditorView['state'], linkTo: number): number | null {
  if (state.doc.sliceString(linkTo, linkTo + 1) !== '(') return null
  const line = state.doc.lineAt(linkTo)
  const rest = state.doc.sliceString(linkTo, line.to)
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

function hasUnterminatedLinkTarget(state: EditorView['state'], linkTo: number): boolean {
  if (state.doc.sliceString(linkTo, linkTo + 1) !== '(') return false
  const line = state.doc.lineAt(linkTo)
  const rest = state.doc.sliceString(linkTo, line.to)
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
      if (depth === 0) return false
    }
  }
  return true
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

let assetVersionSource: unknown = null
let assetVersionIndex: Map<string, number> = new Map()

/** Mtime of the vault asset `href` resolves to, or 0 when unknown. (#472) */
function assetVersionFor(href: string): number {
  const state = useStore.getState()
  const root = state.vault?.root
  const notePath = state.activeNote?.path
  if (!root || !notePath) return 0
  const rel = resolveAssetVaultRelativePath(root, notePath, href)
  if (!rel) return 0
  const files = state.assetFiles
  if (files !== assetVersionSource) {
    assetVersionSource = files
    assetVersionIndex = new Map(files.map((a) => [a.path, a.updatedAt]))
  }
  return assetVersionIndex.get(rel) ?? 0
}

function parseStandaloneLocalImage(lineText: string): ParsedImage | null {
  const state = useStore.getState()
  const fromMarkdown = lineText.match(STANDALONE_IMAGE_RE)
  if (fromMarkdown) {
    const href = (fromMarkdown[2] ?? fromMarkdown[3] ?? '').trim()
    if (classifyLocalAssetHref(href) !== 'image') return null
    const resolvedUrl = resolveLocalAssetUrl(state.vault?.root, state.activeNote?.path, href)
    if (!resolvedUrl) return null
    const { alt, size } = splitEmbedLabel(fromMarkdown[1], 'markdown')
    return {
      alt,
      href,
      resolvedUrl,
      version: assetVersionFor(href),
      width: size?.width,
      height: size?.height
    }
  }

  const fromEmbed = lineText.match(STANDALONE_OBSIDIAN_EMBED_RE)
  if (!fromEmbed) return null
  const href = (fromEmbed[1] ?? '').trim()
  if (classifyLocalAssetHref(href) !== 'image') return null
  const resolvedUrl = resolveLocalAssetUrl(state.vault?.root, state.activeNote?.path, href)
  if (!resolvedUrl) return null
  const { alt, size } = splitEmbedLabel(fromEmbed[2], 'wikilink')
  return {
    alt,
    href,
    resolvedUrl,
    version: assetVersionFor(href),
    width: size?.width,
    height: size?.height
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

type ParsedAttachment = {
  href: string
  resolvedUrl: string
  name: string
}

// A standalone non-previewable attachment embed. Two forms:
//  - Markdown `![](file.tldraw)` — any non-image, non-excalidraw file (PDFs in
//    this form have no dedicated widget, so they chip too).
//  - Obsidian `![[file.tldraw]]` — generic files only; PDF/audio/video keep
//    their rich widgets/embeds.
// Images and excalidraw drawings have their own widgets and are excluded. (#463)
function parseStandaloneLocalAttachment(lineText: string): ParsedAttachment | null {
  const md = lineText.match(STANDALONE_IMAGE_RE)
  const embed = md ? null : lineText.match(STANDALONE_OBSIDIAN_EMBED_RE)
  let href: string
  let alt: string
  if (md) {
    href = (md[2] ?? md[3] ?? '').trim()
    alt = (md[1] ?? '').trim()
  } else if (embed) {
    href = (embed[1] ?? '').trim()
    alt = (embed[2] ?? '').trim()
  } else {
    return null
  }
  const kind = classifyLocalAssetHref(href)
  if (md) {
    if (!kind || kind === 'image' || kind === 'excalidraw') return null
  } else if (kind !== 'file') {
    return null
  }
  const state = useStore.getState()
  const resolvedUrl = resolveLocalAssetUrl(state.vault?.root, state.activeNote?.path, href)
  if (!resolvedUrl) return null
  const name = alt || decodeURIComponentSafe(href.split('/').filter(Boolean).pop()) || 'Attachment'
  return { href, resolvedUrl, name }
}

class LocalImageWidget extends WidgetType {
  constructor(
    private readonly notePath: string,
    private readonly lineFrom: number,
    private readonly lineTo: number,
    private readonly lineText: string,
    private readonly alt: string,
    private readonly href: string,
    private readonly resolvedUrl: string,
    private readonly version: number,
    private readonly width?: number,
    private readonly height?: number
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
      other.resolvedUrl === this.resolvedUrl &&
      other.version === this.version &&
      other.width === this.width &&
      other.height === this.height
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

    // Reuse the decoded element when this image was on screen recently, so
    // scrolling back paints it immediately instead of refetching and
    // re-decoding it. (#472)
    const key = imageCacheKey(this.resolvedUrl, this.version)
    const cached = takeCachedImage(key)
    const image = cached ?? document.createElement('img')
    image.className = 'local-image-embed-image'
    if (!cached) {
      image.src = this.resolvedUrl
      rememberImageOnLoad(key, image)
    }
    image.alt = this.alt
    image.loading = 'lazy'
    image.draggable = false
    // Obsidian-style size hints (#570). The attribute carries the semantic
    // size, but the embed class stretches images to width: 100% and
    // presentational attributes lose to any CSS rule, so the hint also goes
    // on as inline style. The class's max-width: 100% still caps a hint
    // wider than the pane. The cache key above is url|mtime, not the hint,
    // so a reused element may still carry the size of a previous render
    // (hint edited away, or the same file embedded elsewhere with another
    // hint): clear whatever this widget does not set.
    if (this.width) {
      image.width = this.width
      image.style.width = `${this.width}px`
    } else {
      image.removeAttribute('width')
      image.style.removeProperty('width')
    }
    if (this.height) {
      image.height = this.height
      image.style.height = `${this.height}px`
    } else {
      image.removeAttribute('height')
      image.style.removeProperty('height')
    }

    // Logseq-style resize (#684). The picture sits in a sizer that hugs it,
    // so the handle on the sizer's right edge is the picture's edge whatever
    // the frame's width (the frame keeps its full width, as before, so
    // existing notes lay out unchanged). Live width changes stay on the
    // element; the note gets the `|width` hint once, on release.
    const sizer = document.createElement('div')
    sizer.className = 'local-image-embed-sizer'
    const resizeHandle = document.createElement('div')
    resizeHandle.className = 'local-image-embed-resize'
    resizeHandle.title = 'Drag to resize'
    const sizeBadge = document.createElement('span')
    sizeBadge.className = 'local-image-embed-size'
    sizer.append(image, resizeHandle, sizeBadge)
    attachImageResizeHandle({
      handle: resizeHandle,
      image,
      figure,
      badge: sizeBadge,
      maxWidth: () => frame.clientWidth,
      onCommit: (width) => this.commitWidth(figure, width)
    })

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

    frame.append(sizer, topControls, bottomControls)

    const caption = document.createElement('figcaption')
    caption.className = 'local-image-embed-caption'
    caption.textContent = this.alt || decodeURIComponentSafe(this.href.split('/').filter(Boolean).pop()) || 'Image'

    figure.append(frame, caption)
    return figure
  }

  /** Write a dragged width into the note as the size hint. The line is
   *  looked up under the figure at release time rather than trusted from
   *  this widget's own render, and left alone if its text has moved on. */
  private commitWidth(figure: HTMLElement, width: number): void {
    const editor = figure.closest<HTMLElement>('.cm-editor')
    const view = (editor && EditorView.findFromDOM(editor)) ?? useStore.getState().editorViewRef
    if (!view) return
    let lineNumber: number
    try {
      lineNumber = view.state.doc.lineAt(view.posAtDOM(figure)).number
    } catch {
      return
    }
    if (view.state.doc.line(lineNumber).text !== this.lineText) return
    setImageWidthOnLine(view, lineNumber, width)
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
        if (abs) state.pinAssetReferenceForNote(notePath, abs, hrefFragment(this.href) || null)
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
      if (abs) state.pinAssetReferenceForNote(notePath, abs, hrefFragment(this.href) || null)
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
    frame.src = this.resolvedUrl + hrefFragment(this.href)
    frame.title = this.label || 'PDF'

    figure.append(header, frame)
    return figure
  }

  ignoreEvent(): boolean {
    return true
  }
}

type ParsedExcalidraw = {
  href: string
  resolvedPath: string
  width?: number
  height?: number
}

function parseStandaloneLocalExcalidraw(lineText: string): ParsedExcalidraw | null {
  const fromEmbed = lineText.match(STANDALONE_OBSIDIAN_EMBED_RE)
  if (!fromEmbed) return null
  const href = (fromEmbed[1] ?? '').trim()
  if (classifyLocalAssetHref(href) !== 'excalidraw') return null
  const state = useStore.getState()
  const notePaths = state.notes.map((n) => n.path)
  const resolvedPath = resolveExcalidrawEmbedPath(notePaths, href) ?? href
  const hint = parseEmbedSizeHint(fromEmbed[2])
  return {
    href,
    resolvedPath,
    width: hint?.width,
    height: hint?.height
  }
}

/** Renders a `![[drawing.excalidraw]]` embed as an exported PNG image, like an
 *  inline image block. Clicking opens the drawing in a dedicated Excalidraw
 *  tab. The preview is produced lazily by excalidraw-preview.ts (exportToBlob)
 *  and cached by path + mtime. */
class LocalExcalidrawWidget extends WidgetType {
  constructor(
    private readonly notePath: string,
    private readonly lineFrom: number,
    private readonly lineTo: number,
    private readonly href: string,
    private readonly resolvedPath: string,
    private readonly width?: number,
    private readonly height?: number,
    private readonly version = 0
  ) {
    super()
  }

  eq(other: LocalExcalidrawWidget): boolean {
    return (
      other.notePath === this.notePath &&
      other.href === this.href &&
      other.resolvedPath === this.resolvedPath &&
      other.width === this.width &&
      other.height === this.height &&
      other.version === this.version
    )
  }

  toDOM(): HTMLElement {
    const figure = document.createElement('figure')
    figure.className = 'local-image-embed cm-excalidraw-embed'

    const frame = document.createElement('div')
    frame.className = 'local-image-embed-frame'

    const image = document.createElement('img')
    image.className = 'local-image-embed-image excalidraw-embed-image'
    image.alt = ''
    image.loading = 'lazy'
    image.draggable = false
    const imgStyle = image.style
    if (this.width) imgStyle.maxWidth = `${this.width}px`
    if (this.height) imgStyle.maxHeight = `${this.height}px`

    // Lazy-render the PNG and swap it in when ready.
    void getExcalidrawPreview(this.resolvedPath).then((url) => {
      if (url) image.src = url
    })

    // Click anywhere on the image opens the drawing in a new Excalidraw tab.
    image.style.cursor = 'pointer'
    image.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      // Open the drawing itself (routes to the Excalidraw editor via
      // isExcalidrawPath). Wrapping it as an asset tab (zen://asset/…) instead
      // hits the generic asset viewer, which offers to download the file. (#360)
      void useStore.getState().openNoteInTab(this.resolvedPath)
    })
    // Right-click shows the drawing menu (Open / Copy image) rather than the
    // editor's plain text context menu. (#360)
    image.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      window.dispatchEvent(
        new CustomEvent('zen:excalidraw-embed-menu', {
          detail: { path: this.resolvedPath, x: event.clientX, y: event.clientY }
        })
      )
    })

    frame.append(image)

    const caption = document.createElement('figcaption')
    caption.className = 'local-image-embed-caption'
    caption.textContent =
      decodeURIComponentSafe(this.href.split('/').filter(Boolean).pop()) || 'Drawing'

    figure.append(frame, caption)
    return figure
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** Renders a non-previewable attachment (`![](file.tldraw)`) as an attachment
 *  chip — matching the reading preview — instead of leaving the line blank.
 *  Clicking opens the file the same way the image/PDF widgets do. (#463) */
class AttachmentChipWidget extends WidgetType {
  constructor(
    private readonly href: string,
    private readonly resolvedUrl: string,
    private readonly name: string
  ) {
    super()
  }

  eq(other: AttachmentChipWidget): boolean {
    return (
      other.href === this.href &&
      other.resolvedUrl === this.resolvedUrl &&
      other.name === this.name
    )
  }

  toDOM(): HTMLElement {
    return buildAttachmentChip(this.resolvedUrl, this.href, this.name, () => {
      const state = useStore.getState()
      const root = state.vault?.root
      const notePath = state.activeNote?.path
      const assetPath =
        root && notePath ? resolveAssetVaultRelativePath(root, notePath, this.href) : null
      // Open in the OS default app — an in-app asset tab can't render a
      // non-previewable file. (#463) The bridge resolves the vault-relative
      // path itself: prefixing the root here produced a server path that
      // does not exist on this machine for remote workspaces.
      if (assetPath) {
        void openVaultAssetExternally(assetPath)
      }
    })
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
     *  chars (`[ ]`, `[x]`, `[X]`, `[>]`), so the inner state char is at
     *  `from + 1`. */
    private readonly from: number,
    private readonly checked: boolean,
    /** `[>]` — forwarded to another note (#316); shown as an arrow, not a box. */
    private readonly forwarded = false
  ) {
    super()
  }

  eq(other: TaskCheckboxWidget): boolean {
    return (
      other.from === this.from &&
      other.checked === this.checked &&
      other.forwarded === this.forwarded
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-task-checkbox'
    wrap.setAttribute('contenteditable', 'false')

    if (this.forwarded) {
      const marker = document.createElement('span')
      marker.className = 'cm-task-forwarded'
      // The arrow glyph is drawn via the `.cm-task-forwarded::before` rule
      // (absolutely centred), the same as the broken-link path — so no
      // textContent here, or the two would double up.
      marker.title = 'Forwarded to another note'
      wrap.append(marker)
      return wrap
    }

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

/** Renders a `- [>]` forwarded-task marker as an arrow (#316). CodeMirror parses
 *  `[>]` as a broken link rather than a task, so this replaces it directly. */
class ForwardedMarkerWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    // The glyph is drawn via CSS `::before` (absolutely centred) so it aligns
    // with the checkbox column regardless of the arrow glyph's font metrics.
    const span = document.createElement('span')
    span.className = 'cm-task-forwarded'
    span.title = 'Forwarded to another note'
    span.setAttribute('contenteditable', 'false')
    return span
  }
}

class CancelledMarkerWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-task-cancelled-marker'
    span.title = 'Cancelled'
    span.setAttribute('contenteditable', 'false')
    return span
  }
}

/** Renders a `- [/]` in-progress marker as a half-filled box (#512). Like the
 *  `[>]`/`[-]` markers this replaces a broken-link node, not a TaskMarker, so
 *  it draws its own glyph rather than reusing the checkbox input. The text is
 *  left alone: in-progress work still reads as live, not struck out.
 *
 *  Unlike those two, the half-filled box is still a checkbox shape making a
 *  checkbox promise, so clicking it checks the task off — the same `[/]` → `[x]`
 *  the toggle command performs. A dead click here read as a bug (#599).
 *  Forwarded and cancelled markers stay inert on purpose: they are records of
 *  a decision, not live work. */
class InProgressMarkerWidget extends WidgetType {
  constructor(
    /** Absolute doc offset of the opening `[`; the state char is at `from + 1`. */
    private readonly from: number
  ) {
    super()
  }

  eq(other: InProgressMarkerWidget): boolean {
    return other.from === this.from
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-task-in-progress-marker'
    span.title = 'In progress. Click to mark done.'
    span.setAttribute('contenteditable', 'false')
    span.setAttribute('role', 'checkbox')
    span.setAttribute('aria-checked', 'mixed')
    span.setAttribute('aria-label', 'Mark task done')

    // Same pointer handling as TaskCheckboxWidget: keep the selection and
    // focus where they were, then rewrite the single state char in place.
    span.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    span.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const stateFrom = this.from + 1
      view.dispatch({ changes: { from: stateFrom, to: stateFrom + 1, insert: 'x' } })
    })
    return span
  }

  // `false` lets DOM events reach the handlers above (see TaskCheckboxWidget).
  ignoreEvent(): boolean {
    return false
  }
}

// Block-anchor markers by 1-based line number, memoized per document. The
// parser's grammar (fence and frontmatter aware) decides what hides, and the
// scan runs once per doc version rather than on every cursor move, since
// computeDecorations also fires on selection changes.
const blockAnchorCache = new WeakMap<object, Map<number, { from: number; to: number }>>()

function blockAnchorMarkersFor(state: EditorState): Map<number, { from: number; to: number }> {
  const cached = blockAnchorCache.get(state.doc)
  if (cached) return cached
  const markers = new Map<number, { from: number; to: number }>()
  for (const anchor of parseBlockAnchors(state.doc.toString())) {
    markers.set(anchor.markerLine, { from: anchor.markerFrom, to: anchor.markerTo })
  }
  blockAnchorCache.set(state.doc, markers)
  return markers
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
              parsedImage.resolvedUrl,
              parsedImage.version,
              parsedImage.width,
              parsedImage.height
            )
          })
        })
        if (!lineActive) {
          pending.push({
            from: line.from,
            to: line.to,
            deco: imageSourceHide
          })
          // Collapse the now text-less line's strut (see imageEmbedLine).
          pending.push({
            from: line.from,
            to: line.from,
            deco: imageEmbedLine
          })
        }
        continue
      }
      const parsedExcalidraw = parseStandaloneLocalExcalidraw(line.text)
      if (parsedExcalidraw) {
        const st = useStore.getState()
        const notePath = st.activeNote?.path
        if (!notePath) continue
        replacedLines.add(lineNo)
        pending.push({
          from: line.to,
          to: line.to,
          deco: Decoration.widget({
            side: 1,
            widget: new LocalExcalidrawWidget(
              notePath,
              line.from,
              line.to,
              parsedExcalidraw.href,
              parsedExcalidraw.resolvedPath,
              parsedExcalidraw.width,
              parsedExcalidraw.height,
              st.excalidrawPreviewVersion
            )
          })
        })
        if (!lineActive) {
          pending.push({
            from: line.from,
            to: line.to,
            deco: imageSourceHide
          })
          pending.push({
            from: line.from,
            to: line.from,
            deco: imageEmbedLine
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
      const parsedAttachment = parseStandaloneLocalAttachment(line.text)
      if (parsedAttachment && !replacedLines.has(lineNo)) {
        replacedLines.add(lineNo)
        pending.push({
          from: line.to,
          to: line.to,
          deco: Decoration.widget({
            side: 1,
            widget: new AttachmentChipWidget(
              parsedAttachment.href,
              parsedAttachment.resolvedUrl,
              parsedAttachment.name
            )
          })
        })
        pending.push({
          from: line.from,
          to: line.to,
          deco: imageSourceHide
        })
        // Collapse the now text-less line's strut, like the image embed does.
        pending.push({
          from: line.from,
          to: line.from,
          deco: imageEmbedLine
        })
      }

      // #601: a trailing `^block-id` names the line so `[[Note^id]]` can point
      // at it. That is addressing, not prose, so hide it the way other markers
      // are hidden and reveal it when the cursor is on the line to edit. Only
      // markers the parser accepts are hidden: a per-line regex here blanked
      // literal `^word` tails inside code fences and frontmatter that are not
      // anchors at all, so code samples looked corrupted in the editor.
      if (!lineActive && !replacedLines.has(lineNo)) {
        const blockId = blockAnchorMarkersFor(state).get(lineNo)
        if (blockId) {
          pending.push({
            from: blockId.from,
            to: blockId.to,
            deco: hide
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

        // #316: `[>]` at the start of a list item is a forwarded-task marker.
        // CM parses it as a broken link; render an arrow (off the active line)
        // and return false so its bracket marks aren't separately hidden (which
        // would overlap this replacement) while the rest of the line — including
        // the `[[wikilink]]` to the target — still renders normally.
        if (name === 'Link' && state.doc.sliceString(node.from, node.to) === '[>]') {
          const markerLine = state.doc.lineAt(node.from)
          const before = state.doc.sliceString(markerLine.from, node.from)
          if (/^\s*(?:[-+*]|\d+[.)])[ \t]+$/.test(before)) {
            if (!activeLines.has(markerLine.number) && !replacedLines.has(markerLine.number)) {
              pending.push({
                from: node.from,
                to: node.to,
                deco: Decoration.replace({ widget: new ForwardedMarkerWidget() })
              })
            }
            return false
          }
        }

        // #450: `[-]` at the start of a list item is a cancelled-task marker.
        // Also parsed as a broken link (not a TaskMarker). Render a `✕` off the
        // active line and strike the task text (always, like Obsidian's cancel).
        if (name === 'Link' && state.doc.sliceString(node.from, node.to) === '[-]') {
          const markerLine = state.doc.lineAt(node.from)
          const before = state.doc.sliceString(markerLine.from, node.from)
          if (/^\s*(?:[-+*]|\d+[.)])[ \t]+$/.test(before)) {
            if (markerLine.to > node.to) {
              pending.push({ from: node.to, to: markerLine.to, deco: taskCancelledMark })
            }
            if (!activeLines.has(markerLine.number) && !replacedLines.has(markerLine.number)) {
              pending.push({
                from: node.from,
                to: node.to,
                deco: Decoration.replace({ widget: new CancelledMarkerWidget() })
              })
            }
            return false
          }
        }

        // #512: `[/]` at the start of a list item is an in-progress marker.
        // Parsed as a broken link like `[>]`/`[-]`. Draw a half-filled box off
        // the active line; the task text keeps its normal styling, since the
        // work is still live.
        if (name === 'Link' && state.doc.sliceString(node.from, node.to) === '[/]') {
          const markerLine = state.doc.lineAt(node.from)
          const before = state.doc.sliceString(markerLine.from, node.from)
          if (/^\s*(?:[-+*]|\d+[.)])[ \t]+$/.test(before)) {
            if (!activeLines.has(markerLine.number) && !replacedLines.has(markerLine.number)) {
              pending.push({
                from: node.from,
                to: node.to,
                deco: Decoration.replace({ widget: new InProgressMarkerWidget(node.from) })
              })
            }
            return false
          }
        }

        const isPrefix = PREFIX_HIDE_WITH_SPACE.has(name)
        const isSimple = SIMPLE_HIDE.has(name)
        const isUrl = name === URL_NODE
        const isLinkSyntax = name === 'LinkMark' || isUrl

        if (name === TASK_MARKER_NODE) {
          const lineObj = state.doc.lineAt(node.from)
          const line = lineObj.number
          if (replacedLines.has(line)) return
          const markerText = state.doc.sliceString(node.from, node.to)
          // `markerText` is `[ ]` / `[x]` / `[X]` / `[>]`; default to unchecked if
          // the parser ever hands us something unexpected.
          const stateChar = markerText[1] ?? ''
          const checked = markerText.length >= 2 && /[xX]/.test(stateChar)
          const forwarded = stateChar === '>'
          // Mark a completed task's text so CSS can strike/gray it (gated by the
          // `completedTaskStyle` setting). Applied on the active line too, so it
          // doesn't flip as the cursor moves; the checkbox itself is untouched.
          if (checked && lineObj.to > node.to) {
            pending.push({ from: node.to, to: lineObj.to, deco: taskDoneMark })
          }
          // Reveal the raw `[ ]` / `[x]` on the active line so the whole task
          // line reads as source — matching Obsidian, and consistent with the
          // list/quote/heading markers, which also reveal on the active line.
          // Off the line, render the checkbox.
          if (activeLines.has(line)) return
          pending.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({
              widget: new TaskCheckboxWidget(node.from, checked, forwarded)
            })
          })
          return
        }

        // Only hide URL nodes that are link targets — preceded by `(`
        if (isUrl) {
          const prevChar = state.doc.sliceString(node.from - 1, node.from)
          if (prevChar !== '(') return // autolink or label URL → keep visible
          // A URL that follows `(` but hangs off the paragraph rather than the
          // `Link`/`Image` is an autolink, not a destination: either a
          // half-typed target (`[a](https://…` before the `)`) or a
          // parenthesised bare URL (`(https://…)`). Hiding it made the pasted
          // URL vanish while the link was still being written. (#471)
          const urlParent = node.node.parent?.name
          if (urlParent !== 'Link' && urlParent !== 'Image') return
        }

        if (!isPrefix && !isSimple && !isUrl) return

        // Don't hide fenced code block delimiters (```) or language tags —
        // only hide inline code backticks. Hiding fence markers collapses
        // the entire code block.
        if ((name === 'CodeMark' || name === 'CodeInfo') &&
            node.node.parent?.name === 'FencedCode') return

        // The `:` in a reference-link definition (`[label]: url`) parses as a
        // LinkMark whose parent is LinkReference. Keep it visible — hiding it
        // makes the definition read as a broken `[label] url`. (#188)
        if (name === 'LinkMark' && node.node.parent?.name === 'LinkReference') return

        const line = state.doc.lineAt(node.from).number
        if (replacedLines.has(line)) return
        if (isLinkSyntax) {
          const linkRange = enclosingLinkRange(node)
          // A spaced destination (`[text](My Note.md)`) is rejected by the
          // parser, so the `(target)` trails outside the Link node as plain
          // text. Treat the full `[label](target)` as the link: reveal it as
          // one unit and hide the trailing target with the brackets. (#617)
          const tailEnd = linkRange ? terminatedLinkTailEnd(state, linkRange.to) : null
          if (linkRange && selectionTouchesRange(state, linkRange.from, tailEnd ?? linkRange.to))
            return
          // `[label](` with no closing `)` yet isn't a link, so keep its
          // brackets visible: the label reads as source while the target is
          // typed or pasted, and collapses once the syntax is complete. (#471)
          if (linkRange && hasUnterminatedLinkTarget(state, linkRange.to)) return
          if (
            linkRange &&
            tailEnd !== null &&
            node.to === linkRange.to &&
            state.doc.sliceString(node.to - 1, node.to) === ']'
          ) {
            pending.push({ from: linkRange.to, to: tailEnd, deco: hide })
          }
        } else if (activeLines.has(line)) {
          // Reveal every marker on the active line, headings included: the
          // cursor anywhere in a heading shows its `##` prefix, matching the
          // list/quote/task markers and the other markdown elements (a heading
          // used to reveal only when the selection touched the marker itself,
          // which read as "works differently from everything else").
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
          state.assetFiles !== prev.assetFiles ||
          // Notes list arriving late lets Excalidraw embed targets resolve
          // to a vault-relative path; and a bumped version means a drawing
          // was edited elsewhere and the cached preview must refresh.
          state.notes !== prev.notes ||
          state.excalidrawPreviewVersion !== prev.excalidrawPreviewVersion
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
