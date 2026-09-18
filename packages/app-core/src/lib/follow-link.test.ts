// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  selectNote: vi.fn(() => Promise.resolve()),
  assetFiles: [{ path: 'assets/diagram.png' }],
  openNoteInTab: vi.fn(() => Promise.resolve())
}))

const openWikilinkTarget = vi.hoisted(() => vi.fn(() => new Promise<void>(() => undefined)))
const offerCreateNoteFromLink = vi.hoisted(() => vi.fn())
const createNoteFromLinkNow = vi.hoisted(() => vi.fn())

vi.mock('../store', () => ({
  useStore: { getState: () => state }
}))

vi.mock('./wikilink-navigation', () => ({
  openDatabaseFromWikilink: () => false,
  openWikilinkHeading: vi.fn(),
  openWikilinkTarget
}))

vi.mock('./create-note-from-link', () => ({ offerCreateNoteFromLink, createNoteFromLinkNow }))

const { followLinkTarget } = await import('./follow-link')
const { useToastStore } = await import('./toast')

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

// #768: with the modifier held (or `gD`), a dead link creates its note at the
// suggested path at once; the confirmation is what the modifier answers.
describe('followLinkTarget: creating without asking (#768)', () => {
  it('creates the note straight away when asked not to confirm', () => {
    offerCreateNoteFromLink.mockClear()
    createNoteFromLinkNow.mockClear()

    expect(followLinkTarget('Brand new idea', { createWithoutAsking: true })).toBe(true)

    expect(createNoteFromLinkNow).toHaveBeenCalledWith('Brand new idea')
    expect(offerCreateNoteFromLink).not.toHaveBeenCalled()
  })

  it('still asks by default', () => {
    offerCreateNoteFromLink.mockClear()
    createNoteFromLinkNow.mockClear()

    expect(followLinkTarget('Brand new idea')).toBe(true)

    expect(offerCreateNoteFromLink).toHaveBeenCalledWith('Brand new idea')
    expect(createNoteFromLinkNow).not.toHaveBeenCalled()
  })

  it('never creates over an existing note, modifier or not', () => {
    createNoteFromLinkNow.mockClear()
    state.selectNote.mockClear()

    expect(followLinkTarget('Current', { createWithoutAsking: true })).toBe(true)

    expect(state.selectNote).toHaveBeenCalledWith('inbox/Current.md')
    expect(createNoteFromLinkNow).not.toHaveBeenCalled()
  })
})

describe('application links (#764)', () => {
  const openExternalUrl = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.setState({ toasts: [] })
    Object.defineProperty(window, 'zen', { configurable: true, value: { openExternalUrl } })
  })

  it.each([false, true])('never offers or creates a note for a disabled scheme (modifier: %s)', async (createWithoutAsking) => {
    openExternalUrl.mockResolvedValue({ ok: false, error: 'scheme-disabled' })
    followLinkTarget('zotero://open-pdf/library/items/W78FUE98', { createWithoutAsking })
    await vi.waitFor(() => expect(useToastStore.getState().toasts[0]?.action?.label).toBe('Open settings'))
    expect(offerCreateNoteFromLink).not.toHaveBeenCalled()
    expect(createNoteFromLinkNow).not.toHaveBeenCalled()
  })

  it('hands enabled application links to the host intact', async () => {
    openExternalUrl.mockResolvedValue({ ok: true })
    const url = 'zotero://open-pdf/library/items/W78FUE98?page=3#annotation=ABC'
    expect(followLinkTarget(url)).toBe(true)
    await vi.waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(url))
    expect(offerCreateNoteFromLink).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('blocks executable schemes before calling the host', () => {
    followLinkTarget('javascript:alert(1)', { createWithoutAsking: true })
    expect(openExternalUrl).not.toHaveBeenCalled()
    expect(createNoteFromLinkNow).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts[0]?.type).toBe('error')
  })

  it('explains failed app launches', async () => {
    openExternalUrl.mockResolvedValue({ ok: false, error: 'open-failed' })
    followLinkTarget('zotero://open-pdf/item')
    await vi.waitFor(() => expect(useToastStore.getState().toasts[0]?.message).toContain('Check that its application is installed'))
    expect(offerCreateNoteFromLink).not.toHaveBeenCalled()
  })
})
