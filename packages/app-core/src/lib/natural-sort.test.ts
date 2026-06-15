import { describe, expect, it } from 'vitest'
import { naturalCompare } from './natural-sort'

describe('naturalCompare (#168 — numeric-aware name sorting)', () => {
  it('orders numbers numerically, not lexically', () => {
    const sorted = ['10-mango', '2-banana', '1-apple', '21-watermelon', '3-cherry'].sort(
      naturalCompare
    )
    expect(sorted).toEqual(['1-apple', '2-banana', '3-cherry', '10-mango', '21-watermelon'])
  })

  it('is case-insensitive', () => {
    expect(naturalCompare('apple', 'Apple')).toBe(0)
    expect(naturalCompare('ZEBRA', 'apple')).toBeGreaterThan(0)
  })

  it('sorts numeric names before alphabetic ones', () => {
    expect(['z-note', '1-note', 'a-note'].sort(naturalCompare)).toEqual([
      '1-note',
      'a-note',
      'z-note'
    ])
  })

  it('handles embedded multi-digit numbers', () => {
    expect(['file-9', 'file-10', 'file-1'].sort(naturalCompare)).toEqual([
      'file-1',
      'file-9',
      'file-10'
    ])
  })
})
