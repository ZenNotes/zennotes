// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderEntry, NoteMeta } from '@bridge-contract/ipc'
import { databaseTabPath } from '@shared/databases'

const disposers: Array<() => void> = []
const folder = (
  subpath: string,
  kind: FolderEntry['folder'] = 'inbox'
): FolderEntry => ({ folder: kind, subpath, siblingOrder: 0 })
const note = (path: string): NoteMeta => ({
  path,
  title: path.split('/').pop()!.replace(/\.md$/, ''),
  folder: 'inbox',
  siblingOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  size: 0,
  tags: [],
  wikilinks: [],
  assetEmbeds: [],
  hasAttachments: false,
  excerpt: ''
})

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: { getCapabilities: () => ({}) }
  })
})
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

async function setup(folders: FolderEntry[] = []) {
  const { useStore } = await import('./store')
  const browse = await import('./browse')
  const shell = await import('./shell')
  useStore.setState({
    vault: { root: '/test', name: 'Test' },
    folders,
    notes: [note('inbox/One.md')],
    noteSortOrder: 'name-asc'
  })
  return { useStore, ...browse, ...shell }
}

describe('public Browse model', () => {
  it('copies and freezes folder/database metadata without exposing mutable source entries or settings', async () => {
    const s = await setup([folder('Work'), folder('People.base')])
    const snapshot = s.getBrowseSnapshot()
    expect(snapshot.folders).toEqual([{ directory: 'Work', title: 'Work' }])
    expect(snapshot.databases).toEqual([
      {
        directory: 'People.base',
        title: 'People',
        path: databaseTabPath('inbox/People.base/data.csv')
      }
    ])
    expect(snapshot.notes).toBe(s.getShellSnapshot().notes)
    expect(snapshot).not.toHaveProperty('vaultSettings')
    expect(snapshot.folders[0]).not.toBe(s.useStore.getState().folders[0])
    for (const value of [
      snapshot,
      snapshot.folders,
      snapshot.databases,
      snapshot.folders[0],
      snapshot.databases[0],
      snapshot.dateDirectories
    ])
      expect(Object.isFrozen(value)).toBe(true)
    expect(() =>
      Object.assign(snapshot.folders[0], { title: 'Changed' })
    ).toThrow()
    expect(s.useStore.getState().folders[0].subpath).toBe('Work')
  })

  it('lists only immediate children, preserves empty folders, and deduplicates folder entries', async () => {
    const s = await setup([
      folder(''),
      folder('Empty'),
      folder('Work'),
      folder('Work'),
      folder('Work/Nested'),
      folder('Saved', 'archive'),
      folder('Deleted', 'trash')
    ])
    const root = s.getBrowseDirectory(s.getBrowseSnapshot())
    expect(root.folders.map((row) => row.directory)).toEqual(['Empty', 'Work'])
    expect(root.notes.map((row) => row.title)).toEqual(['One'])
    expect(
      s
        .getBrowseDirectory(s.getBrowseSnapshot(), 'Work')
        .folders.map((row) => row.directory)
    ).toEqual(['Work/Nested'])
    expect(s.getBrowseDirectory(s.getBrowseSnapshot(), 'Empty')).toEqual({
      folders: [],
      databases: [],
      notes: []
    })
  })

  it('keeps pinned folders and notes at the front of their own sorted groups', async () => {
    const s = await setup([
      folder('Zulu'),
      folder('Alpha'),
      folder('Beta'),
      folder('Zoo.base'),
      folder('Accounts.base')
    ])
    s.useStore.setState({
      notes: [note('inbox/B.md'), note('inbox/C.md'), note('inbox/A.md')]
    })
    const rows = s.getBrowseDirectory(s.getBrowseSnapshot(), '', {
      folders: ['Zulu', 'Zoo.base', 'Gone'],
      notes: ['inbox/C.md']
    })
    expect(rows.folders.map((row) => row.title)).toEqual([
      'Zulu',
      'Alpha',
      'Beta'
    ])
    expect(rows.databases.map((row) => row.title)).toEqual(['Accounts', 'Zoo'])
    expect(rows.notes.map((row) => row.title)).toEqual(['C', 'A', 'B'])
    for (const value of [rows, rows.folders, rows.databases, rows.notes])
      expect(Object.isFrozen(value)).toBe(true)
  })

  it('never exposes the contents of database directories as Browse folders or note rows', async () => {
    const s = await setup([
      folder('People.BASE'),
      folder('People.BASE/pages'),
      folder('People.BASE/pages/Nested'),
      folder('People.BASE/Other.base'),
      folder('People.base-notes')
    ])
    s.useStore.setState({ notes: [note('inbox/People.BASE/pages/Hidden.md')] })
    const snapshot = s.getBrowseSnapshot()
    expect(snapshot.folders.map((row) => row.directory)).toEqual([
      'People.base-notes'
    ])
    expect(snapshot.databases.map((row) => row.directory)).toEqual([
      'People.BASE'
    ])
    for (const directory of [
      'People.BASE',
      'People.BASE/pages',
      'People.BASE/pages/Nested'
    ])
      expect(s.getBrowseDirectory(snapshot, directory)).toEqual({
        folders: [],
        databases: [],
        notes: []
      })
  })

  it.each(['inbox', 'root'] as const)(
    'composes encoded database targets in %s mode with a custom primary path',
    async (primaryNotesLocation) => {
      const s = await setup([folder('Work/People & café.BASE')])
      s.useStore.setState({
        vaultSettings: {
          ...s.useStore.getState().vaultSettings,
          primaryNotesLocation,
          systemFolderPaths: { inbox: '01 - Notes' }
        }
      })
      const row = s.getBrowseDirectory(s.getBrowseSnapshot(), 'Work')
        .databases[0]
      const prefix = primaryNotesLocation === 'root' ? '' : '01 - Notes/'
      expect(row).toEqual({
        directory: 'Work/People & café.BASE',
        title: 'People & café',
        path: databaseTabPath(`${prefix}Work/People & café.BASE/data.csv`)
      })
    }
  )

  it('reports enabled date directories without exposing or mutating date settings', async () => {
    const s = await setup()
    const settings = s.useStore.getState().vaultSettings
    s.useStore.setState({
      vaultSettings: {
        ...settings,
        dailyNotes: {
          ...settings.dailyNotes,
          enabled: true,
          directory: 'Journal/Daily'
        },
        weeklyNotes: {
          ...settings.weeklyNotes,
          enabled: false,
          directory: 'Journal/Weekly'
        },
        monthlyNotes: {
          ...settings.monthlyNotes,
          enabled: true,
          directory: 'Journal/Monthly'
        }
      }
    })
    const before = s.getBrowseSnapshot()
    expect(before.dateDirectories).toEqual({
      daily: 'Journal/Daily',
      weekly: null,
      monthly: 'Journal/Monthly'
    })
    const current = s.useStore.getState().vaultSettings
    s.useStore.setState({
      vaultSettings: {
        ...current,
        dailyNotes: { ...current.dailyNotes, enabled: false }
      }
    })
    expect(s.getBrowseSnapshot().dateDirectories.daily).toBeNull()
    expect(before.dateDirectories.daily).toBe('Journal/Daily')
  })

  it('retains identity during selection and editor changes and refreshes after folder changes', async () => {
    const s = await setup([folder('Work')])
    const before = s.getBrowseSnapshot()
    s.useStore.setState({
      selectedPath: 'inbox/One.md',
      activeDirty: true,
      editorFontSize: 25
    })
    expect(s.getBrowseSnapshot()).toBe(before)
    s.useStore.setState({ folders: [folder('Renamed')] })
    expect(s.getBrowseSnapshot().folders[0].title).toBe('Renamed')
    expect(before.folders[0].title).toBe('Work')
    expect(s.getBrowseSnapshot().notes).toBe(before.notes)
  })

  it('preserves folder array identity when only notes or unrelated settings change', async () => {
    const s = await setup([folder('Work')])
    const before = s.getBrowseSnapshot()
    s.useStore.setState({
      notes: [note('inbox/New.md')],
      vaultSettings: { ...s.useStore.getState().vaultSettings, folderIcons: {} }
    })
    const after = s.getBrowseSnapshot()
    expect(after.folders).toBe(before.folders)
    expect(after.databases).toBe(before.databases)
    expect(after.dateDirectories).toBe(before.dateDirectories)
    expect(after.notes[0].title).toBe('New')
  })

  it('updates database paths after layout changes without changing delivered snapshots', async () => {
    const s = await setup([folder('People.base')])
    const before = s.getBrowseSnapshot()
    s.useStore.setState({
      vaultSettings: {
        ...s.useStore.getState().vaultSettings,
        primaryNotesLocation: 'root'
      }
    })
    expect(s.getBrowseSnapshot().databases[0].path).toBe(
      databaseTabPath('People.base/data.csv')
    )
    expect(before.databases[0].path).toBe(
      databaseTabPath('inbox/People.base/data.csv')
    )
  })

  it('notifies only on Browse changes and stops after disposal', async () => {
    const s = await setup()
    const before = s.getBrowseSnapshot()
    const listener = vi.fn()
    const dispose = s.subscribeBrowse(listener)
    disposers.push(dispose)
    s.useStore.setState({ selectedPath: 'inbox/One.md' })
    expect(listener).not.toHaveBeenCalled()
    s.useStore.setState({ folders: [folder('New')] })
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      s.getBrowseSnapshot(),
      before
    )
    dispose()
    s.useStore.setState({ folders: [] })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
