import { afterEach, describe, expect, it } from 'vitest'
import {
  clearTabScrollMemory,
  forgetTabScroll,
  recallTabScroll,
  rememberTabScroll
} from './tab-scroll-memory'

afterEach(() => clearTabScrollMemory())

describe('tab scroll memory', () => {
  it('remembers and recalls a tab position by path', () => {
    rememberTabScroll('a.md', { editor: 120, preview: 340 })
    expect(recallTabScroll('a.md')).toEqual({ editor: 120, preview: 340 })
  })

  it('returns undefined for an unseen path', () => {
    expect(recallTabScroll('never.md')).toBeUndefined()
  })

  it('overwrites the position on the same path', () => {
    rememberTabScroll('a.md', { editor: 10, preview: 20 })
    rememberTabScroll('a.md', { editor: 11, preview: 22 })
    expect(recallTabScroll('a.md')).toEqual({ editor: 11, preview: 22 })
  })

  it('forgets a single path', () => {
    rememberTabScroll('a.md', { editor: 1, preview: 2 })
    forgetTabScroll('a.md')
    expect(recallTabScroll('a.md')).toBeUndefined()
  })

  it('ignores an empty path', () => {
    rememberTabScroll('', { editor: 1, preview: 2 })
    expect(recallTabScroll('')).toBeUndefined()
  })

  it('evicts the least-recently-used entry past the cap', () => {
    // Cap is 60. Insert 61 distinct paths; the first inserted should be gone.
    for (let i = 0; i < 61; i++) {
      rememberTabScroll(`note-${i}.md`, { editor: i, preview: i })
    }
    expect(recallTabScroll('note-0.md')).toBeUndefined()
    expect(recallTabScroll('note-60.md')).toEqual({ editor: 60, preview: 60 })
  })

  it('refreshes LRU order on re-remember so an active tab is not evicted', () => {
    for (let i = 0; i < 60; i++) {
      rememberTabScroll(`note-${i}.md`, { editor: i, preview: i })
    }
    // Touch the oldest so it becomes most-recent, then push one more in.
    rememberTabScroll('note-0.md', { editor: 999, preview: 999 })
    rememberTabScroll('note-60.md', { editor: 60, preview: 60 })
    // note-1 (now oldest) is evicted; the refreshed note-0 survives.
    expect(recallTabScroll('note-1.md')).toBeUndefined()
    expect(recallTabScroll('note-0.md')).toEqual({ editor: 999, preview: 999 })
  })
})
