import { describe, expect, it } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { extractTagBlocks } from '@shared/tag-blocks'
import { buildTagViewRows, nextNoteRowIndex, previousNoteRowIndex } from './tag-view-rows'

function note(path: string, title: string, excerpt = ''): NoteMeta {
  return {
    path,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt
  }
}

const ideas = note('inbox/Ideas.md', 'Ideas', 'A grab bag')
const journal = note('inbox/Journal.md', 'Journal', 'Monday')
const frontmatterOnly = note('inbox/Project.md', 'Project', 'Tagged up top')

const blocksByPath = new Map([
  [
    ideas.path,
    extractTagBlocks(
      ['- Recipe gallery #idea', '- Groceries', '- Plugin store #Idea #later', '- Dark mode #later'].join(
        '\n'
      )
    )
  ],
  [journal.path, extractTagBlocks('Woke up early.\n\nWrite the zine #idea')],
  [frontmatterOnly.path, extractTagBlocks('---\ntags: idea\n---\nNo inline tags here')]
])

describe('buildTagViewRows', () => {
  it('lists each note followed by its blocks that carry a selected tag', () => {
    const { rows, noteCount, blockCount } = buildTagViewRows(
      [ideas, journal, frontmatterOnly],
      blocksByPath,
      ['idea'],
      ''
    )
    expect(rows.map((r) => (r.kind === 'note' ? r.note.title : `  L${r.block.startLine + 1}`))).toEqual([
      'Ideas',
      '  L1',
      '  L3',
      'Journal',
      '  L3',
      'Project'
    ])
    expect(noteCount).toBe(3)
    expect(blockCount).toBe(3)
    // A frontmatter-only note keeps today's plain note row.
    expect(rows[5]).toMatchObject({ kind: 'note', blockCount: 0 })
  })

  it('matches block tags case-insensitively and leaves out blocks with other tags only', () => {
    const { rows } = buildTagViewRows([ideas], blocksByPath, ['IDEA'], '')
    expect(rows.filter((r) => r.kind === 'block')).toHaveLength(2)
  })

  it('lists a note whose blocks are not read yet as a note row alone', () => {
    const { rows } = buildTagViewRows([note('inbox/New.md', 'New')], blocksByPath, ['idea'], '')
    expect(rows).toEqual([expect.objectContaining({ kind: 'note', blockCount: 0 })])
  })

  it('keeps every block of a note whose title matches the filter', () => {
    const { rows } = buildTagViewRows([ideas, journal], blocksByPath, ['idea'], 'ideas')
    expect(rows.map((r) => r.kind)).toEqual(['note', 'block', 'block'])
  })

  it('narrows to the blocks whose text matches when only blocks match', () => {
    const { rows, noteCount, blockCount } = buildTagViewRows(
      [ideas, journal],
      blocksByPath,
      ['idea'],
      'plugin'
    )
    expect(rows.map((r) => (r.kind === 'block' ? r.block.text : r.note.title))).toEqual([
      'Ideas',
      'Plugin store #Idea #later'
    ])
    expect([noteCount, blockCount]).toEqual([1, 1])
  })

  it('narrows to matching blocks even when the excerpt also matches', () => {
    const openingIdea = note('inbox/Ideas.md', 'Ideas', 'Recipe gallery Groceries Plugin store')
    const { rows } = buildTagViewRows([openingIdea], blocksByPath, ['idea'], 'plugin')
    expect(rows.map((r) => r.kind)).toEqual(['note', 'block'])
  })

  it('keeps a note found only by its excerpt as a note row alone', () => {
    const { rows } = buildTagViewRows([ideas, journal], blocksByPath, ['idea'], 'grab bag')
    expect(rows).toEqual([expect.objectContaining({ kind: 'note', note: ideas, blockCount: 0 })])
  })

  it('gives each row a key that survives blocks filling in', () => {
    const { rows } = buildTagViewRows([ideas], blocksByPath, ['idea'], '')
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
    expect(rows[0]?.key).toBe(ideas.path)
  })
})

describe('note row hops', () => {
  const { rows } = buildTagViewRows([ideas, journal, frontmatterOnly], blocksByPath, ['idea'], '')

  it('moves to the next note past the current note blocks', () => {
    expect(nextNoteRowIndex(rows, 0)).toBe(3)
    expect(nextNoteRowIndex(rows, 1)).toBe(3)
    expect(nextNoteRowIndex(rows, 5)).toBe(-1)
  })

  it('moves from a block to its own note, and from a note to the one before', () => {
    expect(previousNoteRowIndex(rows, 4)).toBe(3)
    expect(previousNoteRowIndex(rows, 3)).toBe(0)
    expect(previousNoteRowIndex(rows, 0)).toBe(-1)
  })
})
