import { describe, expect, it } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import {
  buildNoteSearchIndex,
  parseNoteSearchQuery,
  searchNoteIndex
} from './note-search'

function note(
  path: string,
  title: string,
  overrides: Partial<NoteMeta> = {}
): NoteMeta {
  return {
    path,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    size: 10,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: '',
    ...overrides
  }
}

// #1024: notes in the template folder are placeholders, not notes anyone is
// looking for, so Search notes leaves them out until the query names the folder.
describe('note search and the template folder', () => {
  const entries = buildNoteSearchIndex([
    note('Templates/Meeting.md', 'Meeting', { excerpt: 'Agenda' }),
    note('Templates/Work/Standup.md', 'Standup'),
    note('Notes/Meeting with Ana.md', 'Meeting with Ana', { excerpt: 'Agenda' }),
    note('Templates Old/Meeting.md', 'Meeting old')
  ])
  const titles = (query: string, templateFolder: string | null = 'Templates'): string[] =>
    searchNoteIndex(entries, query, { limit: 10, templateFolder }).map((n) => n.title).sort()

  it('leaves template notes out of matches and of the empty-query list', () => {
    expect(titles('meeting')).toEqual(['Meeting old', 'Meeting with Ana'])
    expect(titles('agenda')).toEqual(['Meeting with Ana'])
    expect(titles('')).toEqual(['Meeting old', 'Meeting with Ana'])
  })

  it('finds them again when the query starts with the folder path', () => {
    expect(titles('templates/')).toEqual(['Meeting', 'Standup'])
    expect(titles('Templates/meet')).toEqual(['Meeting'])
    expect(titles('Templates/Work/st')).toEqual(['Standup'])
  })

  it('shows everything when the vault has no template folder', () => {
    expect(titles('meeting', null)).toEqual(['Meeting', 'Meeting old', 'Meeting with Ana'])
  })
})

describe('note search', () => {
  it('parses free text and inline tag filters', () => {
    expect(parseNoteSearchQuery('#ops migration #prod')).toEqual({
      freeText: 'migration',
      tagTokens: ['ops', 'prod']
    })
  })

  it('requires every requested tag and excludes trash', () => {
    const entries = buildNoteSearchIndex([
      note('inbox/a.md', 'Alpha', { tags: ['Ops', 'Prod'] }),
      note('inbox/b.md', 'Beta', { tags: ['ops'] }),
      note('trash/c.md', 'Gamma', { folder: 'trash', tags: ['ops', 'prod'] })
    ])

    expect(searchNoteIndex(entries, '#ops #prod', { limit: 10 }).map((n) => n.title)).toEqual([
      'Alpha'
    ])
  })

  it('ranks title matches ahead of weaker excerpt matches', () => {
    const entries = buildNoteSearchIndex([
      note('inbox/body.md', 'Weekly notes', {
        excerpt: 'Database migration runbook',
        updatedAt: 3
      }),
      note('inbox/title.md', 'Migration plan', {
        excerpt: 'Checklist',
        updatedAt: 2
      })
    ])

    expect(searchNoteIndex(entries, 'migration', { limit: 10 }).map((n) => n.title)).toEqual([
      'Migration plan',
      'Weekly notes'
    ])
  })

  it('does not mix weak fuzzy excerpt matches into a unique word result (#666)', () => {
    const entries = buildNoteSearchIndex([
      note('inbox/permissions.md', 'Linux file permissions', {
        excerpt: 'Restore ownership with the chown command before restarting the service.'
      }),
      note('inbox/coffee.md', 'Check how to make coffee, choose beans, and grind them', {
        excerpt: 'A long collection of brewing notes and recommendations for home use.'
      }),
      note('inbox/joplin.md', 'Joplin', {
        excerpt: 'A checklist showing how notes can be organized when moving applications.'
      })
    ])

    expect(searchNoteIndex(entries, 'chown', { limit: 20 }).map((n) => n.title)).toEqual([
      'Linux file permissions'
    ])
  })

  it('finds long exact tokens without requiring fuzzy scoring', () => {
    const entries = buildNoteSearchIndex([
      note('inbox/a.md', 'Alpha', {
        excerpt: 'Contains searchable token desktop-runtime-benchmark-04999.'
      }),
      note('inbox/b.md', 'Beta', {
        excerpt: 'Contains searchable token desktop-runtime-benchmark-00001.'
      })
    ])

    expect(
      searchNoteIndex(entries, 'desktop-runtime-benchmark-04999', { limit: 10 }).map(
        (n) => n.title
      )
    ).toEqual(['Alpha'])
  })

  it('falls back to fuzzy scoring when a long query has no exact matches', () => {
    const entries = buildNoteSearchIndex([
      note('inbox/a.md', 'Desktop runtime benchmark launch checklist'),
      note('inbox/b.md', 'Release notes')
    ])

    expect(
      searchNoteIndex(entries, 'desktopruntimebenchmark', { limit: 10 }).map((n) => n.title)
    ).toEqual(['Desktop runtime benchmark launch checklist'])
  })

  it('uses quick-first recency ordering for empty quick-capture searches', () => {
    const entries = buildNoteSearchIndex([
      note('inbox/new.md', 'New inbox', { updatedAt: 20 }),
      note('quick/old.md', 'Old quick', { folder: 'quick', updatedAt: 1 }),
      note('archive/archive.md', 'Archive', { folder: 'archive', updatedAt: 30 })
    ])

    expect(
      searchNoteIndex(entries, '', {
        limit: 10,
        defaultOrder: 'quick-first-recent'
      }).map((n) => n.title)
    ).toEqual(['Old quick', 'Archive', 'New inbox'])
  })
})
