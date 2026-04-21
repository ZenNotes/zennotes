import { useStore } from '../store'

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

function stripQueryAndHash(href: string): string {
  return href.split('#')[0]?.split('?')[0] ?? href
}

function decodeHrefPath(value: string): string {
  const cleaned = stripQueryAndHash(value)
  try {
    return decodeURIComponent(cleaned)
  } catch {
    return cleaned
  }
}

function posixJoin(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  if (a.endsWith('/')) return `${a}${b}`
  return `${a}/${b}`
}

function posixNormalize(input: string): string {
  const parts = input.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return '..'
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

function assetExtension(href: string): string {
  const clean = stripQueryAndHash(href)
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
  const resolvedRel = resolveAssetVaultRelativePath(vaultRoot, notePath, href)
  if (resolvedRel) {
    return window.zen.resolveVaultAssetUrl(vaultRoot, resolvedRel)
  }
  return window.zen.resolveLocalAssetUrl(vaultRoot, notePath, href)
}

/**
 * Same input as `resolveLocalAssetUrl` but returns a POSIX vault-
 * relative path instead of a `zen-asset://` URL. Useful when we need
 * to feed the asset into our own state (e.g. `pinAssetReference`).
 * Returns null when the asset is outside the vault.
 */
export function resolveAssetVaultRelativePath(
  vaultRoot: string | null | undefined,
  notePath: string | null | undefined,
  href: string
): string | null {
  if (!vaultRoot || !notePath) return null
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null

  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  const decodedHref = decodeHrefPath(trimmed)
  let target = decodedHref.startsWith('/')
    ? decodedHref.replace(/^\/+/, '')
    : noteDir
      ? posixJoin(noteDir, decodedHref)
      : decodedHref
  target = posixNormalize(target)
  if (target.startsWith('../') || target === '..') return null

  const assets = useStore.getState().assetFiles
  if (assets.some((asset) => asset.path === target)) return target

  const targetBase = target.split('/').filter(Boolean).pop()?.toLowerCase()
  if (!targetBase) return null

  const basenameMatches = assets.filter((asset) => {
    const assetBase = asset.path.split('/').filter(Boolean).pop()?.toLowerCase()
    return assetBase === targetBase
  })
  if (basenameMatches.length === 1) {
    return basenameMatches[0]!.path
  }

  return null
}

function localAssetLabel(href: string, fallback: string): string {
  const clean = href.split('#')[0]?.split('?')[0] ?? href
  const parts = clean.split('/').filter(Boolean)
  const last = parts[parts.length - 1]
  if (!last) return fallback
  // Markdown encodes spaces (and other special chars) in the URL via
  // %20 etc. — decode so the visible label reads like a real filename.
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
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
  label: string,
  href: string
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-asset-embed not-prose'
  // Tag the figure so right-click handlers can identify the asset
  // without traversing into the iframe / audio / video child.
  figure.dataset.localAssetUrl = url
  figure.dataset.localAssetKind = kind
  figure.dataset.localAssetHref = href

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

/**
 * Build a compact "showing in reference pane" placeholder used when an
 * embedded PDF in the note is the same one the user has pinned in the
 * side reference pane — no point repeating the iframe, but we want a
 * visual breadcrumb so the user knows it's there.
 */
function buildPinnedRefPlaceholder(
  url: string,
  href: string,
  label: string,
  onActivate: () => void
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-asset-embed local-asset-pinned-ref not-prose'
  figure.dataset.localAssetUrl = url
  figure.dataset.localAssetKind = 'pdf'
  figure.dataset.localAssetHref = href

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'local-asset-pinned-ref-button'
  button.title = 'Showing in the reference pane — click to focus'
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onActivate()
  })

  const icon = document.createElement('span')
  icon.className = 'local-asset-pinned-ref-icon'
  icon.textContent = '↗'

  const text = document.createElement('span')
  text.className = 'local-asset-pinned-ref-text'
  text.textContent = label

  const badge = document.createElement('span')
  badge.className = 'local-asset-pinned-ref-badge'
  badge.textContent = 'in reference pane'

  button.append(icon, text, badge)
  figure.append(button)
  return figure
}

export function enhanceLocalAssetNodes(
  root: HTMLElement,
  options: {
    vaultRoot: string | null | undefined
    notePath: string | null | undefined
    onRequestEdit?: (() => void) | null
    /** When set, PDF embeds matching this vault-relative path are
     *  collapsed to a compact placeholder instead of a full iframe. */
    pinnedAssetPath?: string | null
    onActivatePinnedRef?: (() => void) | null
  }
): void {
  const { vaultRoot, notePath, onRequestEdit, pinnedAssetPath, onActivatePinnedRef } = options
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
    const label = localAssetLabel(raw, anchor.textContent?.trim() || 'Asset')
    if (kind === 'pdf' && pinnedAssetPath) {
      const assetVaultRel = resolveAssetVaultRelativePath(vaultRoot, notePath, raw)
      if (assetVaultRel === pinnedAssetPath) {
        paragraph.replaceWith(
          buildPinnedRefPlaceholder(resolved, raw, label, () => {
            onActivatePinnedRef?.()
          })
        )
        return
      }
    }
    paragraph.replaceWith(buildEmbed(kind, resolved, label, raw))
  })
}
