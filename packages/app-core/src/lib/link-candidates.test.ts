import { describe, it, expect } from 'vitest'
import type { FolderEntry, NoteFolder, NoteMeta } from '@shared/ipc'
import { DEFAULT_VAULT_SETTINGS } from '@shared/ipc'
import {
  linkCandidates,
  noteLinkTarget,
  noteSubtitle,
  notesMatchingSource,
  tagSourceSuggestions
} from './link-candidates'

const makeNote = (path: string, title: string, folder: NoteFolder = 'inbox'): NoteMeta =>
  ({
    path,
    title,
    folder,
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: ''
  }) as NoteMeta

const settings = DEFAULT_VAULT_SETTINGS

describe('linkCandidates ranking', () => {
  it('ranks exact title over prefix over substring', () => {
    const notes = [
      makeNote('inbox/Project Xylophone.md', 'Project Xylophone'),
      makeNote('inbox/Project.md', 'Project'),
      makeNote('inbox/My Project Notes.md', 'My Project Notes')
    ]
    const out = linkCandidates('project', { notes, vaultSettings: settings })
    expect(out.map((c) => c.label)).toEqual([
      'Project',
      'Project Xylophone',
      'My Project Notes'
    ])
  })

  it('excludes trash and the active note', () => {
    const notes = [
      makeNote('inbox/A.md', 'A'),
      makeNote('trash/B.md', 'B', 'trash'),
      makeNote('inbox/C.md', 'C')
    ]
    const out = linkCandidates('', { notes, vaultSettings: settings, activePath: 'inbox/C.md' })
    expect(out.map((c) => c.label)).toEqual(['A'])
  })

  it('boosts notes sharing the active note folder on equal text score', () => {
    const notes = [
      makeNote('archive/deep/Alpha One.md', 'Alpha One', 'archive'),
      makeNote('inbox/work/Alpha Two.md', 'Alpha Two')
    ]
    const out = linkCandidates('alpha', {
      notes,
      vaultSettings: settings,
      activePath: 'inbox/work/Current.md'
    })
    expect(out[0].label).toBe('Alpha Two')
  })

  it('merges .base databases with a title target and DATABASE subtitle', () => {
    const notes = [makeNote('inbox/Meetings note.md', 'Meetings note')]
    const folders = [
      { folder: 'inbox', subpath: 'Meetings.base' } as FolderEntry,
      { folder: 'trash', subpath: 'Old.base' } as FolderEntry
    ]
    const out = linkCandidates('meetings', { notes, folders, vaultSettings: settings })
    const db = out.find((c) => c.kind === 'database')
    expect(db?.label).toBe('Meetings')
    expect(db?.target).toBe('Meetings')
    expect(db?.subtitle.startsWith('DATABASE')).toBe(true)
    expect(out.some((c) => c.label === 'Old')).toBe(false)
  })

  it('respects the limit and omits assets when none are passed', () => {
    const notes = Array.from({ length: 40 }, (_, i) =>
      makeNote(`inbox/Note ${String(i).padStart(2, '0')}.md`, `Note ${String(i).padStart(2, '0')}`)
    )
    const out = linkCandidates('note', { notes, vaultSettings: settings, limit: 5 })
    expect(out).toHaveLength(5)
    expect(out.every((c) => c.kind === 'note')).toBe(true)
  })
})

describe('noteLinkTarget', () => {
  it('uses the bare title when it is unique', () => {
    const notes = [makeNote('inbox/deep/Unique.md', 'Unique'), makeNote('inbox/Other.md', 'Other')]
    expect(noteLinkTarget(notes[0], notes, settings)).toBe('Unique')
  })

  it('disambiguates duplicate titles with the inbox-stripped path form', () => {
    const notes = [
      makeNote('inbox/a/Dup.md', 'Dup'),
      makeNote('inbox/b/Dup.md', 'Dup')
    ]
    expect(noteLinkTarget(notes[0], notes, settings)).toBe('/a/Dup')
    expect(noteLinkTarget(notes[1], notes, settings)).toBe('/b/Dup')
  })

  it('keeps non-inbox duplicate paths verbatim', () => {
    const notes = [
      makeNote('archive/Dup.md', 'Dup', 'archive'),
      makeNote('inbox/Dup.md', 'Dup')
    ]
    expect(noteLinkTarget(notes[0], notes, settings)).toBe('archive/Dup')
  })
})

describe('notesMatchingSource (#500)', () => {
  const notes = [
    makeNote('inbox/projects/Acme.md', 'Acme'),
    makeNote('inbox/people/Jane.md', 'Jane'),
    makeNote('archive/Old.md', 'Old', 'archive')
  ]
  notes[1].tags.push('Person')

  it('passes everything through for the all-notes source', () => {
    expect(notesMatchingSource(notes, { kind: 'notes' })).toHaveLength(3)
    expect(notesMatchingSource(notes, null)).toHaveLength(3)
  })

  it('scopes to a folder prefix, trailing slash tolerant', () => {
    expect(notesMatchingSource(notes, { kind: 'folder', path: 'inbox/projects' }).map((n) => n.title)).toEqual(['Acme'])
    expect(notesMatchingSource(notes, { kind: 'folder', path: 'inbox/projects/' }).map((n) => n.title)).toEqual(['Acme'])
  })

  it('scopes to a tag case-insensitively', () => {
    expect(notesMatchingSource(notes, { kind: 'tag', tag: 'person' }).map((n) => n.title)).toEqual(['Jane'])
  })
})

describe('a field whose options come from a tag leaves template notes out (#1024)', () => {
  const notes = [
    makeNote('inbox/people/Jane.md', 'Jane'),
    makeNote('inbox/Templates/Person.md', 'Person'),
    makeNote('inbox/Templates/Only.md', 'Only')
  ]
  notes[0].tags.push('person')
  notes[1].tags.push('person', 'Template-Only')
  notes[2].tags.push('template-only')

  it('offers no template as an option for its tag', () => {
    expect(
      notesMatchingSource(notes, { kind: 'tag', tag: 'person' }, 'inbox/Templates').map((n) => n.title)
    ).toEqual(['Jane'])
  })

  it('still offers the folder itself when the field names it', () => {
    expect(
      notesMatchingSource(notes, { kind: 'folder', path: 'inbox/Templates' }, 'inbox/Templates').map(
        (n) => n.title
      )
    ).toEqual(['Person', 'Only'])
  })

  it('suggests no tag that only template notes carry when the tag is picked', () => {
    expect(tagSourceSuggestions(notes, 'inbox/Templates')).toEqual(['person'])
    expect(tagSourceSuggestions(notes, null)).toEqual(['person', 'template-only'])
  })
})

describe('noteSubtitle: the [[ picker shows the folder note search shows', () => {
  it('drops the main area directory and keeps every other area', () => {
    expect(noteSubtitle(makeNote('inbox/Projects/Atlas/Overview.md', 'Overview'), settings)).toBe(
      'Projects/Atlas/'
    )
    expect(
      noteSubtitle(makeNote('archive/2025/Atlas/Overview.md', 'Overview', 'archive'), settings)
    ).toBe('archive/2025/Atlas/')
  })

  it('labels a note at the top of an area with the area', () => {
    expect(noteSubtitle(makeNote('inbox/Overview.md', 'Overview'), settings)).toBe('inbox/')
    expect(noteSubtitle(makeNote('archive/Overview.md', 'Overview', 'archive'), settings)).toBe(
      'archive/'
    )
    const rootMode = { ...settings, primaryNotesLocation: 'root' as const }
    expect(noteSubtitle(makeNote('Overview.md', 'Overview'), rootMode)).toBe('')
  })
})
