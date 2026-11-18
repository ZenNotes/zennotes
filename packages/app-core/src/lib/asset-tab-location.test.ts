// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  vault: { root: '/vault' },
  pinAssetReferenceForNote: vi.fn(),
  openNoteInTab: vi.fn(() => Promise.resolve()),
  paneLayout: { kind: 'leaf' as const, id: 'p1', tabs: [] as string[], pinnedTabs: [] as string[] }
}))

vi.mock('../store', () => ({
  useStore: { getState: () => state, subscribe: vi.fn(() => () => undefined) }
}))

Object.defineProperty(window, 'zen', {
  configurable: true,
  value: { resolveVaultAssetUrl: (root: string, path: string) => `zen-asset://local${root}/${path}` }
})

const { pinPdfReferenceAt, useAssetTabLocations } = await import('./asset-tab-location')

describe('pinPdfReferenceAt (#1085)', () => {
  beforeEach(() => {
    state.pinAssetReferenceForNote.mockClear()
    useAssetTabLocations.setState({ byTab: {}, referenceJumps: {} })
  })

  const url = 'zen-asset://local/vault/assets/paper.pdf#page=4&zoom=150,0,333'

  it("pins at the link's spot and asks its frame to jump there", () => {
    pinPdfReferenceAt('notes/Reading.md', 'assets/paper.pdf', '#page=4&zoom=150,0,333')
    expect(state.pinAssetReferenceForNote).toHaveBeenCalledWith(
      'notes/Reading.md',
      'assets/paper.pdf',
      '#page=4&zoom=150,0,333'
    )
    expect(useAssetTabLocations.getState().referenceJumps[url]).toBeTypeOf('number')
  })

  it('jumps again when the same link is followed after scrolling away', () => {
    pinPdfReferenceAt('notes/Reading.md', 'assets/paper.pdf', '#page=4&zoom=150,0,333')
    const first = useAssetTabLocations.getState().referenceJumps[url]
    pinPdfReferenceAt('notes/Reading.md', 'assets/paper.pdf', '#page=4&zoom=150,0,333')
    expect(useAssetTabLocations.getState().referenceJumps[url]).not.toBe(first)
  })

  it('pins a link without a page as before, with no jump', () => {
    pinPdfReferenceAt('notes/Reading.md', 'assets/paper.pdf', '')
    expect(state.pinAssetReferenceForNote).toHaveBeenCalledWith('notes/Reading.md', 'assets/paper.pdf', null)
    expect(useAssetTabLocations.getState().referenceJumps).toEqual({})
  })
})
