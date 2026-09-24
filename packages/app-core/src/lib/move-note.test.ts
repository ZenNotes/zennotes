import { describe, expect, it } from 'vitest'
import type { FolderEntry, NoteMeta, VaultSettings } from '@shared/ipc'
import { DEFAULT_VAULT_SETTINGS } from '@shared/ipc'
import {
  buildMoveDirectoryPrompt,
  buildMoveNotePrompt,
  moveNoteVocabulary,
  parseMoveNoteTarget,
  validateMoveDirectoryTarget,
  validateMoveNoteTarget
} from './move-note'

function settingsFor(
  primaryNotesLocation: 'inbox' | 'root',
  systemFolderPaths: VaultSettings['systemFolderPaths'] = {}
): VaultSettings {
  return { ...DEFAULT_VAULT_SETTINGS, primaryNotesLocation, systemFolderPaths }
}

function folder(folder: FolderEntry['folder'], subpath: string): FolderEntry {
  return { folder, subpath, siblingOrder: 0 }
}

const FOLDERS = [
  folder('inbox', 'Work'),
  folder('inbox', 'Work/Research'),
  folder('inbox', 'Areas'),
  folder('archive', 'Old'),
  folder('quick', ''),
  folder('trash', '')
]

function note(path: string, kind: NoteMeta['folder'] = 'inbox'): Pick<NoteMeta, 'title' | 'path' | 'folder'> {
  return { path, folder: kind, title: path.split('/').pop()!.replace(/\.md$/, '') }
}

const inboxVault = moveNoteVocabulary(settingsFor('inbox'), null, FOLDERS)
const rootVault = moveNoteVocabulary(settingsFor('root'), null, FOLDERS)

describe('moveNoteVocabulary', () => {
  it('names the notes root the way the sidebar does', () => {
    expect(inboxVault.rootLabel).toBe('Inbox')
    expect(rootVault.rootLabel).toBe('Vault root')
    expect(moveNoteVocabulary(settingsFor('inbox'), { inbox: 'Notes' }, FOLDERS).rootLabel).toBe('Notes')
    expect(inboxVault.archiveLabel).toBe('Archive')
  })

  it('knows the Archive by its directory name too', () => {
    const remapped = moveNoteVocabulary(settingsFor('root', { archive: 'Shelf' }), null, FOLDERS)
    expect(parseMoveNoteTarget('Shelf/Old', remapped)).toEqual({ folder: 'archive', subpath: 'Old' })
    expect(parseMoveNoteTarget('archive/Old', remapped)).toEqual({ folder: 'archive', subpath: 'Old' })
  })
})

describe('parseMoveNoteTarget', () => {
  it('reads notes-area paths, with empty as the root', () => {
    expect(parseMoveNoteTarget('', inboxVault)).toEqual({ folder: 'inbox', subpath: '' })
    expect(parseMoveNoteTarget('  Work/Research ', inboxVault)).toEqual({ folder: 'inbox', subpath: 'Work/Research' })
    expect(parseMoveNoteTarget('Areas', rootVault)).toEqual({ folder: 'inbox', subpath: 'Areas' })
    expect(parseMoveNoteTarget('Archive', rootVault)).toEqual({ folder: 'archive', subpath: '' })
  })

  it('still takes the older inbox/ spelling of the notes area', () => {
    expect(parseMoveNoteTarget('inbox', inboxVault)).toEqual({ folder: 'inbox', subpath: '' })
    expect(parseMoveNoteTarget('inbox/Work', inboxVault)).toEqual({ folder: 'inbox', subpath: 'Work' })
    // On a root vault as well, since that is what the old prompt offered there.
    expect(parseMoveNoteTarget('inbox/Areas', rootVault)).toEqual({ folder: 'inbox', subpath: 'Areas' })
  })

  it('means a real folder named inbox on a root vault that has one', () => {
    const withInboxFolder = moveNoteVocabulary(settingsFor('root'), null, [...FOLDERS, folder('inbox', 'inbox')])
    expect(parseMoveNoteTarget('inbox/Sub', withInboxFolder)).toEqual({ folder: 'inbox', subpath: 'inbox/Sub' })
  })
})

describe('validateMoveNoteTarget', () => {
  it('accepts the root, folders and the Archive', () => {
    for (const value of ['', 'Work', 'Work/Research', 'archive', 'archive/Old', 'inbox/Work']) {
      expect(validateMoveNoteTarget(value, inboxVault)).toBeNull()
      expect(validateMoveNoteTarget(value, rootVault)).toBeNull()
    }
  })

  it('refuses hidden names, parent references and control characters', () => {
    for (const value of ['.hidden', 'Work/../Elsewhere', 'inbox/.git', 'bad\u0000name']) {
      expect(validateMoveNoteTarget(value, inboxVault)).toBe(
        'Choose a folder without hidden names or parent-directory segments.'
      )
    }
  })

  it('refuses the Quick Notes and the Trash, which have their own actions', () => {
    expect(validateMoveNoteTarget('quick', rootVault)).toMatch(/Quick Notes and the Trash have their own actions/)
    expect(validateMoveNoteTarget('trash/Old', inboxVault)).toMatch(/^Notes move within Inbox/)
    expect(validateMoveNoteTarget('Trash', rootVault)).toMatch(/^Notes move within the vault root/)
    // Spelled out as a subfolder of the inbox, it is a folder that happens to
    // carry that name, and it stays allowed.
    expect(validateMoveNoteTarget('inbox/trash', inboxVault)).toBeNull()
    const remapped = moveNoteVocabulary(settingsFor('root', { quick: 'Scratch' }), null, FOLDERS)
    expect(validateMoveNoteTarget('Scratch/x', remapped)).toMatch(/own actions/)
  })
})

describe('buildMoveNotePrompt', () => {
  it('offers the notes area without a prefix, the root first, then the Archive', () => {
    const prompt = buildMoveNotePrompt(note('inbox/Work/One.md'), FOLDERS, inboxVault)
    expect(prompt.suggestions?.map((row) => row.value)).toEqual([
      '',
      'Areas',
      'Work',
      'Work/Research',
      'archive',
      'archive/Old'
    ])
    expect(prompt.suggestions?.[0].label).toBe('Inbox')
    expect(prompt.suggestions?.find((row) => row.value === 'Work/Research')?.detail).toBe('Work')
    expect(prompt.suggestions?.find((row) => row.value === 'Areas')?.detail).toBe('Inbox')
    expect(prompt.suggestions?.find((row) => row.value === 'archive')?.detail).toBe('Archive')
    expect(prompt.allowEmptySubmit).toBe(true)
    expect(prompt.description).toContain('empty = Inbox')
  })

  it('reads "Vault root" on a root vault, where the old prompt said inbox/', () => {
    const prompt = buildMoveNotePrompt(note('Areas/Gym/Plan.md'), FOLDERS, rootVault)
    expect(prompt.suggestions?.[0]).toEqual({ value: '', label: 'Vault root' })
    expect(prompt.suggestions?.map((row) => row.value)).not.toContainEqual(expect.stringMatching(/^inbox/))
    expect(prompt.placeholder).toBe('Vault root (type a folder to change)')
  })

  it('opens on the note\'s current folder, spelled like the suggestions', () => {
    expect(buildMoveNotePrompt(note('inbox/Work/One.md'), FOLDERS, inboxVault).initialValue).toBe('Work')
    expect(buildMoveNotePrompt(note('inbox/One.md'), FOLDERS, inboxVault).initialValue).toBe('')
    expect(buildMoveNotePrompt(note('Areas/Gym/Plan.md'), FOLDERS, rootVault).initialValue).toBe('Areas/Gym')
    expect(buildMoveNotePrompt(note('Plan.md'), FOLDERS, rootVault).initialValue).toBe('')
    expect(buildMoveNotePrompt(note('archive/Old/X.md', 'archive'), FOLDERS, inboxVault).initialValue).toBe('archive/Old')
    expect(buildMoveNotePrompt(note('archive/X.md', 'archive'), FOLDERS, rootVault).initialValue).toBe('archive')
  })

  it('validates through the same rules the prompt shows', () => {
    const prompt = buildMoveNotePrompt(note('inbox/One.md'), FOLDERS, inboxVault)
    expect(prompt.validate?.('')).toBeNull()
    expect(prompt.validate?.('quick')).toMatch(/own actions/)
  })
})

describe('directory moves', () => {
  it('offers only the notes area, root first', () => {
    const prompt = buildMoveDirectoryPrompt('Work/Research', FOLDERS, rootVault)
    expect(prompt.suggestions?.map((row) => row.value)).toEqual(['', 'Areas', 'Work'])
    expect(prompt.suggestions?.[0].label).toBe('Vault root')
    expect(prompt.allowEmptySubmit).toBe(true)
  })

  it('keeps folders out of the Archive and names the root the vault uses', () => {
    expect(validateMoveDirectoryTarget('Work/Research', 'archive', FOLDERS, inboxVault)).toBe(
      'Folders and databases move within Inbox, not the Archive.'
    )
    expect(validateMoveDirectoryTarget('Work/Research', 'archive/Old', FOLDERS, rootVault)).toBe(
      'Folders and databases move within the vault root, not the Archive.'
    )
    expect(validateMoveDirectoryTarget('Work/Research', '', FOLDERS, rootVault)).toBeNull()
    expect(validateMoveDirectoryTarget('Work/Research', 'Areas', FOLDERS, rootVault)).toBeNull()
    expect(validateMoveDirectoryTarget('Work/Research', 'inbox/Areas', FOLDERS, inboxVault)).toBeNull()
    expect(validateMoveDirectoryTarget('Work/Research', 'Missing', FOLDERS, rootVault)).toBe('Choose an existing folder.')
    expect(validateMoveDirectoryTarget('Work', 'Work/Research', FOLDERS, rootVault)).toBe('A folder cannot move into itself.')
  })
})
