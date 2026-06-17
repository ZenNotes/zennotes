import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SyncStatus, VaultChangeEvent } from '@shared/ipc'
import type { RemoteServerClient } from '../remote/server-client'
import {
  reconcile,
  type BaseEntry,
  type ConflictReason,
  type FileState,
  type SyncAction
} from './reconcile'
import { loadSyncState, saveSyncState, type SyncState } from './sync-state'
import { conflictCopyPath, type ConflictPolicy } from './conflict'
import { hashBytes, readPrimaryNotesAtRoot, scanLocalVault } from './scan-local'

export interface SyncEngineOptions {
  root: string
  client: RemoteServerClient
  serverProfileId: string
  conflictPolicy: ConflictPolicy
  onStatus?: (status: SyncStatus) => void
}

const DEBOUNCE_MS = 750
const PERIODIC_MS = 5 * 60 * 1000

/**
 * The background sync engine for one synced vault. Triggered by local file
 * changes (chokidar fan-out), server `/api/watch` events, and a periodic
 * backstop; runs a debounced, single-flight three-way reconcile and replicates
 * the resulting actions via the existing RemoteServerClient. Pure decisions live
 * in reconcile.ts; this file is the I/O + scheduling shell.
 */
export class SyncEngine {
  private state: SyncState | null = null
  private status: SyncStatus = {
    kind: 'idle',
    pendingPush: 0,
    pendingPull: 0,
    conflicts: [],
    lastSyncAt: 0,
    lastError: null
  }
  private running = false
  private syncing = false
  private rerun = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private periodicTimer: ReturnType<typeof setInterval> | null = null
  private stopWatch: (() => void) | null = null

  constructor(private readonly opts: SyncEngineOptions) {}

  get root(): string {
    return this.opts.root
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.state = await loadSyncState(
      this.opts.root,
      this.opts.serverProfileId,
      this.opts.client.baseUrl
    )
    this.status = { ...this.status, lastSyncAt: this.state.lastSyncAt }
    this.stopWatch = this.opts.client.watchVaultChanges(() => this.schedule())
    this.periodicTimer = setInterval(() => this.schedule(), PERIODIC_MS)
    this.schedule(true)
  }

  stop(): void {
    this.running = false
    this.stopWatch?.()
    this.stopWatch = null
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.periodicTimer) clearInterval(this.periodicTimer)
    this.debounceTimer = null
    this.periodicTimer = null
  }

  getStatus(): SyncStatus {
    return this.status
  }

  /** Load state (if needed) and run a single reconcile. Used by syncNow paths
   *  and tests; the scheduler calls reconcileOnce directly via runSync. */
  async runOnce(): Promise<void> {
    if (!this.state) {
      this.state = await loadSyncState(
        this.opts.root,
        this.opts.serverProfileId,
        this.opts.client.baseUrl
      )
    }
    await this.reconcileOnce()
  }

  /** Fan-out target for local disk changes under this vault root. */
  onLocalChange(_ev: VaultChangeEvent): void {
    this.schedule()
  }

  /** Force an immediate reconcile (manual "Sync now"). */
  syncNow(): void {
    this.schedule(true)
  }

  private schedule(immediate = false): void {
    if (!this.running) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => void this.runSync(), immediate ? 0 : DEBOUNCE_MS)
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch }
    this.opts.onStatus?.(this.status)
  }

  private async runSync(): Promise<void> {
    if (!this.running) return
    if (this.syncing) {
      this.rerun = true
      return
    }
    this.syncing = true
    this.setStatus({ kind: 'syncing', lastError: null })
    try {
      await this.reconcileOnce()
      this.setStatus({ kind: 'idle', lastSyncAt: Date.now(), pendingPush: 0, pendingPull: 0 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setStatus({ kind: isOffline(message) ? 'offline' : 'error', lastError: message })
    } finally {
      this.syncing = false
      if (this.rerun) {
        this.rerun = false
        this.schedule()
      }
    }
  }

  private async reconcileOnce(): Promise<void> {
    const state = this.state
    if (!state) return
    const primaryAtRoot = await readPrimaryNotesAtRoot(this.opts.root)
    const [localMap, remoteList] = await Promise.all([
      scanLocalVault(this.opts.root, primaryAtRoot),
      this.opts.client.getSyncManifest()
    ])
    const remoteMap = new Map<string, FileState>(
      remoteList.map((e) => [e.path, { hash: e.hash, size: e.size }])
    )
    const baseMap = new Map<string, BaseEntry>(
      Object.entries(state.entries).map(([p, e]) => [p, { contentHash: e.contentHash, size: e.size }])
    )

    const actions = reconcile(localMap, remoteMap, baseMap)
    let pushes = 0
    let pulls = 0
    const conflicts: string[] = []
    for (const action of actions) {
      try {
        await this.execute(action, localMap, remoteMap, state, conflicts)
        if (action.kind === 'push') pushes++
        if (action.kind === 'pull') pulls++
      } catch (err) {
        // One file failing (e.g. oversize, gone) must not abort the whole sync.
        this.setStatus({ lastError: `${action.kind} ${action.path}: ${(err as Error).message}` })
      }
    }
    state.lastSyncAt = Date.now()
    await saveSyncState(this.opts.root, state)
    if (conflicts.length) {
      this.setStatus({ conflicts: dedupe([...this.status.conflicts, ...conflicts]) })
    }
    this.status = { ...this.status, pendingPush: pushes, pendingPull: pulls }
  }

  private async execute(
    action: SyncAction,
    localMap: Map<string, FileState>,
    remoteMap: Map<string, FileState>,
    state: SyncState,
    conflicts: string[]
  ): Promise<void> {
    const client = this.opts.client
    const root = this.opts.root
    switch (action.kind) {
      case 'push': {
        const body = await readLocal(root, action.path)
        await client.writeNote(action.path, body)
        setBase(state, action.path, localMap.get(action.path))
        break
      }
      case 'pull': {
        const content = await client.readNote(action.path)
        await writeLocalAtomic(root, action.path, content.body)
        setBase(state, action.path, remoteMap.get(action.path))
        break
      }
      case 'deleteRemote': {
        await client.deleteNote(action.path)
        delete state.entries[action.path]
        break
      }
      case 'deleteLocal': {
        await removeLocal(root, action.path)
        delete state.entries[action.path]
        break
      }
      case 'converge': {
        setBase(state, action.path, localMap.get(action.path) ?? remoteMap.get(action.path))
        break
      }
      case 'forget': {
        delete state.entries[action.path]
        break
      }
      case 'conflict': {
        await this.resolveConflict(action.path, action.reason, localMap, remoteMap, state, conflicts)
        break
      }
    }
  }

  private async resolveConflict(
    p: string,
    reason: ConflictReason,
    localMap: Map<string, FileState>,
    remoteMap: Map<string, FileState>,
    state: SyncState,
    conflicts: string[]
  ): Promise<void> {
    const client = this.opts.client
    const root = this.opts.root
    // delete-vs-edit: resurrect from the server (the edit wins over the delete).
    if (reason === 'delete-vs-edit') {
      const content = await client.readNote(p)
      await writeLocalAtomic(root, p, content.body)
      setBase(state, p, remoteMap.get(p))
      conflicts.push(p)
      return
    }
    // edit-vs-delete: resurrect to the server (the edit wins over the delete).
    if (reason === 'edit-vs-delete') {
      const body = await readLocal(root, p)
      await client.writeNote(p, body)
      setBase(state, p, localMap.get(p))
      conflicts.push(p)
      return
    }
    // both-edited / first-sync-clash: keep both. Local stays canonical; the
    // server's differing version is written next to it as a conflict copy.
    const remoteContent = await client.readNote(p)
    const copyPath = conflictCopyPath(p, state.deviceId, new Date())
    const remoteBytes = Buffer.from(remoteContent.body, 'utf8')
    await writeLocalAtomic(root, copyPath, remoteContent.body)
    await client.writeNote(copyPath, remoteContent.body)
    const localBody = await readLocal(root, p)
    await client.writeNote(p, localBody) // server's path now matches local (canonical)
    setBase(state, p, localMap.get(p))
    state.entries[copyPath] = { contentHash: hashBytes(remoteBytes), size: remoteBytes.length }
    conflicts.push(copyPath)
  }
}

function setBase(state: SyncState, p: string, entry: FileState | undefined): void {
  if (!entry) {
    delete state.entries[p]
    return
  }
  state.entries[p] = { contentHash: entry.hash, size: entry.size }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}

function isOffline(message: string): boolean {
  return /Could not connect|ECONN|fetch failed|ENOTFOUND|ETIMEDOUT|network/i.test(message)
}

// --- local file helpers (path-safe, atomic writes) ---

function safeAbs(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  const base = path.resolve(root)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`refusing path outside vault: ${rel}`)
  }
  return abs
}

async function readLocal(root: string, rel: string): Promise<string> {
  return fs.readFile(safeAbs(root, rel), 'utf8')
}

async function writeLocalAtomic(root: string, rel: string, body: string): Promise<void> {
  const abs = safeAbs(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${Date.now()}.synctmp`
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, abs)
}

async function removeLocal(root: string, rel: string): Promise<void> {
  await fs.rm(safeAbs(root, rel), { force: true })
}
