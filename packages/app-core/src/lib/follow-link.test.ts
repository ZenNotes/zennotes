// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  selectedPath: 'inbox/Current.md' as string | null,
  notes: [
    {
      path: 'inbox/Current.md',
      title: 'Current',
      folder: 'inbox' as const
    }
  ],
  setFocusedPanel: vi.fn(),
  editorViewRef: null,
  selectNote: vi.fn(),
  assetFiles: [{ path: 'assets/diagram.png' }],
  openNoteInTab: vi.fn(() => Promise.resolve())
}))

const openWikilinkTarget = vi.hoisted(() => vi.fn(() => new Promise<void>(() => undefined)))
const offerCreateNoteFromLink = vi.hoisted(() => vi.fn())

vi.mock('../store', () => ({
  useStore: { getState: () => state }
}))

vi.mock('./wikilink-navigation', () => ({
  openDatabaseFromWikilink: () => false,
  openWikilinkHeading: vi.fn(),
  openWikilinkTarget
}))

vi.mock('./create-note-from-link', () => ({ offerCreateNoteFromLink }))

const { followLinkTarget } = await import('./follow-link')

describe('followLinkTarget: same-note anchors (#601)', () => {
  it('opens [[^block]] in the selected note instead of offering to create a note', () => {
    expect(followLinkTarget('^standalone')).toBe(true)

    expect(openWikilinkTarget).toHaveBeenCalledWith('inbox/Current.md', '^standalone')
    expect(offerCreateNoteFromLink).not.toHaveBeenCalled()
  })
})

describe('followLinkTarget: wikilinks at vault files (#757)', () => {
  it('opens the file in an asset tab instead of offering to create a note named after it', () => {
    offerCreateNoteFromLink.mockClear()
    state.openNoteInTab.mockClear()

    expect(followLinkTarget('assets/diagram.png')).toBe(true)

    expect(state.openNoteInTab).toHaveBeenCalledWith('zen://asset/assets%2Fdiagram.png')
    expect(offerCreateNoteFromLink).not.toHaveBeenCalled()
  })

  it('still offers to create a note for a target no file answers', () => {
    offerCreateNoteFromLink.mockClear()
    state.openNoteInTab.mockClear()

    expect(followLinkTarget('Nowhere')).toBe(true)

    expect(state.openNoteInTab).not.toHaveBeenCalled()
    expect(offerCreateNoteFromLink).toHaveBeenCalledWith('Nowhere')
  })
})
