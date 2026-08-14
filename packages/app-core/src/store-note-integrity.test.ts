// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Reproduction harness for #202 ("Notes show the wrong content" → files
// overwritten with another note's body). Drives the REAL store over an
// in-memory vault, simulating an Obsidian vault opened in ROOT mode and the
// user NAVIGATING between notes (the reporter made "no edits"), plus the
// external file-watcher firing (their vault lived under ~/sync). Asserts that a
// note's content never lands under another note's path, and that pure
// navigation never writes to disk.

interface MemNote {
  path: string
  body: string
}

function meta(path: string, body: string) {
  const title = path.split('/').pop()!.replace(/\.md$/, '')
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
    excerpt: body.slice(0, 40)
  }
}

// The reporter's vault: nested folders, spaces in names, distinct bodies.
const INITIAL: MemNote[] = [
  { path: 'index.md', body: 'INDEX_BODY' },
  { path: 'Work/Documentation/Vault CLI Cheatsheet.md', body: 'CHEATSHEET_BODY' },
  { path: 'Work/Documentation/Another Note.md', body: 'ANOTHER_BODY' },
  { path: 'Work/Projects/plan.md', body: 'PLAN_BODY' }
]

let vault: Map<string, string>
const writeCalls: Array<{ path: string; body: string }> = []

function installZen(): void {
  vault = new Map(INITIAL.map((n) => [n.path, n.body]))
  writeCalls.length = 0
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getCapabilities: vi.fn().mockReturnValue({
        supportsUpdater: false,
        supportsNativeMenus: false,
        supportsFloatingWindows: false,
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: false,
        supportsCliInstall: false,
        supportsCustomTemplates: false
      }),
      scanTasks: vi.fn().mockResolvedValue([]),
      scanTasksForPath: vi.fn().mockResolvedValue([]),
      listNotes: vi.fn(async () => [...vault.entries()].map(([p, b]) => meta(p, b))),
      listFolders: vi.fn().mockResolvedValue([]),
      listLocalVaults: vi.fn().mockResolvedValue([]),
      listAssets: vi.fn().mockResolvedValue([]),
      hasAssetsDir: vi.fn().mockResolvedValue(false),
      getRemoteWorkspaceInfo: vi.fn().mockResolvedValue(null),
      getVaultSettings: vi.fn().mockResolvedValue({}),
      closeVault: vi.fn().mockResolvedValue(null),
      readNote: vi.fn(async (path: string) => {
        if (!vault.has(path)) throw new Error(`ENOENT ${path}`)
        const body = vault.get(path)!
        return { ...meta(path, body), body }
      }),
      writeNote: vi.fn(async (path: string, body: string) => {
        writeCalls.push({ path, body })
        vault.set(path, body)
        return meta(path, body)
      })
    }
  })
}

async function loadStore() {
  vi.resetModules()
  localStorage.clear()
  return import('./store')
}

async function flush(): Promise<void> {
  await new Promise((r) => window.setTimeout(r, 0))
}

beforeEach(() => {
  vi.restoreAllMocks()
  installZen()
})

function seedRootVault(useStore: { setState: (s: Record<string, unknown>) => void }): void {
  useStore.setState({
    notes: INITIAL.map((n) => meta(n.path, n.body)),
    vaultSettings: {
      primaryNotesLocation: 'root',
      dailyNotes: { enabled: false, directory: 'Daily Notes' },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      folderIcons: {},
      folderColors: {},
      favorites: []
    }
  })
}

describe('#202 — store keeps each note its own content during navigation', () => {
  it('opening note after note never cross-wires content', async () => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const paneId = useStore.getState().activePaneId

    for (const n of INITIAL) {
      await useStore.getState().openNoteInPane(paneId, n.path)
      await flush()
    }
    // Revisit in a different order (tab switching).
    for (const n of [...INITIAL].reverse()) {
      await useStore.getState().focusTabInPane(paneId, n.path)
      await flush()
    }

    const contents = useStore.getState().noteContents
    for (const n of INITIAL) {
      expect(contents[n.path]?.body, `${n.path} holds the wrong body`).toBe(n.body)
    }
  })

  it('pure navigation (no edits) writes NOTHING to disk', async () => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const paneId = useStore.getState().activePaneId

    for (const n of INITIAL) {
      await useStore.getState().openNoteInPane(paneId, n.path)
      await flush()
    }
    expect(writeCalls, `navigation triggered a write: ${JSON.stringify(writeCalls)}`).toEqual([])
    // And disk is byte-identical to the originals.
    for (const n of INITIAL) expect(vault.get(n.path)).toBe(n.body)
  })

  it('editing one note autosaves ONLY that note, never a neighbour', async () => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const paneId = useStore.getState().activePaneId

    const target = 'Work/Documentation/Vault CLI Cheatsheet.md'
    await useStore.getState().openNoteInPane(paneId, target)
    await flush()
    useStore.getState().updateNoteBody(target, 'EDITED_CHEATSHEET')
    await useStore.getState().persistNote(target)
    await flush()

    expect(vault.get(target)).toBe('EDITED_CHEATSHEET')
    for (const n of INITIAL) {
      if (n.path === target) continue
      expect(vault.get(n.path), `${n.path} was clobbered by an unrelated edit`).toBe(n.body)
    }
    expect(writeCalls.every((c) => c.path === target)).toBe(true)
  })

  it('an external watcher change (the ~/sync daemon) lands under the right path', async () => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const paneId = useStore.getState().activePaneId

    const a = 'Work/Documentation/Vault CLI Cheatsheet.md'
    const b = 'Work/Documentation/Another Note.md'
    await useStore.getState().openNoteInPane(paneId, a)
    await useStore.getState().openNoteInPane(paneId, b)
    await flush()

    // Sync daemon rewrites A on disk while B is the active tab.
    vault.set(a, 'SYNC_REWROTE_CHEATSHEET')
    await useStore.getState().applyChange({ kind: 'change', path: a, folder: 'inbox', scope: 'content' })
    await flush()

    const contents = useStore.getState().noteContents
    expect(contents[a]?.body).toBe('SYNC_REWROTE_CHEATSHEET')
    expect(contents[b]?.body).toBe('ANOTHER_BODY') // untouched
    // The external change must not have provoked a write-back.
    expect(writeCalls).toEqual([])
  })
})

// #585 ("ZenNotes clears all text from a note while editing"): the watcher
// echo of one save could read the file while the next non-atomic save had it
// truncated. applyChange pushed that empty read over the DIRTY buffer, the
// editor applied it as a non-undoable doc swap, and persistNote had already
// cleared the dirty flag so the follow-up save bailed instead of healing disk.
describe('#585 — dirty buffers survive watcher change events', () => {
  it('a change event delivering a truncated read never clobbers unsaved edits', async () => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const paneId = useStore.getState().activePaneId
    const target = 'index.md'
    await useStore.getState().openNoteInPane(paneId, target)
    await flush()

    useStore.getState().updateNoteBody(target, 'INDEX_BODY plus unsaved edits')
    // What the reporter hit: the file reads back empty mid-save-cycle.
    vault.set(target, '')
    await useStore
      .getState()
      .applyChange({ kind: 'change', path: target, folder: 'inbox', scope: 'content' })
    await flush()

    expect(useStore.getState().noteContents[target]?.body).toBe('INDEX_BODY plus unsaved edits')
    expect(useStore.getState().noteDirty[target]).toBe(true)

    // The still-pending save reconciles disk with the buffer, not vice versa.
    await useStore.getState().persistNote(target)
    expect(vault.get(target)).toBe('INDEX_BODY plus unsaved edits')
  })

  it('typing during a slow write keeps the note dirty so the follow-up save lands', async () => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const paneId = useStore.getState().activePaneId
    const target = 'index.md'
    await useStore.getState().openNoteInPane(paneId, target)
    await flush()

    // Hold the first write open, as a real IPC round-trip can be.
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const zen = window.zen as unknown as {
      writeNote: (p: string, b: string) => Promise<unknown>
    }
    const realWrite = zen.writeNote
    zen.writeNote = async (p: string, b: string) => {
      await gate
      return realWrite(p, b)
    }

    useStore.getState().updateNoteBody(target, 'FIRST')
    const persisting = useStore.getState().persistNote(target)
    useStore.getState().updateNoteBody(target, 'FIRST AND SECOND') // typed mid-write
    release()
    await persisting

    // The buffer is ahead of disk, so the flag must survive the completion.
    expect(useStore.getState().noteDirty[target]).toBe(true)
    await useStore.getState().persistNote(target)
    expect(vault.get(target)).toBe('FIRST AND SECOND')
  })

  it('never lets an older overlapping save finish after the newest body', async () => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const paneId = useStore.getState().activePaneId
    const target = 'index.md'
    await useStore.getState().openNoteInPane(paneId, target)
    await flush()

    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const zen = window.zen as unknown as {
      writeNote: (path: string, body: string) => Promise<ReturnType<typeof meta>>
    }
    zen.writeNote = async (path, body) => {
      if (body === 'FIRST') await firstGate
      vault.set(path, body)
      return meta(path, body)
    }

    useStore.getState().updateNoteBody(target, 'FIRST')
    const firstSave = useStore.getState().persistNote(target)
    useStore.getState().updateNoteBody(target, 'SECOND')
    const secondSave = useStore.getState().persistNote(target)

    // Without per-note serialization, SECOND reaches disk now and the older
    // blocked write replaces it as soon as this gate opens.
    await flush()
    releaseFirst()
    await Promise.all([firstSave, secondSave])

    expect(vault.get(target)).toBe('SECOND')
    expect(useStore.getState().noteContents[target]?.body).toBe('SECOND')
    expect(useStore.getState().noteDirty[target]).toBe(false)
  })

  // Saves are atomic now (temp file renamed into place), and on Linux a rename
  // arrives as IN_MOVED_TO, which the server's watcher reports as 'add'. Any
  // other tool that writes by renaming (git, rsync, Syncthing, vim) looks the
  // same, so an 'add' for an open note carries content that must be read.
  it('refreshes an open note when a writer renames a new file into place', async () => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const paneId = useStore.getState().activePaneId
    const target = 'index.md'
    await useStore.getState().openNoteInPane(paneId, target)
    await flush()

    vault.set(target, 'REPLACED BY RENAME')
    await useStore
      .getState()
      .applyChange({ kind: 'add', path: target, folder: 'inbox', scope: 'content' })
    await flush()

    expect(useStore.getState().noteContents[target]?.body).toBe('REPLACED BY RENAME')
    expect(writeCalls).toEqual([])
  })

  it('still refuses to let an add event overwrite unsaved edits', async () => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const paneId = useStore.getState().activePaneId
    const target = 'index.md'
    await useStore.getState().openNoteInPane(paneId, target)
    await flush()

    useStore.getState().updateNoteBody(target, 'INDEX_BODY with unsaved edits')
    vault.set(target, 'REPLACED BY RENAME')
    await useStore
      .getState()
      .applyChange({ kind: 'add', path: target, folder: 'inbox', scope: 'content' })
    await flush()

    expect(useStore.getState().noteContents[target]?.body).toBe('INDEX_BODY with unsaved edits')
  })
})
