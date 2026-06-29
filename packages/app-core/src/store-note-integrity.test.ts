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
