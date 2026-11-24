import { describe, expect, it } from 'vitest'
import { sectionDepthsFromHeadings } from './section-depth'

describe('sectionDepthsFromHeadings', () => {
  it('puts a heading and what follows it at its level below the shallowest', () => {
    const depth = sectionDepthsFromHeadings([
      { line: 1, level: 1 },
      { line: 3, level: 2 },
      { line: 5, level: 3 },
      { line: 8, level: 2 }
    ])
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(depth)).toEqual([0, 0, 1, 1, 2, 2, 2, 1, 1])
  })

  it('does not push a note in for a missing H1', () => {
    const depth = sectionDepthsFromHeadings([
      { line: 2, level: 2 },
      { line: 4, level: 3 }
    ])
    expect([1, 2, 3, 4, 5].map(depth)).toEqual([0, 0, 0, 1, 1])
  })

  it('leaves a note without headings flat', () => {
    expect(sectionDepthsFromHeadings([])(10)).toBe(0)
  })
})
