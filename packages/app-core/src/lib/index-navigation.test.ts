import { describe, expect, it } from 'vitest'
import { boundedIndexCount, clampIndex, moveIndex } from './index-navigation'

describe('indexed panel navigation', () => {
  it('uses the full virtual item count instead of the rendered DOM count', () => {
    expect(boundedIndexCount(24, 5_000)).toBe(5_000)
  })

  it('falls back to the rendered DOM count for non-virtual panels', () => {
    expect(boundedIndexCount(24, null)).toBe(24)
  })

  it('moves through virtual indices past the current rendered window', () => {
    expect(moveIndex(23, 5_000, 1)).toBe(24)
    expect(moveIndex(4_999, 5_000, 1)).toBe(4_999)
  })

  it('clamps stale cursor indices to the available item range', () => {
    expect(clampIndex(200, 40)).toBe(39)
    expect(clampIndex(-4, 40)).toBe(0)
    expect(clampIndex(10, 0)).toBe(0)
  })
})
