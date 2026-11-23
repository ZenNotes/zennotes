// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #1108: a remote vault keeps nothing on this machine, so a save made while
// the server is unreachable fails and the buffer is the only copy. The store
// used to log that failure and never try again: the edit stayed out of the
// server even after it came back, and quitting lost it. These drive the real
// store over a bridge whose server can be switched off.

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

const NOTE = 'inbox/Offline.md'
const ORIGINAL = '# Offline\n\nwritten on the server\n'
let server: Map<string, string>
let online: boolean
const writes: Array<{ path: string; body: string }> = []
const unreachable = (): Error =>
  new Error(
    "Error invoking remote method 'vault:write-note': Error: Could not connect to the ZenNotes server at http://nas:7878."
  )

function installZen(): void {
  server = new Map([[NOTE, ORIGINAL]])
  online = true
  writes.length = 0
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getCapabilities: vi.fn().mockReturnValue({
        supportsUpdater: false,
        supportsNativeMenus: false,
        supportsFloatingWindows: false,
        supportsLocalFilesystemPickers: false,
        supportsRemoteWorkspace: true,
        supportsCliInstall: false,
        supportsCustomTemplates: false
      }),
      scanTasks: vi.fn().mockResolvedValue([]),
      scanTasksForPath: vi.fn().mockResolvedValue([]),
      listNotes: vi.fn(async () => [...server.entries()].map(([p, b]) => meta(p, b))),
      listFolders: vi.fn().mockResolvedValue([]),
      listAssets: vi.fn().mockResolvedValue([]),
      hasAssetsDir: vi.fn().mockResolvedValue(false),
      getRemoteWorkspaceInfo: vi.fn().mockResolvedValue(null),
      getVaultSettings: vi.fn().mockResolvedValue({}),
      readNote: vi.fn(async (path: string) => {
        if (!online) throw unreachable()
        if (!server.has(path)) throw new Error(`ENOENT ${path}`)
        const body = server.get(path)!
        return { ...meta(path, body), body }
      }),
      writeNote: vi.fn(async (path: string, body: string) => {
        if (!online) throw unreachable()
        writes.push({ path, body })
        server.set(path, body)
        return meta(path, body)
      })
    }
  })
}

let loaded: typeof import('./store') | null = null
async function loadStore(): Promise<typeof import('./store')> {
  vi.resetModules()
  localStorage.clear()
  loaded = await import('./store')
  return loaded
}

beforeEach(() => {
  vi.restoreAllMocks()
  installZen()
})
afterEach(async () => {
  vi.useRealTimers()
  const store = loaded
  loaded = null
  if (!store) return
  // Leave no retry timer or dirty buffer to fire into the next test.
  online = false
  store.useStore.setState({ noteSaveErrors: {}, noteDirty: {} })
  await new Promise((r) => setTimeout(r, 0))
})

async function openOfflineEdit() {
  const { useStore } = await loadStore()
  const { useToastStore } = await import('./lib/toast')
  useStore.setState({ notes: [meta(NOTE, ORIGINAL)] })
  await useStore.getState().openNoteInPane(useStore.getState().activePaneId, NOTE)
  online = false
  const edited = `${ORIGINAL}edited while offline\n`
  useStore.getState().updateNoteBody(NOTE, edited)
  await useStore.getState().persistNote(NOTE)
  return { useStore, useToastStore, edited }
}

describe('#1108 a save that fails while the server is away', () => {
  it('keeps the edit, says so, and is not silent', async () => {
    const { useStore, useToastStore, edited } = await openOfflineEdit()
    const state = useStore.getState()
    expect(state.noteDirty[NOTE]).toBe(true)
    expect(state.noteContents[NOTE]?.body).toBe(edited)
    // The message is the real sentence, without Electron's IPC wrapper.
    expect(state.noteSaveErrors[NOTE]).toBe(
      'Could not connect to the ZenNotes server at http://nas:7878.'
    )
    const toasts = useToastStore.getState().toasts
    expect(toasts.filter((t) => t.type === 'error')).toHaveLength(1)
    expect(toasts[0]?.message).toContain('Couldn’t save “Offline”')
  })

  it('saves on its own once the change feed reconnects, then clears the alarm', async () => {
    const { useStore, useToastStore, edited } = await openOfflineEdit()
    online = true
    await useStore
      .getState()
      .applyChange({ kind: 'change', path: '', folder: 'inbox', scope: 'resync' })
    await vi.waitFor(() => expect(server.get(NOTE)).toBe(edited))
    const state = useStore.getState()
    expect(state.noteDirty[NOTE]).toBe(false)
    expect(state.noteSaveErrors[NOTE]).toBeUndefined()
    const toasts = useToastStore.getState().toasts
    expect(toasts.some((t) => t.type === 'error')).toBe(false)
    expect(toasts.some((t) => t.message === 'Saved “Offline”.')).toBe(true)
  })

  it('retries on a backoff with no event at all', async () => {
    vi.useFakeTimers()
    const { useStore, edited } = await openOfflineEdit()
    // Still down at the first retry: the error stands and another is armed.
    await vi.advanceTimersByTimeAsync(2_100)
    expect(useStore.getState().noteSaveErrors[NOTE]).toBeDefined()
    expect(server.get(NOTE)).toBe(ORIGINAL)
    online = true
    await vi.advanceTimersByTimeAsync(5_100)
    expect(server.get(NOTE)).toBe(edited)
    expect(useStore.getState().noteSaveErrors[NOTE]).toBeUndefined()
  })

  it('keeps the server’s version beside the note when it changed meanwhile', async () => {
    const { useStore, useToastStore, edited } = await openOfflineEdit()
    // Another device saved this note while this one could not reach it.
    const theirs = `${ORIGINAL}edited on the phone\n`
    server.set(NOTE, theirs)
    online = true
    await useStore.getState().retryFailedSaves()
    expect(server.get('inbox/Offline (server copy).md')).toBe(theirs)
    expect(server.get(NOTE)).toBe(edited)
    expect(writes.map((w) => w.path)).toEqual(['inbox/Offline (server copy).md', NOTE])
    expect(useStore.getState().noteSaveErrors[NOTE]).toBeUndefined()
    expect(
      useToastStore.getState().toasts.some((t) => t.message.includes('kept as “Offline (server copy)”'))
    ).toBe(true)
  })

  it('writes straight over a server that still holds what the edit started from', async () => {
    const { useStore, edited } = await openOfflineEdit()
    online = true
    await useStore.getState().retryFailedSaves()
    expect(writes).toEqual([{ path: NOTE, body: edited }])
  })

  it('drops the error when the edit is undone back to what the server has', async () => {
    const { useStore } = await openOfflineEdit()
    useStore.getState().updateNoteBody(NOTE, ORIGINAL)
    await vi.waitFor(() => expect(useStore.getState().noteSaveErrors[NOTE]).toBeUndefined())
    expect(useStore.getState().noteDirty[NOTE]).toBe(false)
    expect(writes).toEqual([])
  })
})
