// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

// #768: a modifier click or `gD` on an unresolved wikilink creates the note
// where the prompt would have suggested, without showing the prompt.

const state = vi.hoisted(() => ({
  notes: [{ path: 'inbox/Existing.md', title: 'Existing', folder: 'inbox' as const }],
  vaultSettings: null as unknown,
  selectNote: vi.fn(() => Promise.resolve()),
  createAndOpen: vi.fn(() => Promise.resolve()),
  openDailyNoteForDate: vi.fn((_date: Date) => Promise.resolve()),
  openWeeklyNoteForDate: vi.fn((_date: Date) => Promise.resolve()),
  openMonthlyNoteForDate: vi.fn((_date: Date) => Promise.resolve()),
  createNoteInPlace: vi.fn((folder: string, subpath: string, title: string) =>
    Promise.resolve({ path: `${folder}/${subpath ? `${subpath}/` : ''}${title}.md` } as {
      path: string
    } | null)
  ),
  ensureDailyNoteForDate: vi.fn((_date: Date) =>
    Promise.resolve({ path: 'Daily Notes/2026-11-03.md' } as { path: string } | null)
  ),
  setFocusedPanel: vi.fn(),
  editorViewRef: null
}))
const promptApp = vi.hoisted(() => vi.fn(() => Promise.resolve(null)))
const confirmApp = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))

vi.mock('../store', () => ({ useStore: { getState: () => state } }))
vi.mock('./prompt-requests', () => ({ promptApp }))
vi.mock('./confirm-requests', () => ({ confirmApp }))

const { createNoteForLinkInPlace, createNoteFromLinkNow, offerCreateNoteFromLink } = await import(
  './create-note-from-link'
)

beforeEach(() => {
  promptApp.mockClear()
  confirmApp.mockClear()
  state.vaultSettings = null
  state.selectNote.mockClear()
  state.createAndOpen.mockClear()
  state.openDailyNoteForDate.mockClear()
  state.openWeeklyNoteForDate.mockClear()
  state.openMonthlyNoteForDate.mockClear()
  state.createNoteInPlace.mockClear()
  state.ensureDailyNoteForDate.mockClear()
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

describe('a dead link that names a periodic note', () => {
  const periodic = {
    dailyNotes: { enabled: true, directory: 'Daily Notes' },
    weeklyNotes: { enabled: true, directory: 'Weekly Notes' }
  }
  const dayOf = (date: Date | undefined): string | null =>
    date ? `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` : null

  it("creates that day's daily note, not a plain Inbox note", async () => {
    state.vaultSettings = periodic
    await createNoteFromLinkNow('2026-11-03')

    expect(state.createAndOpen).not.toHaveBeenCalled()
    expect(state.openDailyNoteForDate).toHaveBeenCalledTimes(1)
    expect(dayOf(state.openDailyNoteForDate.mock.calls[0]?.[0])).toBe('2026-11-3')
  })

  it('asks the way the calendar does, then creates it', async () => {
    state.vaultSettings = periodic
    await offerCreateNoteFromLink('2026-11-03#Research')

    expect(promptApp).not.toHaveBeenCalled()
    expect(confirmApp).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New daily note', confirmLabel: 'Create' })
    )
    expect(dayOf(state.openDailyNoteForDate.mock.calls[0]?.[0])).toBe('2026-11-3')
  })

  it('creates nothing when the question is declined', async () => {
    state.vaultSettings = periodic
    confirmApp.mockResolvedValueOnce(false)
    await offerCreateNoteFromLink('2026-11-03')

    expect(state.openDailyNoteForDate).not.toHaveBeenCalled()
    expect(state.createAndOpen).not.toHaveBeenCalled()
  })

  it('goes to the weekly note for a week title', async () => {
    state.vaultSettings = periodic
    await createNoteFromLinkNow('2026-W45')

    expect(state.openWeeklyNoteForDate).toHaveBeenCalledTimes(1)
    expect(state.openDailyNoteForDate).not.toHaveBeenCalled()
  })

  it('keeps the plain path when daily notes are off or the link names a folder', async () => {
    await createNoteFromLinkNow('2026-11-03')
    expect(state.createAndOpen).toHaveBeenLastCalledWith('inbox', '', { title: '2026-11-03' })

    state.vaultSettings = periodic
    await createNoteFromLinkNow('journal/2026-11-03')
    expect(state.createAndOpen).toHaveBeenLastCalledWith('inbox', 'journal', { title: '2026-11-03' })
    expect(state.openDailyNoteForDate).not.toHaveBeenCalled()
  })
})


// uNyanda (Discord): hover a link and create or edit its note in a small
// floating window, without leaving the note. The link popover creates the
// note where gD would, but never opens it: the popover edits it in place.
describe('createNoteForLinkInPlace (link popover)', () => {
  it('creates the note named after the link without opening or prompting', async () => {
    const path = await createNoteForLinkInPlace('Garden Plan')

    expect(path).toBe('inbox/Garden Plan.md')
    expect(state.createNoteInPlace).toHaveBeenCalledWith('inbox', '', 'Garden Plan')
    expect(state.createAndOpen).not.toHaveBeenCalled()
    expect(state.selectNote).not.toHaveBeenCalled()
    expect(promptApp).not.toHaveBeenCalled()
  })

  it('drops a heading anchor and an alias-free path keeps its folders', async () => {
    await createNoteForLinkInPlace('projects/Plan#Goals')
    expect(state.createNoteInPlace).toHaveBeenLastCalledWith('inbox', 'projects', 'Plan')

    await createNoteForLinkInPlace('archive/Old idea')
    expect(state.createNoteInPlace).toHaveBeenLastCalledWith('archive', '', 'Old idea')
  })

  it('answers with an existing note at that path instead of creating a second one', async () => {
    const path = await createNoteForLinkInPlace('existing')

    expect(path).toBe('inbox/Existing.md')
    expect(state.createNoteInPlace).not.toHaveBeenCalled()
    expect(state.selectNote).not.toHaveBeenCalled()
  })

  it("makes a daily-note link that day's daily note, still without opening it", async () => {
    state.vaultSettings = {
      dailyNotes: { enabled: true, directory: 'Daily Notes' },
      weeklyNotes: { enabled: true, directory: 'Weekly Notes' }
    }
    const path = await createNoteForLinkInPlace('2026-11-03')

    expect(path).toBe('Daily Notes/2026-11-03.md')
    expect(state.ensureDailyNoteForDate).toHaveBeenCalledTimes(1)
    expect(state.openDailyNoteForDate).not.toHaveBeenCalled()
    expect(state.createNoteInPlace).not.toHaveBeenCalled()
  })

  it('leaves a weekly note to the opening path, which runs its template', async () => {
    state.vaultSettings = {
      dailyNotes: { enabled: true, directory: 'Daily Notes' },
      weeklyNotes: { enabled: true, directory: 'Weekly Notes' }
    }
    expect(await createNoteForLinkInPlace('2026-W45')).toBeNull()
    expect(state.createNoteInPlace).not.toHaveBeenCalled()
    expect(state.openWeeklyNoteForDate).not.toHaveBeenCalled()
  })

  it('reports a failed create as null, and a name no file can carry the same way', async () => {
    state.createNoteInPlace.mockResolvedValueOnce(null)
    expect(await createNoteForLinkInPlace('Will fail')).toBeNull()
    expect(await createNoteForLinkInPlace('bad|name?')).toBeNull()
  })
})
