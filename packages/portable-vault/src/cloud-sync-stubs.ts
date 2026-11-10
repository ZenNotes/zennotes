/**
 * Attachments on open (docs/ideas/cloud-in-browser.md, "Notes first,
 * attachments on open"). A host that should not mirror every attachment (the
 * browser) writes a large binary attachment as a STUB FILE in its place: a
 * short magic line and the Cloud reference it stands for as JSON. The stub is
 * an ordinary file, so every vault operation that moves, renames, trashes or
 * restores files keeps working without knowing about it.
 *
 * The rules, and where each is kept:
 * - Stub by kind and size, never by wire shape: a binary reference above the
 *   threshold (`shouldStubCloudContent`). Notes and every text kind are
 *   always written in full, whether they arrive inline or as a reference.
 *   Decided in NativeCloudStaging.stage, before anything downloads.
 * - The repository answers for a stub with the fingerprint it records, and a
 *   `data` that throws if consumed (cloud-sync-repository.ts), the way it
 *   answers for a file the scan cache skipped. The engine reads `data` only
 *   for items whose hash differs from the tracked state, which a stub's never
 *   does, so a stub never uploads; a moved stub keeps its fingerprint and the
 *   engine plans a move.
 * - Stubs are a cache of Cloud, emptied when the history behind it goes: a
 *   first sync removes them before it reports anything (it has no state to
 *   vouch for them), and unlinking hydrates them first.
 * - Every read of an attachment's bytes goes through `hydrateCloudStub`
 *   (opening it, copying or duplicating it, exporting, publishing), which
 *   downloads the recorded revision, checks its hash and writes the real file
 *   in the stub's place only while the stub is still there.
 */
import type { CloudSyncContentReference } from '@zennotes/bridge-contract/cloud-sync'
import { cloudSyncPathKey, normalizeCloudSyncPath } from '@zennotes/shared-domain/cloud-sync'
import { validateCloudSyncDownloadInstruction } from '@zennotes/shared-domain/cloud-sync-content'
import { retryCloudTransfer } from '@zennotes/shared-domain/cloud-sync-stall'
import type { CloudSyncState, CloudSyncTrackedItem } from '@zennotes/shared-domain/cloud-sync-engine'
import { randomUUID } from './uuid'
import {
  CLOUD_STUB_THRESHOLD_BYTES,
  type CloudStubRecord
} from './cloud-stub-format'

export * from './cloud-stub-format'

/** The Cloud reference a stub stands for. */
export function referenceForStub(stub: CloudStubRecord): CloudSyncContentReference {
  return {
    item_id: stub.item_id,
    revision: stub.revision,
    encoding: 'base64',
    sha256: stub.sha256,
    byte_length: stub.byte_length,
    media_type: stub.media_type,
    ...(stub.encrypted ? { encrypted: { ...stub.encrypted } } : {})
  }
}

export function stubRecordFor(reference: CloudSyncContentReference): CloudStubRecord {
  return {
    format: 1,
    item_id: reference.item_id,
    revision: reference.revision,
    sha256: reference.sha256,
    byte_length: reference.byte_length,
    media_type: reference.media_type,
    ...(reference.encrypted ? { encrypted: { sha256: reference.encrypted.sha256, byte_length: reference.encrypted.byte_length } } : {})
  }
}

/** Where stubs are not written whatever their size: the vault's own
 *  settings and anything else under `.zennotes/`. */
function isVaultSystemPath(path: string): boolean {
  return path === '.zennotes' || path.startsWith('.zennotes/')
}

/** Whether a Cloud revision arrives as a stub: a binary attachment above the
 *  threshold. Its wire shape (inline or a reference) never decides. */
export function shouldStubCloudContent(
  content: { encoding: string; byte_length: number },
  path?: string,
  thresholdBytes = CLOUD_STUB_THRESHOLD_BYTES
): boolean {
  if (content.encoding !== 'base64') return false
  if (path !== undefined && isVaultSystemPath(normalizeCloudSyncPath(path))) return false
  return content.byte_length > thresholdBytes
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/** What hydration needs from the vault's file system: its download fast path
 *  (the browser's OPFS worker streams it into a staging file and checks the
 *  hash) and the stub read. */
export interface CloudStubFiles {
  readCloudStub(path: string): Promise<CloudStubRecord | null>
  download(options: { url: string; headers: Record<string, string>; to: string; byteLength: number; sha256: string }): Promise<void>
  /** Moves `from` over `to` only while `to` still holds the stub `expected`;
   *  answers false (and leaves both) when the stub changed or went. */
  replaceCloudStub(from: string, to: string, expected: CloudStubRecord): Promise<boolean>
  mkdir(path: string): Promise<void>
  deleteFile(path: string): Promise<void>
  statVerified(path: string): Promise<'file' | 'directory' | null>
}

export interface CloudStubDownloads {
  /** The signed download of one revision, the service's whole answer
   *  (`CloudSyncApiClient.download`, after content references are negotiated). */
  download(vaultId: string, itemId: string, revision: number): Promise<unknown>
  vaultId: string
  allowInsecureLoopback?: boolean
  signal?: AbortSignal
}

const STAGING_DIRECTORY = '.zennotes/sync/downloads'
const inFlight = new Map<string, Promise<boolean>>()

/**
 * Downloads the revision a stub at `path` records and writes it there, once
 * per path at a time. Answers true when the file at `path` now holds the real
 * bytes (hydrated now or already), false when there is no stub there (a real
 * file, or nothing). Encrypted revisions wait for Phase 5's in-tab opener.
 */
export function hydrateCloudStub(files: CloudStubFiles, downloads: CloudStubDownloads, path: string): Promise<boolean> {
  const key = `${downloads.vaultId}\n${cloudSyncPathKey(normalizeCloudSyncPath(path))}`
  const running = inFlight.get(key)
  if (running) return running
  const run = hydrateOnce(files, downloads, normalizeCloudSyncPath(path)).finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

async function hydrateOnce(files: CloudStubFiles, downloads: CloudStubDownloads, path: string): Promise<boolean> {
  const stub = await files.readCloudStub(path)
  if (!stub) return false
  if (stub.encrypted) {
    throw new Error('This attachment is end-to-end encrypted, which ZenNotes in the browser cannot open yet.')
  }
  await files.mkdir(STAGING_DIRECTORY)
  const staging = `${STAGING_DIRECTORY}/${randomUUID()}`
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const instruction = validateCloudSyncDownloadInstruction(
        await downloads.download(downloads.vaultId, stub.item_id, stub.revision),
        referenceForStub(stub),
        downloads.allowInsecureLoopback
      )
      if (Date.parse(instruction.download.expires_at) <= Date.now()) {
        if (attempt === 0) continue
        throw new Error('Cloud returned an expired download URL.')
      }
      await retryCloudTransfer(async () => {
        try {
          await files.download({
            url: instruction.download.url,
            headers: instruction.download.headers,
            to: staging,
            byteLength: stub.byte_length,
            sha256: stub.sha256
          })
        } catch (error) {
          await files.deleteFile(staging).catch(() => {})
          throw error
        }
      }, { signal: downloads.signal, isTransportFailure: isUnansweredDownload })
      // Placed only while the stub is still the one read above: a sync that
      // replaced or moved it meanwhile wins, and this download is dropped.
      if (await files.replaceCloudStub(staging, path, stub)) return true
      // Another hydration of the same file may have placed it first.
      return (await files.readCloudStub(path)) === null && (await files.statVerified(path)) === 'file'
    }
    throw new Error('Cloud download could not be refreshed.')
  } finally {
    await files.deleteFile(staging).catch(() => {})
  }
}

function isUnansweredDownload(error: unknown): boolean {
  const candidate = error as { code?: unknown; status?: unknown } | null
  return candidate?.code === 'DIRECT_DOWNLOAD_FAILED' && candidate.status === undefined
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

/**
 * The stub that can stand in for a file the tracked state vouches for: the
 * same path, its last synced bytes, a binary above the threshold. Null for
 * anything else (a file with unsynced changes, a note, a small attachment),
 * which eviction must never touch.
 */
export function evictableStubFor(
  state: CloudSyncState | null,
  path: string,
  local: { sha256: string; byteLength: number },
  thresholdBytes = CLOUD_STUB_THRESHOLD_BYTES
): CloudStubRecord | null {
  if (!state || state.version !== 1) return null
  const key = cloudSyncPathKey(normalizeCloudSyncPath(path))
  let tracked: CloudSyncTrackedItem | undefined
  for (const item of Object.values(state.items)) {
    if (item && cloudSyncPathKey(item.path) === key) {
      tracked = item
      break
    }
  }
  if (!tracked || tracked.kind !== 'binary' || tracked.revision < 1) return null
  for (const conflict of Object.values(state.pending_conflicts ?? {})) {
    if (conflict.item_id === tracked.item_id) return null
  }
  if (tracked.sha256 !== local.sha256 || tracked.byte_length !== local.byteLength) return null
  if (!shouldStubCloudContent({ encoding: 'base64', byte_length: tracked.byte_length }, path, thresholdBytes)) return null
  return {
    format: 1,
    item_id: tracked.item_id,
    revision: tracked.revision,
    sha256: tracked.sha256,
    byte_length: tracked.byte_length,
    media_type: tracked.media_type
  }
}
