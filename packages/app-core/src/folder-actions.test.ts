// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { databaseTabPath } from '@shared/databases'
import { parseTasksFromBody } from '@shared/tasks'
import { makeLeaf, allLeaves } from './lib/pane-layout'
import { PANE_PANELS_CLOSED } from './lib/pane-panels'

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
})

async function setup(root = false) {
  const prefix = root ? '' : 'My Notes/'
  let folders = ['Work', 'Work/People.base', 'Other']
  const files = new Map([
    [`${prefix}Work/Note.md`, 'Saved body.\n'],
    [`${prefix}Work/People.base/data.csv`, 'id,Name\n1,Example\n'],
    [`${prefix}Other/Keep.md`, 'Unchanged.\n']
  ])
  const meta = (path: string, body: string) => ({
    path,
    title: path.split('/').pop()!,
    folder: 'inbox' as const,
    subpath: path.slice(prefix.length, path.lastIndexOf('/')),
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 1,
    size: body.length,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: ''
  })
  const folderRows = () =>
    folders.map((subpath) => ({
      folder: 'inbox' as const,
      subpath,
      siblingOrder: 0
    }))
  const notes = () => [...files].filter(([p]) => p.endsWith('.md')).map(([p, b]) => meta(p, b))
  const bridge = {
    getCapabilities: () => ({}),
    listNotes: async () => notes(),
    listFolders: async () => folderRows(),
    hasAssetsDir: async () => false,
    scanTasks: async () => [],
    scanTasksForPath: async () => [],
    listAssets: async () => [],
    getRemoteWorkspaceInfo: async () => null,
    readNote: async (path: string) => ({
      ...meta(path, files.get(path)!),
      body: files.get(path)!
    }),
    writeNote: vi.fn(async (path: string, body: string) => {
      files.set(path, body)
      return meta(path, body)
    }),
    writeDatabaseRows: vi.fn(async (path: string, rows: unknown) => {
      files.set(path, JSON.stringify(rows))
    }),
    writeDatabaseSchema: vi.fn(async (path: string, _schema: unknown, rows: unknown) => {
      files.set(path, JSON.stringify(rows))
    }),
    setVaultSettings: vi.fn(async (settings) => settings),
    createFolder: vi.fn(async (_folder: string, directory: string) => {
      folders.push(directory)
    }),
    renameFolder: vi.fn(async (_folder: string, from: string, to: string) => {
      folders = folders.map((path) =>
        path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path
      )
      for (const [path, body] of [...files])
        if (path.startsWith(`${prefix}${from}/`)) {
          files.delete(path)
          files.set(`${prefix}${to}/${path.slice(`${prefix}${from}/`.length)}`, body)
        }
      return to
    }),
    deleteFolder: vi.fn(async (_folder: string, directory: string) => {
      folders = folders.filter((path) => path !== directory && !path.startsWith(`${directory}/`))
      for (const path of [...files.keys()])
        if (path.startsWith(`${prefix}${directory}/`)) files.delete(path)
    })
  }
  Object.defineProperty(window, 'zen', { configurable: true, value: bridge })
  const { useStore } = await import('./store')
  const path = `${prefix}Work/Note.md`
  const csv = `${prefix}Work/People.base/data.csv`
  const tab = databaseTabPath(csv)
  const leaf = makeLeaf([path, tab, `${prefix}Other/Keep.md`], path)
  useStore.setState({
    vault: { root: '/test', name: 'Test' },
    notes: notes(),
    folders: folderRows(),
    vaultSettings: {
      ...useStore.getState().vaultSettings,
      primaryNotesLocation: root ? 'root' : 'inbox',
      systemFolderPaths: { inbox: 'My Notes' }
    },
    paneLayout: leaf,
    activePaneId: leaf.id,
    selectedPath: path,
    noteContents: Object.fromEntries(
      notes().map((n) => [n.path, { ...n, body: files.get(n.path)! }])
    ),
    noteDirty: { [path]: true },
    activeNote: { ...meta(path, 'Unsaved edit.\n'), body: 'Unsaved edit.\n' },
    activeDirty: true,
    databases: {
      [csv]: {
        version: 1,
        path: csv,
        title: 'People',
        fields: [],
        rows: [],
        views: [],
        activeViewId: '',
        idFieldId: 'id'
      }
    }
  })
  useStore.setState({
    noteContents: {
      ...useStore.getState().noteContents,
      [path]: { ...meta(path, 'Unsaved edit.\n'), body: 'Unsaved edit.\n' }
    }
  })
  return {
    useStore,
    bridge,
    files,
    prefix,
    path,
    csv,
    tab,
    tabs: () => allLeaves(useStore.getState().paneLayout).flatMap((leaf) => leaf.tabs)
  }
}

describe('folder mutation state', () => {
  it.each([false, true])('renames open notes and database tabs with root mode %s', async (root) => {
    const s = await setup(root)
    await s.useStore.getState().renameFolder('inbox', 'Work', 'Renamed')
    expect(s.tabs()).toEqual([
      `${s.prefix}Renamed/Note.md`,
      databaseTabPath(`${s.prefix}Renamed/People.base/data.csv`),
      `${s.prefix}Other/Keep.md`
    ])
    const state = s.useStore.getState()
    expect(state.activeNote?.body).toBe('Unsaved edit.\n')
    expect(state.selectedPath).toBe(`${s.prefix}Renamed/Note.md`)
    expect(state.databases[`${s.prefix}Renamed/People.base/data.csv`]?.path).toBe(
      `${s.prefix}Renamed/People.base/data.csv`
    )
    expect(state.databases[s.csv]).toBeUndefined()
    await state.persistNote(`${s.prefix}Renamed/Note.md`)
    expect(s.files.get(`${s.prefix}Renamed/Note.md`)).toBe('Unsaved edit.\n')
    expect(s.files.has(s.path)).toBe(false)
    expect(s.files.get(`${s.prefix}Other/Keep.md`)).toBe('Unchanged.\n')
  })

  it.each([false, true])(
    'deletes only the target folder and closes database tabs with root mode %s',
    async (root) => {
      const s = await setup(root)
      await s.useStore.getState().deleteFolder('inbox', 'Work')
      expect(s.tabs()).toEqual([`${s.prefix}Other/Keep.md`])
      expect(s.useStore.getState().databases[s.csv]).toBeUndefined()
      expect(s.useStore.getState().noteContents[s.path]).toBeUndefined()
      expect(s.files.size).toBe(1)
      expect(s.files.get(`${s.prefix}Other/Keep.md`)).toBe('Unchanged.\n')
    }
  )

  it.each(['createFolder', 'renameFolder', 'deleteFolder'] as const)(
    'ignores a %s response after a vault switch',
    async (action) => {
      const s = await setup()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      if (action === 'renameFolder')
        s.bridge.renameFolder.mockImplementationOnce(async () => {
          await gate
          return 'Renamed'
        })
      else
        s.bridge[action].mockImplementationOnce(async () => {
          await gate
        })
      const promise =
        action === 'renameFolder'
          ? s.useStore.getState()[action]('inbox', 'Work', 'Renamed')
          : s.useStore.getState()[action]('inbox', 'Work')
      await vi.waitFor(() => expect(s.bridge[action]).toHaveBeenCalled())
      s.useStore.setState({
        vault: { root: '/other', name: 'Other' },
        notes: [],
        folders: [],
        view: { kind: 'folder', folder: 'inbox', subpath: 'Other vault' }
      })
      const before = s.useStore.getState()
      release()
      await promise
      expect(s.useStore.getState()).toBe(before)
      expect(s.bridge.setVaultSettings).not.toHaveBeenCalled()
    }
  )
  it('uses the canonical directory returned by the host', async () => {
    const s = await setup(true)
    const rename = s.bridge.renameFolder.getMockImplementation()!
    s.bridge.renameFolder.mockImplementationOnce((folder, from) =>
      rename(folder, from, 'Canonical')
    )
    await s.useStore.getState().renameFolder('inbox', 'Work', 'Requested')
    expect(s.useStore.getState().selectedPath).toBe('Canonical/Note.md')
    expect(s.files.has('Canonical/Note.md')).toBe(true)
  })

  it('preserves note and database edits made while a rename is pending', async () => {
    const s = await setup(true)
    const initial = s.useStore.getState().databases[s.csv]
    const before = { ...initial, rows: [{ id: '1', cells: { name: 'Before rename' } }] }
    s.useStore.getState().updateDatabaseRows(s.csv, before)
    const rename = s.bridge.renameFolder.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    s.bridge.renameFolder.mockImplementationOnce(async (...args) => {
      await gate
      return rename(...args)
    })
    const operation = s.useStore.getState().renameFolder('inbox', 'Work', 'Renamed')
    await vi.waitFor(() => expect(s.bridge.renameFolder).toHaveBeenCalled())
    expect(s.bridge.writeDatabaseRows).toHaveBeenCalledWith(s.csv, before.rows)
    await s.useStore
      .getState()
      .applyChange({ kind: 'unlink', path: s.path, scope: 'content', folder: 'inbox' })
    await s.useStore
      .getState()
      .applyChange({ kind: 'unlink', path: s.csv, scope: 'database', folder: 'inbox' })
    expect(s.tabs()).toContain(s.path)
    expect(s.tabs()).toContain(s.tab)
    vi.useFakeTimers()
    s.useStore.getState().updateNoteBody(s.path, 'Typed during rename.\n')
    const during = { ...initial, rows: [{ id: '1', cells: { name: 'During rename' } }] }
    s.useStore.getState().updateDatabaseRows(s.csv, during)
    await vi.advanceTimersByTimeAsync(500)
    expect(s.bridge.writeDatabaseRows).toHaveBeenCalledTimes(1)
    release()
    await operation
    await vi.advanceTimersByTimeAsync(500)
    expect(s.files.get('Renamed/Note.md')).toBe('Typed during rename.\n')
    expect(s.files.get('Renamed/People.base/data.csv')).toBe(JSON.stringify(during.rows))
    expect([...s.files.keys()].some((path) => path.startsWith('Work/'))).toBe(false)
  })

  it('drains a pending database write before deletion and never recreates its files', async () => {
    const s = await setup(true)
    vi.useFakeTimers()
    const doc = s.useStore.getState().databases[s.csv]
    s.useStore
      .getState()
      .updateDatabaseRows(s.csv, { ...doc, rows: [{ id: '1', cells: { name: 'Pending' } }] })
    await s.useStore.getState().deleteFolder('inbox', 'Work/People.base')
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.files.has(s.csv)).toBe(false)
    expect(s.bridge.writeDatabaseRows).toHaveBeenCalledTimes(1)
    expect(s.tabs()).not.toContain(s.tab)
    expect(s.tabs()).toContain(s.path)
  })

  it('resumes pending saves at their original paths when a rename fails', async () => {
    const s = await setup(true)
    let reject!: (error: Error) => void
    const gate = new Promise<string>((_resolve, no) => {
      reject = no
    })
    s.bridge.renameFolder.mockImplementationOnce(() => gate)
    const operation = s.useStore.getState().renameFolder('inbox', 'Work', 'Renamed')
    const failure = expect(operation).rejects.toThrow('Name taken')
    await vi.waitFor(() => expect(s.bridge.renameFolder).toHaveBeenCalled())
    vi.useFakeTimers()
    s.useStore.getState().updateNoteBody(s.path, 'Keep this edit.\n')
    const doc = s.useStore.getState().databases[s.csv]
    const rows = [{ id: '1', cells: { name: 'Keep this cell' } }]
    s.useStore.getState().updateDatabaseRows(s.csv, { ...doc, rows })
    reject(new Error('Name taken'))
    await failure
    await vi.advanceTimersByTimeAsync(500)
    expect(s.files.get(s.path)).toBe('Keep this edit.\n')
    expect(s.files.get(s.csv)).toBe(JSON.stringify(rows))
    expect(s.tabs()).toContain(s.path)
  })

  it('ignores a listing fetched before a vault switch', async () => {
    const s = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const listing = s.bridge.listNotes
    s.bridge.listNotes = async () => {
      await gate
      return listing()
    }
    const refresh = s.useStore.getState().refreshNotes()
    s.useStore.setState({ vault: { root: '/other', name: 'Other' }, notes: [], folders: [] })
    const before = s.useStore.getState()
    release()
    await refresh
    expect(s.useStore.getState()).toBe(before)
  })
  it('does not restore an old database cache from a read completed after rename', async () => {
    const s = await setup(true)
    const old = s.useStore.getState().databases[s.csv]
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    Object.assign(s.bridge, {
      openDatabase: async () => {
        await gate
        return old
      }
    })
    const read = s.useStore.getState().loadDatabase(s.csv)
    await s.useStore.getState().renameFolder('inbox', 'Work', 'Renamed')
    release()
    await read
    expect(s.useStore.getState().databases[s.csv]).toBeUndefined()
    expect(s.useStore.getState().databases['Renamed/People.base/data.csv']).toBeDefined()
    expect(s.tabs()).not.toContain(s.tab)
  })

  it('rejects an old listing completed after a rename and its fresh listing', async () => {
    const s = await setup(true)
    const notes = await s.bridge.listNotes()
    const folders = await s.bridge.listFolders()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalNotes = s.bridge.listNotes
    const originalFolders = s.bridge.listFolders
    s.bridge.listNotes = async () => {
      await gate
      return notes
    }
    s.bridge.listFolders = async () => {
      await gate
      return folders
    }
    const oldRefresh = s.useStore.getState().refreshNotes()
    s.bridge.listNotes = originalNotes
    s.bridge.listFolders = originalFolders
    await s.useStore.getState().renameFolder('inbox', 'Work', 'Renamed')
    release()
    await oldRefresh
    expect(s.useStore.getState().folders.some((row) => row.subpath === 'Work')).toBe(false)
    expect(s.useStore.getState().notes.some((row) => row.path === 'Renamed/Note.md')).toBe(true)
    expect(s.tabs()).toContain('Renamed/Note.md')
  })

  it('lets a waiting vault switch flush edits at the renamed path after invalidation', async () => {
    const s = await setup(true)
    let current = true
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const rename = s.bridge.renameFolder.getMockImplementation()!
    s.bridge.renameFolder.mockImplementationOnce(async (...args) => {
      await gate
      return rename(...args)
    })
    const operation = s.useStore.getState().renameFolder('inbox', 'Work', 'Renamed', () => current)
    await vi.waitFor(() => expect(s.bridge.renameFolder).toHaveBeenCalled())
    s.useStore.getState().updateNoteBody(s.path, 'Save before switching.\n')
    const doc = s.useStore.getState().databases[s.csv]
    const rows = [{ id: '1', cells: { name: 'Save before switching' } }]
    s.useStore.getState().updateDatabaseRows(s.csv, { ...doc, rows })
    current = false
    const flush = s.useStore.getState().flushDirtyNotes()
    release()
    await operation
    await flush
    expect(s.files.get('Renamed/Note.md')).toBe('Save before switching.\n')
    expect(s.files.get('Renamed/People.base/data.csv')).toBe(JSON.stringify(rows))
    expect(s.files.has(s.csv)).toBe(false)
    expect(s.files.has(s.path)).toBe(false)
    expect(s.useStore.getState().selectedPath).toBe('Renamed/Note.md')
  })

  it('does not resume old-path writes after an uncertain rollback', async () => {
    const s = await setup(true)
    let reject!: (error: Error) => void
    const gate = new Promise<string>((_yes, no) => {
      reject = no
    })
    s.bridge.renameFolder.mockImplementationOnce(() => gate)
    const operation = s.useStore.getState().renameFolder('inbox', 'Work', 'Renamed')
    const failure = expect(operation).rejects.toThrow('FOLDER_STATE_UNCERTAIN:')
    await vi.waitFor(() => expect(s.bridge.renameFolder).toHaveBeenCalled())
    vi.useFakeTimers()
    s.useStore.getState().updateNoteBody(s.path, 'Keep in memory.\n')
    const writes = s.bridge.writeNote.mock.calls.length
    reject(new Error('FOLDER_STATE_UNCERTAIN: simulated rollback failure'))
    await failure
    await vi.advanceTimersByTimeAsync(1000)
    await expect(s.useStore.getState().flushDirtyNotes()).rejects.toThrow('Reload the vault')
    expect(s.bridge.writeNote).toHaveBeenCalledTimes(writes)
    expect(s.useStore.getState().noteContents[s.path].body).toBe('Keep in memory.\n')
  })

  it.each(['rename', 'delete'] as const)(
    'reconciles path-bearing state during a waiting switch: %s',
    async (action) => {
      const s = await setup(true)
      const state = s.useStore.getState()
      const asset = {
        path: 'Work/image.png',
        name: 'image.png',
        kind: 'image' as const,
        siblingOrder: 0,
        size: 1,
        updatedAt: 1
      }
      const tasks = parseTasksFromBody('- [ ] Keep task', {
        path: s.path,
        title: 'Note',
        folder: 'inbox'
      })
      s.useStore.setState({
        view: { kind: 'folder', folder: 'inbox', subpath: 'Work' },
        paneModes: { [state.activePaneId]: { [s.path]: 'preview' } },
        panePanels: { [state.activePaneId]: { [s.path]: { ...PANE_PANELS_CLOSED, outline: true } } },
        noteRefs: { [s.path]: { path: asset.path, kind: 'asset', fragment: 'page=2' } },
        manualNoteOrder: { Work: ['Work/Z.md', s.path] },
        vaultSettings: {
          ...state.vaultSettings,
          favorites: ['inbox:Work', s.path, 'Other/Keep.md']
        },
        assetFiles: [asset],
        vaultTasks: tasks
      })
      localStorage.setItem(
        'zen.notes.manualOrder./test',
        JSON.stringify(s.useStore.getState().manualNoteOrder)
      )
      let current = true
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const rename = s.bridge.renameFolder.getMockImplementation()!
      const remove = s.bridge.deleteFolder.getMockImplementation()!
      s.bridge.renameFolder.mockImplementationOnce(async (...args) => {
        await gate
        return rename(...args)
      })
      s.bridge.deleteFolder.mockImplementationOnce(async (...args) => {
        await gate
        return remove(...args)
      })
      const operation =
        action === 'rename'
          ? state.renameFolder('inbox', 'Work', 'Renamed', () => current)
          : state.deleteFolder('inbox', 'Work', () => current)
      await vi.waitFor(() =>
        expect(
          action === 'rename' ? s.bridge.renameFolder : s.bridge.deleteFolder
        ).toHaveBeenCalled()
      )
      const oldNotes = await s.bridge.listNotes()
      const oldFolders = await s.bridge.listFolders()
      let releaseRead!: () => void
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      s.bridge.listNotes = async () => {
        await readGate
        return oldNotes
      }
      s.bridge.listFolders = async () => {
        await readGate
        return oldFolders
      }
      Object.assign(s.bridge, {
        listAssets: async () => {
          await readGate
          return [asset]
        }
      })
      const reads = [state.refreshNotes(), state.refreshAssets()]
      current = false
      release()
      await operation
      releaseRead()
      await Promise.all(reads)
      const next = s.useStore.getState()
      expect(s.bridge.setVaultSettings).toHaveBeenCalled()
      expect(s.bridge.setVaultSettings.mock.calls.at(-1)?.[0].favorites).toEqual(
        action === 'rename'
          ? ['inbox:Renamed', 'Renamed/Note.md', 'Other/Keep.md']
          : ['Other/Keep.md']
      )
      expect(next.notes.some((n) => n.path.startsWith('Work/'))).toBe(false)
      expect(next.folders.some((f) => f.subpath === 'Work')).toBe(false)
      expect(next.paneModes[state.activePaneId][s.path]).toBeUndefined()
      expect(next.panePanels[state.activePaneId][s.path]).toBeUndefined()
      expect(next.noteRefs[s.path]).toBeUndefined()
      expect(next.manualNoteOrder.Work).toBeUndefined()
      expect(JSON.parse(localStorage.getItem('zen.notes.manualOrder./test')!)).toEqual(
        next.manualNoteOrder
      )
      if (action === 'rename') {
        expect(next.view).toEqual({ kind: 'folder', folder: 'inbox', subpath: 'Renamed' })
        expect(next.paneModes[state.activePaneId]['Renamed/Note.md']).toBe('preview')
        // A note's remembered panels follow it through a rename too. (#794)
        expect(next.panePanels[state.activePaneId]['Renamed/Note.md']?.outline).toBe(true)
        expect(next.noteRefs['Renamed/Note.md']).toEqual({
          path: 'Renamed/image.png',
          kind: 'asset',
          fragment: 'page=2'
        })
        expect(next.manualNoteOrder.Renamed).toEqual(['Renamed/Z.md', 'Renamed/Note.md'])
        expect(next.assetFiles[0].path).toBe('Renamed/image.png')
        expect(next.vaultTasks[0]).toMatchObject({
          sourcePath: 'Renamed/Note.md',
          id: 'Renamed/Note.md#0'
        })
      } else {
        expect(next.view).toEqual({ kind: 'folder', folder: 'inbox', subpath: '' })
        expect(next.assetFiles).toEqual([])
        expect(next.vaultTasks).toEqual([])
      }
    }
  )

  it('rejects note and task reads that finish after their folder moves', async () => {
    const s = await setup(true)
    const note = s.useStore.getState().noteContents[s.path]
    s.useStore.setState({ noteContents: {}, noteDirty: {} })
    const tasks = parseTasksFromBody('- [ ] Keep task', {
      path: s.path,
      title: 'Note',
      folder: 'inbox'
    })
    s.useStore.setState({ vaultTasks: tasks })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    Object.assign(s.bridge, {
      readNote: async () => {
        await gate
        return note
      },
      scanTasks: async () => {
        await gate
        return tasks
      },
      scanTasksForPath: async () => {
        await gate
        return tasks
      }
    })
    const reads = [
      s.useStore.getState().selectNote(s.path),
      s.useStore.getState().refreshTasks(),
      s.useStore.getState().rescanTasksForPath(s.path)
    ]
    await s.useStore.getState().renameFolder('inbox', 'Work', 'Renamed')
    release()
    await Promise.all(reads)
    expect(s.useStore.getState().noteContents[s.path]).toBeUndefined()
    expect(s.tabs()).not.toContain(s.path)
    expect(s.useStore.getState().vaultTasks[0].sourcePath).toBe('Renamed/Note.md')
  })

  it.each(['read', 'write'] as const)(
    'drains a pending comment %s before moving its note',
    async (kind) => {
      const s = await setup(true)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const comments = [
        {
          id: 'comment',
          notePath: s.path,
          body: 'Keep this thread',
          createdAt: 1,
          updatedAt: 1,
          anchorStart: 0,
          anchorEnd: 0,
          anchorText: '',
          resolvedAt: null
        }
      ]
      const read = vi.fn(async () => {
        if (kind === 'read') await gate
        return comments
      })
      const write = vi.fn(async () => {
        await gate
        return comments
      })
      Object.assign(s.bridge, { readNoteComments: read, writeNoteComments: write })
      if (kind === 'write') s.useStore.setState({ noteComments: { [s.path]: comments } })
      const comment =
        kind === 'read'
          ? s.useStore.getState().loadNoteComments(s.path)
          : s.useStore.getState().updateNoteComment(s.path, 'comment', { body: 'Keep this thread' })
      const operation = s.useStore.getState().renameFolder('inbox', 'Work', 'Renamed')
      await Promise.resolve()
      expect(s.bridge.renameFolder).not.toHaveBeenCalled()
      expect(await s.useStore.getState().loadNoteComments(s.path)).toEqual([])
      release()
      await Promise.all([comment, operation])
      expect(s.useStore.getState().noteComments[s.path]).toBeUndefined()
      expect(s.useStore.getState().noteComments['Renamed/Note.md']).toMatchObject([
        { notePath: 'Renamed/Note.md', body: 'Keep this thread' }
      ])
      expect(read).toHaveBeenCalledTimes(kind === 'read' ? 1 : 0)
    }
  )
  it('allows database reload and clears task loading after a rejected rename', async () => {
    const s = await setup(true)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const doc = s.useStore.getState().databases[s.csv]
    const open = vi.fn(async () => {
      await gate
      return doc
    })
    Object.assign(s.bridge, {
      openDatabase: open,
      scanTasks: async () => {
        await gate
        return []
      }
    })
    const reads = [s.useStore.getState().loadDatabase(s.csv), s.useStore.getState().refreshTasks()]
    s.bridge.renameFolder.mockRejectedValueOnce(new Error('Name taken'))
    await expect(s.useStore.getState().renameFolder('inbox', 'Work', 'Renamed')).rejects.toThrow(
      'Name taken'
    )
    release()
    await Promise.all(reads)
    expect(s.useStore.getState().tasksLoading).toBe(false)
    expect(s.useStore.getState().databasesLoading[s.csv]).toBe(false)
    await s.useStore.getState().loadDatabase(s.csv)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('renames a database with its open record page and edits made during the move', async () => {
    const s = await setup(true)
    const state = s.useStore.getState()
    const page = 'Work/People.base/Record.md'
    const note = { ...state.noteContents[s.path], path: page, body: 'Record body.' }
    s.files.set(page, note.body)
    s.useStore.setState({
      noteContents: { ...state.noteContents, [page]: note },
      databases: {
        ...state.databases,
        [s.csv]: { ...state.databases[s.csv], pages: { row: page } }
      },
      paneLayout: makeLeaf([s.tab, page], page),
      selectedPath: page
    })
    s.useStore.setState({ activePaneId: allLeaves(s.useStore.getState().paneLayout)[0].id })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const rename = vi.fn(async () => {
      await gate
      await s.bridge.renameFolder('inbox', 'Work/People.base', 'Work/Customers 2.base')
      return 'Work/Customers 2.base/data.csv'
    })
    Object.assign(s.bridge, { renameDatabase: rename })
    const operation = state.renameDatabase(s.csv, 'Customers', () => true)
    await vi.waitFor(() => expect(rename).toHaveBeenCalled())
    s.useStore.getState().updateNoteBody(page, 'During rename.')
    const doc = s.useStore.getState().databases[s.csv]
    const rows = [{ id: 'row', cells: { name: 'Keep this edit' } }]
    s.useStore.getState().updateDatabaseRows(s.csv, { ...doc, rows })
    const expectedPage = s.useStore.getState().noteContents[page].body
    release()
    await operation
    await s.useStore.getState().flushDirtyNotes()
    expect(s.files.has(page)).toBe(false)
    expect(s.files.has(s.csv)).toBe(false)
    expect(s.files.get('Work/Customers 2.base/Record.md')).toBe(expectedPage)
    expect(s.files.get('Work/Customers 2.base/data.csv')).toBe(JSON.stringify(rows))
    expect(s.useStore.getState().databases['Work/Customers 2.base/data.csv'].pages?.row).toBe(
      'Work/Customers 2.base/Record.md'
    )
    expect(s.tabs()).toEqual([
      databaseTabPath('Work/Customers 2.base/data.csv'),
      'Work/Customers 2.base/Record.md'
    ])
  })

  it('waits for database creation before switching and ignores its late UI result', async () => {
    const s = await setup(true)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let current = true
    const create = vi.fn(async () => {
      await gate
      return s.useStore.getState().databases[s.csv]
    })
    Object.assign(s.bridge, { createDatabase: create })
    const operation = s.useStore
      .getState()
      .createDatabase('inbox', 'Work', undefined, () => current)
    await vi.waitFor(() => expect(create).toHaveBeenCalled())
    current = false
    let flushed = false
    const flush = s.useStore
      .getState()
      .flushDirtyNotes()
      .then(() => {
        flushed = true
      })
    await Promise.resolve()
    expect(flushed).toBe(false)
    release()
    await Promise.all([operation, flush])
    expect(s.useStore.getState().selectedPath).toBe(s.path)
    expect(flushed).toBe(true)
  })
})
