import { describe, expect, it } from 'vitest'
import type { NoteMeta, VaultSettings } from '@shared/ipc'
import { clipNotePath, clipNoteTitle, findClipNote, insertClipText } from './clip-plan'

const settings = (fields: Partial<VaultSettings>): VaultSettings => fields as VaultSettings
const note = (path: string): NoteMeta => ({ path }) as NoteMeta

describe('clipNotePath', () => {
  it('puts a location inside the notes area', () => {
    expect(clipNotePath(settings({ primaryNotesLocation: 'root' }), 'Clippings', 'Page')).toBe('Clippings/Page.md')
    expect(clipNotePath(settings({ primaryNotesLocation: 'inbox' }), 'Clippings', 'Page')).toBe(
      'inbox/Clippings/Page.md'
    )
    expect(clipNotePath(settings({ primaryNotesLocation: 'root' }), '', 'Page')).toBe('Page.md')
  })

  it('follows a remapped Inbox', () => {
    expect(
      clipNotePath(
        settings({ primaryNotesLocation: 'inbox', systemFolderPaths: { inbox: '00 Entry' } }),
        'Clippings',
        'Page'
      )
    ).toBe('00 Entry/Clippings/Page.md')
  })

  it('names the file the way note creation does', () => {
    expect(clipNotePath(settings({ primaryNotesLocation: 'root' }), 'Web', 'Why: a "guide"?')).toBe(
      'Web/Why- a -guide--.md'
    )
  })
})

describe('findClipNote', () => {
  it('prefers the exact path, then one match ignoring case', () => {
    const notes = [note('Clippings/Log.md'), note('clippings/log.md'), note('Reading/List.md')]
    expect(findClipNote(notes, 'clippings/log.md')?.path).toBe('clippings/log.md')
    expect(findClipNote(notes, 'reading/list.md')?.path).toBe('Reading/List.md')
    expect(findClipNote(notes, 'CLIPPINGS/LOG.md')).toBeNull()
    expect(findClipNote(notes, 'Missing.md')).toBeNull()
  })
})

describe('clipNoteTitle', () => {
  const now = new Date(2026, 10, 9, 8, 5)
  it('uses the name, else the first line below the frontmatter', () => {
    expect(clipNoteTitle('Given', 'text', now)).toBe('Given')
    expect(clipNoteTitle(null, '---\nsource: x\n---\n\n# Heading\n', now)).toBe('Heading')
    expect(clipNoteTitle(null, '---\nsource: x\n---\n', now)).toBe('Quick capture 2026-11-09 0805')
    expect(clipNoteTitle(null, null, now)).toBeUndefined()
  })
})

describe('insertClipText', () => {
  it('folds trailing blank lines before appending', () => {
    expect(insertClipText('# Today\n\n', '- a', 'append')).toBe('# Today\n\n- a\n')
    expect(insertClipText('', '- a', 'append')).toBe('- a\n')
    expect(insertClipText('---\nx: 1\n---\n# T\n', 'Top', 'prepend')).toBe('---\nx: 1\n---\nTop\n\n# T\n')
  })
})
