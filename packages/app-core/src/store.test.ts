// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TASKS_TAB_PATH, type VaultTask } from '@shared/tasks'
import { databaseTabPath } from '@shared/databases'
import { assetTabPath } from './lib/asset-tabs'
import { findLeaf, type PaneLayout, type PaneLeaf } from './lib/pane-layout'

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
      ...overrides
    }
  })
}

async function loadStore() {
  vi.resetModules()
  localStorage.clear()
  return import('./store')
}

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
