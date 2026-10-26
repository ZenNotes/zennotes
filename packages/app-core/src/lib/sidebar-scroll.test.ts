import { describe, expect, it } from 'vitest'
import {
  getScrollTopForPreservedSidebarAnchor,
  isRecentSidebarPointerInteraction,
  sidebarSelectionChanged
} from './sidebar-scroll'

// #993: the reveal re-ran on every listing refresh and on the open note
// coming back after a folder selection, and each run pulled the Vim cursor
// onto the open note.
describe('sidebarSelectionChanged', () => {
  const folderView = { kind: 'folder', folder: 'inbox', subpath: 'Projects' }
  const tags: string[] = []

  it('reveals the first time, after focus comes back (no previous selection)', () => {
    expect(sidebarSelectionChanged(null, ['inbox/a.md', folderView, false, tags])).toBe(true)
  })

  it('stays put when nothing the person selects has changed', () => {
    const selection = ['inbox/a.md', folderView, false, tags]
    expect(sidebarSelectionChanged(selection, ['inbox/a.md', folderView, false, tags])).toBe(false)
  })

  it('follows a different note, a new view, or a toggled special view', () => {
    const selection = ['inbox/a.md', folderView, false, tags]
    expect(sidebarSelectionChanged(selection, ['inbox/b.md', folderView, false, tags])).toBe(true)
    expect(sidebarSelectionChanged(selection, ['inbox/a.md', { ...folderView }, false, tags])).toBe(true)
    expect(sidebarSelectionChanged(selection, ['inbox/a.md', folderView, true, tags])).toBe(true)
    expect(sidebarSelectionChanged(selection, ['inbox/a.md', folderView, false, ['x']])).toBe(true)
  })
})

describe('sidebar scroll anchoring', () => {
  it('keeps the interacted row at the same visual offset', () => {
    expect(
      getScrollTopForPreservedSidebarAnchor({
        scrollTop: 300,
        anchorTop: 40,
        nextAnchorTop: 120,
        scrollHeight: 1_000,
        clientHeight: 400
      })
    ).toBe(380)
  })

  it('clamps preserved scroll positions to the available range', () => {
    expect(
      getScrollTopForPreservedSidebarAnchor({
        scrollTop: 590,
        anchorTop: 20,
        nextAnchorTop: 140,
        scrollHeight: 1_000,
        clientHeight: 400
      })
    ).toBe(600)
  })

  it('treats only fresh pointer interactions as pointer anchored', () => {
    expect(isRecentSidebarPointerInteraction(100, 500, 1_200)).toBe(true)
    expect(isRecentSidebarPointerInteraction(100, 1_500, 1_200)).toBe(false)
    expect(isRecentSidebarPointerInteraction(0, 500, 1_200)).toBe(false)
  })
})
