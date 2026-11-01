import { describe, expect, it } from 'vitest'
import type { FolderEntry, NoteFolder, VaultSettings } from '@shared/ipc'
import {
  filterFolderChoices,
  folderNameChoices,
  primaryFolderChoices,
  stepPickerIndex,
  vaultFolderPathChoices,
  type FolderChoice
} from './folder-picker'

// #1033: the Settings fields that name a vault folder list the vault's
// folders, in the form each field stores, and narrow as you type. The New
// note form's Folder field (#826) ranks and steps through rows the same way.

const entry = (folder: NoteFolder, subpath: string): FolderEntry => ({
  folder,
  subpath,
  siblingOrder: 0
})

const folders = [
  entry('inbox', ''),
  entry('inbox', 'Projects/Alpha'),
  entry('inbox', 'Projects'),
  entry('inbox', 'Books'),
  entry('inbox', 'Reading.base'),
  entry('inbox', 'assets'),
  entry('inbox', 'Physics/typst'),
  entry('quick', 'scratch'),
  entry('archive', 'Old/Typst'),
  entry('trash', 'Gone')
]

const inboxVault = { primaryNotesLocation: 'inbox' } as VaultSettings
const rootVault = { primaryNotesLocation: 'root' } as VaultSettings
const values = (choices: readonly FolderChoice[]): string[] => choices.map((c) => c.value)

describe('vaultFolderPathChoices', () => {
  it('lists folders by their path from the vault root, area by area, top level first', () => {
    expect(values(vaultFolderPathChoices(folders, inboxVault, { areaRoots: false }))).toEqual([
      'inbox/assets',
      'inbox/Books',
      'inbox/Projects',
      'inbox/Physics/typst',
      'inbox/Projects/Alpha',
      'quick/scratch',
      'archive/Old/Typst'
    ])
  })

  it('offers the areas themselves when asked, never the Trash or a database', () => {
    const paths = values(vaultFolderPathChoices(folders, inboxVault, { areaRoots: true }))
    expect(paths.slice(0, 2)).toEqual(['inbox', 'inbox/assets'])
    expect(paths).toContain('quick')
    expect(paths).toContain('archive')
    expect(paths.some((p) => p.startsWith('trash'))).toBe(false)
    expect(paths.some((p) => p.includes('.base'))).toBe(false)
  })

  it('drops the inbox prefix in a vault that keeps its notes at the root, and its root', () => {
    const paths = values(vaultFolderPathChoices(folders, rootVault, { areaRoots: true }))
    expect(paths.slice(0, 3)).toEqual(['assets', 'Books', 'Projects'])
    expect(paths).not.toContain('')
  })

  it('follows a remapped system folder', () => {
    const remapped = { ...inboxVault, systemFolderPaths: { archive: '99 - Archive' } } as VaultSettings
    expect(values(vaultFolderPathChoices(folders, remapped, { areaRoots: false }))).toContain(
      '99 - Archive/Old/Typst'
    )
  })
})

describe('primaryFolderChoices', () => {
  it('lists primary-area folders as the subpath the Specific folder fields store', () => {
    // `assets` is an ordinary folder inside `inbox/`; only at the vault root
    // does it hold attachments.
    expect(values(primaryFolderChoices(folders, inboxVault))).toEqual([
      'assets',
      'Books',
      'Projects',
      'Physics/typst',
      'Projects/Alpha'
    ])
  })

  it('leaves out a folder whose files would land elsewhere, and databases', () => {
    const paths = values(primaryFolderChoices(folders, rootVault))
    expect(paths).not.toContain('assets')
    expect(paths).not.toContain('Reading.base')
  })
})

describe('folderNameChoices', () => {
  it('offers each folder name once, in any case, sorted', () => {
    expect(values(folderNameChoices(folders))).toEqual([
      'Alpha',
      'assets',
      'Books',
      'Projects',
      'scratch',
      'typst'
    ])
  })
})

describe('filterFolderChoices', () => {
  const choices = vaultFolderPathChoices(folders, inboxVault, { areaRoots: true })

  it('lists everything for empty text, up to the limit', () => {
    expect(filterFolderChoices(choices, '', 3)).toHaveLength(3)
    expect(filterFolderChoices(choices, '   ', 100)).toHaveLength(choices.length)
  })

  it('ranks an exact value, then prefixes, then anything containing the text', () => {
    expect(values(filterFolderChoices(choices, 'inbox/projects', 100))).toEqual([
      'inbox/Projects',
      'inbox/Projects/Alpha'
    ])
    expect(values(filterFolderChoices(choices, 'typst', 100))).toEqual([
      'inbox/Physics/typst',
      'archive/Old/Typst'
    ])
    expect(values(filterFolderChoices(choices, '/archive/', 100))).toEqual([
      'archive',
      'archive/Old/Typst'
    ])
    expect(filterFolderChoices(choices, 'nothing here', 100)).toEqual([])
  })
})

describe('stepPickerIndex', () => {
  it('cycles through the typed value (-1) and the rows, wrapping at both ends', () => {
    expect(stepPickerIndex(-1, 1, 3)).toBe(0)
    expect(stepPickerIndex(2, 1, 3)).toBe(-1)
    expect(stepPickerIndex(-1, -1, 3)).toBe(2)
    expect(stepPickerIndex(0, -1, 3)).toBe(-1)
    expect(stepPickerIndex(-1, 1, 0)).toBe(-1)
  })
})
