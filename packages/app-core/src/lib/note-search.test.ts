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
    hasAttachments: false,
    excerpt: '',
    ...overrides
  }
}

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
