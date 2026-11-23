// @vitest-environment jsdom

import { createHash } from 'node:crypto'
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
const writes: Array<{ path: string; body: string; baseSha256?: string }> = []
// A server with conditional writes (#1108) names each note's bytes; null is a
// server from before them, which returns no hash and ignores any base.
let conditional: boolean
// Runs inside the next conditional write, just before the server compares:
// another device saving the note between the retry's read and its write.
let beforeConditionalWrite: (() => void) | null
const sha = (body: string): string => createHash('sha256').update(body).digest('hex')
const unreachable = (): Error =>
  new Error(
    "Error invoking remote method 'vault:write-note': Error: Could not connect to the ZenNotes server at http://nas:7878."
  )

function installZen(): void {
  server = new Map([[NOTE, ORIGINAL]])
  online = true
  writes.length = 0
  conditional = false
  beforeConditionalWrite = null
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
        return { ...meta(path, body), body, ...(conditional ? { sha256: sha(body) } : {}) }
      }),
      writeNote: vi.fn(async (path: string, body: string, options?: { baseSha256?: string }) => {
        if (!online) throw unreachable()
        const base = conditional ? options?.baseSha256 : undefined
        if (base) {
          const race = beforeConditionalWrite
          beforeConditionalWrite = null
          race?.()
          const current = server.get(path)
          if (current === undefined || sha(current) !== base) {
            throw new Error(
              `Error invoking remote method 'vault:write-note': RemoteRequestError: ${path} changed on the server since it was read, so it was not saved over. Someone else saved it in the meantime.`
            )
          }
        }
        writes.push({ path, body, ...(base ? { baseSha256: base } : {}) })
        server.set(path, body)
        return { ...meta(path, body), ...(conditional ? { sha256: sha(body) } : {}) }
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

describe('#1108 the retry on a server with conditional writes', () => {
  it('saves on the version it just read', async () => {
    const { useStore, edited } = await openOfflineEdit()
    conditional = true
    online = true
    await useStore.getState().retryFailedSaves()
    expect(writes).toEqual([{ path: NOTE, body: edited, baseSha256: sha(ORIGINAL) }])
    expect(useStore.getState().noteSaveErrors[NOTE]).toBeUndefined()
  })

  it('keeps a save that lands between its read and its write instead of writing over it', async () => {
    const { useStore, edited } = await openOfflineEdit()
    conditional = true
    online = true
    const theirs = `${ORIGINAL}saved on the phone that very second\n`
    beforeConditionalWrite = () => server.set(NOTE, theirs)
    await useStore.getState().retryFailedSaves()
    // Refused, then tried again at once: the second read sees their save and
    // keeps it beside ours, and ours lands on the version that read named.
    await vi.waitFor(() => expect(server.get(NOTE)).toBe(edited))
    expect(server.get('inbox/Offline (server copy).md')).toBe(theirs)
    expect(writes.map((w) => w.path)).toEqual(['inbox/Offline (server copy).md', NOTE])
    expect(writes[1]?.baseSha256).toBe(sha(theirs))
    expect(useStore.getState().noteSaveErrors[NOTE]).toBeUndefined()
    expect(useStore.getState().noteDirty[NOTE]).toBe(false)
  })

  it('sends no base to a server that returns no hash', async () => {
    const { useStore, edited } = await openOfflineEdit()
    online = true
    await useStore.getState().retryFailedSaves()
    expect(writes).toEqual([{ path: NOTE, body: edited }])
    const calls = (window.zen.writeNote as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.at(-1)).toEqual([NOTE, edited])
  })
})
