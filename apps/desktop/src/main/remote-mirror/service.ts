import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  CloudSyncBootstrapConflict,
  CloudSyncBootstrapConflictDetails,
  CloudSyncBootstrapConflictResolution,
  CloudSyncPendingConflictDetails,
  CloudSyncPendingConflictResolution,
  CloudSyncRunSummary,
  CloudSyncSettingsChoice,
  CloudSyncSettingsConflict,
  CloudVaultLink
} from '@zennotes/bridge-contract/cloud-sync'
import type { RemoteMirrorOrigin, RemoteMirrorStatus } from '@zennotes/bridge-contract/ipc'
import type { CloudSyncCoordinator, CloudSyncRepository } from '@zennotes/shared-domain/cloud-sync-coordinator'
import { planCloudSyncMutations } from '@zennotes/shared-domain/cloud-sync-engine'
import {
  CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
  CLOUD_SYNC_VAULT_SETTINGS_PATH,
  cloudSyncPathKey
} from '@zennotes/shared-domain/cloud-sync'
import { encodeCloudErrorMessage } from '@zennotes/shared-domain/cloud-error-copy'
import {
  describeRemoteMirrorError,
  isRemoteMirrorUnreachable,
  remoteMirrorVaultMismatchMessage
} from '@zennotes/shared-domain/remote-mirror-copy'
import type { RemoteHeader } from '@shared/remote-headers'
import {
  createDesktopCloudSyncCoordinator,
  DesktopCloudSyncRepository,
  DesktopCloudSyncStateStore
} from '../cloud-sync-filesystem'
import { setVaultSettings } from '../vault'
import { createZnServerSyncRemote, fetchServerSyncVaultId } from './sync-remote'

/**
 * The offline copy of a self-hosted server's vault (#1108, phase 3).
 *
 * A copy is a real folder under userData that the app opens like a local
 * vault, so reading, saving, search and the watcher work while the server is
 * away. Cloud's own engine keeps it in step with the server: this service is
 * the thin sibling of DesktopCloudSyncService without accounts, links,
 * encryption or backups. The folder is the offline queue; there is no log of
 * operations to replay, because the engine plans what to send by comparing
 * the folder with the last state the server acknowledged.
 *
 * Layout, per saved remote and per server vault, so a copy never syncs into
 * a vault it was not made from:
 *
 *   <storage>/settings.json                    which remotes keep a copy
 *   <storage>/<profile>/<vaultId>/vault/       the copy the window opens
 *   <storage>/<profile>/<vaultId>/state/       the engine's CloudSyncState
 *
 * Notes only in this phase: attachments stay on the server (the server
 * neither lists nor takes binaries yet), and the repository below leaves any
 * binary in the folder out of what sync sees, so a file the server would
 * refuse can never hold the rest of a run back.
 */

export interface RemoteMirrorConnection {
  baseUrl: string
  authToken: string | null
  headers: readonly RemoteHeader[]
  /** The server's `supportsSync`, or 0 when it did not say. */
  syncVersion: number
}

export interface RemoteMirrorServiceDependencies {
  storageDirectory: string
  /** The saved remote's name, or null when it is gone. */
  profileName(profileId: string): Promise<string | null>
  /** How to reach a saved remote's server: its URL, token and headers. */
  connection(profileId: string): Promise<RemoteMirrorConnection | null>
  /** Draft saves in other windows on the copy, before a run touches it. */
  withWindowSync?(root: string, run: () => Promise<CloudSyncRunSummary>): Promise<CloudSyncRunSummary>
  now?: () => number
}

interface ProfileSettings {
  enabled: boolean
  paused: boolean
  vaultId: string | null
  baseUrl: string
  lastReachedAt: number | null
  lastSyncedAt: number | null
  vaultMismatch: boolean
  reachable: boolean
}

interface SettingsFile {
  version: 1
  profiles: Record<string, ProfileSettings>
}

/** Thrown with words for the person, already in the shape IPC keeps. */
function wordedError(error: unknown, serverName: string): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  return new Error(encodeCloudErrorMessage(describeRemoteMirrorError(error, serverName)))
}

export class RemoteMirrorSyncService {
  private readonly runs = new Map<string, Promise<CloudSyncRunSummary>>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private settingsWrite: Promise<unknown> = Promise.resolve()
  private settingsCache: SettingsFile | null = null
  private requestController = new AbortController()
  private readonly now: () => number

  constructor(private readonly dependencies: RemoteMirrorServiceDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  /** Shutdown cancels requests in flight before windows disappear. */
  stop(): void {
    this.requestController.abort()
  }

  // --- Where copies live -------------------------------------------------

  mirrorRoot(profileId: string, vaultId: string): string {
    return path.join(this.profileDirectory(profileId), fingerprint(vaultId), 'vault')
  }

  private stateDirectory(profileId: string, vaultId: string): string {
    return path.join(this.profileDirectory(profileId), fingerprint(vaultId), 'state')
  }

  private profileDirectory(profileId: string): string {
    return path.join(this.dependencies.storageDirectory, fingerprint(profileId))
  }

  /** Whether `root` is inside the folder every copy lives in. A copy is never
   *  a local vault: Cloud refuses it, and the vault list never remembers it. */
  isMirrorPath(candidate: string): boolean {
    const base = path.resolve(this.dependencies.storageDirectory)
    const resolved = path.resolve(candidate)
    return resolved === base || resolved.startsWith(`${base}${path.sep}`)
  }

  // --- Settings ----------------------------------------------------------

  private async readSettings(): Promise<SettingsFile> {
    if (this.settingsCache) return this.settingsCache
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(this.dependencies.storageDirectory, 'settings.json'), 'utf8')
      ) as SettingsFile
      if (parsed && parsed.version === 1 && parsed.profiles && typeof parsed.profiles === 'object') {
        this.settingsCache = parsed
        return parsed
      }
    } catch {
      // Missing or damaged: no remote keeps a copy.
    }
    this.settingsCache = { version: 1, profiles: {} }
    return this.settingsCache
  }

  private updateSettings(
    profileId: string,
    update: (current: ProfileSettings | null) => ProfileSettings | null
  ): Promise<ProfileSettings | null> {
    const write = this.settingsWrite.catch(() => undefined).then(async () => {
      const settings = await this.readSettings()
      const next = update(settings.profiles[profileId] ?? null)
      const profiles = { ...settings.profiles }
      if (next) profiles[profileId] = next
      else delete profiles[profileId]
      const file: SettingsFile = { version: 1, profiles }
      const target = path.join(this.dependencies.storageDirectory, 'settings.json')
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      await fs.mkdir(this.dependencies.storageDirectory, { recursive: true })
      await fs.writeFile(temporary, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, target)
      this.settingsCache = file
      return next
    })
    this.settingsWrite = write
    return write
  }

  async profileSettings(profileId: string): Promise<ProfileSettings | null> {
    return (await this.readSettings()).profiles[profileId] ?? null
  }

  /** The copy a saved remote keeps, once its first sync has learned the vault. */
  async origin(profileId: string): Promise<RemoteMirrorOrigin | null> {
    const settings = await this.profileSettings(profileId)
    if (!settings?.enabled || !settings.vaultId) return null
    const profileName = (await this.dependencies.profileName(profileId)) ?? settings.baseUrl
    return { profileId, profileName, baseUrl: settings.baseUrl, vaultId: settings.vaultId }
  }

  /** A copy that exists on disk and has finished its first download. */
  async openableOrigin(profileId: string): Promise<RemoteMirrorOrigin | null> {
    const origin = await this.origin(profileId)
    if (!origin) return null
    const state = await new DesktopCloudSyncStateStore(this.stateDirectory(profileId, origin.vaultId)).load(origin.vaultId)
    return state ? origin : null
  }

  // --- Turning it on and off --------------------------------------------

  /**
   * Make the copy: learn which vault the server serves, then download it with
   * the engine's first sync. The copy is openable only once that finishes, so
   * an interrupted first download leaves the window where it was.
   */
  async enable(profileId: string): Promise<RemoteMirrorOrigin> {
    const connection = await this.requireConnection(profileId)
    const name = (await this.dependencies.profileName(profileId)) ?? connection.baseUrl
    if (connection.syncVersion < 1) {
      throw new Error(`${name} does not keep offline copies yet. Update it to ZenNotes server 2.91.1 or later.`)
    }
    let vaultId: string
    try {
      vaultId = (await fetchServerSyncVaultId({ ...connection, signal: this.requestController.signal })).vaultId
    } catch (error) {
      throw wordedError(error, name)
    }
    const current = await this.profileSettings(profileId)
    await fs.mkdir(this.mirrorRoot(profileId, vaultId), { recursive: true })
    await this.updateSettings(profileId, () => ({
      enabled: true,
      paused: false,
      vaultId,
      baseUrl: connection.baseUrl,
      lastReachedAt: this.now(),
      lastSyncedAt: current?.vaultId === vaultId ? current.lastSyncedAt : null,
      vaultMismatch: false,
      reachable: true
    }))
    await this.sync(profileId)
    const origin = await this.origin(profileId)
    if (!origin) throw new Error('The offline copy was turned off while it downloaded.')
    return origin
  }

  /**
   * Remove the copy. While the server has not taken every change made here,
   * that would lose them, so it refuses unless the person chose to.
   */
  async disable(profileId: string, options: { discardUnsynced?: boolean } = {}): Promise<void> {
    const settings = await this.profileSettings(profileId)
    if (!settings) return
    if (!options.discardUnsynced && settings.vaultId) {
      const pending = await this.pendingChanges(profileId, settings.vaultId).catch(() => 0)
      if (pending > 0) {
        const name = (await this.dependencies.profileName(profileId)) ?? settings.baseUrl
        const error = new Error(
          pending === 1
            ? `1 change on this computer has not reached ${name}. Removing the offline copy deletes it.`
            : `${pending} changes on this computer have not reached ${name}. Removing the offline copy deletes them.`
        )
        error.name = 'RemoteMirrorUnsyncedError'
        throw error
      }
    }
    await this.exclusive(profileId, async () => {
      await this.updateSettings(profileId, () => null)
      await fs.rm(this.profileDirectory(profileId), { recursive: true, force: true })
    })
  }

  async setPaused(profileId: string, paused: boolean): Promise<void> {
    await this.updateSettings(profileId, (current) => (current ? { ...current, paused } : null))
  }

  // --- Sync --------------------------------------------------------------

  sync(profileId: string): Promise<CloudSyncRunSummary> {
    const existing = this.runs.get(profileId)
    if (existing) return existing
    const run = async (): Promise<CloudSyncRunSummary> => {
      const origin = await this.requireOrigin(profileId)
      const settings = await this.profileSettings(profileId)
      if (settings?.paused) {
        throw new Error(`Working offline: the copy keeps every change until you choose Work Online.`)
      }
      return await this.exclusive(profileId, () => this.runOnce(origin))
    }
    const root = this.origin(profileId).then((origin) => (origin ? this.mirrorRoot(profileId, origin.vaultId) : null))
    const running = root
      .then((mirrorRoot) =>
        mirrorRoot && this.dependencies.withWindowSync ? this.dependencies.withWindowSync(mirrorRoot, run) : run()
      )
      .finally(() => this.runs.delete(profileId))
    this.runs.set(profileId, running)
    return running
  }

  private async runOnce(origin: RemoteMirrorOrigin): Promise<CloudSyncRunSummary> {
    const { coordinator } = await this.coordinator(origin)
    try {
      const result = await coordinator.sync()
      await this.updateSettings(origin.profileId, (current) =>
        current ? { ...current, lastSyncedAt: this.now(), vaultMismatch: false } : null
      )
      return {
        cursor: result.state.cursor,
        pulled: result.pulled,
        pushed: result.pushed,
        conflicts: result.conflicts,
        bootstrap_conflicts: result.bootstrapConflicts,
        local_conflicts: result.localConflicts,
        pending_conflicts: result.pendingConflicts,
        legacy_conflict_copies: result.legacyConflictCopies,
        refused_paths: result.refusedPaths
      }
    } catch (error) {
      if (isRemoteMirrorUnreachable(error)) {
        await this.updateSettings(origin.profileId, (current) => (current ? { ...current, reachable: false } : null))
      }
      if ((error as { code?: unknown } | null)?.code === 'VAULT_MISMATCH') {
        await this.updateSettings(origin.profileId, (current) => (current ? { ...current, vaultMismatch: true } : null))
        throw new Error(remoteMirrorVaultMismatchMessage(origin.profileName))
      }
      throw wordedError(error, origin.profileName)
    }
  }

  /** A cheap look: the server's cursor moved past the copy's. */
  async hasRemoteChanges(profileId: string): Promise<boolean> {
    if (this.runs.has(profileId)) return false
    const origin = await this.origin(profileId)
    const settings = await this.profileSettings(profileId)
    if (!origin || settings?.paused) return false
    const state = await new DesktopCloudSyncStateStore(this.stateDirectory(profileId, origin.vaultId)).load(origin.vaultId)
    if (!state) return true
    const { remote } = await this.coordinator(origin)
    try {
      const manifest = await remote.manifest(origin.vaultId, { page: 1, perPage: 1 })
      return manifest.cursor !== state.cursor
    } catch (error) {
      if (isRemoteMirrorUnreachable(error)) {
        await this.updateSettings(profileId, (current) => (current ? { ...current, reachable: false } : null))
      }
      throw wordedError(error, origin.profileName)
    }
  }

  /** What a Cloud window reads as its link, so Cloud's review and status
   *  code run unchanged on a copy: the server and its name. */
  async link(profileId: string): Promise<CloudVaultLink | null> {
    const origin = await this.origin(profileId)
    if (!origin) return null
    return {
      base_url: origin.baseUrl,
      vault_id: origin.vaultId,
      vault_name: origin.profileName,
      linked_at: new Date(0).toISOString()
    }
  }

  async status(profileId: string): Promise<RemoteMirrorStatus | null> {
    const origin = await this.origin(profileId)
    const settings = await this.profileSettings(profileId)
    if (!origin || !settings) return null
    const root = this.mirrorRoot(profileId, origin.vaultId)
    const [pendingChanges, sizeBytes] = await Promise.all([
      this.pendingChanges(profileId, origin.vaultId).catch(() => 0),
      folderSize(path.dirname(root)).catch(() => 0)
    ])
    return {
      origin,
      pendingChanges,
      lastReachedAt: settings.lastReachedAt,
      lastSyncedAt: settings.lastSyncedAt,
      paused: settings.paused,
      vaultMismatch: settings.vaultMismatch,
      reachable: settings.reachable,
      sizeBytes
    }
  }

  /** Files the next run would send: the folder against the last state the
   *  server acknowledged, the same comparison the engine plans from. */
  async pendingChanges(profileId: string, vaultId: string): Promise<number> {
    const state = await new DesktopCloudSyncStateStore(this.stateDirectory(profileId, vaultId)).load(vaultId)
    if (!state) return 0
    const repository = notesOnlyRepository(new DesktopCloudSyncRepository(this.mirrorRoot(profileId, vaultId)))
    const plan = planCloudSyncMutations(state, await repository.scan(), { itemId: randomUUID, operationId: randomUUID })
    const waiting = new Set(
      Object.values(state.pending_conflicts ?? {}).flatMap((conflict) =>
        [conflict.local.path, conflict.cloud.path, conflict.base.path].filter((p): p is string => !!p).map(cloudSyncPathKey)
      )
    )
    return plan.mutations.filter((mutation) => {
      const at = mutation.type === 'delete' ? state.items[mutation.item_id]?.path : mutation.path
      return !at || !waiting.has(cloudSyncPathKey(at))
    }).length
  }

  // --- Conflicts: Cloud's resolver, on the copy ---------------------------

  async getConflict(profileId: string, conflictId: string): Promise<CloudSyncPendingConflictDetails> {
    return this.withCoordinator(profileId, (coordinator) => coordinator.getConflict(conflictId))
  }

  async saveConflictDraft(profileId: string, conflictId: string, draftText: string | null): Promise<void> {
    await this.withCoordinator(profileId, (coordinator) => coordinator.saveConflictDraft(conflictId, draftText))
  }

  async resolveConflict(profileId: string, resolution: CloudSyncPendingConflictResolution): Promise<void> {
    await this.withCoordinator(profileId, (coordinator) => coordinator.resolveConflict(resolution))
  }

  async getBootstrapConflict(
    profileId: string,
    conflict: CloudSyncBootstrapConflict
  ): Promise<CloudSyncBootstrapConflictDetails> {
    return this.withCoordinator(profileId, (coordinator) => coordinator.getBootstrapConflict(conflict))
  }

  async resolveBootstrapConflict(profileId: string, resolution: CloudSyncBootstrapConflictResolution): Promise<void> {
    await this.withCoordinator(profileId, (coordinator) => coordinator.resolveBootstrapConflict(resolution))
  }

  async settingsConflict(profileId: string): Promise<CloudSyncSettingsConflict | null> {
    const origin = await this.origin(profileId)
    if (!origin) return null
    const parked = path.join(this.mirrorRoot(profileId, origin.vaultId), ...CLOUD_SYNC_SETTINGS_CONFLICT_PATH.split('/'))
    let raw: string
    try {
      raw = await fs.readFile(parked, 'utf8')
    } catch {
      return null
    }
    let parsed: unknown = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    const cloudSettings =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    return {
      path: CLOUD_SYNC_VAULT_SETTINGS_PATH,
      cloud_path: CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
      ...(cloudSettings ? { cloud_settings: cloudSettings } : {})
    }
  }

  async resolveSettingsConflict(profileId: string, choice: CloudSyncSettingsChoice): Promise<void> {
    const origin = await this.requireOrigin(profileId)
    const root = this.mirrorRoot(profileId, origin.vaultId)
    const parked = path.join(root, ...CLOUD_SYNC_SETTINGS_CONFLICT_PATH.split('/'))
    if (choice === 'cloud') {
      const parsed = JSON.parse(await fs.readFile(parked, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`The settings from ${origin.profileName} could not be read, so nothing was changed.`)
      }
      await setVaultSettings(root, parsed as Parameters<typeof setVaultSettings>[1])
    }
    await fs.rm(parked, { force: true })
  }

  // --- Plumbing ----------------------------------------------------------

  private async withCoordinator<T>(profileId: string, run: (coordinator: CloudSyncCoordinator) => Promise<T>): Promise<T> {
    const origin = await this.requireOrigin(profileId)
    return await this.exclusive(profileId, async () => {
      const { coordinator } = await this.coordinator(origin)
      try {
        return await run(coordinator)
      } catch (error) {
        throw wordedError(error, origin.profileName)
      }
    })
  }

  private async coordinator(origin: RemoteMirrorOrigin) {
    const connection = await this.requireConnection(origin.profileId)
    const remote = createZnServerSyncRemote({
      ...connection,
      revisions: connection.syncVersion >= 2,
      signal: this.requestController.signal,
      onAnswer: () => {
        void this.updateSettings(origin.profileId, (current) =>
          current ? { ...current, lastReachedAt: this.now(), reachable: true } : null
        )
      }
    })
    const coordinator = createDesktopCloudSyncCoordinator({
      root: this.mirrorRoot(origin.profileId, origin.vaultId),
      stateDirectory: this.stateDirectory(origin.profileId, origin.vaultId),
      vaultId: origin.vaultId,
      remote,
      repository: notesOnlyRepository,
      coordinator: {
        remoteName: origin.profileName,
        serviceName: origin.profileName,
        // The server takes any path its disk takes; one it refuses comes
        // back as a refusal like Cloud's and is held the same way.
        pathFits: () => true
      }
    })
    return { coordinator, remote }
  }

  private async requireOrigin(profileId: string): Promise<RemoteMirrorOrigin> {
    const origin = await this.origin(profileId)
    if (!origin) throw new Error('This remote does not keep an offline copy.')
    return origin
  }

  private async requireConnection(profileId: string): Promise<RemoteMirrorConnection> {
    const connection = await this.dependencies.connection(profileId)
    if (!connection) throw new Error('This remote is no longer saved on this computer.')
    return connection
  }

  private exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key)
    let current!: Promise<T>
    current = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(operation)
      .finally(() => {
        if (this.operations.get(key) === current) this.operations.delete(key)
      })
    this.operations.set(key, current)
    return current
  }
}

/**
 * The copy's folder as the server sees it: notes and text only. A binary
 * someone put in the folder (Finder, a drag that bypassed the app) stays on
 * this computer instead of being offered to a server that refuses it, which
 * would hold back the run's deletes along with it.
 */
export function notesOnlyRepository(base: DesktopCloudSyncRepository): CloudSyncRepository {
  const repository = Object.create(base) as DesktopCloudSyncRepository
  repository.scan = async () => (await base.scan()).filter((item) => item.kind === 'text')
  return repository
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

async function folderSize(directory: string): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) total += await folderSize(full)
    else if (entry.isFile()) total += (await fs.stat(full).catch(() => ({ size: 0 }))).size
  }
  return total
}
