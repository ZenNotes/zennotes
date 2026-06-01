import { describe, expect, it } from 'vitest'
import {
  DIAGRAM_ZOOM_MAX,
  DIAGRAM_ZOOM_MIN,
  clampDiagramZoom,
  diagramZoomLabel,
  fitDiagramToViewport,
  stepDiagramZoom,
  zoomDiagramAtPoint,
  zoomFromWheelDelta
} from './diagram-pan-zoom'

describe('diagram pan/zoom helpers', () => {
  it('clamps zoom to the supported expanded-diagram range', () => {
    expect(clampDiagramZoom(0.01)).toBe(DIAGRAM_ZOOM_MIN)
    expect(clampDiagramZoom(12)).toBe(DIAGRAM_ZOOM_MAX)
    expect(clampDiagramZoom(Number.NaN)).toBe(1)
  })

  it('steps zoom in fixed increments', () => {
    expect(stepDiagramZoom(1, 1)).toBe(1.2)
    expect(stepDiagramZoom(1, -1)).toBe(0.8)
  })

  it('keeps the diagram point under the cursor stable while zooming', () => {
    const next = zoomDiagramAtPoint(
      { zoom: 1, pan: { x: 25, y: 40 } },
      2,
      { x: 125, y: 140 }
    )

    expect(next.zoom).toBe(2)
    expect(next.pan).toEqual({ x: -75, y: -60 })
  })

  it('wheel zoom scales gently and is proportional to the delta', () => {
    // Scroll up (negative delta) zooms in, down zooms out.
    expect(zoomFromWheelDelta(1, -50)).toBeGreaterThan(1)
    expect(zoomFromWheelDelta(1, 50)).toBeLessThan(1)
    // A small (trackpad-sized) delta barely moves; a large one moves more.
    const small = zoomFromWheelDelta(1, -4) - 1
    const large = zoomFromWheelDelta(1, -40) - 1
    expect(small).toBeGreaterThan(0)
    expect(large).toBeGreaterThan(small)
  })

  it('caps a single wheel event to ~10% and stays within zoom bounds', () => {
    // A huge delta (e.g. a line-mode notch) must not leap more than the cap.
    expect(zoomFromWheelDelta(1, -100000)).toBeCloseTo(1.1, 5)
    expect(zoomFromWheelDelta(1, 100000)).toBeCloseTo(0.9, 5)
    // Never escapes the clamp range, even when compounding past the edges.
    expect(zoomFromWheelDelta(DIAGRAM_ZOOM_MAX, -100000)).toBe(DIAGRAM_ZOOM_MAX)
    expect(zoomFromWheelDelta(DIAGRAM_ZOOM_MIN, 100000)).toBe(DIAGRAM_ZOOM_MIN)
  })

  it('treats a zero or non-finite wheel delta as a no-op', () => {
    expect(zoomFromWheelDelta(1.5, 0)).toBe(1.5)
    expect(zoomFromWheelDelta(1.5, Number.NaN)).toBe(1.5)
  })

  it('formats zoom as a rounded percentage', () => {
    expect(diagramZoomLabel(1.234)).toBe('123%')
  })

  it('fits large diagrams inside the viewport without upscaling small diagrams', () => {
    expect(
      fitDiagramToViewport(
        { width: 1000, height: 500 },
        { width: 2000, height: 1000 },
        0
      )
    ).toEqual({ zoom: 0.5, pan: { x: 0, y: 0 } })

    expect(
      fitDiagramToViewport(
        { width: 1000, height: 500 },
        { width: 300, height: 200 },
        0
      ).zoom
    ).toBe(1)
  })
})
