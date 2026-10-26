import { describe, expect, it } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { extractTagBlocks } from '@shared/tag-blocks'
import { buildSearchPaletteRows, type SearchPaletteRow } from './search-palette-rows'

function note(path: string, title: string, updatedAt = 0): NoteMeta {
  return {
    path,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt,
    size: 0,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: ''
  }
}

const ideas = note('inbox/Ideas.md', 'Ideas', 3)
const journal = note('inbox/Journal.md', 'Journal', 2)
const deep = note('inbox/Deep.md', 'Deep', 1)
const plain = note('inbox/Plain.md', 'Plain', 0)

const blocksByPath = new Map([
  [
    ideas.path,
    extractTagBlocks(
      [
        '- Recipe gallery #idea',
        '- Plugin store #idea',
        '- Dark mode #idea #later',
        '- Zine #idea',
        '- Groceries'
      ].join('\n')
    )
  ],
  [journal.path, extractTagBlocks('Woke up.\n\nWrite a zine about walking #idea')],
  [deep.path, extractTagBlocks('# Deep\n\nLots of prose.\n\n- Gallery wall for the hallway #idea')],
  [plain.path, extractTagBlocks('---\ntags: [idea]\n---\nOnly frontmatter.')]
])

const shape = (rows: SearchPaletteRow[]): string[] =>
  rows.map((r) =>
    r.kind === 'note'
      ? r.note.title
      : r.kind === 'more'
        ? `  +${r.hidden} more`
        : `  L${r.block.startLine + 1} ${r.block.text}`
  )

const base = {
  tagged: [ideas, journal, deep, plain],
  blocksByPath,
  freeText: '',
  enabled: true,
  limit: 20
}

describe('buildSearchPaletteRows', () => {
  it('lists two tagged blocks per note, then a row for the rest', () => {
    const rows = buildSearchPaletteRows({
      ...base,
      results: [ideas, journal, plain],
      tagTokens: ['idea']
    })
    expect(shape(rows)).toEqual([
      'Ideas',
      '  L1 Recipe gallery #idea',
      '  L2 Plugin store #idea',
      '  +2 more',
      'Journal',
      '  L3 Write a zine about walking #idea',
      'Plain'
    ])
  })

  it('puts blocks carrying every query tag first, then those carrying any', () => {
    const rows = buildSearchPaletteRows({
      ...base,
      results: [ideas],
      tagTokens: ['idea', 'later']
    })
    expect(shape(rows)).toEqual(['Ideas', '  L3 Dark mode #idea #later', '  L1 Recipe gallery #idea', '  +2 more'])
  })

  it('narrows blocks to the free text and lists a note found by a deep block first', () => {
    const rows = buildSearchPaletteRows({
      ...base,
      // The search ranked Ideas (excerpt) and Plain (title); Deep matched neither.
      results: [plain, ideas],
      tagTokens: ['idea'],
      freeText: 'gallery'
    })
    expect(shape(rows)).toEqual([
      'Ideas',
      '  L1 Recipe gallery #idea',
      'Deep',
      '  L5 Gallery wall for the hallway #idea',
      'Plain'
    ])
  })

  it('keeps a note that matched only by title as a plain row', () => {
    const rows = buildSearchPaletteRows({
      ...base,
      results: [journal],
      tagTokens: ['idea'],
      freeText: 'journal'
    })
    expect(shape(rows)).toEqual(['Journal'])
  })

  it('counts the rest of the narrowed blocks, not every tagged block', () => {
    const rows = buildSearchPaletteRows({
      ...base,
      results: [ideas],
      tagTokens: ['idea'],
      // Three of the four tagged blocks contain an "r"; "Zine" does not.
      freeText: 'r'
    })
    expect(shape(rows).filter((r) => r.includes('more'))).toEqual(['  +1 more'])
  })

  it('lists plain note rows without a tag in the query', () => {
    const rows = buildSearchPaletteRows({ ...base, results: [ideas, journal], tagTokens: [] })
    expect(shape(rows)).toEqual(['Ideas', 'Journal'])
  })

  it('lists plain note rows, exactly the results, with the setting off', () => {
    const rows = buildSearchPaletteRows({
      ...base,
      results: [plain, ideas],
      tagTokens: ['idea'],
      freeText: 'gallery',
      enabled: false
    })
    expect(rows.map((r) => r.kind)).toEqual(['note', 'note'])
    expect(shape(rows)).toEqual(['Plain', 'Ideas'])
  })

  it('caps the note rows at the limit', () => {
    const rows = buildSearchPaletteRows({
      ...base,
      results: [plain],
      tagTokens: ['idea'],
      freeText: 'a',
      limit: 2
    })
    expect(rows.filter((r) => r.kind === 'note')).toHaveLength(2)
  })

  it('gives every row a distinct key', () => {
    const rows = buildSearchPaletteRows({ ...base, results: [ideas, journal], tagTokens: ['idea'] })
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })
})
