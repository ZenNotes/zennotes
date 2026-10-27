import { useStore } from '../store'
import { externalLinkUrl } from './internal-links'
import { openVaultAssetExternally } from './external-file-link'
import { canShowPdfInline } from './pdf-inline'
import { isExcalidrawPath, isObsidianExcalidrawPath } from '@shared/excalidraw'
import {
  decodeHrefPath,
  resolveAssetPathAmong,
  stripQueryAndHash,
  type AssetPathRef
} from './asset-path-resolution'
import type { PreviewEditRequest } from './preview-outline-jump'

type RequestEdit = (request?: PreviewEditRequest | null) => void

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

export type LocalAssetKind = 'image' | 'pdf' | 'audio' | 'video' | 'excalidraw' | 'file'

export function hrefFragment(href: string): string {
  const hashIdx = href.indexOf('#')
  return hashIdx >= 0 ? href.slice(hashIdx) : ''
}

function assetExtension(href: string): string {
  const clean = stripQueryAndHash(href)
  const lastDot = clean.lastIndexOf('.')
  return lastDot === -1 ? '' : clean.slice(lastDot).toLowerCase()
}

export function classifyLocalAssetHref(href: string): LocalAssetKind | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) return null
  if (isExcalidrawPath(href) || isObsidianExcalidrawPath(href)) return 'excalidraw'
  const ext = assetExtension(href)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'file'
}

/** Where an embed's href leads, as `resolveLocalAsset` finds it. */
export interface LocalAsset {
  url: string
  /** Vault-relative path of the listed file the href names; null when no
   *  listed file answers it and `url` is the guess beside the note. */
  path: string | null
  /** No file in the vault's own listing carries the name the href points
   *  at, so this device does not have it. An embed of it says so instead of
   *  drawing a player, picture or document with nothing to load. */
  missing: boolean
}

export function resolveLocalAsset(
  vaultRoot: string | null | undefined,
  notePath: string | null | undefined,
  href: string
): LocalAsset | null {
  if (!vaultRoot || !notePath) return null
  const { assetFiles, assetFilesListed } = useStore.getState()
  const path = resolveAssetPathAmong(assetFiles, notePath, href)
  if (path) {
    const url = window.zen.resolveVaultAssetUrl(vaultRoot, path)
    return url ? { url, path, missing: false } : null
  }
  // If the asset list hasn't arrived yet (cold start, before
  // `listAssets` resolves), skip producing a URL rather than baking in
  // the notedir-relative fallback. The cm-live-preview plugin
  // re-decorates as soon as `assetFiles` populates and the basename
  // search will then run with real data. This stops the wrong URL from
  // being cached by the widget on the first paint, and stops every embed
  // from reading as missing until then.
  if (assetFiles.length === 0 && !assetFilesListed) return null
  const url = window.zen.resolveLocalAssetUrl(vaultRoot, notePath, href)
  if (!url) return null
  // A list seeded by hand (the share viewer's, PDF export's) never says a
  // file is missing: the share viewer serves the files its list leaves out
  // from this very URL.
  return { url, path: null, missing: assetFilesListed && !listsFileNamed(assetFiles, href) }
}

// A name two listed files share is a link that cannot choose between them,
// not a file this device lacks; it keeps the guessed URL it always had.
function listsFileNamed(assetFiles: ReadonlyArray<AssetPathRef>, href: string): boolean {
  const name = decodeHrefPath(href.trim()).split('/').filter(Boolean).pop()?.toLowerCase()
  if (!name) return false
  return assetFiles.some(
    (asset) => asset.path.slice(asset.path.lastIndexOf('/') + 1).toLowerCase() === name
  )
}

export function resolveLocalAssetUrl(
  vaultRoot: string | null | undefined,
  notePath: string | null | undefined,
  href: string
): string | null {
  return resolveLocalAsset(vaultRoot, notePath, href)?.url ?? null
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
  return resolveAssetPathAmong(useStore.getState().assetFiles, notePath, href)
}

export function localAssetLabel(href: string, fallback: string): string {
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
  sourceLine: number | null,
  onRequestEdit?: RequestEdit | null,
  onOpenAsset?: (() => void) | null
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-image-embed not-prose'
  // Tag the host the way PDF / audio / video embeds and attachment chips are,
  // so the reading view's right-click asset menu (Open, Rename…, Move…,
  // Reveal, Delete…) finds an image too. Only the `<img>` carried the URL
  // before, and the menu handler looks for kind + url on one host, so images
  // were the one embed with no menu.
  figure.dataset.localAssetUrl = resolvedUrl
  figure.dataset.localAssetKind = 'image'
  figure.dataset.localAssetHref = rawHref
  // The figure stands in for the stamped paragraph it replaces, so the
  // split scroll sync and the reading position carried into Edit still see
  // this block's source line. (#822)
  if (sourceLine != null) figure.dataset.sourceLine = String(sourceLine)

  const frame = document.createElement('div')
  frame.className = 'local-image-embed-frame'

  const controlsTop = document.createElement('div')
  controlsTop.className = 'local-image-embed-controls local-image-embed-controls-top'

  if (onRequestEdit) {
    const editButton = buildImageAction('Edit this block', 'edit')
    editButton.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onRequestEdit({ sourceLine, blockClientTop: figure.getBoundingClientRect().top })
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
  // A |WxH size hint arrives as width/height attributes (#570). The embed
  // class stretches images to the pane width, and presentational attributes
  // lose to any CSS rule, so a hinted size must win through inline style.
  const hintWidth = Number(img.getAttribute('width')) || 0
  const hintHeight = Number(img.getAttribute('height')) || 0
  if (hintWidth > 0) img.style.width = `${hintWidth}px`
  if (hintHeight > 0) img.style.height = `${hintHeight}px`
  frame.append(img, controlsTop, controlsBottom)

  const caption = document.createElement('figcaption')
  caption.className = 'local-image-embed-caption'
  caption.textContent = imageCaptionLabel(img, rawHref)

  figure.append(frame, caption)
  return figure
}

function buildEmbedEditButton(onEdit: () => void): HTMLButtonElement {
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'local-asset-embed-edit'
  edit.textContent = '</>'
  edit.title = 'Edit this block'
  edit.setAttribute('aria-label', 'Edit this block')
  edit.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onEdit()
  })
  return edit
}

/**
 * The PDF, audio and video embed of the reading view. The editor's live
 * preview draws a standalone audio or video line with this same builder, so
 * the two surfaces show one player; it passes `onEdit` for the `</>` action
 * that the editor's image and PDF blocks carry too.
 */
export function buildEmbed(
  kind: Exclude<LocalAssetKind, 'image' | 'file' | 'excalidraw'>,
  url: string,
  label: string,
  href: string,
  onOpenAsset?: (() => void) | null,
  onEdit?: (() => void) | null
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
  if (onEdit) header.append(buildEmbedEditButton(onEdit))
  figure.append(header)

  if (kind === 'pdf') {
    const frame = document.createElement('iframe')
    frame.className = 'local-asset-embed-frame'
    frame.src = url + hrefFragment(href)
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

// Paperclip — denotes a non-previewable attachment. Static markup (no user
// input), so `innerHTML` is safe here.
const ATTACHMENT_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>'

/**
 * A compact chip that denotes a non-previewable attachment (`.tldraw`, `.zip`,
 * unknown types) embedded with image syntax `![](file.ext)`. Reused by both the
 * reading preview and the editor's live-preview widget so the two match. When
 * `onOpen` is given the chip is a button that runs it; otherwise it's a plain
 * link to the resolved asset URL. (#463)
 */
export function buildAttachmentChip(
  resolvedUrl: string,
  rawHref: string,
  label: string,
  onOpen?: (() => void) | null
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-file-attachment not-prose'
  figure.dataset.localAssetUrl = resolvedUrl
  figure.dataset.localAssetKind = 'file'
  figure.dataset.localAssetHref = rawHref

  const action = onOpen ? document.createElement('button') : document.createElement('a')
  action.className = 'local-file-attachment-button'
  if (onOpen) {
    ;(action as HTMLButtonElement).type = 'button'
    action.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onOpen()
    })
  } else {
    const link = action as HTMLAnchorElement
    link.href = resolvedUrl
    link.target = '_blank'
    link.rel = 'noreferrer'
  }

  const icon = document.createElement('span')
  icon.className = 'local-file-attachment-icon'
  icon.innerHTML = ATTACHMENT_ICON_SVG

  const name = document.createElement('span')
  name.className = 'local-file-attachment-name'
  name.textContent = label

  const openHint = document.createElement('span')
  openHint.className = 'local-file-attachment-open'
  openHint.setAttribute('aria-hidden', 'true')
  openHint.textContent = '↗'

  action.append(icon, name, openHint)
  figure.append(action)
  return figure
}

const PDF_IN_REFERENCE_PANE = {
  title: 'Showing in the reference pane (click to focus)',
  badge: 'in reference pane'
}

const PDF_OPEN_ELSEWHERE = { title: 'Open this PDF in another app', badge: 'open' }

/**
 * Build a compact "showing in reference pane" placeholder used when an
 * embedded PDF in the note is the same one the user has pinned in the
 * side reference pane — no point repeating the iframe, but we want a
 * visual breadcrumb so the user knows it's there.
 *
 * The same card stands in for the whole embed where the engine cannot draw a
 * PDF at all (`canShowPdfInline`), with `PDF_OPEN_ELSEWHERE`'s words and an
 * action that hands the file to another app.
 */
function buildPinnedRefPlaceholder(
  url: string,
  href: string,
  label: string,
  onActivate: () => void,
  words: { title: string; badge: string } = PDF_IN_REFERENCE_PANE
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-asset-embed local-asset-pinned-ref not-prose'
  figure.dataset.localAssetUrl = url
  figure.dataset.localAssetKind = 'pdf'
  figure.dataset.localAssetHref = href

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'local-asset-pinned-ref-button'
  button.title = words.title
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
  badge.textContent = words.badge

  button.append(icon, text, badge)
  figure.append(button)
  return figure
}

const CLOUD_SYNC_NOTICE_CLASS = 'local-asset-cloud-notice'

/**
 * Puts the line under an embed that says Cloud sync keeps its file on this
 * device, or takes it away again (`text` null). The editor's widgets call it
 * again when only that line changed, so a video playing above it keeps
 * playing while the notice comes and goes.
 */
export function setCloudSyncNotice(host: HTMLElement, text: string | null): void {
  let notice: HTMLElement | null = null
  for (const child of Array.from(host.children)) {
    if (child instanceof HTMLElement && child.classList.contains(CLOUD_SYNC_NOTICE_CLASS)) {
      notice = child
      break
    }
  }
  if (!text) {
    notice?.remove()
    return
  }
  if (!notice) {
    notice = document.createElement('div')
    notice.className = 'local-asset-cloud-notice whitespace-normal break-words text-xs text-warning'
    notice.setAttribute('role', 'note')
    notice.dataset.cloudSyncNotice = ''
    host.append(notice)
  }
  if (notice.textContent !== text) notice.textContent = text
}

/** The embeds that say so when their file is not on this device. Any other
 *  attachment keeps its chip: the vault listing leaves out files a chip can
 *  still name (notes, drawings, dotfiles), so it cannot vouch for those. */
export type MissingAssetKind = 'image' | 'pdf' | 'audio' | 'video'

export function isMissingAssetKind(kind: LocalAssetKind | null): kind is MissingAssetKind {
  return kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video'
}

/**
 * Stands in for the picture, document or player of an embed whose file is not
 * on this device, the state every other device is in when a file too large for
 * Cloud stays on the one that has it. One line in the embed's card, worded and
 * coloured as the Cloud notice that device shows under its player. The reading
 * view and the editor build the same card; the editor passes `onEdit` for the
 * `</>` action its other embeds carry, and the reading view the block's
 * `sourceLine`, so a double-click edits the line as on any block.
 */
export function buildMissingAssetNotice(
  kind: MissingAssetKind,
  href: string,
  options: { sourceLine?: number | null; onEdit?: (() => void) | null } = {}
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-asset-embed local-asset-missing not-prose'
  // Not `data-local-asset-kind`: that marks a file the asset menu can act on,
  // and keeps a double-click from editing the block. There is no file here.
  figure.dataset.localAssetMissing = kind
  figure.dataset.localAssetHref = href
  if (options.sourceLine != null) figure.dataset.sourceLine = String(options.sourceLine)

  const notice = document.createElement('div')
  notice.className = 'local-asset-missing-notice whitespace-normal break-words text-xs text-warning'
  notice.setAttribute('role', 'note')
  notice.textContent = `${localAssetLabel(href, 'This file')} isn't on this device.`
  figure.append(notice)

  if (options.onEdit) figure.append(buildEmbedEditButton(options.onEdit))
  return figure
}

function blockSourceLine(block: HTMLElement): number | null {
  const line = Number(block.dataset.sourceLine)
  return Number.isFinite(line) && line >= 1 ? line : null
}

export function enhanceLocalAssetNodes(
  root: HTMLElement,
  options: {
    vaultRoot: string | null | undefined
    notePath: string | null | undefined
    onRequestEdit?: RequestEdit | null
    /** When set, PDF embeds matching this vault-relative path are
     *  collapsed to a compact placeholder instead of a full iframe. */
    pinnedAssetPath?: string | null
    onActivatePinnedRef?: (() => void) | null
    onOpenAsset?: ((assetPath: string) => void) | null
    /** The Cloud notice for the file at a vault-relative path, or null.
     *  Left out while no file is over the limit, and then no embed is
     *  looked up for it at all. */
    cloudSyncNotice?: ((assetPath: string) => string | null) | null
  }
): void {
  const {
    vaultRoot,
    notePath,
    onRequestEdit,
    pinnedAssetPath,
    onActivatePinnedRef,
    onOpenAsset,
    cloudSyncNotice
  } = options
  if (!vaultRoot || !notePath) return
  const withCloudNotice = (host: HTMLElement, assetPath: string | null): HTMLElement => {
    if (cloudSyncNotice && assetPath) setCloudSyncNotice(host, cloudSyncNotice(assetPath))
    return host
  }

  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
    const raw = img.getAttribute('src') || ''
    const asset = resolveLocalAsset(vaultRoot, notePath, raw)
    if (!asset) return
    const { url: resolved, path: assetVaultRel } = asset

    // #463: a non-image file embedded with image syntax (`![](file.tldraw)`)
    // is a broken <img> with no indication it's an attachment. Denote it — a
    // chip when it's on its own line, an inline link otherwise — so it never
    // renders blank. Real images fall through to the embed path below;
    // excalidraw keeps its own dedicated embed handling.
    const imgKind = classifyLocalAssetHref(raw)
    if (imgKind && imgKind !== 'image' && imgKind !== 'excalidraw') {
      const label = localAssetLabel(raw, 'Attachment')
      // A non-previewable file opens in the OS default app (a `.tldraw` in its
      // editor, a `.zip` in the archiver) — an in-app asset tab can't render
      // it, which read as "nothing happened" when clicked. (#463)
      // The bridge takes the vault-relative path: a local vault opens the
      // file in place, a remote workspace downloads it first. Joining the
      // vault root here handed remote users a server path that does not
      // exist on their machine.
      const openAsset = assetVaultRel ? () => void openVaultAssetExternally(assetVaultRel) : null
      const standalone = isStandaloneImageParagraph(img)
      if (standalone && standalone.dataset.assetEmbed !== 'true') {
        standalone.dataset.assetEmbed = 'true'
        if (asset.missing && isMissingAssetKind(imgKind)) {
          standalone.replaceWith(
            buildMissingAssetNotice(imgKind, raw, { sourceLine: blockSourceLine(standalone) })
          )
          return
        }
        // Audio and video in image syntax (`![](clip.mp4)`, the Markdown
        // spelling of `![[clip.mp4]]`) play here as the wikilink form does,
        // and as the editor draws both. PDFs in this form still chip.
        if (imgKind === 'audio' || imgKind === 'video') {
          standalone.replaceWith(
            withCloudNotice(
              buildEmbed(
                imgKind,
                resolved,
                label,
                raw,
                assetVaultRel && onOpenAsset ? () => onOpenAsset(assetVaultRel) : null
              ),
              assetVaultRel
            )
          )
          return
        }
        standalone.replaceWith(
          withCloudNotice(buildAttachmentChip(resolved, raw, label, openAsset), assetVaultRel)
        )
      } else {
        const link = document.createElement('a')
        link.className = 'local-file-attachment-inline'
        link.textContent = label
        link.href = resolved
        link.dataset.localAssetUrl = resolved
        link.dataset.localAssetKind = 'file'
        link.dataset.localAssetHref = raw
        if (openAsset) {
          link.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            openAsset()
          })
        } else {
          link.target = '_blank'
          link.rel = 'noreferrer'
        }
        img.replaceWith(link)
      }
      return
    }

    // Ahead of `img.src`, so no request goes out for a file that is not here.
    // A picture inside a sentence stays in the sentence.
    if (asset.missing && imgKind === 'image') {
      const standalone = isStandaloneImageParagraph(img)
      if (standalone && standalone.dataset.assetEmbed !== 'true') {
        standalone.replaceWith(
          buildMissingAssetNotice('image', raw, { sourceLine: blockSourceLine(standalone) })
        )
        return
      }
    }

    img.src = resolved
    img.loading = 'lazy'
    img.dataset.localAssetUrl = resolved
    img.dataset.localAssetHref = raw
    const paragraph = isStandaloneImageParagraph(img)
    if (!paragraph || paragraph.dataset.assetEmbed === 'true') return
    paragraph.dataset.assetEmbed = 'true'
    const sourceLine = Number(paragraph.dataset.sourceLine)
    paragraph.replaceWith(
      withCloudNotice(
        buildImageEmbed(
          img,
          raw,
          resolved,
          Number.isFinite(sourceLine) && sourceLine >= 1 ? sourceLine : null,
          onRequestEdit,
          assetVaultRel && onOpenAsset ? () => onOpenAsset(assetVaultRel) : null
        ),
        assetVaultRel
      )
    )
  })

  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    if (anchor.classList.contains('wikilink') || anchor.classList.contains('hashtag')) return
    const raw = anchor.getAttribute('href') || ''
    // A `.md` link is a note link, and an external web link (`google.com`,
    // `https://…`) isn't a vault asset — leave both for the link-navigation
    // handlers instead of rewriting them to a zen-asset URL. (#201)
    if (/\.md(?:[#?].*)?$/i.test(raw.trim()) || externalLinkUrl(raw)) return
    const asset = resolveLocalAsset(vaultRoot, notePath, raw)
    if (!asset) return

    const { url: resolved, path: assetVaultRel } = asset
    const kind = classifyLocalAssetHref(raw) ?? 'file'
    anchor.href = resolved + hrefFragment(raw)
    anchor.dataset.localAssetUrl = resolved
    anchor.dataset.localAssetKind = kind
    anchor.dataset.localAssetHref = raw
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'
    if (assetVaultRel && onOpenAsset) {
      anchor.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onOpenAsset(assetVaultRel)
      })
    }

    if (kind === 'file' || kind === 'image' || kind === 'excalidraw') return

    const paragraph = isStandaloneAnchorParagraph(anchor)
    if (!paragraph || paragraph.dataset.assetEmbed === 'true') return
    paragraph.dataset.assetEmbed = 'true'
    if (asset.missing) {
      paragraph.replaceWith(
        buildMissingAssetNotice(kind, raw, { sourceLine: blockSourceLine(paragraph) })
      )
      return
    }
    const label = localAssetLabel(raw, anchor.textContent?.trim() || 'Asset')
    if (kind === 'pdf' && assetVaultRel && !canShowPdfInline()) {
      paragraph.replaceWith(
        withCloudNotice(
          buildPinnedRefPlaceholder(
            resolved,
            raw,
            label,
            () => void openVaultAssetExternally(assetVaultRel, { confirm: false }),
            PDF_OPEN_ELSEWHERE
          ),
          assetVaultRel
        )
      )
      return
    }
    if (kind === 'pdf' && pinnedAssetPath) {
      if (assetVaultRel === pinnedAssetPath) {
        paragraph.replaceWith(
          withCloudNotice(
            buildPinnedRefPlaceholder(resolved, raw, label, () => {
              onActivatePinnedRef?.()
            }),
            assetVaultRel
          )
        )
        return
      }
    }
    paragraph.replaceWith(
      withCloudNotice(
        buildEmbed(
          kind,
          resolved,
          label,
          raw,
          assetVaultRel && onOpenAsset ? () => onOpenAsset(assetVaultRel) : null
        ),
        assetVaultRel
      )
    )
  })
}
