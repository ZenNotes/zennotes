import { describe, expect, it } from 'vitest'
import { applyManualMove, manualOrderCompare, parentDirOf, sameFolder } from './manual-order'

describe('parentDirOf / sameFolder', () => {
  it('returns the directory, or "" at the root', () => {
    expect(parentDirOf('inbox/Sub/Note.md')).toBe('inbox/Sub')
    expect(parentDirOf('inbox/Note.md')).toBe('inbox')
    expect(parentDirOf('Note.md')).toBe('')
  })
  it('detects siblings by parent dir', () => {
    expect(sameFolder('inbox/a.md', 'inbox/b.md')).toBe(true)
    expect(sameFolder('inbox/a.md', 'inbox/Sub/b.md')).toBe(false)
  })
})

describe('applyManualMove', () => {
  const order = ['a', 'b', 'c', 'd']
  it('moves before a target', () => {
    expect(applyManualMove(order, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c'])
  })
  it('moves after a target', () => {
    expect(applyManualMove(order, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
  })
  it('is a no-op when the target is absent', () => {
    expect(applyManualMove(order, 'a', 'zzz', 'before')).toEqual(order)
  })
  it('does not mutate the input', () => {
    const copy = [...order]
    applyManualMove(order, 'a', 'c', 'after')
    expect(order).toEqual(copy)
  })
})

describe('manualOrderCompare', () => {
  const order = ['c.md', 'a.md', 'b.md'] // user-chosen order

  it('orders listed notes by their index', () => {
    expect(Math.sign(manualOrderCompare(order, 'c.md', 0, 'a.md', 1))).toBe(-1)
    expect(Math.sign(manualOrderCompare(order, 'b.md', 0, 'c.md', 1))).toBe(1)
  })

  it('puts listed notes before unlisted ones, which keep file order', () => {
    // 'a.md' is listed, 'new.md' is not → listed first
    expect(manualOrderCompare(order, 'a.md', 9, 'new.md', 0)).toBe(-1)
    // both unlisted → fall back to siblingOrder
    expect(manualOrderCompare(order, 'x.md', 2, 'y.md', 5)).toBe(-3)
  })

  it('falls back to siblingOrder with no stored order', () => {
    expect(manualOrderCompare(undefined, 'x.md', 1, 'y.md', 4)).toBe(-3)
  })

  it('is a total order (sort is stable and deterministic)', () => {
    const notes = [
      { path: 'new.md', s: 5 },
      { path: 'b.md', s: 1 },
      { path: 'c.md', s: 0 },
      { path: 'a.md', s: 2 }
    ]
    const sorted = [...notes].sort((x, y) =>
      manualOrderCompare(order, x.path, x.s, y.path, y.s)
    )
    expect(sorted.map((n) => n.path)).toEqual(['c.md', 'a.md', 'b.md', 'new.md'])
  })
})
