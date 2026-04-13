const IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp'
])
const PDF_EXTENSIONS = new Set(['.pdf'])
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'])
const VIDEO_EXTENSIONS = new Set(['.m4v', '.mov', '.mp4', '.ogv', '.webm'])

export type LocalAssetKind = 'image' | 'pdf' | 'audio' | 'video' | 'file'

function assetExtension(href: string): string {
  const clean = href.split('#')[0]?.split('?')[0] ?? href
  const lastDot = clean.lastIndexOf('.')
  return lastDot === -1 ? '' : clean.slice(lastDot).toLowerCase()
}

export function classifyLocalAssetHref(href: string): LocalAssetKind | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) return null
  const ext = assetExtension(href)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'file'
}

export function resolveLocalAssetUrl(
  vaultRoot: string | null | undefined,
  notePath: string | null | undefined,
  href: string
): string | null {
  if (!vaultRoot || !notePath) return null
  return window.zen.resolveLocalAssetUrl(vaultRoot, notePath, href)
}

function localAssetLabel(href: string, fallback: string): string {
  const clean = href.split('#')[0]?.split('?')[0] ?? href
  const parts = clean.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? fallback
}

function imageCaptionLabel(img: HTMLImageElement, href: string): string {
  const alt = img.getAttribute('alt')?.trim()
  if (alt) return alt
  return localAssetLabel(href, 'Image')
}

function isStandaloneAnchorParagraph(anchor: HTMLAnchorElement): HTMLParagraphElement | null {
  const paragraph = anchor.parentElement as HTMLParagraphElement | null
  if (!paragraph || paragraph.tagName !== 'P') return null
  const otherAnchors = paragraph.querySelectorAll('a')
  if (otherAnchors.length !== 1 || otherAnchors[0] !== anchor) return null
  const text = paragraph.textContent?.trim() ?? ''
  const anchorText = anchor.textContent?.trim() ?? ''
  return text === anchorText ? paragraph : null
}

function isStandaloneImageParagraph(img: HTMLImageElement): HTMLParagraphElement | null {
  const paragraph = img.parentElement as HTMLParagraphElement | null
  if (!paragraph || paragraph.tagName !== 'P') return null
  const images = paragraph.querySelectorAll('img')
  if (images.length !== 1 || images[0] !== img) return null
  const text = paragraph.textContent?.trim() ?? ''
  return text === '' ? paragraph : null
}

function buildImageAction(label: string, variant: 'edit' | 'open'): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `local-image-embed-action local-image-embed-action-${variant}`
  button.setAttribute('aria-label', label)
  button.title = label
  button.textContent = variant === 'edit' ? '</>' : '+'
  return button
}

function buildImageEmbed(
  img: HTMLImageElement,
  rawHref: string,
  resolvedUrl: string,
  onRequestEdit?: (() => void) | null
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-image-embed not-prose'

  const frame = document.createElement('div')
  frame.className = 'local-image-embed-frame'

  const controlsTop = document.createElement('div')
  controlsTop.className = 'local-image-embed-controls local-image-embed-controls-top'

  if (onRequestEdit) {
    const editButton = buildImageAction('Edit this block', 'edit')
    editButton.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onRequestEdit()
    })
    controlsTop.append(editButton)
  }

  const controlsBottom = document.createElement('div')
  controlsBottom.className = 'local-image-embed-controls local-image-embed-controls-bottom'
  const openButton = buildImageAction('Open image', 'open')
  openButton.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    window.open(resolvedUrl, '_blank')
  })
  controlsBottom.append(openButton)

  img.classList.add('local-image-embed-image')
  img.dataset.localAssetUrl = resolvedUrl
  frame.append(img, controlsTop, controlsBottom)

  const caption = document.createElement('figcaption')
  caption.className = 'local-image-embed-caption'
  caption.textContent = imageCaptionLabel(img, rawHref)

  figure.append(frame, caption)
  return figure
}

function buildEmbed(
  kind: Exclude<LocalAssetKind, 'image' | 'file'>,
  url: string,
  label: string
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-asset-embed not-prose'

  const header = document.createElement('div')
  header.className = 'local-asset-embed-header'

  const title = document.createElement('div')
  title.className = 'local-asset-embed-title'
  title.textContent = label

  const open = document.createElement('a')
  open.className = 'local-asset-embed-open'
  open.href = url
  open.dataset.localAssetUrl = url
  open.target = '_blank'
  open.rel = 'noreferrer'
  open.textContent = 'Open'

  header.append(title, open)
  figure.append(header)

  if (kind === 'pdf') {
    const frame = document.createElement('iframe')
    frame.className = 'local-asset-embed-frame'
    frame.src = url
    frame.title = label
    figure.append(frame)
    return figure
  }

  if (kind === 'audio') {
    const audio = document.createElement('audio')
    audio.className = 'local-asset-embed-audio'
    audio.src = url
    audio.controls = true
    audio.preload = 'metadata'
    figure.append(audio)
    return figure
  }

  const video = document.createElement('video')
  video.className = 'local-asset-embed-video'
  video.src = url
  video.controls = true
  video.preload = 'metadata'
  figure.append(video)
  return figure
}

export function enhanceLocalAssetNodes(
  root: HTMLElement,
  options: {
    vaultRoot: string | null | undefined
    notePath: string | null | undefined
    onRequestEdit?: (() => void) | null
  }
): void {
  const { vaultRoot, notePath, onRequestEdit } = options
  if (!vaultRoot || !notePath) return

  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
    const raw = img.getAttribute('src') || ''
    const resolved = resolveLocalAssetUrl(vaultRoot, notePath, raw)
    if (!resolved) return
    img.src = resolved
    img.loading = 'lazy'
    img.dataset.localAssetUrl = resolved
    const paragraph = isStandaloneImageParagraph(img)
    if (!paragraph || paragraph.dataset.assetEmbed === 'true') return
    paragraph.dataset.assetEmbed = 'true'
    paragraph.replaceWith(buildImageEmbed(img, raw, resolved, onRequestEdit))
  })

  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    if (anchor.classList.contains('wikilink') || anchor.classList.contains('hashtag')) return
    const raw = anchor.getAttribute('href') || ''
    const resolved = resolveLocalAssetUrl(vaultRoot, notePath, raw)
    if (!resolved) return

    const kind = classifyLocalAssetHref(raw) ?? 'file'
    anchor.href = resolved
    anchor.dataset.localAssetUrl = resolved
    anchor.dataset.localAssetKind = kind
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'

    if (kind === 'file' || kind === 'image') return

    const paragraph = isStandaloneAnchorParagraph(anchor)
    if (!paragraph || paragraph.dataset.assetEmbed === 'true') return
    paragraph.dataset.assetEmbed = 'true'
    paragraph.replaceWith(buildEmbed(kind, resolved, localAssetLabel(raw, anchor.textContent?.trim() || 'Asset')))
  })
}
