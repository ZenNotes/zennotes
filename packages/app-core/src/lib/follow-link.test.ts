// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  assetFiles: [{ path: 'assets/diagram.png' }, { path: 'assets/papers/paper.pdf' }],
  paneLayout: { kind: 'leaf' as const, id: 'p1', tabs: [] as string[], pinnedTabs: [] as string[] },
  openNoteInTab: vi.fn(() => Promise.resolve())
}))

const openWikilinkTarget = vi.hoisted(() => vi.fn(() => new Promise<void>(() => undefined)))
const offerCreateNoteFromLink = vi.hoisted(() => vi.fn())
const createNoteFromLinkNow = vi.hoisted(() => vi.fn())

vi.mock('../store', () => ({
  useStore: { getState: () => state, subscribe: vi.fn(() => () => undefined) }
}))

vi.mock('./wikilink-navigation', () => ({
  openDatabaseFromWikilink: () => false,
  openWikilinkHeading: vi.fn(),
  openWikilinkTarget
}))

vi.mock('./create-note-from-link', () => ({ offerCreateNoteFromLink, createNoteFromLinkNow }))

const { followLinkTarget } = await import('./follow-link')
const { useToastStore } = await import('./toast')
const { assetTabLocation } = await import('./asset-tab-location')

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

  it("opens a PDF link's tab at the page and zoom the link names (#1085)", () => {
    state.openNoteInTab.mockClear()
    const tab = 'zen://asset/assets%2Fpapers%2Fpaper.pdf'

    expect(followLinkTarget('assets/papers/paper.pdf#page=3&zoom=120,0,400')).toBe(true)
    expect(state.openNoteInTab).toHaveBeenCalledWith(tab)
    const first = assetTabLocation(tab)
    expect(first?.fragment).toBe('#page=3&zoom=120,0,400')

    // Following the same link again is a new request, so the frame returns
    // to the spot even if the reader scrolled away.
    followLinkTarget('assets/papers/paper.pdf#page=3&zoom=120,0,400')
    expect(assetTabLocation(tab)?.nonce).not.toBe(first?.nonce)
  })

  it('opens a PDF link without a fragment where it always did', () => {
    state.openNoteInTab.mockClear()
    followLinkTarget('assets/diagram.png#ignored')
    expect(state.openNoteInTab).toHaveBeenCalledWith('zen://asset/assets%2Fdiagram.png')
    expect(assetTabLocation('zen://asset/assets%2Fdiagram.png')).toBeNull()
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

// A wikilink names a note. Followed as an href, `[[2024.01.15]]` passed the
// bare-domain guess and opened https://2024.01.15 in the browser.
describe('followLinkTarget: wikilink names that look like domains', () => {
  const open = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('open', open)
    state.notes.push({ path: 'inbox/2024.01.15.md', title: '2024.01.15', folder: 'inbox' })
  })
  afterEach(() => {
    state.notes.splice(1)
    vi.unstubAllGlobals()
  })

  it('opens the note [[2024.01.15]] names, not https://2024.01.15', () => {
    expect(followLinkTarget('2024.01.15', { kind: 'wikilink' })).toBe(true)

    expect(open).not.toHaveBeenCalled()
    expect(state.selectNote).toHaveBeenCalledWith('inbox/2024.01.15.md')
  })

  it('creates a dated note that does not exist yet instead of opening the browser', () => {
    expect(followLinkTarget('2025.12.31', { kind: 'wikilink', createWithoutAsking: true })).toBe(true)

    expect(open).not.toHaveBeenCalled()
    expect(createNoteFromLinkNow).toHaveBeenCalledWith('2025.12.31')
  })

  it('still opens a wikilink written with a scheme, and a bare-domain href (#201)', () => {
    followLinkTarget('https://example.net', { kind: 'wikilink' })
    followLinkTarget('example.com')

    expect(open.mock.calls).toEqual([
      ['https://example.net', '_blank'],
      ['https://example.com', '_blank']
    ])
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
