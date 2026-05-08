import { describe, expect, it } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { buildNoteSearchIndex, searchNoteIndex } from './note-search'
import { getVirtualRange } from './virtual-list'

const NOTE_COUNT = 25_000

function makeNote(index: number): NoteMeta {
  const folder = index % 17 === 0 ? 'archive' : index % 13 === 0 ? 'quick' : 'inbox'
  const tag = index % 10 === 0 ? 'milestone' : `tag-${index % 20}`
  const id = String(index).padStart(5, '0')
  return {
    path: `${folder}/folder-${index % 100}/Note ${id}.md`,
    title: `Note ${id}`,
    folder,
    siblingOrder: index,
    createdAt: index,
    updatedAt: NOTE_COUNT - index,
    size: 512,
    tags: ['perf', tag],
    wikilinks: [`Target ${index % 200}`],
    hasAttachments: index % 31 === 0,
    excerpt: `Synthetic renderer benchmark note ${index} with phrase needle-${index} and desktop-runtime-benchmark-${id}.`
  }
}

function measure<T>(label: string, detail: Record<string, unknown>, fn: () => T): T {
  const startedAt = performance.now()
  const value = fn()
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100
  console.info(`[zen:bench] ${label} ${durationMs.toFixed(2)}ms`, detail)
  return value
}

describe.skipIf(process.env['ZEN_PERF_BENCH'] !== '1')('app-core performance', () => {
  it('measures note search and virtual range costs at large-vault scale', () => {
    const notes = measure('noteMeta.generate', { notes: NOTE_COUNT }, () =>
      Array.from({ length: NOTE_COUNT }, (_, index) => makeNote(index))
    )

    const index = measure('noteSearch.buildIndex', { notes: NOTE_COUNT }, () =>
      buildNoteSearchIndex(notes)
    )
    expect(index).toHaveLength(NOTE_COUNT)

    const titleResults = measure('noteSearch.title', { query: 'Note 24999' }, () =>
      searchNoteIndex(index, 'Note 24999', { limit: 20 })
    )
    expect(titleResults[0]?.path).toBe('quick/folder-99/Note 24999.md')

    const tagResults = measure('noteSearch.tagFilter', { query: '#milestone needle-2500' }, () =>
      searchNoteIndex(index, '#milestone needle-2500', { limit: 20 })
    )
    expect(tagResults.some((note) => note.path.endsWith('Note 02500.md'))).toBe(true)

    const longTokenResults = measure(
      'noteSearch.longExactToken',
      { query: 'desktop-runtime-benchmark-24999' },
      () => searchNoteIndex(index, 'desktop-runtime-benchmark-24999', { limit: 20 })
    )
    expect(longTokenResults[0]?.path).toBe('quick/folder-99/Note 24999.md')

    const defaultResults = measure('noteSearch.emptyQuickFirst', { query: '' }, () =>
      searchNoteIndex(index, '', { limit: 30, defaultOrder: 'quick-first-recent' })
    )
    expect(defaultResults).toHaveLength(30)
    expect(defaultResults[0]?.folder).toBe('quick')

    const range = measure('virtualList.range', { rows: NOTE_COUNT, scrollTop: 1_000_000 }, () =>
      getVirtualRange({
        itemCount: NOTE_COUNT,
        itemSize: 76,
        scrollTop: 1_000_000,
        viewportHeight: 900,
        overscan: 8
      })
    )
    expect(range.end - range.start).toBeLessThanOrEqual(29)
  })
})
