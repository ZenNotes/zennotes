import type { WebContents, WebFrameMain } from "electron";
import type { PdfViewLocation } from "@zennotes/bridge-contract/bridge";

/**
 * Read where a PDF is scrolled to, for "Copy link to PDF location" (#1085).
 *
 * A PDF in an iframe is drawn by Chromium's built-in viewer, an extension page
 * nested one frame below the iframe. The note page cannot script it (another
 * origin), but the main process can run code in any frame of its own window.
 * The renderer names the iframe it means; main finds that frame among the
 * window's frames and asks the viewer frame under it. Nothing the renderer
 * sends is evaluated: the name only selects a frame.
 *
 * `viewport_` is the viewer's private state, so a Chromium update can rename
 * it. Every read is guarded, and any surprise answers null so the caller can
 * still copy a plain link to the file.
 */

const PDF_VIEWER_ORIGIN = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai";

const READ_VIEWER_STATE = `(() => {
  const viewer = document.querySelector('pdf-viewer');
  const viewport = viewer && viewer.viewport_;
  if (!viewport || typeof viewport.getMostVisiblePage !== 'function') return null;
  const page = viewport.getMostVisiblePage();
  const dims = viewport.pageDimensions_ && viewport.pageDimensions_[page];
  const position = viewport.position;
  return {
    page,
    zoom: viewport.getZoom(),
    x: position ? position.x : 0,
    y: position ? position.y : 0,
    pageX: dims ? dims.x : null,
    pageY: dims ? dims.y : null
  };
})()`;

export interface PdfViewerState {
  page: number;
  zoom: number;
  x: number;
  y: number;
  pageX: number | null;
  pageY: number | null;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Turn the viewer's state into fragment terms. The viewer scrolls a
 * `#page=P&zoom=Z,L,T` link to `(pageOrigin + (L, T)) * zoom`, measured in its
 * 100%-zoom layout units, so the spot on screen inverts to
 * `L = x / zoom - pageX`, `T = y / zoom - pageY`. Without the page origin the
 * link still names the page and zoom.
 */
export function pdfLocationFromViewerState(raw: unknown): PdfViewLocation | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Partial<PdfViewerState>;
  if (!finite(state.page) || state.page < 0 || !finite(state.zoom) || state.zoom <= 0) return null;
  const zoom = Math.round(state.zoom * 100);
  if (zoom <= 0) return null;
  let left = 0;
  let top = 0;
  if (finite(state.x) && finite(state.y) && finite(state.pageX) && finite(state.pageY)) {
    left = Math.max(0, Math.round(state.x / state.zoom - state.pageX));
    top = Math.max(0, Math.round(state.y / state.zoom - state.pageY));
  }
  return { page: Math.floor(state.page) + 1, zoom, left, top };
}

function framesNamed(contents: WebContents, name: string): WebFrameMain[] {
  try {
    return contents.mainFrame.framesInSubtree.filter((frame) => frame.name === name);
  } catch {
    // A frame mid-navigation can already be disposed when read.
    return [];
  }
}

export async function readPdfViewLocation(
  contents: WebContents,
  frameName: unknown,
): Promise<PdfViewLocation | null> {
  if (typeof frameName !== "string" || !frameName || frameName.length > 200) return null;
  for (const frame of framesNamed(contents, frameName)) {
    let viewer: WebFrameMain | undefined;
    try {
      viewer = frame.frames.find((child) => child.origin === PDF_VIEWER_ORIGIN);
    } catch {
      viewer = undefined;
    }
    if (!viewer) continue;
    try {
      return pdfLocationFromViewerState(await viewer.executeJavaScript(READ_VIEWER_STATE));
    } catch {
      return null;
    }
  }
  return null;
}
