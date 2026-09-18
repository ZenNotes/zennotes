// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

// #768: a modifier click or `gD` on an unresolved wikilink creates the note
// where the prompt would have suggested, without showing the prompt.

const state = vi.hoisted(() => ({
  notes: [{ path: 'inbox/Existing.md', title: 'Existing', folder: 'inbox' as const }],
  selectNote: vi.fn(() => Promise.resolve()),
  createAndOpen: vi.fn(() => Promise.resolve()),
  setFocusedPanel: vi.fn(),
  editorViewRef: null
}))
const promptApp = vi.hoisted(() => vi.fn(() => Promise.resolve(null)))

vi.mock('../store', () => ({ useStore: { getState: () => state } }))
vi.mock('./prompt-requests', () => ({ promptApp }))

const { createNoteFromLinkNow, offerCreateNoteFromLink } = await import('./create-note-from-link')

beforeEach(() => {
  promptApp.mockClear()
  state.selectNote.mockClear()
  state.createAndOpen.mockClear()
})

describe('createNoteFromLinkNow (#768)', () => {
  it('creates the note in Inbox, named after the link, without prompting', async () => {
    await createNoteFromLinkNow('Brand new idea')

    expect(promptApp).not.toHaveBeenCalled()
    expect(state.createAndOpen).toHaveBeenCalledWith('inbox', '', { title: 'Brand new idea' })
  })

  it('keeps a path-style link under Inbox and drops a heading anchor', async () => {
    await createNoteFromLinkNow('projects/Plan#Goals')

    expect(state.createAndOpen).toHaveBeenCalledWith('inbox', 'projects', { title: 'Plan' })
  })

  it('honors an explicit top folder', async () => {
    await createNoteFromLinkNow('archive/Old idea')

    expect(state.createAndOpen).toHaveBeenCalledWith('archive', '', { title: 'Old idea' })
  })

  it('opens a note that already exists at the suggested path instead of creating', async () => {
    await createNoteFromLinkNow('Existing')

    expect(state.createAndOpen).not.toHaveBeenCalled()
    expect(state.selectNote).toHaveBeenCalledWith('inbox/Existing.md')
  })

  it('the confirming path still prompts first', async () => {
    await offerCreateNoteFromLink('Brand new idea')

    expect(promptApp).toHaveBeenCalledTimes(1)
    expect(state.createAndOpen).not.toHaveBeenCalled()
  })
})
