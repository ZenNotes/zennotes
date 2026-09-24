// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// The store module a test loaded. Each test gets a fresh one, but a timer the
// old one armed keeps running with real timers and calls whatever window.zen
// is current when it fires, so afterEach settles the old store before the
// next test installs its own bridge.
let loaded: Awaited<ReturnType<typeof loadStore>> | null = null

async function loadStore() {
  vi.resetModules()
  localStorage.clear()
  loaded = await import('./store')
  return loaded
}

async function flush(): Promise<void> {
  await new Promise((r) => window.setTimeout(r, 0))
}

beforeEach(() => {
  vi.restoreAllMocks()
  installZen()
})
afterEach(async () => {
  // Real timers first: a fake-timer test's pending saves are dropped with the
  // fake clock, and the race below needs a real setTimeout.
  vi.useRealTimers()
  // Typing arms the store's 350 ms debounced save. A test that ends with a
  // dirty buffer would let that timer fire into a later test and push a write
  // nobody there made into writeCalls (the #852 dirty-buffer test did exactly
  // that under turbo's parallel load). persistNote clears the timer before
  // its first await, so calling it is enough; the write it starts goes to
  // this test's bridge, which may be gated forever, hence the race.
  const store = loaded
  loaded = null
  if (!store) return
  const state = store.useStore.getState()
  const dirty = Object.entries(state.noteDirty)
    .filter(([, isDirty]) => isDirty)
    .map(([path]) => path)
  await Promise.race([
    Promise.allSettled(dirty.map((path) => state.persistNote(path))),
    new Promise((resolve) => setTimeout(resolve, 50))
  ])
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

// #852: the editor tells a body that came from disk apart from one another
// pane or a rename rewrite produced by the note's disk revision, which only a
// read from disk moves.
describe('#852: a note body taken from disk moves its disk revision', () => {
  const a = 'Work/Documentation/Vault CLI Cheatsheet.md'

  it('an external change to an open, clean note bumps it once', async () => {
    const { useStore, noteDiskRevision } = await loadStore()
    seedRootVault(useStore)
    await useStore.getState().openNoteInPane(useStore.getState().activePaneId, a)
    await flush()
    expect(noteDiskRevision(a)).toBe(0)

    vault.set(a, 'Hello, changed outside')
    await useStore.getState().applyChange({ kind: 'change', path: a, folder: 'inbox' })
    await flush()
    expect(useStore.getState().noteContents[a]?.body).toBe('Hello, changed outside')
    expect(noteDiskRevision(a)).toBe(1)
  })

  it("the app's own save echo and the user's typing leave it alone", async () => {
    const { useStore, noteDiskRevision } = await loadStore()
    seedRootVault(useStore)
    await useStore.getState().openNoteInPane(useStore.getState().activePaneId, a)
    await flush()

    // Typing is an in-app change: no disk read, no revision.
    useStore.getState().updateNoteBody(a, 'CLI_BODY typed')
    await useStore.getState().persistNote(a)
    expect(vault.get(a)).toBe('CLI_BODY typed')
    expect(noteDiskRevision(a)).toBe(0)

    // The watcher echoing that save reads the same bytes the buffer holds.
    await useStore.getState().applyChange({ kind: 'change', path: a, folder: 'inbox' })
    await flush()
    expect(noteDiskRevision(a)).toBe(0)
  })

  it('a rewrite the app made itself (an asset rename) is read back without moving it', async () => {
    const { useStore, noteDiskRevision } = await loadStore()
    seedRootVault(useStore)
    await useStore.getState().openNoteInPane(useStore.getState().activePaneId, a)
    await flush()

    vault.set(a, 'CLI_BODY with ![](renamed.png)')
    await useStore.getState().applyChange({ kind: 'change', path: a, folder: 'inbox' }, { source: 'app' })
    await flush()
    expect(useStore.getState().noteContents[a]?.body).toBe('CLI_BODY with ![](renamed.png)')
    expect(noteDiskRevision(a)).toBe(0)
  })

  it('a change refused because the buffer is dirty does not count as one', async () => {
    const { useStore, noteDiskRevision } = await loadStore()
    seedRootVault(useStore)
    await useStore.getState().openNoteInPane(useStore.getState().activePaneId, a)
    await flush()
    useStore.getState().updateNoteBody(a, 'unsaved typing')

    vault.set(a, 'Hello, changed outside')
    await useStore.getState().applyChange({ kind: 'change', path: a, folder: 'inbox' })
    await flush()
    expect(useStore.getState().noteContents[a]?.body).toBe('unsaved typing')
    expect(noteDiskRevision(a)).toBe(0)

    // The user's own write reaching disk is not a disk change either.
    await useStore.getState().persistNote(a)
    expect(vault.get(a)).toBe('unsaved typing')
    expect(noteDiskRevision(a)).toBe(0)
  })
})

// #585 ("ZenNotes clears all text from a note while editing"): the watcher
// echo of one save could read the file while the next non-atomic save had it
// truncated. applyChange pushed that empty read over the DIRTY buffer, the
// editor applied it as a non-undoable doc swap, and persistNote had already
// cleared the dirty flag so the follow-up save bailed instead of healing disk.
describe('#585 — dirty buffers survive watcher change events', () => {
  it('ignores an older watcher read when a later event restores the starting content', async () => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const target = 'index.md'
    await useStore.getState().openNoteInPane(useStore.getState().activePaneId, target)
    let readStarted!: () => void
    const started = new Promise<void>((resolve) => { readStarted = resolve })
    let releaseRead!: () => void
    const pending = new Promise<void>((resolve) => { releaseRead = resolve })
    const zen = window.zen as unknown as { readNote: (path: string) => Promise<unknown> }
    let reads = 0
    zen.readNote = async () => {
      if (++reads === 1) {
        readStarted()
        await pending
        return { ...meta(target, 'STALE CLOUD CONTENT'), body: 'STALE CLOUD CONTENT' }
      }
      return { ...meta(target, 'INDEX_BODY'), body: 'INDEX_BODY' }
    }
    const event = { kind: 'change' as const, path: target, folder: 'inbox' as const, scope: 'content' as const }
    const earlier = useStore.getState().applyChange(event)
    await started
    await useStore.getState().applyChange(event)
    releaseRead()
    await earlier

    expect(useStore.getState().activeNote?.body).toBe('INDEX_BODY')
    expect(useStore.getState().noteContents[target]?.body).toBe('INDEX_BODY')
    expect(writeCalls).toEqual([])
  })

  it.each([
    { saved: 'NEW LOCAL CONTENT', stale: 'INDEX_BODY' },
    { saved: 'INDEX_BODY', stale: 'STALE CLOUD CONTENT' }
  ])('ignores a delayed watcher read after saving $saved', async ({ saved, stale }) => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const target = 'index.md'
    await useStore.getState().openNoteInPane(useStore.getState().activePaneId, target)
    let readStarted!: () => void
    const started = new Promise<void>((resolve) => { readStarted = resolve })
    let releaseRead!: () => void
    const pending = new Promise<void>((resolve) => { releaseRead = resolve })
    const zen = window.zen as unknown as { readNote: (path: string) => Promise<unknown> }
    zen.readNote = async () => {
      readStarted()
      await pending
      return { ...meta(target, stale), body: stale }
    }
    const change = useStore.getState().applyChange({ kind: 'change', path: target, folder: 'inbox', scope: 'content' })
    await started
    useStore.getState().updateNoteBody(target, 'INTERMEDIATE LOCAL CONTENT')
    await useStore.getState().persistNote(target)
    useStore.getState().updateNoteBody(target, saved)
    await useStore.getState().persistNote(target)
    releaseRead()
    await change

    expect(useStore.getState().activeNote?.body).toBe(saved)
    expect(useStore.getState().noteContents[target]?.body).toBe(saved)
    expect(vault.get(target)).toBe(saved)
    expect(useStore.getState().noteDirty[target]).toBe(false)
  })

  it.each(['change', 'add'] as const)('refreshes a clean note restored to an earlier local save (%s)', async (kind) => {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const target = 'index.md'
    await useStore.getState().openNoteInPane(useStore.getState().activePaneId, target)
    useStore.getState().updateNoteBody(target, 'SAVED BACKUP CONTENT')
    await useStore.getState().persistNote(target)

    // Another device edits the note; restoring a backup later brings back
    // bytes this renderer once wrote, but that is no longer a save echo.
    vault.set(target, 'NEWER CLOUD CONTENT')
    await useStore.getState().applyChange({ kind, path: target, folder: 'inbox', scope: 'content' })
    expect(useStore.getState().noteContents[target]?.body).toBe('NEWER CLOUD CONTENT')
    vault.set(target, 'SAVED BACKUP CONTENT')
    await useStore.getState().applyChange({ kind, path: target, folder: 'inbox', scope: 'content' })

    expect(useStore.getState().noteContents[target]?.body).toBe('SAVED BACKUP CONTENT')
    expect(useStore.getState().activeNote?.body).toBe('SAVED BACKUP CONTENT')
    expect(useStore.getState().noteDirty[target]).toBe(false)
    expect(writeCalls).toEqual([{ path: target, body: 'SAVED BACKUP CONTENT' }])
  })

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
    // The edit above armed a real debounced save. Settle it here: a timer that
    // outlives its test fires into whichever test is running 350 ms later and
    // shows up there as a write nobody asked for.
    await useStore.getState().persistNote(target)
    expect(vault.get(target)).toBe('INDEX_BODY with unsaved edits')
  })
})

// #828: a custom Vim insert-mode escape such as `jk` types the `j` into the
// document and removes it again once the `k` completes the sequence. The
// buffer ends where it started, but the first change had marked the note
// dirty, so the debounced save rewrote identical bytes, the file's mtime
// moved, and {{modified_*}} tokens updated for a note nobody changed. The
// same shape covers a typed character that is backspaced and an undo back to
// the saved text.
describe('#828: a buffer back on its saved bytes is not rewritten', () => {
  async function openIndex() {
    const { useStore } = await loadStore()
    seedRootVault(useStore)
    const target = 'index.md'
    await useStore.getState().openNoteInPane(useStore.getState().activePaneId, target)
    await flush()
    return { useStore, target }
  }

  it('cancels the save when an inserted character is removed again', async () => {
    const { useStore, target } = await openIndex()
    vi.useFakeTimers()

    useStore.getState().updateNoteBody(target, 'INDEX_BODYj')
    expect(useStore.getState().noteDirty[target]).toBe(true)
    useStore.getState().updateNoteBody(target, 'INDEX_BODY')
    await vi.advanceTimersByTimeAsync(1000)

    expect(writeCalls).toEqual([])
    expect(useStore.getState().noteDirty[target]).toBe(false)
    expect(useStore.getState().activeDirty).toBe(false)
    expect(useStore.getState().noteContents[target]?.body).toBe('INDEX_BODY')
  })

  it('still saves once when real typing ends with the escape sequence', async () => {
    const { useStore, target } = await openIndex()
    vi.useFakeTimers()

    useStore.getState().updateNoteBody(target, 'INDEX_BODY typed')
    useStore.getState().updateNoteBody(target, 'INDEX_BODY typedj')
    useStore.getState().updateNoteBody(target, 'INDEX_BODY typed')
    await vi.advanceTimersByTimeAsync(1000)

    expect(writeCalls).toEqual([{ path: target, body: 'INDEX_BODY typed' }])
    expect(useStore.getState().noteDirty[target]).toBe(false)
  })

  it('measures a revert against the last save, not the body the note opened with', async () => {
    const { useStore, target } = await openIndex()
    vi.useFakeTimers()

    useStore.getState().updateNoteBody(target, 'FIRST')
    await vi.advanceTimersByTimeAsync(1000)
    expect(writeCalls).toEqual([{ path: target, body: 'FIRST' }])

    // Back to what disk holds now: nothing to write.
    useStore.getState().updateNoteBody(target, 'FIRST more')
    useStore.getState().updateNoteBody(target, 'FIRST')
    await vi.advanceTimersByTimeAsync(1000)
    expect(writeCalls).toHaveLength(1)
    expect(useStore.getState().noteDirty[target]).toBe(false)

    // Back to the body it opened with: disk has moved on, so this is an edit.
    useStore.getState().updateNoteBody(target, 'INDEX_BODY')
    await vi.advanceTimersByTimeAsync(1000)
    expect(writeCalls).toEqual([
      { path: target, body: 'FIRST' },
      { path: target, body: 'INDEX_BODY' }
    ])
    expect(vault.get(target)).toBe('INDEX_BODY')
  })

  it('a revert while a write is in flight still lands on disk', async () => {
    const { useStore, target } = await openIndex()
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
    // The disk is about to hold FIRST, so going back to the opening body is
    // not a return to the saved bytes even though it matches them right now.
    useStore.getState().updateNoteBody(target, 'INDEX_BODY')
    release()
    await persisting

    expect(vault.get(target)).toBe('FIRST')
    expect(useStore.getState().noteDirty[target]).toBe(true)
    await useStore.getState().persistNote(target)
    expect(vault.get(target)).toBe('INDEX_BODY')
    expect(useStore.getState().noteDirty[target]).toBe(false)
  })

  it('typing ahead of a write and then returning to the written body is clean', async () => {
    const { useStore, target } = await openIndex()
    // Installed before the first edit so every debounce timer this test arms
    // is a fake one that the fake clearTimeout can actually cancel.
    vi.useFakeTimers()
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
    expect(useStore.getState().noteDirty[target]).toBe(true)

    useStore.getState().updateNoteBody(target, 'FIRST')
    await vi.advanceTimersByTimeAsync(1000)

    expect(writeCalls).toEqual([{ path: target, body: 'FIRST' }])
    expect(useStore.getState().noteDirty[target]).toBe(false)
  })
})
