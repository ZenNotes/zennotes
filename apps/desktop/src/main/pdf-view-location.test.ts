import { describe, expect, it } from "vitest";
import { pdfLocationFromViewerState } from "./pdf-view-location";

// The states below were read from Electron 41's viewer after opening a 5-page
// PDF at the fragment named in each case, so each must invert to that fragment.
describe("pdfLocationFromViewerState", () => {
  it("inverts the viewer's scroll spot to the fragment that produced it", () => {
    // #page=3&zoom=150,0,600
    expect(
      pdfLocationFromViewerState({ page: 2, zoom: 1.5, x: 0, y: 4110, pageX: 0, pageY: 2140 }),
    ).toEqual({ page: 3, zoom: 150, left: 0, top: 600 });
    // #page=3&zoom=150,100,600
    expect(
      pdfLocationFromViewerState({ page: 2, zoom: 1.5, x: 150, y: 4110, pageX: 0, pageY: 2140 }),
    ).toEqual({ page: 3, zoom: 150, left: 100, top: 600 });
  });

  it("rounds a fitted zoom to a whole percentage", () => {
    // #page=3 in a 900 px frame fits the page at 70.7%.
    expect(
      pdfLocationFromViewerState({ page: 2, zoom: 0.7070217917675545, x: 0, y: 1513, pageX: 0, pageY: 2140 }),
    ).toEqual({ page: 3, zoom: 71, left: 0, top: 0 });
  });

  it("still names the page and zoom when the page origin is unknown", () => {
    expect(
      pdfLocationFromViewerState({ page: 0, zoom: 1, x: 0, y: 300, pageX: null, pageY: null }),
    ).toEqual({ page: 1, zoom: 100, left: 0, top: 0 });
  });

  it("answers null for anything that is not viewer state", () => {
    expect(pdfLocationFromViewerState(null)).toBeNull();
    expect(pdfLocationFromViewerState("page 3")).toBeNull();
    expect(pdfLocationFromViewerState({ page: Number.NaN, zoom: 1 })).toBeNull();
    expect(pdfLocationFromViewerState({ page: 1, zoom: 0 })).toBeNull();
  });
});
