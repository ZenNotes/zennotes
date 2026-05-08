import { describe, expect, it } from 'vitest'
import { getVirtualRange, getScrollTopForVirtualIndex } from './virtual-list'

describe('getVirtualRange', () => {
  it('returns a bounded overscanned range for the current viewport', () => {
    expect(
      getVirtualRange({
        itemCount: 1_000,
        itemSize: 20,
        scrollTop: 200,
        viewportHeight: 100,
        overscan: 2
      })
    ).toEqual({
      start: 8,
      end: 17,
      totalSize: 20_000
    })
  })

  it('keeps a small initial range when the viewport has not measured yet', () => {
    expect(
      getVirtualRange({
        itemCount: 100,
        itemSize: 20,
        scrollTop: 0,
        viewportHeight: 0,
        overscan: 3
      })
    ).toEqual({
      start: 0,
      end: 7,
      totalSize: 2_000
    })
  })

  it('handles empty lists', () => {
    expect(
      getVirtualRange({
        itemCount: 0,
        itemSize: 20,
        scrollTop: 100,
        viewportHeight: 100
      })
    ).toEqual({
      start: 0,
      end: 0,
      totalSize: 0
    })
  })
})

describe('getScrollTopForVirtualIndex', () => {
  it('keeps the scroll position when the target row is already visible', () => {
    expect(
      getScrollTopForVirtualIndex({
        index: 8,
        itemCount: 100,
        itemSize: 20,
        currentScrollTop: 100,
        viewportHeight: 100
      })
    ).toBe(100)
  })

  it('scrolls down just enough to reveal a lower target row', () => {
    expect(
      getScrollTopForVirtualIndex({
        index: 12,
        itemCount: 100,
        itemSize: 20,
        currentScrollTop: 100,
        viewportHeight: 100
      })
    ).toBe(160)
  })

  it('scrolls up to reveal an upper target row', () => {
    expect(
      getScrollTopForVirtualIndex({
        index: 3,
        itemCount: 100,
        itemSize: 20,
        currentScrollTop: 100,
        viewportHeight: 100
      })
    ).toBe(60)
  })
})
