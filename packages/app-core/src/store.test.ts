// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TASKS_TAB_PATH, type VaultTask } from '@shared/tasks'
import { WORKFLOWS_TAB_PATH } from '@shared/workflows-view'
import { databaseTabPath, type DatabaseDoc } from '@shared/databases'
import { assetTabPath } from './lib/asset-tabs'
import { findLeaf, type PaneLayout, type PaneLeaf } from './lib/pane-layout'
import { NO_VALUE_COLUMN_ID } from './components/TasksKanban'

function makeTask(content: string, taskIndex = 0): VaultTask {
  return {
    id: `inbox/Note.md#${taskIndex}`,
    sourcePath: 'inbox/Note.md',
    noteTitle: 'Note',
    noteFolder: 'inbox',
    lineNumber: taskIndex,
    taskIndex,
    rawText: `- [ ] ${content}`,
    content,
    checked: false,
    forwarded: false,
    cancelled: false,
    inProgress: false,
    waiting: false,
    tags: []
  }
}

// Some store flows validate tabs against `state.notes` by path, so tests that
// open multiple tabs need note fixtures whose metadata matches each tab path.
function makeNote(body: string, path = 'inbox/Note.md') {
  const title = path.split('/').pop()?.replace(/\.md$/i, '') || 'Note'
  return {
    path,
    title,
    folder: 'inbox' as const,
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 1,
    size: body.length,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: body,
    body
  }
}

function installZen(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      scanTasks: vi.fn().mockResolvedValue([]),
      scanTasksForPath: vi.fn().mockResolvedValue([]),
      getCapabilities: vi.fn().mockReturnValue({
        supportsUpdater: false,
        supportsNativeMenus: false,
        supportsFloatingWindows: false,
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: false,
        supportsCliInstall: false,
        supportsCustomTemplates: false
      }),
      listNotes: vi.fn().mockResolvedValue([makeNote('- [ ] old task')]),
      listFolders: vi.fn().mockResolvedValue([]),
      listLocalVaults: vi.fn().mockResolvedValue([]),
      listAssets: vi.fn().mockResolvedValue([]),
      hasAssetsDir: vi.fn().mockResolvedValue(false),
      getRemoteWorkspaceInfo: vi.fn().mockResolvedValue(null),
      getVaultSettings: vi.fn().mockResolvedValue({}),
      closeVault: vi.fn().mockResolvedValue(null),
      readNote: vi.fn().mockResolvedValue(makeNote('- [ ] old task')),
      // The database save is debounced at the module level, so a write
      // scheduled by one test can fire while a later test is running, against
      // whichever `window.zen` is installed by then. These two are called
      // straight inside the timer callback, so a missing method throws
      // synchronously and escapes the promise `.catch` as an unhandled error
      // that fails the whole run. Defaulting them keeps a stray timer inert
      // regardless of test order; tests that assert on them still override.
      writeDatabaseRows: vi.fn().mockResolvedValue(undefined),
      writeDatabaseSchema: vi.fn().mockResolvedValue(undefined),
      ...overrides
    }
  })
}

// The most recent store module a test loaded. `vi.resetModules` gives every
// test a fresh module, but timers the OLD module already scheduled keep
// running: `updateNoteBody` debounces a `persistNote` at 350ms
// (pathSaveTimers), and database edits debounce a write at 400ms
// (databaseSaveTimers). A test that schedules either without awaiting it
// leaves a straggler that fires against whichever `window.zen` spy is
// installed one or two tests later; a partial mock there turns the write
// into `undefined.catch`, which is an unhandled error that fails the whole
// run (seen on the macOS runner). The cure is the afterEach below: it
// starves both timers' bail-out checks on the old store, so a stray
// persistNote finds nothing dirty and a stray database write finds no doc,
// and each returns before touching `window.zen`.
let lastLoadedStore: { useStore: { setState: (partial: object) => void } } | null = null

async function loadStore() {
  vi.resetModules()
  localStorage.clear()
  const mod = await import('./store')
  lastLoadedStore = mod as unknown as typeof lastLoadedStore
  return mod
}

afterEach(() => {
  lastLoadedStore?.useStore.setState({ noteDirty: {}, databases: {} })
  lastLoadedStore = null
})

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0))
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('tasks cache freshness', () => {
  it('refreshes tasks when focusing an existing Tasks tab', async () => {
    const freshTasks = [makeTask('new task')]
    const scanTasks = vi.fn().mockResolvedValue(freshTasks)
    installZen({ scanTasks })

    const { useStore } = await loadStore()
    const paneId = useStore.getState().activePaneId
    await useStore.getState().openNoteInPane(paneId, TASKS_TAB_PATH)
    await useStore.getState().openNoteInPane(paneId, 'inbox/Note.md')
    useStore.setState({ vaultTasks: [makeTask('stale task')] })

    await useStore.getState().focusTabInPane(paneId, TASKS_TAB_PATH)
    await flushAsyncWork()

    expect(scanTasks).toHaveBeenCalledTimes(1)
    expect(useStore.getState().vaultTasks).toEqual(freshTasks)
  })

  it('rescans changed notes while the Tasks tab is open but inactive', async () => {
    const freshTasks = [makeTask('new task')]
    const scanTasksForPath = vi.fn().mockResolvedValue(freshTasks)
    installZen({ scanTasksForPath })

    const { useStore } = await loadStore()
    const paneId = useStore.getState().activePaneId
    await useStore.getState().openNoteInPane(paneId, TASKS_TAB_PATH)
    await useStore.getState().openNoteInPane(paneId, 'inbox/Note.md')
    useStore.setState({ vaultTasks: [makeTask('stale task')] })

    await useStore.getState().applyChange({
      kind: 'change',
      path: 'inbox/Note.md',
      folder: 'inbox',
      scope: 'content'
    })

    expect(scanTasksForPath).toHaveBeenCalledWith('inbox/Note.md')
    expect(useStore.getState().vaultTasks).toEqual(freshTasks)
  })
})

describe('closed tab history', () => {
  it('reopens closed tabs in reverse close order', async () => {
    installZen({
      readNote: vi.fn((path: string) => Promise.resolve(makeNote(`# ${path}`, path)))
    })

    const { useStore } = await loadStore()
    const paneId = useStore.getState().activePaneId
    useStore.setState({
      notes: [makeNote('A', 'inbox/A.md'), makeNote('B', 'inbox/B.md')]
    })

    await useStore.getState().openNoteInPane(paneId, 'inbox/A.md')
    await useStore.getState().openNoteInPane(paneId, 'inbox/B.md')
    await useStore.getState().closeTabInPane(paneId, 'inbox/A.md')
    await useStore.getState().closeTabInPane(paneId, 'inbox/B.md')

    await useStore.getState().reopenLastClosedTab()
    const reopenedPaneId = useStore.getState().activePaneId
    expect(findLeaf(useStore.getState().paneLayout, reopenedPaneId)?.activeTab).toBe('inbox/B.md')

    await useStore.getState().reopenLastClosedTab()
    const leaf = findLeaf(useStore.getState().paneLayout, reopenedPaneId)
    expect(leaf?.tabs).toEqual(['inbox/A.md', 'inbox/B.md'])
    expect(leaf?.activeTab).toBe('inbox/A.md')
  })
})

describe('daily note patterns', () => {
  it('creates daily notes using the configured directory and title patterns', async () => {
    const created = {
      ...makeNote(''),
      path: 'inbox/2026/06-Jun/2026-06-09-Tue.md',
      title: '2026-06-09-Tue'
    }
    const createNote = vi.fn().mockResolvedValue(created)
    installZen({
      createNote,
      listNotes: vi.fn().mockResolvedValue([created]),
      readNote: vi.fn().mockResolvedValue({ ...created, body: '' })
    })

    const { useStore } = await loadStore()
    useStore.setState({
      notes: [],
      customTemplates: [],
      vaultSettings: {
        primaryNotesLocation: 'inbox',
        dailyNotes: {
          enabled: true,
          directory: 'yyyy/MM-MMM',
          titlePattern: 'yyyy-MM-dd-EEE',
          locale: 'en-US'
        },
        weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
        monthlyNotes: { enabled: false, directory: 'Monthly Notes' },
        folderIcons: {},
        folderColors: {},
        favorites: []
      }
    })

    await useStore.getState().openDailyNoteForDate(new Date(2026, 5, 9))

    expect(createNote).toHaveBeenCalledWith('inbox', '2026-06-09-Tue', '2026/06-Jun')
  })
})

describe('weekly note patterns', () => {
  it('creates weekly notes using the configured directory and title patterns', async () => {
    const created = {
      ...makeNote(''),
      path: 'inbox/2026/06-Jun/2026-W24-Mon.md',
      title: '2026-W24-Mon'
    }
    const createNote = vi.fn().mockResolvedValue(created)
    installZen({
      createNote,
      listNotes: vi.fn().mockResolvedValue([created]),
      readNote: vi.fn().mockResolvedValue({ ...created, body: '' })
    })

    const { useStore } = await loadStore()
    useStore.setState({
      notes: [],
      customTemplates: [],
      vaultSettings: {
        primaryNotesLocation: 'inbox',
        dailyNotes: { enabled: false, directory: 'Daily Notes' },
        weeklyNotes: {
          enabled: true,
          directory: 'yyyy/MM-MMM',
          titlePattern: "yyyy-'W'ww-EEE",
          locale: 'en-US'
        },
        monthlyNotes: { enabled: false, directory: 'Monthly Notes' },
        folderIcons: {},
        folderColors: {},
        favorites: []
      }
    })

    await useStore.getState().openWeeklyNoteForDate(new Date(2026, 5, 9))

    expect(createNote).toHaveBeenCalledWith('inbox', '2026-W24-Mon', '2026/06-Jun')
  })
})

describe('date note pattern history', () => {
  it('keeps existing daily notes dynamic when the daily pattern changes', async () => {
    const oldSettings = {
      primaryNotesLocation: 'inbox' as const,
      dailyNotes: {
        enabled: true,
        directory: 'Daily Notes',
        titlePattern: 'yyyy-MM-dd',
        locale: 'en-US'
      },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      monthlyNotes: { enabled: false, directory: 'Monthly Notes' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    }
    const nextSettings = {
      ...oldSettings,
      dailyNotes: {
        ...oldSettings.dailyNotes,
        directory: 'yyyy/MM-MMM',
        titlePattern: 'yyyy-MM-dd-EEE'
      }
    }
    const existing = {
      ...makeNote('daily'),
      path: 'inbox/Daily Notes/2026-06-12.md',
      title: '2026-06-12',
      body: '# 2026-06-12\n'
    }
    const setVaultSettings = vi.fn().mockImplementation(async (settings) => settings)
    const moveNote = vi.fn()
    const renameNote = vi.fn()
    const createNote = vi.fn()
    installZen({
      setVaultSettings,
      moveNote,
      renameNote,
      createNote,
      listNotes: vi.fn().mockResolvedValue([existing]),
      readNote: vi.fn().mockResolvedValue(existing)
    })

    const { useStore } = await loadStore()
    useStore.setState({
      notes: [existing],
      vaultSettings: oldSettings
    })

    await useStore.getState().setVaultSettings(nextSettings)
    await useStore.getState().openDailyNoteForDate(new Date(2026, 5, 12))

    expect(setVaultSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dailyNotes: expect.objectContaining({
          directory: 'yyyy/MM-MMM',
          titlePattern: 'yyyy-MM-dd-EEE',
          legacyPatterns: [
            { directory: 'Daily Notes', titlePattern: 'yyyy-MM-dd', locale: 'en-US' }
          ]
        })
      })
    )
    expect(moveNote).not.toHaveBeenCalled()
    expect(renameNote).not.toHaveBeenCalled()
    expect(createNote).not.toHaveBeenCalled()
    expect(useStore.getState().selectedPath).toBe(existing.path)
  })

  it('keeps existing weekly notes dynamic when the weekly pattern changes', async () => {
    const oldSettings = {
      primaryNotesLocation: 'inbox' as const,
      dailyNotes: { enabled: false, directory: 'Daily Notes' },
      weeklyNotes: {
        enabled: true,
        directory: 'Weekly Notes',
        titlePattern: "yyyy-'W'ww",
        locale: 'en-US'
      },
      monthlyNotes: { enabled: false, directory: 'Monthly Notes' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    }
    const nextSettings = {
      ...oldSettings,
      weeklyNotes: {
        ...oldSettings.weeklyNotes,
        directory: 'yyyy/MM-MMM',
        titlePattern: "yyyy-'W'ww-EEE"
      }
    }
    const existing = {
      ...makeNote('weekly'),
      path: 'inbox/Weekly Notes/2026-W24.md',
      title: '2026-W24',
      body: '# 2026-W24\n'
    }
    const setVaultSettings = vi.fn().mockImplementation(async (settings) => settings)
    const moveNote = vi.fn()
    const renameNote = vi.fn()
    const createNote = vi.fn()
    installZen({
      setVaultSettings,
      moveNote,
      renameNote,
      createNote,
      listNotes: vi.fn().mockResolvedValue([existing]),
      readNote: vi.fn().mockResolvedValue(existing)
    })

    const { useStore } = await loadStore()
    useStore.setState({
      notes: [existing],
      vaultSettings: oldSettings
    })

    await useStore.getState().setVaultSettings(nextSettings)
    await useStore.getState().openWeeklyNoteForDate(new Date(2026, 5, 12))

    expect(setVaultSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyNotes: expect.objectContaining({
          directory: 'yyyy/MM-MMM',
          titlePattern: "yyyy-'W'ww-EEE",
          legacyPatterns: [
            { directory: 'Weekly Notes', titlePattern: "yyyy-'W'ww", locale: 'en-US' }
          ]
        })
      })
    )
    expect(moveNote).not.toHaveBeenCalled()
    expect(renameNote).not.toHaveBeenCalled()
    expect(createNote).not.toHaveBeenCalled()
    expect(useStore.getState().selectedPath).toBe(existing.path)
  })
})

describe('local vault shortcuts', () => {
  it('stores known local vaults for the sidebar switcher', async () => {
    const localVaults = [
      { root: '/Users/test/Notes', name: 'Notes', lastOpenedAt: 2 },
      { root: '/Users/test/Work', name: 'Work', lastOpenedAt: 1 }
    ]
    const listLocalVaults = vi.fn().mockResolvedValue(localVaults)
    installZen({ listLocalVaults })

    const { useStore } = await loadStore()
    await useStore.getState().refreshLocalVaults()

    expect(listLocalVaults).toHaveBeenCalledTimes(1)
    expect(useStore.getState().localVaults).toEqual(localVaults)
  })

  it('loads asset files during local vault switches', async () => {
    const assetFiles = [
      {
        path: 'assets/photo.png',
        name: 'photo.png',
        kind: 'image' as const,
        siblingOrder: 0,
        size: 42,
        updatedAt: 1
      }
    ]
    const listAssets = vi.fn().mockResolvedValue(assetFiles)
    installZen({
      openLocalVault: vi.fn().mockResolvedValue({ root: '/Users/test/Work', name: 'Work' }),
      getRemoteWorkspaceInfo: vi.fn().mockResolvedValue(null),
      getVaultSettings: vi.fn().mockResolvedValue({}),
      listLocalVaults: vi.fn().mockResolvedValue([]),
      listAssets,
      hasAssetsDir: vi.fn().mockResolvedValue(true)
    })

    const { useStore } = await loadStore()
    useStore.setState({ vault: { root: '/Users/test/Notes', name: 'Notes' } })

    await useStore.getState().openLocalVault('/Users/test/Work')

    expect(listAssets).toHaveBeenCalledTimes(1)
    expect(useStore.getState().assetFiles).toEqual(assetFiles)
    expect(useStore.getState().hasAssetsDir).toBe(true)
  })

  it('switches from a remote workspace to a local vault that shares the server path', async () => {
    // A localhost server reports the served folder's real on-disk path as the
    // vault root, so the current remote vault.root can equal a local vault's
    // path. Switching back to local must not be blocked by that coincidence.
    const sharedRoot = '/Users/test/Shared'
    const openLocalVault = vi
      .fn()
      .mockResolvedValue({ root: sharedRoot, name: 'Shared' })
    installZen({
      openLocalVault,
      getRemoteWorkspaceInfo: vi.fn().mockResolvedValue(null),
      getVaultSettings: vi.fn().mockResolvedValue({}),
      listLocalVaults: vi.fn().mockResolvedValue([]),
      listAssets: vi.fn().mockResolvedValue([]),
      hasAssetsDir: vi.fn().mockResolvedValue(false)
    })

    const { useStore } = await loadStore()
    useStore.setState({
      vault: { root: sharedRoot, name: 'Shared' },
      workspaceMode: 'remote'
    })

    await useStore.getState().openLocalVault(sharedRoot)

    expect(openLocalVault).toHaveBeenCalledWith(sharedRoot)
    expect(useStore.getState().workspaceMode).toBe('local')
    expect(useStore.getState().vault).toEqual({ root: sharedRoot, name: 'Shared' })
  })

  it('ignores reopening the current local vault', async () => {
    const openLocalVault = vi
      .fn()
      .mockResolvedValue({ root: '/Users/test/Notes', name: 'Notes' })
    installZen({ openLocalVault })

    const { useStore } = await loadStore()
    useStore.setState({
      vault: { root: '/Users/test/Notes', name: 'Notes' },
      workspaceMode: 'local'
    })

    await useStore.getState().openLocalVault('/Users/test/Notes')

    expect(openLocalVault).not.toHaveBeenCalled()
  })

  it('closes the current local vault and clears workspace state', async () => {
    const closeVault = vi.fn().mockResolvedValue(null)
    const listLocalVaults = vi.fn().mockResolvedValue([])
    installZen({ closeVault, listLocalVaults })

    const { useStore } = await loadStore()
    useStore.setState({
      vault: { root: '/Users/test/Notes', name: 'Notes' },
      workspaceMode: 'local',
      notes: [makeNote('- [ ] stale task')],
      folders: [{ folder: 'inbox', subpath: 'Projects', siblingOrder: 0 }],
      assetFiles: [
        {
          path: 'assets/photo.png',
          name: 'photo.png',
          kind: 'image' as const,
          siblingOrder: 0,
          size: 42,
          updatedAt: 1
        }
      ],
      selectedPath: 'inbox/Note.md',
      activeNote: makeNote('Body')
    })

    await useStore.getState().closeVault()

    expect(closeVault).toHaveBeenCalledTimes(1)
    expect(listLocalVaults).toHaveBeenCalledTimes(1)
    expect(useStore.getState().vault).toBeNull()
    expect(useStore.getState().notes).toEqual([])
    expect(useStore.getState().folders).toEqual([])
    expect(useStore.getState().assetFiles).toEqual([])
    expect(useStore.getState().selectedPath).toBeNull()
    expect(useStore.getState().activeNote).toBeNull()
    expect(useStore.getState().workspaceRestored).toBe(true)
    expect(useStore.getState().localVaults).toEqual([])
  })

  it('switches to the next remembered local vault when closing the current one', async () => {
    const nextVault = { root: '/Users/test/Work', name: 'Work' }
    const closeVault = vi.fn().mockResolvedValue(nextVault)
    const listLocalVaults = vi.fn().mockResolvedValue([
      { root: nextVault.root, name: nextVault.name, lastOpenedAt: 1 }
    ])
    const listAssets = vi.fn().mockResolvedValue([])
    installZen({
      closeVault,
      listLocalVaults,
      listAssets,
      getVaultSettings: vi.fn().mockResolvedValue({})
    })

    const { useStore } = await loadStore()
    useStore.setState({
      vault: { root: '/Users/test/Notes', name: 'Notes' },
      workspaceMode: 'local',
      notes: [makeNote('- [ ] stale task')],
      selectedPath: 'inbox/Note.md',
      activeNote: makeNote('Body')
    })

    await useStore.getState().closeVault()

    expect(closeVault).toHaveBeenCalledTimes(1)
    expect(useStore.getState().vault).toEqual(nextVault)
    expect(useStore.getState().workspaceRestored).toBe(true)
    expect(useStore.getState().notes).toHaveLength(1)
    expect(listAssets).toHaveBeenCalledTimes(1)
    expect(useStore.getState().localVaults).toEqual([
      { root: nextVault.root, name: nextVault.name, lastOpenedAt: 1 }
    ])
  })

  it('falls back to a remembered local vault when desktop close returns none', async () => {
    const nextVault = { root: '/Users/test/Work', name: 'Work' }
    const closeVault = vi.fn().mockResolvedValue(null)
    const openLocalVault = vi.fn().mockResolvedValue(nextVault)
    const listLocalVaults = vi
      .fn()
      .mockResolvedValueOnce([{ root: nextVault.root, name: nextVault.name, lastOpenedAt: 1 }])
      .mockResolvedValueOnce([{ root: nextVault.root, name: nextVault.name, lastOpenedAt: 2 }])
    installZen({
      closeVault,
      openLocalVault,
      listLocalVaults,
      getVaultSettings: vi.fn().mockResolvedValue({})
    })

    const { useStore } = await loadStore()
    useStore.setState({
      vault: { root: '/Users/test/Notes', name: 'Notes' },
      workspaceMode: 'local',
      localVaults: [{ root: nextVault.root, name: nextVault.name, lastOpenedAt: 1 }]
    })

    await useStore.getState().closeVault()

    expect(closeVault).toHaveBeenCalledTimes(1)
    expect(openLocalVault).toHaveBeenCalledWith(nextVault.root)
    expect(useStore.getState().vault).toEqual(nextVault)
    expect(useStore.getState().localVaults).toEqual([
      { root: nextVault.root, name: nextVault.name, lastOpenedAt: 2 }
    ])
  })
})

describe('asset undo', () => {
  it('records deleted assets and restores them on undo', async () => {
    const deleted = {
      path: 'media/10-7.png',
      name: '10-7.png',
      undoToken: '11111111-1111-4111-8111-111111111111'
    }
    const restored = {
      path: deleted.path,
      name: deleted.name,
      kind: 'image' as const,
      siblingOrder: 0,
      size: 12,
      updatedAt: 2
    }
    const deleteAsset = vi.fn().mockResolvedValue(deleted)
    const restoreDeletedAsset = vi.fn().mockResolvedValue(restored)
    const listAssets = vi.fn().mockResolvedValue([])
    installZen({ deleteAsset, restoreDeletedAsset, listAssets })

    const { useStore } = await loadStore()

    await useStore.getState().deleteAsset(deleted.path)

    expect(deleteAsset).toHaveBeenCalledWith(deleted.path)
    expect(useStore.getState().assetUndoStack).toEqual([
      expect.objectContaining({ kind: 'delete-asset', deleted, createdAt: expect.any(Number) })
    ])

    await expect(useStore.getState().undoLastAssetAction()).resolves.toBe(true)

    expect(restoreDeletedAsset).toHaveBeenCalledWith(deleted)
    expect(useStore.getState().assetUndoStack).toEqual([])
    expect(listAssets).toHaveBeenCalledTimes(2)
  })
})

describe('vault text search jumps', () => {
  it('records the pending editor jump before loading an unopened note', async () => {
    const note = makeNote('first line\nsecond line target\n')
    const pendingRead = deferred<ReturnType<typeof makeNote>>()
    installZen({
      readNote: vi.fn().mockReturnValue(pendingRead.promise)
    })

    const { useStore } = await loadStore()
    const open = useStore.getState().openNoteAtOffset(note.path, 18, { scrollMode: 'center' })

    expect(useStore.getState().pendingJumpLocation).toMatchObject({
      path: note.path,
      editorSelectionAnchor: 18,
      editorSelectionHead: 18,
      editorScrollMode: 'center'
    })

    pendingRead.resolve(note)
    await open
  })
})

describe('importDroppedMarkdownFiles (web import-as-note)', () => {
  it('creates a note from a dropped markdown file, writes its contents, and opens it', async () => {
    const created = { ...makeNote(''), path: 'inbox/Dropped.md', title: 'Dropped' }
    const createNote = vi.fn().mockResolvedValue(created)
    const writeNote = vi.fn().mockResolvedValue(created)
    installZen({
      createNote,
      writeNote,
      listNotes: vi.fn().mockResolvedValue([created]),
      readNote: vi.fn().mockResolvedValue({ ...created, body: '# Hello' })
    })

    const { useStore } = await loadStore()
    const file = { name: 'Dropped.md', text: () => Promise.resolve('# Hello') } as unknown as File

    await useStore.getState().importDroppedMarkdownFiles([file])

    expect(createNote).toHaveBeenCalledWith('inbox', 'Dropped')
    expect(writeNote).toHaveBeenCalledWith('inbox/Dropped.md', '# Hello')
    expect(useStore.getState().selectedPath).toBe('inbox/Dropped.md')
  })

  it('still creates the note when the dropped file is empty (no content write)', async () => {
    const created = { ...makeNote(''), path: 'inbox/Empty.md', title: 'Empty' }
    const createNote = vi.fn().mockResolvedValue(created)
    const writeNote = vi.fn().mockResolvedValue(created)
    installZen({
      createNote,
      writeNote,
      listNotes: vi.fn().mockResolvedValue([created]),
      readNote: vi.fn().mockResolvedValue({ ...created, body: '' })
    })

    const { useStore } = await loadStore()
    const file = { name: 'Empty.md', text: () => Promise.resolve('') } as unknown as File

    await useStore.getState().importDroppedMarkdownFiles([file])

    expect(createNote).toHaveBeenCalledWith('inbox', 'Empty')
    expect(writeNote).not.toHaveBeenCalled()
  })
})

describe('cancelTaskFromList (#450)', () => {
  it('cancels an inline task by writing `[-]` to the note', async () => {
    const note = { ...makeNote('- [ ] Write the proposal'), path: 'inbox/Note.md', title: 'Note' }
    const writeNote = vi.fn().mockResolvedValue(note)
    installZen({
      writeNote,
      listNotes: vi.fn().mockResolvedValue([note]),
      readNote: vi.fn().mockResolvedValue({ ...note, body: '- [ ] Write the proposal' })
    })
    const { useStore } = await loadStore()

    await useStore.getState().cancelTaskFromList(makeTask('Write the proposal', 0))

    expect(writeNote).toHaveBeenCalledWith('inbox/Note.md', '- [-] Write the proposal')
  })

  it('un-cancels a `[-]` task back to `[ ]`', async () => {
    const note = { ...makeNote('- [-] Write the proposal'), path: 'inbox/Note.md', title: 'Note' }
    const writeNote = vi.fn().mockResolvedValue(note)
    installZen({
      writeNote,
      listNotes: vi.fn().mockResolvedValue([note]),
      readNote: vi.fn().mockResolvedValue({ ...note, body: '- [-] Write the proposal' })
    })
    const { useStore } = await loadStore()

    await useStore.getState().cancelTaskFromList({ ...makeTask('Write the proposal', 0), cancelled: true })

    expect(writeNote).toHaveBeenCalledWith('inbox/Note.md', '- [ ] Write the proposal')
  })
})

describe('optimistic task state transitions (#512)', () => {
  it('starting a completed file task immediately clears every competing state', async () => {
    installZen()
    const { useStore } = await loadStore()
    const body = '---\ntags: [task]\nstatus: done\ncompletedDate: 2026-08-01\n---\n'
    const task: VaultTask = {
      ...makeTask('Note', -1),
      id: 'inbox/Note.md#file',
      taskIndex: -1,
      kind: 'file',
      rawText: '',
      checked: true,
      cancelled: false,
      inProgress: false,
      waiting: true,
      status: 'done',
      fields: { status: 'done' }
    }
    useStore.setState({
      noteContents: { 'inbox/Note.md': makeNote(body) },
      vaultTasks: [task]
    })

    await useStore.getState().startTaskFromList(task)

    expect(useStore.getState().vaultTasks[0]).toMatchObject({
      checked: false,
      forwarded: false,
      cancelled: false,
      inProgress: true,
      waiting: false,
      status: 'in-progress',
      fields: { status: 'in-progress' }
    })
  })

  it('starting a forwarded inline task immediately clears the old state marker', async () => {
    installZen()
    const { useStore } = await loadStore()
    const task: VaultTask = {
      ...makeTask('Send draft', 0),
      rawText: '- [>] Send draft',
      forwarded: true
    }
    useStore.setState({
      noteContents: { 'inbox/Note.md': makeNote('- [>] Send draft') },
      vaultTasks: [task]
    })

    await useStore.getState().startTaskFromList(task)

    expect(useStore.getState().vaultTasks[0]).toMatchObject({
      checked: false,
      forwarded: false,
      cancelled: false,
      inProgress: true
    })
  })

  it('completing or cancelling a file task immediately clears in-progress', async () => {
    installZen()
    const { useStore } = await loadStore()
    const body = '---\ntags: [task]\nstatus: in-progress\n---\n'
    const task: VaultTask = {
      ...makeTask('Note', -1),
      id: 'inbox/Note.md#file',
      taskIndex: -1,
      kind: 'file',
      rawText: '',
      inProgress: true,
      status: 'in-progress',
      fields: { status: 'in-progress' }
    }
    useStore.setState({
      noteContents: { 'inbox/Note.md': makeNote(body) },
      vaultTasks: [task]
    })

    await useStore.getState().toggleTaskFromList(task)
    expect(useStore.getState().vaultTasks[0]).toMatchObject({
      checked: true,
      cancelled: false,
      inProgress: false,
      waiting: false,
      status: 'done'
    })

    useStore.setState({
      noteContents: { 'inbox/Note.md': makeNote(body) },
      vaultTasks: [task]
    })
    await useStore.getState().cancelTaskFromList(task)
    expect(useStore.getState().vaultTasks[0]).toMatchObject({
      checked: false,
      cancelled: true,
      inProgress: false,
      waiting: false,
      status: 'cancelled'
    })
  })
})

describe('preview tabs (VS Code-style open flow)', () => {
  function activeLeaf(store: { paneLayout: PaneLayout; activePaneId: string }): PaneLeaf {
    const leaf = findLeaf(store.paneLayout, store.activePaneId)
    if (!leaf) throw new Error('no active leaf')
    return leaf
  }

  it('previews replace each other; a permanent re-open promotes the preview', async () => {
    const noteA = { ...makeNote('alpha'), path: 'inbox/A.md', title: 'A' }
    const noteB = { ...makeNote('beta'), path: 'inbox/B.md', title: 'B' }
    installZen({
      readNote: vi
        .fn()
        .mockImplementation((path: string) =>
          Promise.resolve(path === 'inbox/A.md' ? noteA : noteB)
        )
    })

    const { useStore } = await loadStore()

    // Single click: open A as the preview tab.
    await useStore.getState().previewNote('inbox/A.md')
    let leaf = activeLeaf(useStore.getState())
    expect(leaf.tabs).toEqual(['inbox/A.md'])
    expect(leaf.previewTab).toBe('inbox/A.md')

    // Single click on B: it takes over A's preview slot.
    await useStore.getState().previewNote('inbox/B.md')
    leaf = activeLeaf(useStore.getState())
    expect(leaf.tabs).toEqual(['inbox/B.md'])
    expect(leaf.previewTab).toBe('inbox/B.md')

    // Double click / Enter on the note that is already the active preview:
    // the permanent open must promote it (regression: the already-active
    // fast path used to return early without promoting).
    await useStore.getState().selectNote('inbox/B.md')
    leaf = activeLeaf(useStore.getState())
    expect(leaf.tabs).toEqual(['inbox/B.md'])
    expect(leaf.previewTab).toBeNull()

    // The next preview opens alongside the promoted tab instead of replacing it.
    await useStore.getState().previewNote('inbox/A.md')
    leaf = activeLeaf(useStore.getState())
    expect(leaf.tabs).toEqual(['inbox/B.md', 'inbox/A.md'])
    expect(leaf.previewTab).toBe('inbox/A.md')
  })

  it('editing the previewed note promotes it', async () => {
    const noteA = { ...makeNote('alpha'), path: 'inbox/A.md', title: 'A' }
    installZen({
      readNote: vi.fn().mockResolvedValue(noteA),
      writeNote: vi.fn().mockResolvedValue({ ...noteA, updatedAt: 2 })
    })

    const { useStore } = await loadStore()

    await useStore.getState().previewNote('inbox/A.md')
    expect(activeLeaf(useStore.getState()).previewTab).toBe('inbox/A.md')

    useStore.getState().updateNoteBody('inbox/A.md', 'alpha edited')
    expect(activeLeaf(useStore.getState()).previewTab).toBeNull()
  })
})

describe('note jump history with database tabs', () => {
  // A database can be the active tab two ways: the `zen://database/…` tab
  // ("New Database"), or a `.csv` opened directly as an asset tab
  // (`zen://asset/Foo.csv`) that renders as a grid. Both must round-trip so
  // Ctrl+O from a record page returns to the grid.
  it.each([
    ['database tab', databaseTabPath('Projects.csv')],
    ['csv asset tab', assetTabPath('Projects.csv')]
  ])('Ctrl+O (jumpToPreviousNote) returns to the %s a record page was opened from', async (_label, dbTab) => {
    installZen()
    const { useStore } = await loadStore()

    // Open the database surface, then open a record page note from it.
    await useStore.getState().selectNote(dbTab)
    expect(useStore.getState().selectedPath).toBe(dbTab)

    await useStore.getState().selectNote('inbox/Note.md')
    expect(useStore.getState().selectedPath).toBe('inbox/Note.md')
    // The database must be recorded as a back-target (it is a virtual tab, so
    // without the database-surface exception it would be dropped here).
    expect(useStore.getState().noteBackstack.map((l) => l.path)).toContain(dbTab)

    // Ctrl+O → jump back to the grid.
    await useStore.getState().jumpToPreviousNote()
    expect(useStore.getState().selectedPath).toBe(dbTab)
  })
})

describe('note jump history for offset opens (#484)', () => {
  // Opening a note *at an offset* — a template's `{{cursor}}`, a vault-search
  // hit, a `[[note#heading]]` link — went straight to the raw tab primitive and
  // recorded nothing, so Ctrl+O skipped straight past the note you left. After
  // "New Note from Template" with only one note behind you, it did nothing at
  // all, which is how this was reported.
  it('records where you came from, so Ctrl+O returns there', async () => {
    installZen({
      readNote: vi
        .fn()
        .mockImplementation(async (path: string) => makeNote('body text', path))
    })
    const { useStore } = await loadStore()

    await useStore.getState().selectNote('inbox/From.md')
    expect(useStore.getState().selectedPath).toBe('inbox/From.md')

    await useStore.getState().openNoteAtOffset('inbox/Target.md', 4)
    expect(useStore.getState().selectedPath).toBe('inbox/Target.md')
    expect(useStore.getState().noteBackstack.map((l) => l.path)).toContain('inbox/From.md')

    await useStore.getState().jumpToPreviousNote()
    expect(useStore.getState().selectedPath).toBe('inbox/From.md')
  })

  it('leaves the forward stack ready after jumping back', async () => {
    installZen({
      readNote: vi
        .fn()
        .mockImplementation(async (path: string) => makeNote('body text', path))
    })
    const { useStore } = await loadStore()

    await useStore.getState().selectNote('inbox/From.md')
    await useStore.getState().openNoteAtOffset('inbox/Target.md', 4)
    await useStore.getState().jumpToPreviousNote()
    expect(useStore.getState().selectedPath).toBe('inbox/From.md')

    await useStore.getState().jumpToNextNote()
    expect(useStore.getState().selectedPath).toBe('inbox/Target.md')
  })

  it('does not record a jump to the note already open', async () => {
    installZen({
      readNote: vi
        .fn()
        .mockImplementation(async (path: string) => makeNote('body text', path))
    })
    const { useStore } = await loadStore()

    await useStore.getState().selectNote('inbox/Same.md')
    const before = useStore.getState().noteBackstack.length
    await useStore.getState().openNoteAtOffset('inbox/Same.md', 8)
    expect(useStore.getState().noteBackstack.length).toBe(before)
  })
})

describe('database deletion', () => {
  it('forgets a deleted database instead of re-reading the gone file', async () => {
    const csvPath = 'quick/Untitled Database.csv'
    const doc = { path: csvPath, title: 'Untitled Database', rows: [], columns: [], views: [] }
    const openDatabase = vi.fn().mockResolvedValue(doc)
    installZen({ openDatabase })

    const { useStore } = await loadStore()
    const paneId = useStore.getState().activePaneId
    const tabPath = databaseTabPath(csvPath)

    // Open the database: caches the doc and opens its tab.
    await useStore.getState().openDatabase(csvPath)
    expect(useStore.getState().databases[csvPath]).toBeTruthy()
    expect(findLeaf(useStore.getState().paneLayout, paneId)?.tabs).toContain(tabPath)

    openDatabase.mockClear()

    // The watcher reports the .csv was deleted (the user removed the database).
    await useStore.getState().applyChange({
      kind: 'unlink',
      path: csvPath,
      folder: 'quick',
      scope: 'database'
    })

    // It must NOT re-read the gone file (that throws "Database not found" and
    // logs an Electron handler error in the terminal).
    expect(openDatabase).not.toHaveBeenCalled()
    // The cached doc is dropped and its tab is closed.
    expect(useStore.getState().databases[csvPath]).toBeUndefined()
    expect(findLeaf(useStore.getState().paneLayout, paneId)?.tabs ?? []).not.toContain(tabPath)
  })

  it('still re-reads on a non-delete database change', async () => {
    const csvPath = 'quick/Live.csv'
    const v1 = { path: csvPath, title: 'Live', rows: [], columns: [], views: [] }
    const v2 = { ...v1, rows: [{ id: 'r1' }] }
    const openDatabase = vi.fn().mockResolvedValueOnce(v1).mockResolvedValue(v2)
    installZen({ openDatabase })

    const { useStore } = await loadStore()
    await useStore.getState().openDatabase(csvPath)
    openDatabase.mockClear()

    // A change (not a delete) more than the write-echo window ago re-syncs.
    await useStore.getState().applyChange({
      kind: 'change',
      path: csvPath,
      folder: 'quick',
      scope: 'database'
    })

    expect(openDatabase).toHaveBeenCalledWith(csvPath)
    expect(useStore.getState().databases[csvPath]).toBeTruthy()
  })

  it('closes a stale tab when the database no longer exists (open returns null)', async () => {
    // Simulates a database tab restored on startup after its .csv was deleted:
    // DatabaseView calls loadDatabase, the main process returns null (no throw),
    // and the renderer forgets the tab instead of looping on a missing file.
    const csvPath = 'inbox/Gone.csv'
    const openDatabase = vi.fn().mockResolvedValue(null)
    installZen({ openDatabase })

    const { useStore } = await loadStore()
    const paneId = useStore.getState().activePaneId
    const tabPath = databaseTabPath(csvPath)

    // Restore the tab directly (as the persisted layout would on launch).
    await useStore.getState().openNoteInPane(paneId, tabPath)
    expect(findLeaf(useStore.getState().paneLayout, paneId)?.tabs).toContain(tabPath)

    // DatabaseView's effect fires this when it has no cached doc.
    await useStore.getState().loadDatabase(csvPath)

    expect(useStore.getState().databases[csvPath]).toBeUndefined()
    expect(findLeaf(useStore.getState().paneLayout, paneId)?.tabs ?? []).not.toContain(tabPath)
  })
})

describe('viewPrefsFromVault (#292 — per-vault view overlay)', () => {
  type ViewArg = Parameters<Awaited<ReturnType<typeof loadStore>>['viewPrefsFromVault']>[0]

  it('overlays valid view overrides onto the prefs patch', async () => {
    installZen()
    const { viewPrefsFromVault } = await loadStore()
    const patch = viewPrefsFromVault({
      view: {
        noteSortOrder: 'name-asc',
        groupByKind: false,
        tasksViewMode: 'kanban',
        kanbanGroupBy: 'priority',
        autoReveal: true,
        unifiedSidebar: true
      }
    } as unknown as ViewArg)
    expect(patch.noteSortOrder).toBe('name-asc')
    expect(patch.groupByKind).toBe(false)
    expect(patch.tasksViewMode).toBe('kanban')
    expect(patch.kanbanGroupBy).toBe('priority')
    expect(patch.autoReveal).toBe(true)
    expect(patch.unifiedSidebar).toBe(true)
  })

  it('drops invalid enum values (they stay out of the patch → keep the global)', async () => {
    installZen()
    const { viewPrefsFromVault } = await loadStore()
    const patch = viewPrefsFromVault({
      view: { noteSortOrder: 'totally-invalid', tasksViewMode: 'nope' }
    } as unknown as ViewArg)
    expect('noteSortOrder' in patch).toBe(false)
    expect('tasksViewMode' in patch).toBe(false)
  })

  it('overlays the Assets sort order, and drops an invalid one (#473)', async () => {
    installZen()
    const { viewPrefsFromVault } = await loadStore()
    expect(
      viewPrefsFromVault({ view: { assetSortOrder: 'modified-desc' } } as unknown as ViewArg)
        .assetSortOrder
    ).toBe('modified-desc')
    expect(
      'assetSortOrder' in
        viewPrefsFromVault({ view: { assetSortOrder: 'size-sideways' } } as unknown as ViewArg)
    ).toBe(false)
  })
  it('returns an empty patch when there is no view block', async () => {
    installZen()
    const { viewPrefsFromVault } = await loadStore()
    expect(viewPrefsFromVault({} as unknown as ViewArg)).toEqual({})
    expect(viewPrefsFromVault(null)).toEqual({})
  })

  it('overlays and normalizes kanbanColumnOrder (#389)', async () => {
    installZen()
    const { viewPrefsFromVault } = await loadStore()
    const patch = viewPrefsFromVault({
      view: {
        kanbanColumnOrder: {
          'field:status': ['review', 'backlog', 'review', 42, 'done'],
          'not-a-groupby': ['x'],
          priority: []
        }
      }
    } as unknown as ViewArg)
    // Dedupes, drops non-strings, drops unknown group-bys, drops empty arrays.
    expect(patch.kanbanColumnOrder).toEqual({ 'field:status': ['review', 'backlog', 'done'] })
  })

  it('overlays and normalizes kanbanCardOrder (manual card arrangement)', async () => {
    installZen()
    const { viewPrefsFromVault } = await loadStore()
    const key = (path: string, index: number): string => `${path}\0${index}`
    const patch = viewPrefsFromVault({
      view: {
        kanbanCardOrder: {
          'status:today': [key('inbox/a.md', 1), key('inbox/b.md', 0), key('inbox/a.md', 1), 42],
          'field:status:review': [key('inbox/c.md', 3)],
          'not-a-groupby:today': [key('inbox/d.md', 0)],
          'status:done': []
        }
      }
    } as unknown as ViewArg)
    // Dedupes, drops non-strings, drops unknown board keys, drops empty lists.
    expect(patch.kanbanCardOrder).toEqual({
      'status:today': [key('inbox/a.md', 1), key('inbox/b.md', 0)],
      'field:status:review': [key('inbox/c.md', 3)]
    })
  })

  it('keeps a renamed No-value bucket title through normalization (#389)', async () => {
    installZen()
    const { viewPrefsFromVault } = await loadStore()
    // The "No <field>" bucket's title key ends in the __none__ sentinel; its
    // underscore prefix must not be rejected, or the rename would silently vanish.
    const key = `field:status:${NO_VALUE_COLUMN_ID}`
    const patch = viewPrefsFromVault({
      view: { kanbanColumnTitles: { [key]: 'Unassigned', 'field:status:review': 'In review' } }
    } as unknown as ViewArg)
    expect(patch.kanbanColumnTitles).toEqual({ [key]: 'Unassigned', 'field:status:review': 'In review' })
  })
})

describe('assetSortOrder (#473: Assets view sort is sticky)', () => {
  it('defaults to name-asc and survives a store reload', async () => {
    installZen()
    const first = await loadStore()
    expect(first.useStore.getState().assetSortOrder).toBe('name-asc')

    first.useStore.getState().setAssetSortOrder('modified-desc')
    expect(first.useStore.getState().assetSortOrder).toBe('modified-desc')

    // Re-import without clearing localStorage: this is the "quit and reopen"
    // path, and the header choice has to come back with it.
    vi.resetModules()
    const reloaded = await import('./store')
    expect(reloaded.useStore.getState().assetSortOrder).toBe('modified-desc')
  })

  it('falls back to the default when the persisted value is junk', async () => {
    installZen()
    const { DEFAULT_PREFS } = await loadStore()
    localStorage.setItem(
      'zen:prefs:v2',
      JSON.stringify({ ...DEFAULT_PREFS, assetSortOrder: 'nonsense' })
    )
    vi.resetModules()
    const reloaded = await import('./store')
    expect(reloaded.useStore.getState().assetSortOrder).toBe('name-asc')
  })
})

describe('setKanbanColumnOrder (#389 — manual Kanban column order)', () => {
  it('stores a trimmed, deduped order per board and clears it on empty', async () => {
    installZen()
    const { useStore } = await loadStore()
    useStore
      .getState()
      .setKanbanColumnOrder('field:status', ['review', 'backlog', 'review', ' done '])
    expect(useStore.getState().kanbanColumnOrder['field:status']).toEqual([
      'review',
      'backlog',
      'done'
    ])
    useStore.getState().setKanbanColumnOrder('field:status', [])
    expect(useStore.getState().kanbanColumnOrder['field:status']).toBeUndefined()
  })
})

describe('viewSettingsScope (#292 — global vs per-vault)', () => {
  it('overlays the vault view when switching to per-vault, not when switching to global', async () => {
    installZen()
    const { useStore } = await loadStore()
    // A vault override that differs from the live (global) prefs.
    useStore.setState({
      vaultSettings: {
        ...useStore.getState().vaultSettings,
        view: { groupByKind: false, noteSortOrder: 'name-asc' }
      },
      groupByKind: true,
      noteSortOrder: 'none',
      viewSettingsScope: 'global'
    })
    // Global scope leaves the live (global) prefs alone.
    useStore.getState().setViewSettingsScope('global')
    expect(useStore.getState().groupByKind).toBe(true)
    expect(useStore.getState().noteSortOrder).toBe('none')
    // Per-vault scope overlays the vault's saved view immediately (no reopen).
    useStore.getState().setViewSettingsScope('vault')
    expect(useStore.getState().groupByKind).toBe(false)
    expect(useStore.getState().noteSortOrder).toBe('name-asc')
  })
})

describe('pdfExportUseTheme — theme in PDF export', () => {
  it('defaults off and round-trips through persistence', async () => {
    installZen()
    const { useStore } = await loadStore()
    expect(useStore.getState().pdfExportUseTheme).toBe(false)

    useStore.getState().setPdfExportUseTheme(true)
    expect(useStore.getState().pdfExportUseTheme).toBe(true)
    // collectPrefs persisted it to localStorage.
    const saved = JSON.parse(localStorage.getItem('zen:prefs:v2') ?? '{}')
    expect(saved.pdfExportUseTheme).toBe(true)

    // A fresh module instance reads it back via loadPrefs → normalizePrefs.
    vi.resetModules()
    const reloaded = await import('./store')
    expect(reloaded.useStore.getState().pdfExportUseTheme).toBe(true)
  })

  it('normalizes missing and non-boolean stored values to false', async () => {
    installZen()
    await loadStore() // fresh module + cleared storage

    // Non-boolean → default.
    localStorage.setItem('zen:prefs:v2', JSON.stringify({ pdfExportUseTheme: 'yes' }))
    vi.resetModules()
    const bad = await import('./store')
    expect(bad.useStore.getState().pdfExportUseTheme).toBe(false)

    // Missing → default.
    localStorage.setItem('zen:prefs:v2', JSON.stringify({ themeId: 'dark-hard' }))
    vi.resetModules()
    const missing = await import('./store')
    expect(missing.useStore.getState().pdfExportUseTheme).toBe(false)
  })
})

describe('workflowsEnabled (Workflows feature switch)', () => {
  it('defaults off and round-trips the opt-in through persistence', async () => {
    installZen()
    const { useStore } = await loadStore()
    // Off by default: workflows can rewrite notes in bulk, so the feature is
    // something a user turns on once in Settings, not something they stumble
    // into. The toggle is the front door.
    expect(useStore.getState().workflowsEnabled).toBe(false)

    useStore.getState().setWorkflowsEnabled(true)
    expect(useStore.getState().workflowsEnabled).toBe(true)
    const saved = JSON.parse(localStorage.getItem('zen:prefs:v2') ?? '{}')
    expect(saved.workflowsEnabled).toBe(true)

    vi.resetModules()
    const reloaded = await import('./store')
    expect(reloaded.useStore.getState().workflowsEnabled).toBe(true)
  })

  it('normalizes missing and non-boolean stored values to off', async () => {
    installZen()
    await loadStore() // fresh module + cleared storage

    localStorage.setItem('zen:prefs:v2', JSON.stringify({ workflowsEnabled: 'nope' }))
    vi.resetModules()
    const bad = await import('./store')
    expect(bad.useStore.getState().workflowsEnabled).toBe(false)

    localStorage.setItem('zen:prefs:v2', JSON.stringify({ themeId: 'dark-hard' }))
    vi.resetModules()
    const missing = await import('./store')
    expect(missing.useStore.getState().workflowsEnabled).toBe(false)
  })

  it('closes an open Workflows tab when the feature is switched off', async () => {
    installZen()
    const { useStore } = await loadStore()
    const paneId = useStore.getState().activePaneId
    useStore.setState({ notes: [makeNote('A', 'inbox/A.md')] })
    // Opted in first: the default is off and openWorkflowsView refuses then.
    useStore.getState().setWorkflowsEnabled(true)

    await useStore.getState().openNoteInPane(paneId, 'inbox/A.md')
    await useStore.getState().openWorkflowsView()
    expect(findLeaf(useStore.getState().paneLayout, paneId)?.tabs).toContain(WORKFLOWS_TAB_PATH)

    useStore.getState().setWorkflowsEnabled(false)
    await flushAsyncWork()
    // No live canvas may survive behind a disabled feature.
    expect(findLeaf(useStore.getState().paneLayout, paneId)?.tabs).not.toContain(
      WORKFLOWS_TAB_PATH
    )
  })

  it('refuses to open the view while the feature is off', async () => {
    installZen()
    const { useStore } = await loadStore()
    useStore.getState().setWorkflowsEnabled(false)

    await useStore.getState().openWorkflowsView()

    const paneId = useStore.getState().activePaneId
    expect(findLeaf(useStore.getState().paneLayout, paneId)?.tabs ?? []).not.toContain(
      WORKFLOWS_TAB_PATH
    )
  })
})

describe('date-nav expand state (#301)', () => {
  it('expand/collapse/toggle add and remove keys', async () => {
    installZen()
    const { useStore } = await loadStore()
    const s = () => useStore.getState()

    expect(s().dateNavExpanded).toEqual([])

    s().expandDateNav('d:2026')
    expect(s().dateNavExpanded).toContain('d:2026')

    // idempotent — expanding an already-open group adds no duplicate
    s().expandDateNav('d:2026')
    expect(s().dateNavExpanded.filter((k) => k === 'd:2026')).toHaveLength(1)

    s().expandDateNav('d:2026:7')
    expect(s().dateNavExpanded).toEqual(['d:2026', 'd:2026:7'])

    s().collapseDateNav('d:2026')
    expect(s().dateNavExpanded).toEqual(['d:2026:7'])

    // collapsing an absent key is a no-op
    s().collapseDateNav('nope')
    expect(s().dateNavExpanded).toEqual(['d:2026:7'])

    s().toggleDateNav('w:2026')
    expect(s().dateNavExpanded).toContain('w:2026')
    s().toggleDateNav('w:2026')
    expect(s().dateNavExpanded).not.toContain('w:2026')
  })
})

describe('deleteDatabaseRows (#391 — purge record-page schema mappings)', () => {
  const CSV = 'db.base/data.csv'
  function makeDbDoc(): DatabaseDoc {
    return {
      version: 1,
      idFieldId: 'f_id',
      fields: [],
      views: [],
      activeViewId: 'v1',
      path: CSV,
      title: 'db',
      rows: [
        { id: 'r1', cells: { f_id: 'r1' } },
        { id: 'r2', cells: { f_id: 'r2' } }
      ],
      pages: { r1: 'db.base/pages/r1.md' },
      pageHasContent: { r1: true }
    } as unknown as DatabaseDoc
  }

  it('purges the deleted row page mapping and trashes the note on confirm', async () => {
    const moveToTrash = vi.fn().mockResolvedValue({})
    installZen({
      moveToTrash,
      writeDatabaseSchema: vi.fn().mockResolvedValue(undefined),
      writeDatabaseRows: vi.fn().mockResolvedValue(undefined)
    })
    const { useStore } = await loadStore()
    const { getConfirmRequest, settleConfirmRequest } = await import('./lib/confirm-requests')
    useStore.setState({ databases: { [CSV]: makeDbDoc() } })

    const p = useStore.getState().deleteDatabaseRows(CSV, ['r1'])
    const req = getConfirmRequest()
    expect(req).toBeTruthy() // prompted because r1 has a linked page
    settleConfirmRequest(req!, true) // "Delete row + note"
    await p

    const doc = useStore.getState().databases[CSV]!
    expect(doc.rows.map((r) => r.id)).toEqual(['r2'])
    expect(doc.pages).toEqual({})
    expect(doc.pageHasContent).toEqual({})
    expect(moveToTrash).toHaveBeenCalledWith('db.base/pages/r1.md')
  })

  it('keeps the note on cancel but still purges the stale mapping', async () => {
    const moveToTrash = vi.fn().mockResolvedValue({})
    installZen({
      moveToTrash,
      writeDatabaseSchema: vi.fn().mockResolvedValue(undefined),
      writeDatabaseRows: vi.fn().mockResolvedValue(undefined)
    })
    const { useStore } = await loadStore()
    const { getConfirmRequest, settleConfirmRequest } = await import('./lib/confirm-requests')
    useStore.setState({ databases: { [CSV]: makeDbDoc() } })

    const p = useStore.getState().deleteDatabaseRows(CSV, ['r1'])
    settleConfirmRequest(getConfirmRequest()!, false) // "Keep note"
    await p

    const doc = useStore.getState().databases[CSV]!
    expect(doc.rows.map((r) => r.id)).toEqual(['r2'])
    expect(doc.pages).toEqual({}) // stale mapping purged even when the note is kept
    expect(moveToTrash).not.toHaveBeenCalled()
  })

  it('deletes a page-less row without prompting', async () => {
    installZen({
      writeDatabaseRows: vi.fn().mockResolvedValue(undefined),
      writeDatabaseSchema: vi.fn().mockResolvedValue(undefined)
    })
    const { useStore } = await loadStore()
    const { getConfirmRequest } = await import('./lib/confirm-requests')
    useStore.setState({ databases: { [CSV]: makeDbDoc() } })

    await useStore.getState().deleteDatabaseRows(CSV, ['r2']) // r2 has no linked page
    expect(getConfirmRequest()).toBeNull() // no prompt
    const doc = useStore.getState().databases[CSV]!
    expect(doc.rows.map((r) => r.id)).toEqual(['r1'])
    expect(doc.pages).toEqual({ r1: 'db.base/pages/r1.md' })
  })
})

describe('renameNote heading sync (#455)', () => {
  const BODY = '# Untitled\n\nbody\n'
  // `listNotes`/`renameNote` hand back NoteMeta — metadata only, no body. The
  // buffer is the only place a body lives, so the fixtures must not carry one
  // or a refresh would spread a stale body back over the rewritten heading.
  function metaOf(path: string, title: string) {
    const { body: _body, ...meta } = makeNote('', path)
    return { ...meta, title }
  }
  const renamedMeta = metaOf('inbox/Groceries.md', 'Groceries')

  function installRename(overrides: Record<string, unknown> = {}) {
    const renameNote = vi.fn().mockResolvedValue(renamedMeta)
    const writeNote = vi.fn().mockResolvedValue(renamedMeta)
    const readNote = vi
      .fn()
      .mockImplementation((path: string) =>
        Promise.resolve({ ...metaOf(path, 'Untitled'), body: BODY })
      )
    installZen({
      renameNote,
      writeNote,
      readNote,
      listNotes: vi.fn().mockResolvedValue([renamedMeta]),
      ...overrides
    })
    return { renameNote, writeNote, readNote }
  }

  it('retitles the heading of a note that is not open, straight on disk', async () => {
    const { writeNote, readNote } = installRename()
    const { useStore } = await loadStore()

    await useStore.getState().renameNote('inbox/Untitled.md', 'Groceries')

    expect(readNote).toHaveBeenCalledWith('inbox/Groceries.md')
    expect(writeNote).toHaveBeenCalledWith('inbox/Groceries.md', '# Groceries\n\nbody\n')
  })

  it('retitles through the buffer when the note is open, so panes repaint', async () => {
    const { writeNote } = installRename()
    const { useStore } = await loadStore()
    await useStore.getState().selectNote('inbox/Untitled.md')

    await useStore.getState().renameNote('inbox/Untitled.md', 'Groceries')

    expect(useStore.getState().noteContents['inbox/Groceries.md']?.body).toBe(
      '# Groceries\n\nbody\n'
    )
    expect(writeNote).toHaveBeenCalledWith('inbox/Groceries.md', '# Groceries\n\nbody\n')
  })

  it('leaves the body alone when the setting is off', async () => {
    const { writeNote, readNote } = installRename()
    const { useStore } = await loadStore()
    useStore.getState().setSyncTitleHeadingOnRename(false)

    await useStore.getState().renameNote('inbox/Untitled.md', 'Groceries')

    expect(readNote).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('never invents a heading for a note that has none', async () => {
    const { writeNote } = installRename({
      readNote: vi
        .fn()
        .mockResolvedValue({ ...metaOf('inbox/Groceries.md', 'Groceries'), body: 'just prose\n' })
    })
    const { useStore } = await loadStore()

    await useStore.getState().renameNote('inbox/Untitled.md', 'Groceries')

    expect(writeNote).not.toHaveBeenCalled()
  })

  it('skips non-markdown notes', async () => {
    const drawing = metaOf('inbox/Sketch.excalidraw', 'Sketch')
    const { writeNote, readNote } = installRename({
      renameNote: vi.fn().mockResolvedValue(drawing),
      listNotes: vi.fn().mockResolvedValue([drawing])
    })
    const { useStore } = await loadStore()

    await useStore.getState().renameNote('inbox/Untitled.excalidraw', 'Sketch')

    expect(readNote).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('leaves an Obsidian drawing stored as .md alone', async () => {
    const drawing = metaOf('inbox/Sketch.excalidraw.md', 'Sketch')
    const { writeNote, readNote } = installRename({
      renameNote: vi.fn().mockResolvedValue(drawing),
      listNotes: vi.fn().mockResolvedValue([drawing])
    })
    const { useStore } = await loadStore()

    await useStore.getState().renameNote('inbox/Old.excalidraw.md', 'Sketch')

    expect(readNote).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('leaves a plain .md carrying the excalidraw-plugin marker alone', async () => {
    const body = '---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n'
    const { writeNote } = installRename({
      readNote: vi
        .fn()
        .mockResolvedValue({ ...metaOf('inbox/Groceries.md', 'Groceries'), body })
    })
    const { useStore } = await loadStore()

    await useStore.getState().renameNote('inbox/Untitled.md', 'Groceries')

    expect(writeNote).not.toHaveBeenCalled()
  })

  it('keeps the rename when the heading rewrite fails', async () => {
    const { writeNote } = installRename({
      readNote: vi.fn().mockRejectedValue(new Error('gone'))
    })
    const { useStore } = await loadStore()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await useStore.getState().renameNote('inbox/Untitled.md', 'Groceries')

    expect(writeNote).not.toHaveBeenCalled()
    expect(useStore.getState().notes.map((n) => n.path)).toContain('inbox/Groceries.md')
  })
})

describe('applyTaskMutation write queue (#503)', () => {
  it('rapid mutations on one note serialize, so neither write is lost on disk', async () => {
    // The second mutation must read the body the FIRST write produced. Without
    // the per-path queue both read the original inside the first write's
    // in-flight window, and the second write puts the first task back.
    let disk = '- [ ] alpha\n- [ ] beta'
    const readNote = vi.fn(async () => makeNote(disk))
    const writeNote = vi.fn(async (_path: string, body: string) => {
      await new Promise((resolve) => window.setTimeout(resolve, 10))
      disk = body
    })
    installZen({ readNote, writeNote })
    const { useStore } = await loadStore()

    const first = useStore.getState().applyTaskMutation(makeTask('alpha', 0), {
      kind: 'set-checked',
      checked: true
    })
    const second = useStore.getState().applyTaskMutation(makeTask('beta', 1), {
      kind: 'set-checked',
      checked: true
    })
    await Promise.all([first, second])

    expect(disk).toBe('- [x] alpha\n- [x] beta')
    expect(writeNote).toHaveBeenCalledTimes(2)
  })
})

describe('hidden workflow presets', () => {
  it('normalizes garbage and keeps unknown ids', async () => {
    installZen()
    const { useStore } = await loadStore()
    const { hideWorkflowPreset } = useStore.getState()

    hideWorkflowPreset('reading-log')
    // Unknown ids are kept on purpose: a preset renamed away and back across
    // versions must stay hidden through the gap.
    hideWorkflowPreset('from-a-future-version')
    hideWorkflowPreset('reading-log') // duplicate, deduped
    hideWorkflowPreset('   ') // blank, dropped

    expect(useStore.getState().hiddenWorkflowPresets).toEqual([
      'reading-log',
      'from-a-future-version'
    ])
  })

  it('restore removes one id; wholesale set covers Hide all and Restore all', async () => {
    installZen()
    const { useStore } = await loadStore()
    const state = useStore.getState()

    state.hideWorkflowPreset('reading-log')
    state.hideWorkflowPreset('meeting-index')
    useStore.getState().restoreWorkflowPreset('reading-log')
    expect(useStore.getState().hiddenWorkflowPresets).toEqual(['meeting-index'])

    useStore.getState().setHiddenWorkflowPresets(['a', 'b', 'a', ' '])
    expect(useStore.getState().hiddenWorkflowPresets).toEqual(['a', 'b'])

    useStore.getState().setHiddenWorkflowPresets([])
    expect(useStore.getState().hiddenWorkflowPresets).toEqual([])
  })

  it('survives a reload through prefs persistence', async () => {
    installZen()
    const first = await loadStore()
    first.useStore.getState().hideWorkflowPreset('reading-log')
    const prefsRaw = localStorage.getItem('zen:prefs:v2')
    expect(prefsRaw).toContain('reading-log')

    // A fresh module instance reads prefs back from localStorage, which is
    // exactly the launch path. Not `loadStore()`: that helper clears the
    // storage this test just seeded.
    installZen()
    vi.resetModules()
    localStorage.clear()
    if (prefsRaw !== null) localStorage.setItem('zen:prefs:v2', prefsRaw)
    const second = await import('./store')
    expect(second.useStore.getState().hiddenWorkflowPresets).toEqual(['reading-log'])
  })
})

describe('Workflows feature switch and the reopen stack', () => {
  it('does not let Reopen Closed Tab bring the canvas back after the switch is off', async () => {
    installZen()
    const { useStore } = await loadStore()
    const paneId = useStore.getState().activePaneId
    useStore.setState({ notes: [makeNote('A', 'inbox/A.md')] })
    useStore.getState().setWorkflowsEnabled(true)

    await useStore.getState().openNoteInPane(paneId, 'inbox/A.md')
    await useStore.getState().openWorkflowsView()
    expect(findLeaf(useStore.getState().paneLayout, paneId)?.tabs).toContain(WORKFLOWS_TAB_PATH)

    useStore.getState().setWorkflowsEnabled(false)
    await flushAsyncWork()
    // Closing pushed the tab onto the reopen stack; disabling the feature has
    // to take it back off, or Cmd+Shift+T walks straight past the switch.
    expect(
      useStore.getState().closedTabStack.some((entry) => entry.path === WORKFLOWS_TAB_PATH)
    ).toBe(false)

    await useStore.getState().reopenLastClosedTab()
    expect(findLeaf(useStore.getState().paneLayout, paneId)?.tabs ?? []).not.toContain(
      WORKFLOWS_TAB_PATH
    )
  })

  it('refuses the virtual tab at openNoteInPane, whichever caller asks', async () => {
    installZen()
    const { useStore } = await loadStore()
    const paneId = useStore.getState().activePaneId
    useStore.getState().setWorkflowsEnabled(false)

    // The reopen path calls this directly rather than going through
    // openWorkflowsView, so the gate cannot live only there.
    await useStore.getState().openNoteInPane(paneId, WORKFLOWS_TAB_PATH)
    expect(findLeaf(useStore.getState().paneLayout, paneId)?.tabs ?? []).not.toContain(
      WORKFLOWS_TAB_PATH
    )

    await useStore.getState().focusTabInPane(paneId, WORKFLOWS_TAB_PATH)
    expect(findLeaf(useStore.getState().paneLayout, paneId)?.tabs ?? []).not.toContain(
      WORKFLOWS_TAB_PATH
    )
  })
})

describe('workflow run record across vaults', () => {
  const runRecord = {
    workflowId: 'reading-log',
    receipt: {
      runId: 'run-1',
      workflowId: 'reading-log',
      startedAt: 0,
      applied: 2,
      paths: ['inbox/A.md'],
      irreversible: 0
    },
    undone: null,
    undoError: null
  }

  it('drops the receipt and the tutorial when another vault is opened', async () => {
    installZen({
      openLocalVault: vi.fn().mockResolvedValue({ root: '/Users/test/Work', name: 'Work' }),
      listLocalVaults: vi.fn().mockResolvedValue([])
    })
    const { useStore } = await loadStore()
    useStore.setState({
      vault: { root: '/Users/test/Notes', name: 'Notes' },
      workflowRunRecord: runRecord,
      workflowTutorialStep: 2
    })

    await useStore.getState().openLocalVault('/Users/test/Work')

    // A run id means nothing to another vault's journal: offering the Undo
    // would fail with "Unknown workflow run" on a same-named preset.
    expect(useStore.getState().workflowRunRecord).toBeNull()
    expect(useStore.getState().workflowTutorialStep).toBeNull()
  })

  it('drops them on closing a vault too', async () => {
    installZen({
      closeVault: vi.fn().mockResolvedValue(null),
      listLocalVaults: vi.fn().mockResolvedValue([])
    })
    const { useStore } = await loadStore()
    useStore.setState({
      vault: { root: '/Users/test/Notes', name: 'Notes' },
      workspaceMode: 'local',
      workflowRunRecord: runRecord,
      workflowTutorialStep: 1
    })

    await useStore.getState().closeVault()

    expect(useStore.getState().workflowRunRecord).toBeNull()
    expect(useStore.getState().workflowTutorialStep).toBeNull()
  })
})

describe('vault watcher subscription', () => {
  it('drops the previous listener when init runs again after a reconnect', async () => {
    const offs: Array<() => void> = []
    const onVaultChange = vi.fn(() => {
      const off = vi.fn()
      offs.push(off)
      return off
    })
    installZen({
      onVaultChange,
      getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop' }),
      getServerCapabilities: vi.fn().mockResolvedValue({}),
      getCurrentVault: vi.fn().mockResolvedValue({ root: '/Users/test/Notes', name: 'Notes' }),
      retryWorkspaceBoot: vi.fn().mockResolvedValue({ root: '/Users/test/Notes', name: 'Notes' })
    })

    const { useStore } = await loadStore()
    await useStore.getState().init()
    expect(onVaultChange).toHaveBeenCalledTimes(1)

    // The reconnect path re-enters init on purpose; every re-entry that
    // subscribed without disposing left one duplicate IPC listener behind.
    await useStore.getState().retryWorkspaceBoot()
    expect(onVaultChange).toHaveBeenCalledTimes(2)
    expect(offs[0]).toHaveBeenCalledTimes(1)
  })
})

describe('flushDirtyNotes drains queued task writes (#503)', () => {
  it('waits for an in-flight task write instead of leaving it behind on quit', async () => {
    let disk = '- [ ] alpha'
    const readNote = vi.fn(async () => makeNote(disk))
    const writeNote = vi.fn(async (_path: string, body: string) => {
      await new Promise((resolve) => window.setTimeout(resolve, 10))
      disk = body
    })
    installZen({ readNote, writeNote })
    const { useStore } = await loadStore()

    // Not awaited: this is the Kanban move still in flight when the window
    // closes. `flushDirtyNotes` is the only quit-time signal, and the note is
    // clean, so without the drain the write is simply dropped.
    void useStore.getState().applyTaskMutation(makeTask('alpha', 0), {
      kind: 'set-checked',
      checked: true
    })

    await useStore.getState().flushDirtyNotes()

    expect(disk).toBe('- [x] alpha')
  })
})

describe('startup workspace restore', () => {
  it('restores the saved layout before the full notes index finishes', async () => {
    const note = makeNote('body', 'inbox/Note.md')
    const { promise: notesPromise, resolve: resolveNotes } = deferred<ReturnType<typeof makeNote>[]>()
    const snapshot = {
      savedAt: Date.now(),
      paneLayout: {
        kind: 'leaf' as const,
        id: 'main',
        tabs: ['inbox/Note.md'],
        pinnedTabs: [],
        activeTab: 'inbox/Note.md'
      },
      activePaneId: 'main',
      view: { kind: 'folder' as const, folder: 'inbox' as const, subpath: '' }
    }
    installZen({
      getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop' }),
      getServerCapabilities: vi.fn().mockResolvedValue({}),
      getCurrentVault: vi.fn().mockResolvedValue({ root: '/Users/test/Notes', name: 'Notes' }),
      getVaultSettings: vi.fn().mockResolvedValue({}),
      readWorkspaceState: vi.fn().mockResolvedValue(JSON.stringify(snapshot)),
      listNotes: vi.fn().mockReturnValue(notesPromise),
      listFolders: vi.fn().mockResolvedValue([]),
      listAssets: vi.fn().mockResolvedValue([]),
      hasAssetsDir: vi.fn().mockResolvedValue(false),
      listTemplates: vi.fn().mockResolvedValue([]),
      listWorkflows: vi.fn().mockResolvedValue([]),
      rootContentHiddenByInboxMode: vi.fn().mockResolvedValue(false),
      onVaultChange: vi.fn().mockReturnValue(vi.fn())
    })

    const { useStore } = await loadStore()
    const initPromise = useStore.getState().init()
    await flushAsyncWork()

    expect(useStore.getState().workspaceRestored).toBe(true)
    const leaf = findLeaf(useStore.getState().paneLayout, useStore.getState().activePaneId)
    expect(leaf?.activeTab).toBe('inbox/Note.md')

    resolveNotes([note])
    await initPromise

    expect(useStore.getState().notes).toEqual([note])
    expect(useStore.getState().activeNote?.path).toBe('inbox/Note.md')
  })
})

