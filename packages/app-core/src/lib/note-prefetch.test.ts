import { describe, expect, it } from 'vitest'
import type { NoteFolder, NoteMeta } from '@shared/ipc'
import { selectInitialVisibleNotePrefetchPaths } from './note-prefetch'

function note(folder: NoteFolder, index: number, overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    path: `${folder}/note-${index}.md`,
    title: `${folder} ${index}`,
    folder,
    siblingOrder: index,
    createdAt: index,
    updatedAt: index,
    size: 10,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    excerpt: '',
    ...overrides
  }
}

describe('selectInitialVisibleNotePrefetchPaths', () => {
  it('spreads the warmup budget across visible system folders', () => {
    const notes = [
      ...Array.from({ length: 40 }, (_, index) => note('quick', index)),
      ...Array.from({ length: 4 }, (_, index) => note('inbox', index)),
      ...Array.from({ length: 4 }, (_, index) => note('archive', index)),
      ...Array.from({ length: 4 }, (_, index) => note('trash', index))
    ]

    const paths = selectInitialVisibleNotePrefetchPaths(notes, 'none', { batchSize: 12 })

    expect(paths).toHaveLength(12)
    expect(paths.slice(0, 4).map((path) => path.split('/')[0])).toEqual([
      'quick',
      'inbox',
      'archive',
      'trash'
    ])
    expect(new Set(paths.map((path) => path.split('/')[0]))).toEqual(
      new Set(['quick', 'inbox', 'archive', 'trash'])
    )
  })

  it('keeps prefetch candidates bounded to the initially rendered sidebar rows', () => {
    const notes = Array.from({ length: 10 }, (_, index) => note('inbox', index))

    expect(
      selectInitialVisibleNotePrefetchPaths(notes, 'none', {
        batchSize: 10,
        visibleRows: 3,
        edgeRows: 10
      })
    ).toEqual(['inbox/note-2.md', 'inbox/note-0.md', 'inbox/note-1.md'])
  })

  it('honors the active note sort order before selecting visible edges', () => {
    const notes = [
      note('quick', 0, { title: 'Beta' }),
      note('quick', 1, { title: 'Alpha' }),
      note('quick', 2, { title: 'Gamma' })
    ]

    expect(
      selectInitialVisibleNotePrefetchPaths(notes, 'name-asc', {
        batchSize: 3,
        visibleRows: 3,
        edgeRows: 3
      })
    ).toEqual(['quick/note-2.md', 'quick/note-1.md', 'quick/note-0.md'])
  })
})
