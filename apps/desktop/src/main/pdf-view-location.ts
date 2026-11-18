import type { WebContents, WebFrameMain } from "electron";
import type { PdfFlashTarget, PdfViewLocation } from "@zennotes/bridge-contract/bridge";

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

/**
 * How far down the view the reader's line sits: a copy records the line a
 * fifth of the way down rather than the view's top edge, which was often half
 * hidden under the viewer's toolbar, and a jump puts that line a fifth of the
 * way down again (see `flashScript`), so copy, jump, copy is stable.
 */
export const PDF_FOCUS_FRACTION = 0.2;

const READ_VIEWER_STATE = `(() => {
  const viewer = document.querySelector('pdf-viewer');
  const viewport = viewer && viewer.viewport_;
  if (!viewport || typeof viewport.getMostVisiblePage !== 'function') return null;
  const position = viewport.position;
  const size = viewport.size;
  const dims = viewport.pageDimensions_;
  return {
    page: viewport.getMostVisiblePage(),
    zoom: viewport.getZoom(),
    x: position ? position.x : 0,
    y: position ? position.y : 0,
    viewHeight: size ? size.height : null,
    pages: Array.isArray(dims) ? dims.map((d) => ({ x: d.x, y: d.y, height: d.height })) : null
  };
})()`;

export interface PdfViewerState {
  /** The most visible page, from 0; the fallback when the layout is unknown. */
  page: number;
  zoom: number;
  /** Scroll offsets, in screen pixels. */
  x: number;
  y: number;
  /** The page area's height, in screen pixels. */
  viewHeight: number | null;
  /** Every page's box in the viewer's 100%-zoom layout. */
  pages: Array<{ x: number; y: number; height: number }> | null;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Turn the viewer's state into fragment terms. The viewer scrolls a
 * `#page=P&zoom=Z,L,T` link to `(pageOrigin + (L, T)) * zoom`, in its
 * 100%-zoom layout units, so a point on screen inverts to an offset on a page.
 *
 * The point taken is the reader's line, a fifth of the way down the view, on
 * whichever page it falls. When that page's top edge is in view, the link
 * names the page (T = 0) rather than a line, since the reader is looking at
 * the page as a whole; a jump then outlines it. Without the page layout the
 * link still names the most visible page and the zoom.
 */
export function pdfLocationFromViewerState(raw: unknown): PdfViewLocation | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Partial<PdfViewerState>;
  if (!finite(state.page) || state.page < 0 || !finite(state.zoom) || state.zoom <= 0) return null;
  const zoom = Math.round(state.zoom * 100);
  if (zoom <= 0) return null;
  const pages = Array.isArray(state.pages) ? state.pages : null;
  if (!pages || pages.length === 0 || !finite(state.x) || !finite(state.y) || !finite(state.viewHeight)) {
    return { page: Math.floor(state.page) + 1, zoom, left: 0, top: 0 };
  }
  const viewTop = state.y / state.zoom;
  const focus = (state.y + PDF_FOCUS_FRACTION * state.viewHeight) / state.zoom;
  let index = 0;
  for (let i = 0; i < pages.length; i++) {
    if (finite(pages[i]?.y) && pages[i]!.y <= focus) index = i;
  }
  const page = pages[index]!;
  if (!finite(page.x) || !finite(page.y)) return { page: index + 1, zoom, left: 0, top: 0 };
  const left = Math.max(0, Math.round(state.x / state.zoom - page.x));
  const top = page.y >= viewTop - 8 ? 0 : Math.max(0, Math.round(focus - page.y));
  return { page: index + 1, zoom, left, top };
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

/* ------------------------------------------------------------------------ */
/* Marking the spot a link landed on                                        */
/* ------------------------------------------------------------------------ */

export interface PdfFlashGeometry {
  zoom: number;
  /** The viewer's scroll offset, in screen pixels. */
  scrollY: number;
  /** The linked page's top in the viewer's 100%-zoom layout. */
  pageY: number;
  /** How far down that page the link points, at 100% zoom. */
  top: number;
  /** The page area (`#plugin`), in the viewer document's coordinates. */
  plugin: { left: number; top: number; width: number; height: number };
  /** The linked page's box within the page area, in screen pixels
   *  (`getPageScreenRect`). */
  page: { x: number; y: number; width: number; height: number };
}

export interface PdfFlashBand {
  /** `band` marks a spot down the page; `page` outlines the whole page. */
  kind: "band" | "page";
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * What to mark, clipped to the page area so it never covers the thumbnails or
 * toolbar. A link copied mid-page (`zoom=150,0,333`) gets a band across the
 * page at that spot. A link at a page's top (`#page=1`, or a copy taken while
 * the whole page was in view) names the page rather than a line, and a band
 * there only lit the empty top margin, so the whole visible page is outlined
 * instead (Adib, trying #1085). Null when the mark would be off screen (the
 * viewer could not scroll the spot to the top, say near the end of a
 * document, and it fell below the fold).
 *
 * Kept free of outside names: it is also sent into the viewer as source text.
 */
export function pdfFlashBand(g: PdfFlashGeometry): PdfFlashBand | null {
  const pluginRight = g.plugin.left + g.plugin.width;
  const pluginBottom = g.plugin.top + g.plugin.height;
  const left = Math.max(g.plugin.left, g.plugin.left + g.page.x);
  const right = Math.min(pluginRight, g.plugin.left + g.page.x + g.page.width);
  if (right - left < 40) return null;
  // Within 8 points of the top, a link names the page, not a spot on it.
  if (g.top <= 8) {
    const pageTop = g.plugin.top + g.page.y;
    const pageBottom = pageTop + g.page.height;
    const top = Math.round(Math.max(g.plugin.top, pageTop));
    const bottom = Math.round(Math.min(pluginBottom, pageBottom));
    if (bottom - top < 24) return null;
    const edgeLeft = Math.round(left);
    return { kind: "page", left: edgeLeft, top, width: Math.round(right) - edgeLeft, height: bottom - top };
  }
  const height = Math.round(Math.min(Math.max(36 * g.zoom, 24), g.plugin.height * 0.3));
  // Centred on the reader's line: the spot is a point on it, not its top.
  const rawTop = g.plugin.top + (g.pageY + g.top) * g.zoom - g.scrollY - height / 2;
  if (rawTop >= pluginBottom - 8 || rawTop + height <= g.plugin.top) return null;
  // Round the edges, not the sizes, so the band never pokes a pixel past the
  // page area.
  const edgeLeft = Math.round(left);
  const edgeTop = Math.round(Math.max(g.plugin.top, rawTop));
  const edgeRight = Math.round(right);
  const edgeBottom = Math.round(Math.min(pluginBottom, rawTop + height));
  return { kind: "band", left: edgeLeft, top: edgeTop, width: edgeRight - edgeLeft, height: edgeBottom - edgeTop };
}

export function pdfFlashTargetFrom(raw: unknown): PdfFlashTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const { page, top } = raw as Partial<PdfFlashTarget>;
  if (!finite(page) || page < 1 || page > 100000 || !finite(top) || top < 0 || top > 1e6) return null;
  return { page: Math.floor(page), top };
}

// Runs inside the viewer: wait for the page layout and for the scroll the
// link asked for to settle, then draw the band and fade it out. The only
// values spliced in are the two validated numbers and `pdfFlashBand`'s source.
function flashScript(target: PdfFlashTarget): string {
  return `(async () => {
    const band = ${pdfFlashBand.toString()};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pageIndex = ${target.page - 1};
    let last = null;
    let stable = 0;
    let nudged = ${target.top} <= 8;
    for (let i = 0; i < 50; i++) {
      const viewer = document.querySelector('pdf-viewer');
      const viewport = viewer && viewer.viewport_;
      const plugin = viewer && viewer.shadowRoot && viewer.shadowRoot.querySelector('#plugin');
      const dims = viewport && viewport.pageDimensions_ && viewport.pageDimensions_[pageIndex];
      if (viewport && plugin && dims) {
        const y = viewport.position.y;
        stable = last !== null && Math.abs(y - last) < 0.5 ? stable + 1 : 0;
        last = y;
        if (stable >= 2 && !nudged) {
          // The link scrolled its line to the top edge; bring it a fifth of
          // the way down (PDF_FOCUS_FRACTION), where the copy took it from.
          nudged = true;
          stable = 0;
          viewport.setPosition({ x: viewport.position.x, y: Math.max(0, y - ${PDF_FOCUS_FRACTION} * viewport.size.height) });
        } else if (stable >= 2) {
          const p = plugin.getBoundingClientRect();
          const rect = viewport.getPageScreenRect(pageIndex);
          const b = band({
            zoom: viewport.getZoom(), scrollY: y, pageY: dims.y, top: ${target.top},
            plugin: { left: p.left, top: p.top, width: p.width, height: p.height },
            page: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          });
          if (!b) return false;
          document.getElementById('zen-pdf-flash')?.remove();
          const el = document.createElement('div');
          el.id = 'zen-pdf-flash';
          const look = b.kind === 'page'
            ? 'background:rgba(250,204,21,.10);box-shadow:inset 0 0 0 3px rgba(234,179,8,.9);'
            : 'background:rgba(250,204,21,.28);box-shadow:inset 0 0 0 2px rgba(234,179,8,.85);';
          el.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border-radius:4px;' + look +
            'left:' + b.left + 'px;top:' + b.top + 'px;width:' + b.width + 'px;height:' + b.height + 'px';
          document.documentElement.appendChild(el);
          const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
          if (still) setTimeout(() => el.remove(), 1500);
          else el.animate(
            [{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.62 }, { opacity: 0 }],
            { duration: 2600, easing: 'ease-out' }
          ).finished.then(() => el.remove(), () => el.remove());
          return true;
        }
      }
      await sleep(100);
    }
    return false;
  })()`;
}

/**
 * Mark the spot a followed link landed on (#1085). The frame may still be
 * loading when the renderer asks, so wait up to about five seconds for the
 * viewer frame to appear before handing it the script. Best effort: any
 * surprise draws nothing, and the jump itself has already happened.
 */
export async function flashPdfLocation(
  contents: WebContents,
  frameName: unknown,
  rawTarget: unknown,
): Promise<boolean> {
  if (typeof frameName !== "string" || !frameName || frameName.length > 200) return false;
  const target = pdfFlashTargetFrom(rawTarget);
  if (!target) return false;
  for (let i = 0; i < 50; i++) {
    for (const frame of framesNamed(contents, frameName)) {
      let viewer: WebFrameMain | undefined;
      try {
        viewer = frame.frames.find((child) => child.origin === PDF_VIEWER_ORIGIN);
      } catch {
        viewer = undefined;
      }
      if (!viewer) continue;
      try {
        return (await viewer.executeJavaScript(flashScript(target))) === true;
      } catch {
        return false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
