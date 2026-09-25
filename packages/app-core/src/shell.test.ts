// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@bridge-contract/ipc'

const disposers: Array<() => void> = []
const note = (path: string, extra: Partial<NoteMeta> = {}): NoteMeta => ({
  path,
  title: path.split('/').pop()!.replace(/\.md$/, ''),
  folder: 'inbox',
  createdAt: 0,
  updatedAt: 0,
  siblingOrder: 0,
  size: 10,
  tags: [],
  wikilinks: [],
  assetEmbeds: [],
  hasAttachments: false,
  excerpt: 'Private preview',
  ...extra
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

async function setup(notes = [note('inbox/One.md')]) {
  const { useStore } = await import('./store')
  const shell = await import('./shell')
  useStore.setState({
    notes,
    vault: { root: '/test', name: 'Test' },
    workspaceRestored: true
  })
  return { useStore, ...shell }
}

describe('public shell snapshots', () => {
  it('exposes frozen, copied identity metadata without bodies, credentials, or store internals', async () => {
    const s = await setup()
    s.useStore.setState({ selectedPath: 'inbox/One.md' })
    const snapshot = s.getShellSnapshot()
    expect(snapshot.selectedNote).toBe(snapshot.notes[0])
    expect(snapshot.notes[0]).toEqual({
      path: 'inbox/One.md',
      title: 'One',
      folder: 'inbox',
      directory: '',
      createdAt: 0,
      updatedAt: 0
    })
    expect(snapshot).not.toHaveProperty('activeNote')
    expect(snapshot).not.toHaveProperty('remoteWorkspaceProfiles')
    expect(snapshot).not.toHaveProperty('paneLayout')
    expect(snapshot).not.toHaveProperty('editorViewRef')
    expect(snapshot.vault).not.toBe(s.useStore.getState().vault)
    expect(snapshot.notes[0]).not.toBe(s.useStore.getState().notes[0])
    for (const value of [
      snapshot,
      snapshot.notes,
      snapshot.notes[0],
      snapshot.vault
    ])
      expect(Object.isFrozen(value)).toBe(true)
    expect(() =>
      Object.assign(snapshot.notes[0], { title: 'Changed' })
    ).toThrow()
    expect(s.useStore.getState().notes[0].title).toBe('One')
  })

  it('keeps snapshot identity across repeated reads and unrelated editor changes', async () => {
    const s = await setup()
    const before = s.getShellSnapshot()
    s.useStore.setState({ editorFontSize: 25, activeDirty: true })
    expect(s.getShellSnapshot()).toBe(before)
    expect(s.getShellSnapshot()).toBe(before)
    const settings = s.useStore.getState().vaultSettings
    s.useStore.setState({
      vaultSettings: {
        ...settings,
        dailyNotes: {
          ...settings.dailyNotes,
          enabled: !settings.dailyNotes.enabled
        }
      }
    })
    expect(s.getShellSnapshot()).toBe(before)
  })

  it('copies changed metadata without mutating previously delivered snapshots', async () => {
    const s = await setup()
    const before = s.getShellSnapshot()
    s.useStore.setState({
      notes: [note('inbox/One.md', { title: 'Renamed', updatedAt: 8 })]
    })
    const after = s.getShellSnapshot()
    expect(after.notes[0].title).toBe('Renamed')
    expect(before.notes[0].title).toBe('One')
    expect(after.vault).toBe(before.vault)
  })

  it('reports Home, virtual pages, and removed notes without inventing a selected note', async () => {
    const s = await setup()
    for (const selectedPath of [null, 'zen://help', 'inbox/Missing.md']) {
      s.useStore.setState({ selectedPath })
      expect(s.getShellSnapshot()).toMatchObject({
        selectedPath,
        selectedNote: null
      })
    }
  })

  it('notifies only on public changes with coherent previous snapshots and supports disposal', async () => {
    const s = await setup()
    const before = s.getShellSnapshot()
    const listener = vi.fn()
    const dispose = s.subscribeShell(listener)
    disposers.push(dispose)
    expect(listener).not.toHaveBeenCalled()
    s.useStore.setState({ activeDirty: true })
    expect(listener).not.toHaveBeenCalled()
    s.useStore.setState({ selectedPath: 'inbox/One.md' })
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      s.getShellSnapshot(),
      before
    )
    expect(s.getShellSnapshot().notes).toBe(before.notes)
    dispose()
    s.useStore.setState({ selectedPath: null })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('tracks workspace replacement and restoration without exposing mutable vault objects', async () => {
    const s = await setup()
    const before = s.getShellSnapshot()
    s.useStore.setState({
      vault: { root: '/other', name: 'Other', temporary: true },
      notes: [],
      workspaceMode: 'remote',
      workspaceRestored: false
    })
    expect(s.getShellSnapshot()).toMatchObject({
      vault: { root: '/other', name: 'Other', temporary: true },
      notes: [],
      workspaceMode: 'remote',
      workspaceRestored: false
    })
    expect(before.vault?.root).toBe('/test')
    s.useStore.setState({ vault: null })
    expect(s.getShellSnapshot().vault).toBeNull()
  })

  it('carries the folder name a host gave, and notices when it changes', async () => {
    // The phone shells describe a vault by a label root and name the folder
    // separately (#692); a snapshot that dropped folderName made the
    // switcher unable to tell which folder is open.
    const s = await setup()
    s.useStore.setState({
      vault: { root: 'On this device › ZenNotes › docs', name: 'Acme API docs', folderName: 'docs' }
    })
    const first = s.getShellSnapshot()
    expect(first.vault).toMatchObject({ name: 'Acme API docs', folderName: 'docs' })
    s.useStore.setState({
      vault: { root: 'On this device › ZenNotes › docs', name: 'Acme API docs', folderName: 'docs2' }
    })
    expect(s.getShellSnapshot().vault?.folderName).toBe('docs2')
    expect(s.getShellSnapshot().vault).not.toBe(first.vault)
  })

  it('observes the current state after an earlier subscriber corrects a transition', async () => {
    const s = await setup()
    disposers.push(
      s.useStore.subscribe((state) => {
        if (state.selectedPath === 'inbox/One.md')
          s.useStore.setState({ selectedPath: null })
      })
    )
    const listener = vi.fn()
    disposers.push(s.subscribeShell(listener))
    s.useStore.setState({ selectedPath: 'inbox/One.md' })
    expect(listener).not.toHaveBeenCalled()
    expect(s.getShellSnapshot().selectedPath).toBeNull()
  })

  it('keeps previous snapshots coherent when a listener causes another public change', async () => {
    const s = await setup()
    const transitions: Array<[string | null, string | null]> = []
    disposers.push(
      s.subscribeShell((next, previous) => {
        transitions.push([previous.selectedPath, next.selectedPath])
        if (next.selectedPath) s.useStore.setState({ selectedPath: null })
      })
    )
    s.useStore.setState({ selectedPath: 'inbox/One.md' })
    expect(transitions).toEqual([
      [null, 'inbox/One.md'],
      ['inbox/One.md', null]
    ])
  })

  it('recomputes folder-relative directories when system folders or primary location change', async () => {
    const s = await setup([
      note('Notes/Work/One.md'),
      note('Saved/Two.md', { folder: 'archive' })
    ])
    const settings = s.useStore.getState().vaultSettings
    s.useStore.setState({
      vaultSettings: {
        ...settings,
        systemFolderPaths: {
          ...settings.systemFolderPaths,
          inbox: 'Notes',
          archive: 'Saved'
        }
      }
    })
    expect(s.getShellSnapshot().notes.map((n) => n.directory)).toEqual([
      'Work',
      ''
    ])
    s.useStore.setState({
      vaultSettings: {
        ...s.useStore.getState().vaultSettings,
        primaryNotesLocation: 'root'
      }
    })
    expect(s.getShellSnapshot().notes.map((n) => n.directory)).toEqual([
      'Notes/Work',
      ''
    ])
  })
})

describe('public Browse ordering', () => {
  const names = (rows: readonly { title: string }[]) => rows.map((n) => n.title)
  it.each([
    ['name-asc', ['Note 2', 'Note 10', 'Note 20']],
    ['name-desc', ['Note 20', 'Note 10', 'Note 2']],
    ['updated-asc', ['Note 10', 'Note 2', 'Note 20']],
    ['updated-desc', ['Note 20', 'Note 2', 'Note 10']],
    ['created-asc', ['Note 20', 'Note 10', 'Note 2']],
    ['created-desc', ['Note 2', 'Note 10', 'Note 20']],
    ['none', ['Note 20', 'Note 2', 'Note 10']],
    ['manual', ['Note 20', 'Note 2', 'Note 10']]
  ] as const)(
    'preserves mobile %s sorting',
    async (noteSortOrder, expected) => {
      const s = await setup([
        note('inbox/Note 10.md', { updatedAt: 1, createdAt: 2 }),
        note('inbox/Note 2.md', { updatedAt: 2, createdAt: 3 }),
        note('inbox/Note 20.md', { updatedAt: 3, createdAt: 1 })
      ])
      s.useStore.setState({ noteSortOrder })
      const snapshot = s.getShellSnapshot()
      expect(names(s.getBrowseNotes(snapshot))).toEqual(expected)
      expect(names(snapshot.notes)).toEqual(['Note 10', 'Note 2', 'Note 20'])
    }
  )

  it('pins first while retaining sorted order within both groups and input order for ties', async () => {
    const s = await setup(
      ['C', 'A', 'B', 'D'].map((name) => note(`inbox/${name}.md`))
    )
    const pins = ['inbox/B.md', 'inbox/C.md', 'inbox/B.md', 'inbox/Gone.md']
    expect(names(s.getBrowseNotes(s.getShellSnapshot(), '', pins))).toEqual([
      'C',
      'B',
      'A',
      'D'
    ])
    s.useStore.setState({ noteSortOrder: 'name-asc' })
    const rows = s.getBrowseNotes(s.getShellSnapshot(), '', pins)
    expect(names(rows)).toEqual(['B', 'C', 'A', 'D'])
    expect(Object.isFrozen(rows)).toBe(true)
    expect(pins).toHaveLength(4)
  })

  it('keeps navigation in the immediate primary folder and stops at both ends', async () => {
    const s = await setup([
      note('inbox/Work/A.md'),
      note('inbox/Work/B.md'),
      note('inbox/Work/nested/C.md'),
      note('inbox/D.md'),
      note('archive/E.md', { folder: 'archive' }),
      note('quick/F.md', { folder: 'quick' })
    ])
    const snapshot = s.getShellSnapshot()
    expect(names(s.getBrowseNotes(snapshot, 'Work'))).toEqual(['A', 'B'])
    expect(s.getAdjacentNotePath(snapshot, 'inbox/Work/A.md', 'next')).toBe(
      'inbox/Work/B.md'
    )
    expect(s.getAdjacentNotePath(snapshot, 'inbox/Work/B.md', 'previous')).toBe(
      'inbox/Work/A.md'
    )
    expect(
      s.getAdjacentNotePath(snapshot, 'inbox/Work/A.md', 'previous')
    ).toBeNull()
    expect(
      s.getAdjacentNotePath(snapshot, 'inbox/Work/B.md', 'next')
    ).toBeNull()
    for (const path of [
      'archive/E.md',
      'quick/F.md',
      'zen://help',
      'missing.md'
    ])
      expect(s.getAdjacentNotePath(snapshot, path, 'next')).toBeNull()
    expect(
      s.getAdjacentNotePath(snapshot, 'inbox/Work/B.md', 'next', [
        'inbox/Work/B.md'
      ])
    ).toBe('inbox/Work/A.md')
  })

  it('excludes database records at every depth while retaining ordinary similarly named folders', async () => {
    const s = await setup([
      note('inbox/People.base/One.md'),
      note('inbox/People.base/pages/Two.md'),
      note('inbox/Work/PEOPLE.BASE/pages/Three.md'),
      note('inbox/People.base-notes/Four.md')
    ])
    const snapshot = s.getShellSnapshot()
    for (const path of [
      'People.base',
      'People.base/pages',
      'Work/PEOPLE.BASE/pages'
    ])
      expect(s.getBrowseNotes(snapshot, path)).toEqual([])
    for (const n of snapshot.notes.slice(0, 3))
      expect(s.getAdjacentNotePath(snapshot, n.path, 'next')).toBeNull()
    expect(names(s.getBrowseNotes(snapshot, 'People.base-notes'))).toEqual([
      'Four'
    ])
  })
})
