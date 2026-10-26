import { describe, expect, it } from 'vitest'
import type { NoteFolder } from '@shared/ipc'
import { unresolvedOccurrencesIn } from '@shared/unresolved-links'
import { vaultUnresolvedLinks, wikilinkReaches, type WikilinkReachContext } from './unresolved-links'
import { extractWikilinkTargets } from './wikilinks'

// uNyanda (Discord): "I sometimes create wiki links to notes I want to write
// later, but I forget to create the actual notes." The Unresolved Links view
// lists every such link, and must agree with the editor about which links are
// broken: same resolver, applied to every note in the vault.

interface FixtureNote {
  path: string
  title: string
  folder: NoteFolder
  wikilinks: string[]
  body: string
}

function note(path: string, body: string, folder: NoteFolder = 'inbox'): FixtureNote {
  const title = path.split('/').pop()!.replace(/\.md$/i, '')
  // The vault index stores each note's wikilink targets, code masked. The
  // renderer's scanner applies the same rules as the main process's.
  return { path, title, folder, body, wikilinks: extractWikilinkTargets(body) }
}

const context: Omit<WikilinkReachContext, 'notes'> = {
  databases: [{ csvPath: 'Budget.base/data.csv', title: 'Budget' }],
  assets: [{ path: 'assets/diagram.png' }, { path: 'Papers/spec.pdf' }]
}

function groupsOf(notes: FixtureNote[]) {
  return vaultUnresolvedLinks(notes, context).map((g) => ({
    target: g.target,
    sources: g.sources.map((n) => n.path)
  }))
}

describe('vaultUnresolvedLinks', () => {
  it('lists a missing note with every note that links to it', () => {
    const notes = [
      note('inbox/Ideas.md', 'Write up [[Garden Plan]] and see [[Reading]]'),
      note('inbox/Reading.md', 'Back to [[Ideas]]. Also [[Garden Plan#Beds|the beds]].'),
      note('inbox/Journal.md', 'Nothing linked here')
    ]
    expect(groupsOf(notes)).toEqual([
      { target: 'Garden Plan', sources: ['inbox/Ideas.md', 'inbox/Reading.md'] }
    ])
  })

  it('treats headings, blocks and aliases of an existing note as resolved', () => {
    const notes = [
      note('inbox/Doc.md', '# Intro\ntext ^b1'),
      note('inbox/A.md', '[[Doc#Intro]] [[Doc^b1]] [[Doc#^b1]] [[Doc|alias]] [[doc]] [[Doc.md]]')
    ]
    expect(groupsOf(notes)).toEqual([])
  })

  it('treats same-note heading and block links as resolved', () => {
    expect(groupsOf([note('inbox/A.md', '# H\n[[#H]] [[#Missing heading]] [[^blk]]')])).toEqual([])
  })

  it('ignores links that only appear inside code', () => {
    const body = [
      '`[[Inline Code]]`',
      '```',
      '[[Fenced]]',
      '```',
      '- list',
      '  ~~~',
      '  [[Nested Fence]]',
      '  ~~~',
      'Real [[Later]]'
    ].join('\n')
    expect(groupsOf([note('inbox/A.md', body)])).toEqual([
      { target: 'Later', sources: ['inbox/A.md'] }
    ])
  })

  it('counts files in the vault and databases as resolved, wherever the note sits', () => {
    const notes = [
      note('Projects/Deep/A.md', '[[assets/diagram.png]] [[spec.pdf]] [[Budget]] [[Budget#x]]')
    ]
    expect(groupsOf(notes)).toEqual([])
  })

  it('lists a link to a trashed note, and never a trashed note as a source', () => {
    const notes = [
      note('trash/Old.md', '[[Ghost]]', 'trash'),
      note('inbox/A.md', 'See [[Old]]')
    ]
    expect(groupsOf(notes)).toEqual([{ target: 'Old', sources: ['inbox/A.md'] }])
  })

  it('resolves through remapped system folders by title and by path', () => {
    // Inbox mapped to `Notes/`, Archive to `Old Stuff/` (vault.json
    // systemFolderPaths). Notes keep their logical folder; paths are on-disk.
    const notes = [
      note('Notes/Plan.md', 'body'),
      note('Old Stuff/Retro.md', 'body', 'archive'),
      note('Notes/A.md', '[[Plan]] [[Notes/Plan]] [[Retro]] [[Old Stuff/Retro]] [[Notes/Nope]]')
    ]
    expect(groupsOf(notes)).toEqual([{ target: 'Notes/Nope', sources: ['Notes/A.md'] }])
  })

  it('groups spellings of one missing note, case and anchors aside', () => {
    const notes = [
      note('inbox/A.md', '[[Someday]] [[someday#When]]'),
      note('inbox/B.md', '[[SOMEDAY|later]] [[Someday.md]]')
    ]
    expect(groupsOf(notes)).toEqual([
      { target: 'Someday', sources: ['inbox/A.md', 'inbox/B.md'] }
    ])
  })

  it('finds the line each source note mentions its missing targets on', () => {
    const notes = [
      note('inbox/A.md', 'top\n```\n[[Later]]\n```\nwrite [[Later]] soon\n[[later#part]]')
    ]
    const [group] = vaultUnresolvedLinks(notes, context)
    const hits = unresolvedOccurrencesIn(notes[0]!.body, new Set([group!.key]))
    expect(hits.map((h) => [h.line, h.text])).toEqual([
      [5, 'write [[Later]] soon'],
      [6, '[[later#part]]']
    ])
  })
})

describe('wikilinkReaches', () => {
  const reach: WikilinkReachContext = {
    notes: [{ path: 'inbox/Doc.md', title: 'Doc', folder: 'inbox' }],
    ...context
  }

  it('resolves an embed relative to the note it sits in', () => {
    // Two files share the basename, so only the note-relative reading can
    // pick one.
    const local = { ...reach, assets: [{ path: 'Projects/img/a.png' }, { path: 'Elsewhere/a.png' }] }
    expect(wikilinkReaches('img/a.png', 'Projects/Note.md', local)).toBe(true)
    expect(wikilinkReaches('img/a.png', 'Other/Note.md', local)).toBe(false)
  })

  it('says no for a name nothing answers', () => {
    expect(wikilinkReaches('Nowhere', 'inbox/A.md', reach)).toBe(false)
    expect(wikilinkReaches('Doc', 'inbox/A.md', reach)).toBe(true)
  })
})
