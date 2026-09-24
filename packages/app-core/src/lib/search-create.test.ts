import { describe, expect, it } from 'vitest'
import type { FolderEntry, NoteFolder, NoteMeta, VaultSettings } from '@shared/ipc'
import {
  addTag,
  buildDestinationChoices,
  checkNoteName,
  composeNewNoteBody,
  destinationLabel,
  destinationText,
  filterDestinationChoices,
  findNameCollision,
  normalizeTag,
  parseDestinationText,
  rankTagChoices,
  searchCreateDraft,
  type AreaLabels
} from './search-create'

// #826: the note search palette offers to create the note the query names.
// This is the pure half of the New note form: the draft read off the query,
// the Name and Folder fields, the "already exists" check, the folder picker
// and the tags.

function note(path: string, folder: NoteFolder = 'inbox', tags: string[] = []): NoteMeta {
  const file = path.split('/').pop() ?? path
  return {
    path,
    title: file.replace(/\.md$/, ''),
    folder,
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags,
    wikilinks: [],
    hasAttachments: false,
    assetEmbeds: [],
    excerpt: ''
  }
}

const notes = [
  note('inbox/Alpha.md'),
  note('inbox/projects/Roadmap.md'),
  note('quick/Scratch.md', 'quick'),
  note('archive/Alpha.md', 'archive'),
  note('trash/Gone.md', 'trash')
]

const LABELS: AreaLabels = { inbox: 'Inbox', quick: 'Quick Notes', archive: 'Archive', trash: 'Trash' }

describe('searchCreateDraft', () => {
  it('drafts nothing for an empty or tag-only query', () => {
    expect(searchCreateDraft('', [])).toBeNull()
    expect(searchCreateDraft('   ', ['ops'])).toBeNull()
  })

  it('splits a path into the Folder and Name fields, in the `:e` dialect', () => {
    expect(searchCreateDraft('Meeting notes', [])).toEqual({
      name: 'Meeting notes',
      folderText: '',
      tags: []
    })
    expect(searchCreateDraft('projects/ideas/Q4', [])).toMatchObject({
      name: 'Q4',
      folderText: 'projects/ideas'
    })
    expect(searchCreateDraft('archive/Old plan', [])).toMatchObject({
      name: 'Old plan',
      folderText: 'archive'
    })
    expect(searchCreateDraft('quick/Scratch 2', [])).toMatchObject({ folderText: 'quick' })
    expect(searchCreateDraft('/Meeting notes.md', [])).toMatchObject({
      name: 'Meeting notes',
      folderText: ''
    })
  })

  it('keeps text that cannot be a path, so the form can say why', () => {
    // No slash: the whole thing is the name, and the Name field complains.
    expect(searchCreateDraft('what?', [])).toMatchObject({ name: 'what?', folderText: '' })
    // With a slash, each field gets its own part to complain about.
    expect(searchCreateDraft('projects/what?', [])).toMatchObject({
      name: 'what?',
      folderText: 'projects'
    })
    expect(searchCreateDraft('../escape', [])).toMatchObject({ name: 'escape', folderText: '..' })
    // The Trash parses fine as a path; the Folder field is what rejects it.
    expect(searchCreateDraft('trash/Gone', [])).toMatchObject({ name: 'Gone', folderText: 'trash' })
  })

  it('carries the query tags over, deduplicated and without the ones that are not tags', () => {
    expect(searchCreateDraft('Runbook', ['ops', 'Ops', 'prod', '9lives'])?.tags).toEqual([
      'ops',
      'prod'
    ])
  })
})

describe('parseDestinationText', () => {
  it('reads empty text and the Inbox name as the Inbox root', () => {
    const root = { destination: { folder: 'inbox', subpath: '' }, error: null }
    expect(parseDestinationText('')).toEqual(root)
    expect(parseDestinationText('  /  ')).toEqual(root)
    expect(parseDestinationText('inbox')).toEqual(root)
    expect(parseDestinationText('Inbox/')).toEqual(root)
  })

  it('nests under Inbox unless a top folder leads, and tolerates slashes either way', () => {
    expect(parseDestinationText('projects/ideas/').destination).toEqual({
      folder: 'inbox',
      subpath: 'projects/ideas'
    })
    expect(parseDestinationText('projects\\ideas').destination).toEqual({
      folder: 'inbox',
      subpath: 'projects/ideas'
    })
    expect(parseDestinationText('Inbox/projects').destination).toEqual({
      folder: 'inbox',
      subpath: 'projects'
    })
    expect(parseDestinationText('archive').destination).toEqual({ folder: 'archive', subpath: '' })
    expect(parseDestinationText('archive/old').destination).toEqual({
      folder: 'archive',
      subpath: 'old'
    })
    expect(parseDestinationText('quick').destination).toEqual({ folder: 'quick', subpath: '' })
  })

  it('refuses the Trash, databases, dot segments and characters a folder cannot carry', () => {
    expect(parseDestinationText('trash').error).toBe('Notes cannot be created in the Trash.')
    expect(parseDestinationText('trash/old').error).toBe('Notes cannot be created in the Trash.')
    expect(parseDestinationText('Tasks.base').error).toMatch(/Databases/)
    expect(parseDestinationText('team/Tasks.base/pages').error).toMatch(/Databases/)
    expect(parseDestinationText('a/../b').error).toMatch(/"\." or "\.\."/)
    expect(parseDestinationText('bad:name').error).toMatch(/^Folder names cannot contain/)
  })
})

describe('checkNoteName', () => {
  it('trims, drops a .md suffix, and lets a name spell a folder without becoming one', () => {
    expect(checkNoteName('  Plan  ')).toEqual({ title: 'Plan', error: null })
    expect(checkNoteName('Plan.md')).toEqual({ title: 'Plan', error: null })
    expect(checkNoteName('Inbox')).toEqual({ title: 'Inbox', error: null })
    expect(checkNoteName('archive')).toEqual({ title: 'archive', error: null })
  })

  it('names what is wrong: nothing, a slash, a forbidden character, a dot segment', () => {
    expect(checkNoteName('   ').error).toBe('Enter a name.')
    expect(checkNoteName('a/b').error).toMatch(/slash/)
    expect(checkNoteName('a\\b').error).toMatch(/slash/)
    expect(checkNoteName('what?').error).toMatch(/cannot contain/)
    expect(checkNoteName('..').error).toMatch(/"\." or "\.\."/)
  })
})

describe('findNameCollision', () => {
  const inboxRoot = { folder: 'inbox' as const, subpath: '' }

  it('prefers the note in the chosen folder, ignoring case', () => {
    expect(findNameCollision('alpha', inboxRoot, notes, null)).toEqual({
      note: notes[0],
      sameFolder: true
    })
    expect(findNameCollision('Alpha', { folder: 'archive', subpath: '' }, notes, null)).toEqual({
      note: notes[3],
      sameFolder: true
    })
    // Folder names compare case-insensitively too, as the default macOS file
    // system does: creating in `Projects` would land on `projects/Roadmap.md`.
    expect(findNameCollision('roadmap', { folder: 'inbox', subpath: 'Projects' }, notes, null)).toEqual({
      note: notes[1],
      sameFolder: true
    })
  })

  it('reports a same-named note elsewhere without calling it a twin', () => {
    expect(findNameCollision('Roadmap', inboxRoot, notes, null)).toEqual({
      note: notes[1],
      sameFolder: false
    })
    expect(findNameCollision('scratch', inboxRoot, notes, null)).toEqual({
      note: notes[2],
      sameFolder: false
    })
  })

  it('never counts a partial match, an empty name, or a trashed note', () => {
    expect(findNameCollision('Alph', inboxRoot, notes, null)).toBeNull()
    expect(findNameCollision('  ', inboxRoot, notes, null)).toBeNull()
    expect(findNameCollision('Gone', inboxRoot, notes, null)).toBeNull()
  })

  it('reads folders the way the vault lays them out, not from the literal path', () => {
    // Notes kept at the vault root: `projects/Roadmap.md` is the `projects`
    // subfolder of the notes area, and `Alpha.md` sits in its root.
    const rootMode = { primaryNotesLocation: 'root' } as unknown as VaultSettings
    const rooted = [note('Alpha.md'), note('projects/Roadmap.md')]
    expect(findNameCollision('alpha', inboxRoot, rooted, rootMode)?.sameFolder).toBe(true)
    expect(
      findNameCollision('roadmap', { folder: 'inbox', subpath: 'projects' }, rooted, rootMode)
        ?.sameFolder
    ).toBe(true)
    expect(findNameCollision('roadmap', inboxRoot, rooted, rootMode)?.sameFolder).toBe(false)
  })
})

describe('the folder picker', () => {
  const entry = (folder: NoteFolder, subpath: string): FolderEntry => ({
    folder,
    subpath,
    siblingOrder: 0
  })
  const folders = [
    entry('inbox', 'projects/ideas'),
    entry('inbox', 'projects'),
    entry('inbox', 'Tasks.base'),
    entry('inbox', 'a'),
    entry('archive', 'old'),
    entry('quick', 'scratch'),
    entry('trash', 'x')
  ]

  it('lists each area root then its subfolders by depth and name, skipping databases and the Trash', () => {
    const choices = buildDestinationChoices(folders, LABELS)
    expect(choices.map((c) => c.value)).toEqual([
      '',
      'a',
      'projects',
      'projects/ideas',
      'quick',
      'quick/scratch',
      'archive',
      'archive/old'
    ])
    expect(choices.map((c) => c.label)).toEqual([
      'Inbox',
      'Inbox › a',
      'Inbox › projects',
      'Inbox › projects/ideas',
      'Quick Notes',
      'Quick Notes › scratch',
      'Archive',
      'Archive › old'
    ])
    expect(choices[3].destination).toEqual({ folder: 'inbox', subpath: 'projects/ideas' })
  })

  it('speaks the labels it is given, so renamed folders and root-mode vaults read right', () => {
    const labels = { ...LABELS, inbox: 'My Vault' }
    expect(buildDestinationChoices(folders, labels)[2].label).toBe('My Vault › projects')
    expect(destinationLabel({ folder: 'inbox', subpath: '' }, labels)).toBe('My Vault')
    expect(destinationLabel({ folder: 'archive', subpath: 'old' }, labels)).toBe('Archive › old')
  })

  it('narrows by value first, then label, then anything containing the text', () => {
    const choices = buildDestinationChoices(folders, LABELS)
    const values = (text: string): string[] =>
      filterDestinationChoices(choices, text).map((c) => c.value)
    expect(values('proj')).toEqual(['projects', 'projects/ideas'])
    expect(values('projects')).toEqual(['projects', 'projects/ideas'])
    expect(values('ideas')).toEqual(['projects/ideas'])
    expect(values('Inbox')).toEqual(['', 'a', 'projects', 'projects/ideas'])
    expect(values('old')).toEqual(['archive/old'])
    expect(values('/archive/')).toEqual(['archive', 'archive/old'])
    expect(values('nothing-here')).toEqual([])
    expect(values('')).toHaveLength(choices.length)
  })

  it('round-trips a destination through its field text', () => {
    for (const destination of [
      { folder: 'inbox' as const, subpath: '' },
      { folder: 'inbox' as const, subpath: 'projects/ideas' },
      { folder: 'quick' as const, subpath: '' },
      { folder: 'archive' as const, subpath: 'old' }
    ]) {
      expect(parseDestinationText(destinationText(destination)).destination).toEqual(destination)
    }
  })
})

describe('tags', () => {
  const counts = new Map([
    ['Ops', 3],
    ['devops', 1],
    ['op', 1],
    ['other', 5]
  ])

  it('normalizes a typed tag the way extractTags reads one', () => {
    expect(normalizeTag('#Ops')).toBe('Ops')
    expect(normalizeTag(' ops/infra ')).toBe('ops/infra')
    expect(normalizeTag('9lives')).toBeNull()
    expect(normalizeTag('two words')).toBeNull()
    expect(normalizeTag('#')).toBeNull()
  })

  it('adds a tag once, in the spelling the vault already uses', () => {
    expect(addTag([], 'ops', counts)).toEqual(['Ops'])
    expect(addTag(['Ops'], '#OPS', counts)).toEqual(['Ops'])
    expect(addTag(['a'], 'b')).toEqual(['a', 'b'])
    expect(addTag(['a'], 'not a tag')).toEqual(['a'])
  })

  it('ranks the exact tag first, then prefixes, then substrings, minus the chosen ones', () => {
    expect(rankTagChoices('op', counts, []).map((t) => t.tag)).toEqual(['op', 'Ops', 'devops'])
    expect(rankTagChoices('op', counts, ['op', 'devops']).map((t) => t.tag)).toEqual(['Ops'])
    // No text: the vault's tags, most used first.
    expect(rankTagChoices('', counts, []).map((t) => t.tag)).toEqual(['other', 'Ops', 'devops', 'op'])
  })

  it('writes the body the CLI would', () => {
    expect(composeNewNoteBody('Runbook', [])).toBe('# Runbook\n\n')
    expect(composeNewNoteBody('Runbook', ['ops', 'prod'])).toBe('# Runbook\n\n#ops #prod\n\n')
  })
})
