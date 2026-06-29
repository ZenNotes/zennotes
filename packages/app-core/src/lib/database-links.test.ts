import { describe, expect, it } from 'vitest'
import type { FolderEntry, VaultSettings } from '@shared/ipc'
import { listDatabaseLinkTargets, resolveDatabaseWikilink } from './database-links'

const folder = (f: FolderEntry['folder'], subpath: string): FolderEntry => ({
  folder: f,
  subpath,
  siblingOrder: 0
})

const rootSettings = { primaryNotesLocation: 'root' } as VaultSettings
const inboxSettings = { primaryNotesLocation: 'inbox' } as VaultSettings

describe('listDatabaseLinkTargets (#238)', () => {
  it('returns only .base folders, with csvPath + title (notes-at-root)', () => {
    const folders = [
      folder('inbox', 'demo'),
      folder('inbox', 'mydatabase.base'),
      folder('inbox', 'work/clients.base'),
      folder('inbox', 'work')
    ]
    expect(listDatabaseLinkTargets(folders, rootSettings)).toEqual([
      { csvPath: 'mydatabase.base/data.csv', title: 'mydatabase' },
      { csvPath: 'work/clients.base/data.csv', title: 'clients' }
    ])
  })

  it('prefixes the top folder when notes are not at root', () => {
    expect(listDatabaseLinkTargets([folder('inbox', 'mydatabase.base')], inboxSettings)).toEqual([
      { csvPath: 'inbox/mydatabase.base/data.csv', title: 'mydatabase' }
    ])
  })

  it('excludes databases in the trash', () => {
    const folders = [folder('trash', 'old.base'), folder('inbox', 'keep.base')]
    expect(listDatabaseLinkTargets(folders, rootSettings).map((d) => d.title)).toEqual(['keep'])
  })

  it('does not treat a `pages` subfolder of a database as a database', () => {
    const folders = [folder('inbox', 'mydatabase.base'), folder('inbox', 'mydatabase.base/pages')]
    expect(listDatabaseLinkTargets(folders, rootSettings).map((d) => d.title)).toEqual(['mydatabase'])
  })
})

describe('resolveDatabaseWikilink (#238)', () => {
  const dbs = [
    { csvPath: 'mydatabase.base/data.csv', title: 'mydatabase' },
    { csvPath: 'work/clients.base/data.csv', title: 'Clients' }
  ]

  it('matches by title, case-insensitively', () => {
    expect(resolveDatabaseWikilink(dbs, 'mydatabase')?.csvPath).toBe('mydatabase.base/data.csv')
    expect(resolveDatabaseWikilink(dbs, 'clients')?.csvPath).toBe('work/clients.base/data.csv')
  })

  it('strips a #heading / ^block anchor before matching', () => {
    expect(resolveDatabaseWikilink(dbs, 'mydatabase#whatever')?.title).toBe('mydatabase')
  })

  it('returns null when nothing matches', () => {
    expect(resolveDatabaseWikilink(dbs, 'nope')).toBeNull()
    expect(resolveDatabaseWikilink(dbs, '')).toBeNull()
  })
})
