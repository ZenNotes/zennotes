import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Per-path base: the content + server state recorded at the last successful sync. */
export interface SyncEntry {
  /** sha256 of the bytes that were in sync (local == remote at that moment). */
  contentHash: string
  size: number
}

/**
 * The base snapshot for a synced vault, persisted at
 * `<root>/.zennotes/sync-state.json`. It is per-device and never itself synced.
 * `pendingPull`/`pendingPush` form an intent log: paths whose transfer was
 * started but not confirmed, re-derived from the manifest on the next run so a
 * crash mid-sync can never be mistaken for a user edit.
 */
export interface SyncState {
  version: number
  deviceId: string
  serverProfileId: string
  baseUrl: string
  lastSyncAt: number
  entries: Record<string, SyncEntry>
  pendingPull: string[]
  pendingPush: string[]
}

export const SYNC_STATE_VERSION = 1

export function syncStatePath(root: string): string {
  return path.join(root, '.zennotes', 'sync-state.json')
}

export function emptySyncState(serverProfileId: string, baseUrl: string): SyncState {
  return {
    version: SYNC_STATE_VERSION,
    deviceId: randomUUID(),
    serverProfileId,
    baseUrl,
    lastSyncAt: 0,
    entries: {},
    pendingPull: [],
    pendingPush: []
  }
}

export async function loadSyncState(
  root: string,
  serverProfileId: string,
  baseUrl: string
): Promise<SyncState> {
  try {
    const raw = await fs.readFile(syncStatePath(root), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SyncState>
    if (
      parsed.version === SYNC_STATE_VERSION &&
      typeof parsed.deviceId === 'string' &&
      parsed.entries &&
      typeof parsed.entries === 'object'
    ) {
      return {
        version: SYNC_STATE_VERSION,
        deviceId: parsed.deviceId,
        serverProfileId: parsed.serverProfileId ?? serverProfileId,
        baseUrl: parsed.baseUrl ?? baseUrl,
        lastSyncAt: typeof parsed.lastSyncAt === 'number' ? parsed.lastSyncAt : 0,
        entries: parsed.entries as Record<string, SyncEntry>,
        pendingPull: Array.isArray(parsed.pendingPull) ? parsed.pendingPull : [],
        pendingPush: Array.isArray(parsed.pendingPush) ? parsed.pendingPush : []
      }
    }
  } catch {
    // missing or invalid → fresh state (first sync = union merge)
  }
  return emptySyncState(serverProfileId, baseUrl)
}

/** Atomically persist the base snapshot (temp file + rename). */
export async function saveSyncState(root: string, state: SyncState): Promise<void> {
  const target = syncStatePath(root)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state), 'utf8')
  await fs.rename(tmp, target)
}
