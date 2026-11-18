import type { PdfFlashTarget, PdfViewLocation } from '@zennotes/bridge-contract/bridge'
import { useToastStore } from './toast'

/**
 * "Copy link to PDF location" (#1085): a Markdown link to the vault PDF at
 * the page, zoom and scroll spot it is showing, ready to paste into a note.
 * Following the link (click or `gd`) opens the PDF back at that spot.
 *
 * Every PDF frame that can be copied from carries `PDF_FRAME_ATTR` with its
 * vault path and a unique `name`; the main process finds the frame by that
 * name to read the viewer (see `pdf-view-location.ts` in desktop main).
 */
export const PDF_FRAME_ATTR = 'data-zen-pdf-path'

let frameCounter = 0

/** A frame name no other PDF frame in this window carries. */
export function nextPdfFrameName(): string {
  frameCounter += 1
  return `zen-pdf-${frameCounter}`
}

/** `#page=3&zoom=150,0,600`: the viewer's own fragment for a spot. */
export function pdfLocationFragment(location: PdfViewLocation): string {
  return `#page=${location.page}&zoom=${location.zoom},${location.left},${location.top}`
}

// A Markdown link destination ends at a space or an unbalanced paren, and `#`
// or `?` would start a fragment or query inside a file name.
function encodeLinkPath(path: string): string {
  return path.replace(/[%\s()<>#?[\]]/g, (ch) => {
    const code = ch.charCodeAt(0)
    // encodeURIComponent leaves `(` and `)` alone.
    return code < 0x80 ? `%${code.toString(16).toUpperCase().padStart(2, '0')}` : encodeURIComponent(ch)
  })
}

function escapeLabel(text: string): string {
  return text.replace(/[[\]\\]/g, (ch) => `\\${ch}`)
}

export function pdfLocationMarkdownLink(
  assetPath: string,
  location: PdfViewLocation | null
): string {
  const name = assetPath.split('/').filter(Boolean).pop() ?? assetPath
  const label = location ? `${name}, p. ${location.page}` : name
  const fragment = location ? pdfLocationFragment(location) : ''
  return `[${escapeLabel(label)}](${encodeLinkPath(assetPath)}${fragment})`
}

/** The PDF frame a command means: the one holding focus, else the first one
 *  on screen inside the active pane, else the first one on screen anywhere
 *  (the reference pane). */
export function pdfFrameForCommand(doc: Document = document): HTMLIFrameElement | null {
  const active = doc.activeElement
  if (active instanceof HTMLIFrameElement && active.hasAttribute(PDF_FRAME_ATTR)) return active
  const visible = Array.from(
    doc.querySelectorAll<HTMLIFrameElement>(`iframe[${PDF_FRAME_ATTR}]`)
  ).filter((frame) => frame.getClientRects().length > 0)
  const inActivePane = visible.find((frame) => frame.closest('[data-active-pane="true"]'))
  return inActivePane ?? visible[0] ?? null
}

export async function copyPdfLocationLink(frame: HTMLIFrameElement | null): Promise<boolean> {
  const toast = useToastStore.getState().addToast
  const assetPath = frame?.getAttribute(PDF_FRAME_ATTR)
  if (!frame || !assetPath) {
    toast('Open a PDF to copy a link to it', 'info')
    return false
  }
  let location: PdfViewLocation | null = null
  try {
    location = (await window.zen.readPdfViewLocation?.(frame.name)) ?? null
  } catch {
    location = null
  }
  window.zen.clipboardWriteText(pdfLocationMarkdownLink(assetPath, location))
  toast(
    location
      ? `Copied a link to page ${location.page}`
      : "Copied a link to the PDF (its page couldn't be read)",
    location ? 'success' : 'info'
  )
  return true
}

/**
 * The spot a link's fragment names, for marking it once the PDF lands there:
 * `#page=4&zoom=150,0,333` is page 4, 333 down. A fragment with a page and no
 * position marks the top of that page. Null without a page (a `#search=`, a
 * named destination), where there is no single spot to mark.
 */
export function pdfFlashTargetFromFragment(fragment: string | null | undefined): PdfFlashTarget | null {
  if (!fragment) return null
  const params = new URLSearchParams(fragment.replace(/^#/, ''))
  const page = Number(params.get('page'))
  if (!Number.isInteger(page) || page < 1) return null
  const zoom = params.get('zoom')?.split(',') ?? []
  const top = zoom.length >= 3 ? Number(zoom[2]) : 0
  return { page, top: Number.isFinite(top) && top > 0 ? top : 0 }
}

const flashed = new Set<string>()

/**
 * Mark the spot a followed link landed on with a band that fades out (#1085).
 * `jumpKey` names one jump (a tab's or the reference pane's nonce), so a frame
 * that remounts later, when its tab comes back to the front, does not flash
 * again. Desktop only; elsewhere, and on any failure, nothing is drawn.
 */
export function flashPdfFrameOnce(jumpKey: string, frameName: string, fragment: string | null | undefined): void {
  if (flashed.has(jumpKey)) return
  const target = pdfFlashTargetFromFragment(fragment)
  if (!target || typeof window.zen.flashPdfLocation !== 'function') return
  flashed.add(jumpKey)
  void window.zen.flashPdfLocation(frameName, target).catch(() => false)
}
