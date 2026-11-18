import type { PdfViewLocation } from '@zennotes/bridge-contract/bridge'
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
