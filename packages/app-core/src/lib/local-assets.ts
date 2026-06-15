import { useStore } from '../store'
import type { AssetMeta } from '@shared/ipc'

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

const ASSET_REF_RE = /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export function assetIdFromHref(href: string): string | null {
  const match = href.trim().match(ASSET_REF_RE)
  return match?.[1] ?? null
}

function assetPathBasename(value: string | null | undefined): string {
  return value?.split('/').filter(Boolean).pop()?.toLowerCase() ?? ''
}

export function assetSourcePath(asset: AssetMeta): string {
  return asset.sourcePath || asset.path
}

function assetForId(id: string): AssetMeta | null {
  const bundlePath = `assets/${id}.asset`
  return (
    useStore
      .getState()
      .assetFiles.find(
        (asset) =>
          asset.id === id ||
          asset.path === bundlePath ||
          asset.path?.startsWith(`${bundlePath}/`) ||
          asset.bundlePath === bundlePath ||
          asset.sourcePath?.startsWith(`${bundlePath}/`)
      ) ?? null
  )
}

function assetForHref(href: string): AssetMeta | null {
  const id = assetIdFromHref(href)
  return id ? assetForId(id) : null
}

function assetUrlForVaultRelativePath(vaultRoot: string, relPath: string): string | null {
  const asset = useStore.getState().assetFiles.find((item) => item.path === relPath)
  return window.zen.resolveVaultAssetUrl(vaultRoot, asset ? assetSourcePath(asset) : relPath)
}

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
  const asset = assetForHref(href)
  if (asset) return asset.kind
  if (assetIdFromHref(href)) return 'file'
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
  const trimmed = href.trim()
  const resolvedRel = resolveAssetVaultRelativePath(vaultRoot, notePath, href)
  if (resolvedRel) {
    return assetUrlForVaultRelativePath(vaultRoot, resolvedRel)
  }
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('//') ||
    assetIdFromHref(trimmed) ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
  ) {
    return null
  }
  // If the asset list hasn't arrived yet (cold start, before
  // `listAssets` resolves), skip producing a URL rather than baking in
  // the notedir-relative fallback. The cm-live-preview plugin
  // re-decorates as soon as `assetFiles` populates and the basename
  // search will then run with real data. This stops the wrong URL from
  // being cached by the widget on the first paint.
  if (useStore.getState().assetFiles.length === 0) return null
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
  const assetRef = assetForHref(trimmed)
  if (assetRef) return assetRef.path
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
  const exact = assets.find((asset) => asset.path === target || asset.sourcePath === target)
  if (exact) return exact.path

  const targetBase = target.split('/').filter(Boolean).pop()?.toLowerCase()
  if (!targetBase) return null

  const basenameMatches = assets.filter((asset) => {
    return (
      asset.name.toLowerCase() === targetBase ||
      assetPathBasename(asset.sourcePath) === targetBase ||
      assetPathBasename(asset.path) === targetBase
    )
  })
  if (basenameMatches.length === 1) {
    return basenameMatches[0]!.path
  }

  return null
}

function localAssetLabel(href: string, fallback: string): string {
  const asset = assetForHref(href)
  if (asset) return asset.name
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
  onRequestEdit?: (() => void) | null,
  onOpenAsset?: (() => void) | null
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
    if (onOpenAsset) {
      onOpenAsset()
    }
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
  href: string,
  onOpenAsset?: (() => void) | null
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

  const open = onOpenAsset
    ? document.createElement('button')
    : document.createElement('a')
  open.className = 'local-asset-embed-open'
  open.dataset.localAssetUrl = url
  open.dataset.localAssetHref = href
  open.textContent = 'Open'
  if (onOpenAsset) {
    open.type = 'button'
    open.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onOpenAsset()
    })
  } else {
    const link = open as HTMLAnchorElement
    link.href = url
    link.target = '_blank'
    link.rel = 'noreferrer'
  }

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

function buildVideoEmbed(
  url: string,
  label: string,
  href: string,
  onOpenAsset?: (() => void) | null,
  posterUrl?: string | null
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-video-embed not-prose'
  figure.dataset.localAssetUrl = url
  figure.dataset.localAssetKind = 'video'
  figure.dataset.localAssetHref = href

  const frame = document.createElement('div')
  frame.className = 'local-video-embed-frame'

  const video = document.createElement('video')
  video.className = 'local-video-embed-video'
  video.src = url
  video.controls = true
  video.preload = 'metadata'
  if (posterUrl) video.poster = posterUrl
  video.addEventListener('loadedmetadata', () => {
    figure.classList.toggle('is-portrait', video.videoHeight > video.videoWidth)
  })
  frame.append(video)

  if (onOpenAsset) {
    const controlsTop = document.createElement('div')
    controlsTop.className = 'local-image-embed-controls local-image-embed-controls-top'
    const openButton = buildImageAction('Open video', 'open')
    openButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onOpenAsset()
    })
    controlsTop.append(openButton)
    frame.append(controlsTop)
  }

  const caption = document.createElement('figcaption')
  caption.className = 'local-video-embed-caption'
  caption.textContent = label || localAssetLabel(href, 'Video')

  figure.append(frame, caption)
  return figure
}

function buildPdfBookEmbed(
  url: string,
  label: string,
  href: string,
  onOpenAsset?: (() => void) | null,
  previewUrl?: string | null
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-pdf-book-embed not-prose'
  figure.dataset.localAssetUrl = url
  figure.dataset.localAssetKind = 'pdf'
  figure.dataset.localAssetHref = href

  const shell = document.createElement('div')
  shell.className = 'local-pdf-book-shell'

  const cover = document.createElement('button')
  cover.type = 'button'
  cover.className = 'local-pdf-book-cover'
  cover.title = 'Open PDF'
  if (onOpenAsset) {
    cover.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onOpenAsset()
    })
  }

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

  const caption = document.createElement('figcaption')
  caption.className = 'local-pdf-book-caption'
  caption.textContent = label || localAssetLabel(href, 'PDF')

  shell.append(cover)
  figure.append(shell, caption)
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

type LocalAssetAnchorInfo = {
  anchor: HTMLAnchorElement
  raw: string
  resolved: string
  asset: AssetMeta | null
  assetVaultRel: string | null
  kind: LocalAssetKind
  label: string
}

function paragraphHasOnlyLocalAssetAnchors(paragraph: HTMLParagraphElement): boolean {
  if (!paragraph.querySelector('a[href], a[data-wikilink]')) return false
  for (const node of Array.from(paragraph.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? '').trim()) return false
      continue
    }
    if (node.nodeName === 'BR') continue
    if (node.nodeName === 'A') continue
    return false
  }
  return true
}

function assetHrefFromAnchor(anchor: HTMLAnchorElement): string {
  const wikilinkTarget = anchor.dataset.wikilink?.trim() ?? ''
  if (assetIdFromHref(wikilinkTarget)) return wikilinkTarget
  return anchor.dataset.localAssetHref || anchor.getAttribute('href') || ''
}

function removeAdjacentAssetLineBreaks(embed: HTMLElement): void {
  const removeIgnorable = (node: ChildNode | null, direction: 'previous' | 'next'): void => {
    let current = node
    while (
      current &&
      (current.nodeName === 'BR' ||
        (current.nodeType === Node.TEXT_NODE && !(current.textContent ?? '').trim()))
    ) {
      const next = direction === 'previous' ? current.previousSibling : current.nextSibling
      current.remove()
      current = next
    }
  }

  removeIgnorable(embed.previousSibling, 'previous')
  removeIgnorable(embed.nextSibling, 'next')
}

function hoistAssetEmbedsFromTaskLists(root: HTMLElement): void {
  root.querySelectorAll<HTMLOListElement | HTMLUListElement>('ol, ul').forEach((list) => {
    const embeds = Array.from(
      list.querySelectorAll<HTMLElement>('li.task-list-item figure[data-local-asset-kind]')
    ).filter((figure) => figure.closest('ol, ul') === list)
    if (embeds.length === 0) return
    list.dataset.localAssetHoistSource = 'true'
    embeds.forEach((embed) => {
      removeAdjacentAssetLineBreaks(embed)
      embed.dataset.localAssetHoisted = 'true'
    })
    list.after(...embeds)
  })
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
    onOpenAsset?: ((assetPath: string) => void) | null
  }
): void {
  const {
    vaultRoot,
    notePath,
    onRequestEdit,
    pinnedAssetPath,
    onActivatePinnedRef,
    onOpenAsset
  } = options
  if (!vaultRoot || !notePath) return

  const localAssetAnchorInfo = (anchor: HTMLAnchorElement): LocalAssetAnchorInfo | null => {
    if (anchor.classList.contains('hashtag')) return null
    const raw = assetHrefFromAnchor(anchor)
    if (anchor.classList.contains('wikilink') && !assetIdFromHref(raw)) return null
    const resolved = resolveLocalAssetUrl(vaultRoot, notePath, raw)
    if (!resolved) return null
    const assetVaultRel = resolveAssetVaultRelativePath(vaultRoot, notePath, raw)
    const asset = assetVaultRel
      ? useStore.getState().assetFiles.find((entry) => entry.path === assetVaultRel) ?? null
      : assetForHref(raw)
    const kind = classifyLocalAssetHref(raw) ?? 'file'
    const label = localAssetLabel(raw, anchor.textContent?.trim() || 'Asset')

    anchor.href = resolved
    anchor.dataset.localAssetUrl = resolved
    anchor.dataset.localAssetKind = kind
    anchor.dataset.localAssetHref = raw
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'
    if (assetVaultRel && onOpenAsset && anchor.dataset.localAssetClick !== 'open-asset') {
      anchor.dataset.localAssetClick = 'open-asset'
      anchor.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onOpenAsset(assetVaultRel)
      })
    }

    return { anchor, raw, resolved, asset, assetVaultRel, kind, label }
  }

  const buildAnchorEmbed = (info: LocalAssetAnchorInfo): HTMLElement | null => {
    if (info.kind === 'file') return null
    if (info.kind === 'image') {
      const img = document.createElement('img')
      img.src = info.resolved
      img.alt = info.label
      img.loading = 'lazy'
      img.dataset.localAssetUrl = info.resolved
      img.dataset.localAssetHref = info.raw
      return buildImageEmbed(
        img,
        info.raw,
        info.resolved,
        onRequestEdit,
        info.assetVaultRel && onOpenAsset ? () => onOpenAsset(info.assetVaultRel!) : null
      )
    }
    if (info.kind === 'pdf' && pinnedAssetPath && info.assetVaultRel === pinnedAssetPath) {
      return buildPinnedRefPlaceholder(info.resolved, info.raw, info.label, () => {
        onActivatePinnedRef?.()
      })
    }
    if (info.kind === 'pdf') {
      const previewUrl =
        info.asset?.previewPath ? window.zen.resolveVaultAssetUrl(vaultRoot, info.asset.previewPath) : null
      return buildPdfBookEmbed(
        info.resolved,
        info.label,
        info.raw,
        info.assetVaultRel && onOpenAsset ? () => onOpenAsset(info.assetVaultRel!) : null,
        previewUrl
      )
    }
    if (info.kind === 'video') {
      const posterUrl =
        info.asset?.previewPath ? window.zen.resolveVaultAssetUrl(vaultRoot, info.asset.previewPath) : null
      return buildVideoEmbed(
        info.resolved,
        info.label,
        info.raw,
        info.assetVaultRel && onOpenAsset ? () => onOpenAsset(info.assetVaultRel!) : null,
        posterUrl
      )
    }
    return buildEmbed(
      info.kind,
      info.resolved,
      info.label,
      info.raw,
      info.assetVaultRel && onOpenAsset ? () => onOpenAsset(info.assetVaultRel!) : null
    )
  }

  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
    const raw = img.getAttribute('src') || ''
    const resolved = resolveLocalAssetUrl(vaultRoot, notePath, raw)
    if (!resolved) return
    const assetVaultRel = resolveAssetVaultRelativePath(vaultRoot, notePath, raw)
    img.src = resolved
    img.loading = 'lazy'
    img.dataset.localAssetUrl = resolved
    img.dataset.localAssetHref = raw
    const paragraph = isStandaloneImageParagraph(img)
    if (!paragraph || paragraph.dataset.assetEmbed === 'true') return
    paragraph.dataset.assetEmbed = 'true'
    paragraph.replaceWith(
      buildImageEmbed(
        img,
        raw,
        resolved,
        onRequestEdit,
        assetVaultRel && onOpenAsset ? () => onOpenAsset(assetVaultRel) : null
      )
    )
  })

  root.querySelectorAll<HTMLAnchorElement>('a[href], a[data-wikilink]').forEach((anchor) => {
    if (!root.contains(anchor)) return
    const info = localAssetAnchorInfo(anchor)
    if (!info) return

    const parentParagraph = anchor.parentElement as HTMLParagraphElement | null
    if (
      parentParagraph?.tagName === 'P' &&
      parentParagraph.dataset.assetEmbed !== 'true' &&
      paragraphHasOnlyLocalAssetAnchors(parentParagraph)
    ) {
      const embeds: HTMLElement[] = []
      for (const item of Array.from(
        parentParagraph.querySelectorAll<HTMLAnchorElement>('a[href], a[data-wikilink]')
      )) {
        const itemInfo = localAssetAnchorInfo(item)
        const embed = itemInfo ? buildAnchorEmbed(itemInfo) : null
        if (!embed) {
          embeds.length = 0
          break
        }
        embeds.push(embed)
      }
      if (embeds.length > 0) {
        parentParagraph.dataset.assetEmbed = 'true'
        parentParagraph.replaceWith(...embeds)
        return
      }
    }

    const embed = buildAnchorEmbed(info)
    if (!embed) return
    const paragraph = isStandaloneAnchorParagraph(anchor)
    if (paragraph && paragraph.dataset.assetEmbed !== 'true') {
      paragraph.dataset.assetEmbed = 'true'
      paragraph.replaceWith(embed)
      return
    }
    if (anchor.parentElement?.tagName === 'P') return
    anchor.replaceWith(embed)
  })

  hoistAssetEmbedsFromTaskLists(root)
}
