import { describe, expect, it } from 'vitest'
import { mapSplitScrollTop, splitScrollAnchors, splitScrollEchoes } from './split-scroll-sync'

// Blocks as [editorTop, previewTop] pairs, in document order.
function geometry(blocks: Array<[number, number]>, editorMax: number, previewMax: number) {
  return splitScrollAnchors(
    blocks.map(([editor, preview]) => ({ editor, preview })),
    editorMax,
    previewMax
  )
}

describe('mapSplitScrollTop (#859)', () => {
  it('falls back to the scroll ratio when no block is anchored', () => {
    const g = geometry([], 1000, 3000)
    expect(mapSplitScrollTop(g, 'editor', 250)).toBe(750)
    expect(mapSplitScrollTop(g, 'preview', 750)).toBe(250)
  })

  it('keeps the top of one pane at the top of the other, padding included', () => {
    // The H1 starts 16px down in the preview: the old sync scrolled that
    // padding away and pinned the heading against the pane's top edge.
    const g = geometry([[0, 16], [120, 300]], 2000, 6000)
    expect(mapSplitScrollTop(g, 'editor', 0)).toBe(0)
    expect(mapSplitScrollTop(g, 'preview', 0)).toBe(0)
  })

  it('lands a block on its counterpart and interpolates inside it', () => {
    // A callout 100px tall in the editor renders 1000px tall in the preview.
    const g = geometry([[0, 0], [400, 900], [500, 1900], [800, 2200]], 3000, 9000)
    expect(mapSplitScrollTop(g, 'editor', 400)).toBe(900)
    expect(mapSplitScrollTop(g, 'editor', 450)).toBe(1400)
    expect(mapSplitScrollTop(g, 'preview', 1400)).toBe(450)
    expect(mapSplitScrollTop(g, 'preview', 2050)).toBe(650)
  })

  it('returns where it started after a round trip, anywhere in the note', () => {
    const g = geometry([[0, 16], [90, 400], [300, 420], [310, 1700], [900, 2000], [1500, 5200]], 2400, 7000)
    for (let top = 0; top <= 2400; top += 37) {
      const there = mapSplitScrollTop(g, 'editor', top)
      expect(mapSplitScrollTop(g, 'preview', there)).toBeCloseTo(top, 6)
    }
  })

  it('skips blocks the editor folds into one widget', () => {
    // Three blocks inside one rendered callout widget share its top in the
    // editor; the segment runs to the first block past it in both panes.
    const g = geometry([[100, 200], [100, 500], [100, 800], [300, 1200]], 1000, 4000)
    expect(mapSplitScrollTop(g, 'editor', 200)).toBe(700)
    expect(mapSplitScrollTop(g, 'preview', 700)).toBe(200)
  })

  it('maps the end of one pane to the end of the other', () => {
    // The last blocks begin inside the final screenful, where neither pane's
    // top can reach them.
    const g = geometry([[0, 0], [700, 2000], [950, 2900], [990, 3100]], 900, 2800)
    expect(mapSplitScrollTop(g, 'editor', 900)).toBe(2800)
    expect(mapSplitScrollTop(g, 'preview', 2800)).toBe(900)
    expect(mapSplitScrollTop(g, 'editor', 800)).toBe(2400)
  })

  it.each([
    ['editor', 900, 2000],
    ['preview', 700, 2800],
    ['both panes', 900, 2800]
  ] as const)('keeps both ends reachable when a block starts exactly at the end of %s', (_, editor, preview) => {
    const g = geometry([[0, 16], [100, 200], [editor, preview]], 900, 2800)
    expect(mapSplitScrollTop(g, 'editor', 900)).toBe(2800)
    expect(mapSplitScrollTop(g, 'preview', 2800)).toBe(900)
    expect(mapSplitScrollTop(g, 'editor', 899)).toBeLessThan(2800)
    expect(mapSplitScrollTop(g, 'preview', 2799)).toBeLessThan(900)
    for (const top of [0, 250, 450, 700, 899, 900]) {
      const there = mapSplitScrollTop(g, 'editor', top)
      expect(mapSplitScrollTop(g, 'preview', there)).toBeCloseTo(top, 6)
    }
  })

  it('clamps to the target pane and handles a pane that cannot scroll', () => {
    const g = geometry([[0, 0], [100, 400]], 500, 2000)
    expect(mapSplitScrollTop(g, 'editor', -50)).toBe(0)
    expect(mapSplitScrollTop(g, 'editor', 9999)).toBe(2000)
    expect(mapSplitScrollTop(geometry([[0, 0]], 0, 2000), 'editor', 0)).toBe(0)
    expect(mapSplitScrollTop(geometry([[0, 0]], 500, 0), 'editor', 300)).toBe(0)
  })
})

describe('splitScrollEchoes (#859)', () => {
  it('ignores a pane while the other one leads, and only then', () => {
    const lead = { pane: 'preview' as const, until: 1000 }
    expect(splitScrollEchoes(lead, 'editor', 999)).toBe(true)
    expect(splitScrollEchoes(lead, 'preview', 999)).toBe(false)
    expect(splitScrollEchoes(lead, 'editor', 1000)).toBe(false)
    expect(splitScrollEchoes(null, 'editor', 0)).toBe(false)
  })
})
