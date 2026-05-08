import { describe, expect, it } from 'vitest'
import {
  getSidebarEntryLimitIncludingIndex,
  getInitialSidebarEntryLimit,
  getNextSidebarEntryLimit,
  getSidebarEdgePrefetchPaths,
  SIDEBAR_PROGRESSIVE_BATCH_ROWS,
  SIDEBAR_PROGRESSIVE_INITIAL_ROWS,
  SIDEBAR_VISIBLE_PREFETCH_EDGE_ROWS
} from './sidebar-progressive'

describe('sidebar progressive row limits', () => {
  it('keeps large folders bounded at first render', () => {
    expect(getInitialSidebarEntryLimit(5_000, true)).toBe(SIDEBAR_PROGRESSIVE_INITIAL_ROWS)
  })

  it('only exposes one additional batch when more rows are requested', () => {
    expect(getNextSidebarEntryLimit(SIDEBAR_PROGRESSIVE_INITIAL_ROWS, 5_000)).toBe(
      SIDEBAR_PROGRESSIVE_INITIAL_ROWS + SIDEBAR_PROGRESSIVE_BATCH_ROWS
    )
  })

  it('renders small or disabled folders in full', () => {
    expect(getInitialSidebarEntryLimit(80, true)).toBe(80)
    expect(getInitialSidebarEntryLimit(5_000, false)).toBe(5_000)
  })

  it('clamps requested batches to the total entry count', () => {
    expect(getNextSidebarEntryLimit(320, 350)).toBe(350)
  })

  it('expands the visible limit far enough to include a revealed target', () => {
    expect(getSidebarEntryLimitIncludingIndex(SIDEBAR_PROGRESSIVE_INITIAL_ROWS, 5_000, 900)).toBe(
      901
    )
  })

  it('keeps the current limit for invalid reveal targets', () => {
    expect(getSidebarEntryLimitIncludingIndex(SIDEBAR_PROGRESSIVE_INITIAL_ROWS, 5_000, -1)).toBe(
      SIDEBAR_PROGRESSIVE_INITIAL_ROWS
    )
    expect(getSidebarEntryLimitIncludingIndex(SIDEBAR_PROGRESSIVE_INITIAL_ROWS, 5_000, 5_100)).toBe(
      SIDEBAR_PROGRESSIVE_INITIAL_ROWS
    )
  })

  it('prefetches the trailing and leading edges of the visible window first', () => {
    const paths = Array.from({ length: SIDEBAR_PROGRESSIVE_INITIAL_ROWS }, (_, index) => {
      return `note-${index}.md`
    })

    expect(getSidebarEdgePrefetchPaths(paths).slice(0, 6)).toEqual([
      'note-159.md',
      'note-0.md',
      'note-158.md',
      'note-1.md',
      'note-157.md',
      'note-2.md'
    ])
    expect(getSidebarEdgePrefetchPaths(paths)).toHaveLength(SIDEBAR_VISIBLE_PREFETCH_EDGE_ROWS)
  })

  it('skips non-note placeholders while preserving edge priority', () => {
    expect(getSidebarEdgePrefetchPaths([null, 'a.md', undefined, 'b.md'], 4)).toEqual([
      'b.md',
      'a.md'
    ])
  })
})
