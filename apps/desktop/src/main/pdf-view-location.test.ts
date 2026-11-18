import { describe, expect, it } from "vitest";
import { pdfFlashBand, pdfFlashTargetFrom, pdfLocationFromViewerState } from "./pdf-view-location";

// The 12-page fixture in Electron 41's viewer: pages 1066 tall, 1070 apart
// (page 4 starts at 3210), in a pane 644 px tall.
const pages = Array.from({ length: 12 }, (_, i) => ({ x: 0, y: i * 1070, height: 1066 }));
const view = { zoom: 1.5, x: 0, viewHeight: 644, pages, page: 3 };
const fifth = 0.2 * 644;

describe("pdfLocationFromViewerState", () => {
  it("records the reader's line, a fifth of the way down the view", () => {
    // After following #page=4&zoom=150,0,333 the viewer shows that line a fifth
    // down; copying it again gives the same link back.
    expect(pdfLocationFromViewerState({ ...view, y: (3210 + 333) * 1.5 - fifth })).toEqual({
      page: 4, zoom: 150, left: 0, top: 333,
    });
    expect(pdfLocationFromViewerState({ ...view, x: 150, y: (3210 + 333) * 1.5 - fifth })).toEqual({
      page: 4, zoom: 150, left: 100, top: 333,
    });
  });

  it("names the page when its top edge is in view", () => {
    // Page 4 starts 50 px below the view's top: the reader is looking at it whole.
    expect(pdfLocationFromViewerState({ ...view, y: 3210 * 1.5 - 50 })).toEqual({
      page: 4, zoom: 150, left: 0, top: 0,
    });
    // #page=1 at a fit zoom, the whole page in view.
    expect(pdfLocationFromViewerState({ ...view, zoom: 0.58, y: 0, page: 0 })).toEqual({
      page: 1, zoom: 58, left: 0, top: 0,
    });
  });

  it("still names the page and zoom when the layout is unknown", () => {
    expect(pdfLocationFromViewerState({ page: 0, zoom: 1, x: 0, y: 300, viewHeight: null, pages: null })).toEqual({
      page: 1, zoom: 100, left: 0, top: 0,
    });
  });

  it("answers null for anything that is not viewer state", () => {
    expect(pdfLocationFromViewerState(null)).toBeNull();
    expect(pdfLocationFromViewerState("page 3")).toBeNull();
    expect(pdfLocationFromViewerState({ page: Number.NaN, zoom: 1 })).toBeNull();
    expect(pdfLocationFromViewerState({ page: 1, zoom: 0 })).toBeNull();
  });
});

describe("pdfFlashBand", () => {
  // The viewer at #page=4&zoom=150,0,333 in a 900x700 frame with thumbnails:
  // the page area starts at (301, 56) and the link's spot is scrolled to its top.
  const geometry = {
    zoom: 1.5,
    // After the jump has brought the line a fifth of the way down.
    scrollY: (3208 + 333) * 1.5 - 0.2 * 644,
    pageY: 3208,
    top: 333,
    plugin: { left: 301, top: 56, width: 599, height: 644 },
    page: { x: 7.5, y: -495, width: 1224, height: 1584 },
  };

  it("lays the band across the page, centred on the reader's line", () => {
    // The line sits at 56 + 128.8 = 184.8; the band is 54 tall around it.
    expect(pdfFlashBand(geometry)).toEqual({ kind: "band", left: 309, top: 158, width: 591, height: 54 });
  });

  it("outlines the whole visible page for a link at a page's top", () => {
    // #page=1&zoom=58,0,0, copied with the whole page in view: a band here
    // only lit the empty top margin.
    const page1 = {
      zoom: 0.58,
      scrollY: 0,
      pageY: 0,
      top: 0,
      plugin: { left: 301, top: 56, width: 599, height: 644 },
      page: { x: 62, y: 2, width: 473, height: 612 },
    };
    expect(pdfFlashBand(page1)).toEqual({ kind: "page", left: 363, top: 58, width: 473, height: 612 });
    // A page taller than the pane is outlined only where it shows.
    expect(pdfFlashBand({ ...geometry, top: 0, page: { ...geometry.page, y: 0 } })).toEqual({
      kind: "page", left: 309, top: 56, width: 591, height: 644,
    });
  });

  it("follows the line down when the viewer could not scroll that far", () => {
    const band = pdfFlashBand({ ...geometry, scrollY: geometry.scrollY - 200 });
    expect(band?.top).toBe(358);
  });

  it("draws nothing when the spot is off screen", () => {
    expect(pdfFlashBand({ ...geometry, scrollY: geometry.scrollY - 2000 })).toBeNull();
    expect(pdfFlashBand({ ...geometry, scrollY: geometry.scrollY + 2000 })).toBeNull();
  });
});

describe("pdfFlashTargetFrom", () => {
  it("takes a page and a position, and nothing else", () => {
    expect(pdfFlashTargetFrom({ page: 4, top: 333 })).toEqual({ page: 4, top: 333 });
    expect(pdfFlashTargetFrom({ page: 0, top: 0 })).toBeNull();
    expect(pdfFlashTargetFrom({ page: "4", top: 0 })).toBeNull();
    expect(pdfFlashTargetFrom({ page: 4, top: -1 })).toBeNull();
    expect(pdfFlashTargetFrom(null)).toBeNull();
  });
});
