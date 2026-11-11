import type {
  CloudBackupNoteRestoreResult,
  CloudBackupRestoreResult,
  CloudBackupSchedule,
  CloudBackupSnapshot,
  CloudBackupItemsPage,
  CloudBackupItemsQuery,
  CloudBackupSnapshotItem,
  CloudSyncRunSummary,
  CloudSyncPendingConflictDetails,
  CloudSyncPendingConflictResolution,
  CloudSyncBootstrapConflict,
  CloudSyncBootstrapConflictDetails,
  CloudSyncBootstrapConflictResolution,
  CloudSyncSettingsChoice,
  CloudSyncSettingsConflict,
  CloudSyncContentReference,
  CloudSyncEncryptedContent,
  CloudVaultLink
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
  CLOUD_SYNC_VAULT_SETTINGS_PATH,
  shouldSyncVaultPath,
  shouldTraverseCloudSyncDirectory
} from '@zennotes/shared-domain/cloud-sync'
import {
  CloudSyncHostService,
  type CloudSyncHostPersistence,
  type CloudSyncHostVault
} from '@zennotes/shared-domain/cloud-sync-host-service'
import {
  PortableCloudSyncRepository,
  type PortableCloudSyncFileSystem
} from '@zennotes/shared-domain/cloud-sync-portable-filesystem'
import type { CloudSyncState } from '@zennotes/shared-domain/cloud-sync-engine'
import { CLOUD_E2EE_HEADER, CLOUD_E2EE_HEADER_VALUE } from '@zennotes/shared-domain/cloud-e2ee-vault'
import { CachedCloudSyncRepository, type ScanCache } from './cloud-sync-repository'
import type { PortableVault } from './vault-fs'
import { hasSyncFastPath, portableHost, type SyncFastPath, type VaultDirEntry, type VaultFileSystem } from './host'
import {
  CLOUD_STUB_MAX_BYTES,
  CLOUD_STUB_THRESHOLD_BYTES,
  evictableStubFor,
  hydrateCloudStub,
  shouldStubCloudContent,
  type CloudStubFiles,
  type CloudStubRecord
} from './cloud-sync-stubs'
import { mobileCloudRequestSignal } from './cloud-sync-client'
import { trackCloudSyncChanges } from './cloud-sync-refresh'
import { reconcileLayoutForCloudJoin } from './cloud-layout'
import {
  MOBILE_END_TO_END_ENCRYPTION,
  authenticatedClient,
  authenticatedCredential,
  getMobileCloudAccountStatus
} from './mobile-cloud-auth'
import {
  ENCRYPTED_VAULT_BACKUP_DOWNLOAD_MESSAGE,
  assertMobileCloudVaultCanLink,
  createMobileEncryptedCloudVault,
  isMobileCloudVaultEncrypted
} from './mobile-cloud-encryption'
import { randomUUID } from './uuid'

const STORAGE_ROOT = 'zennotes-cloud-sync'
const refreshStates = new WeakMap<PortableVault, { changed: boolean }>()

const persistence: CloudSyncHostPersistence = {
  async loadLink(vaultKey: string): Promise<unknown> {
    return readJson(await linkPath(vaultKey))
  },
  async saveLink(vaultKey: string, link: CloudVaultLink): Promise<void> {
    await writeJson(await linkPath(vaultKey), link)
  },
  async deleteLink(vaultKey: string): Promise<void> {
    await deleteDataFile(await linkPath(vaultKey))
  },
  async loadState(vaultKey: string, baseUrl: string, vaultId: string): Promise<unknown> {
    return readJson(await statePath(vaultKey, baseUrl, vaultId))
  },
  async saveState(vaultKey: string, baseUrl: string, state: CloudSyncState): Promise<void> {
    await writeJson(await statePath(vaultKey, baseUrl, state.vault_id), state)
  },
  async retireState(vaultKey: string, baseUrl: string, vaultId: string): Promise<void> {
    const path = await statePath(vaultKey, baseUrl, vaultId)
    const data = await portableHost().storage.read(path)
    if (data === null) return
    // Preserve the complete state, including unsent conflict drafts, before unlinking.
    await portableHost().storage.write(
      path.replace('/states/', '/retired-states/').replace(/\.json$/, `.${randomUUID()}.json`),
      data
    )
    await deleteDataFile(path)
  }
}

const service = new CloudSyncHostService({
  persistence,
  accountStatus: getMobileCloudAccountStatus,
  createClient: authenticatedClient
})

export async function getMobileCloudVaultLink(vault: PortableVault): Promise<CloudVaultLink | null> {
  return service.linkedVault(hostVault(vault))
}

export async function linkMobileCloudVault(
  vault: PortableVault,
  vaultId: string
): Promise<CloudVaultLink> {
  // An encrypted vault's name and content need the account key, so linking
  // a locked device stops here instead of at the first sync.
  await assertMobileCloudVaultCanLink(vaultId)
  const link = await service.link(hostVault(vault), vaultId)
  // Joining an established cloud vault: align this vault's physical layout
  // with the cloud tree before the first sync merges them (zennotesandroid#17).
  // Best-effort: a failure here leaves the old behavior, never a broken link.
  try {
    await reconcileLayoutForCloudJoin(vault, link.vault_id)
  } catch {
    // The link itself succeeded; sync proceeds against the unmoved layout.
  }
  return link
}

export async function createAndLinkMobileCloudVault(
  vault: PortableVault,
  name: string,
  options: { encrypted?: boolean } = {}
): Promise<CloudVaultLink> {
  if (!options.encrypted) return service.createAndLink(hostVault(vault), name)
  // The service stores a placeholder name; the shared link step reads the
  // listing, which shows this unlocked device the real one.
  return service.link(hostVault(vault), await createMobileEncryptedCloudVault(name))
}

export async function unlinkMobileCloudVault(vault: PortableVault): Promise<void> {
  // A stub with no link can never be filled: bring every attachment here
  // first, or stay linked.
  await requireEveryStubHydrated(vault, 'unlinking')
  await service.unlink(hostVault(vault))
}

/** Permanently delete the cloud copy, then unlink this device (desktop parity). */
export async function deleteMobileCloudVault(vault: PortableVault): Promise<void> {
  // The only copy of a stubbed attachment is the one about to be deleted.
  await requireEveryStubHydrated(vault, 'deleting the Cloud copy')
  await service.deleteLinkedVault(hostVault(vault))
}

// ---------------------------------------------------------------------------
// Attachments on open (cloud-sync-stubs.ts)
// ---------------------------------------------------------------------------

type StubCapableFiles = VaultFileSystem & SyncFastPath & CloudStubFiles

function stubFiles(files: VaultFileSystem): StubCapableFiles | null {
  const candidate = files as Partial<StubCapableFiles>
  return hasSyncFastPath(files) && typeof candidate.readCloudStub === 'function' &&
    typeof candidate.replaceCloudStub === 'function' && typeof candidate.writeCloudStub === 'function'
    ? (files as StubCapableFiles)
    : null
}

/** Whether a revision arriving now is written as a stub on this host. */
function stubPolicy(path?: string): ((reference: Pick<CloudSyncContentReference, 'encoding' | 'byte_length'>) => boolean) | undefined {
  const stubs = portableHost().cloudStubs
  if (!stubs) return undefined
  const threshold = stubs.thresholdBytes ?? CLOUD_STUB_THRESHOLD_BYTES
  return (reference) => stubs.enabled() && shouldStubCloudContent(reference, path, threshold)
}

/**
 * The one way an attachment's bytes reach this device after it arrived as a
 * stub: opening it, copying it, exporting or publishing it, unlinking. True
 * when the file now holds its bytes, false when there was no stub there.
 */
export async function hydrateMobileCloudStub(vault: PortableVault, relPath: string): Promise<boolean> {
  const files = stubFiles(vault.fs)
  const stub = files ? await files.readCloudStub(relPath) : null
  if (!files || !stub) return false
  const link = await getMobileCloudVaultLink(vault)
  if (!link) {
    throw new Error('This attachment is only in ZenNotes Cloud, and this vault is no longer linked to it.')
  }
  const client = await authenticatedClient()
  if (!(await client.negotiateContentReferences())) {
    throw new Error('ZenNotes Cloud could not send this attachment. Try again in a moment.')
  }
  // Throws while this device is locked: an encrypted attachment stays a stub.
  const decryptor = stub.encrypted ? await client.contentDecryptor(link.vault_id) : null
  return hydrateCloudStub(files, {
    vaultId: link.vault_id,
    download: (vaultId, itemId, revision) => client.download(vaultId, itemId, revision),
    allowInsecureLoopback: client.allowInsecureLoopbackDownloads,
    signal: mobileCloudRequestSignal(),
    ...(decryptor ? { decryptor } : {})
  }, relPath)
}

const TEXT_KIND_EXTENSIONS = new Set([
  '.base', '.css', '.csv', '.excalidraw', '.htm', '.html', '.ini', '.js', '.json', '.jsx', '.md', '.mdx',
  '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'
])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** Every file the vault's sync sees, with its listing entry. */
async function walkSyncedFiles(
  files: VaultFileSystem,
  visit: (path: string, entry: VaultDirEntry) => Promise<void>,
  directory = ''
): Promise<void> {
  for (const entry of await files.readdirStrict(directory)) {
    const path = directory ? `${directory}/${entry.name}` : entry.name
    if (entry.type === 'directory') {
      if (shouldTraverseCloudSyncDirectory(path)) await walkSyncedFiles(files, visit, path)
    } else if (shouldSyncVaultPath(path)) {
      await visit(path, entry)
    }
  }
}

/** The stubs in a vault: only small files of a binary kind can be one, so a
 *  vault of notes is listed, not read. */
export async function listMobileCloudStubs(vault: PortableVault): Promise<Array<{ path: string; stub: CloudStubRecord }>> {
  const files = stubFiles(vault.fs)
  if (!files) return []
  const found: Array<{ path: string; stub: CloudStubRecord }> = []
  await walkSyncedFiles(files, async (path, entry) => {
    if (entry.size > CLOUD_STUB_MAX_BYTES || TEXT_KIND_EXTENSIONS.has(extensionOf(entry.name))) return
    const stub = await files.readCloudStub(path)
    if (stub) found.push({ path, stub })
  })
  return found
}

/** Downloads every stubbed attachment, a few at a time. */
export async function hydrateAllMobileCloudStubs(
  vault: PortableVault,
  onProgress?: (done: number, total: number) => void
): Promise<{ hydrated: number; failed: Array<{ path: string; error: unknown }> }> {
  const stubs = await listMobileCloudStubs(vault)
  const failed: Array<{ path: string; error: unknown }> = []
  let hydrated = 0
  let done = 0
  const queue = [...stubs]
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        if (await hydrateMobileCloudStub(vault, next.path)) hydrated += 1
      } catch (error) {
        failed.push({ path: next.path, error })
      }
      done += 1
      onProgress?.(done, stubs.length)
    }
  }
  await Promise.all([worker(), worker(), worker()])
  if (hydrated > 0) await vault.rescan()
  return { hydrated, failed }
}

async function requireEveryStubHydrated(vault: PortableVault, doing: string): Promise<void> {
  if (!stubFiles(vault.fs)) return
  const { failed } = await hydrateAllMobileCloudStubs(vault)
  if (failed.length === 0) return
  const count = failed.length === 1 ? 'One attachment is' : `${failed.length} attachments are`
  throw new Error(
    `${count} still only in ZenNotes Cloud, and ${doing} would leave it out of this vault. Connect to the internet and try again.`
  )
}

export interface MobileCloudEvictionResult {
  stubbed: number
  freedBytes: number
}

/**
 * Turns synced attachments back into stubs to make room: only binaries above
 * the threshold whose bytes are exactly what Cloud has (never a file with an
 * unsynced change, never a note), in the order the host gives (oldest opened
 * first), until `targetBytes` are freed or every candidate is a stub.
 */
export async function evictMobileCloudAttachments(
  vault: PortableVault,
  options: {
    targetBytes?: number
    /** The candidates in the order to take them (the host's oldest-opened
     *  first); absent, the listing's order. */
    order?: (candidates: Array<{ path: string; size: number; mtime: number }>) => Promise<string[]> | string[]
  } = {}
): Promise<MobileCloudEvictionResult> {
  const files = stubFiles(vault.fs) as (StubCapableFiles & Partial<{
    evictToCloudStub(path: string, expected: { size: number; mtime: number; sha256: string }, stub: CloudStubRecord): Promise<boolean>
  }>) | null
  if (!files || typeof files.evictToCloudStub !== 'function') return { stubbed: 0, freedBytes: 0 }
  const vaultKey = files.syncKey
  const state = (await linkedState(vaultKey)) as CloudSyncState | null | undefined
  if (!state) return { stubbed: 0, freedBytes: 0 }
  // A stub of an encrypted vault must name its ciphertext, which sync state
  // does not keep, so the service is asked for it (below). Signed out it
  // could not be, and nothing could hydrate the stub anyway.
  if ((await getMobileCloudAccountStatus()).state !== 'connected') return { stubbed: 0, freedBytes: 0 }
  const ciphertextOf = await ciphertextLookup(vault)
  const threshold = portableHost().cloudStubs?.thresholdBytes ?? CLOUD_STUB_THRESHOLD_BYTES
  const candidates = new Map<string, VaultDirEntry>()
  await walkSyncedFiles(files, async (path, entry) => {
    if (entry.size > threshold && !TEXT_KIND_EXTENSIONS.has(extensionOf(entry.name))) candidates.set(path, entry)
  })
  const ordered = options.order
    ? await options.order([...candidates.entries()].map(([path, entry]) => ({ path, size: entry.size, mtime: entry.mtime })))
    : [...candidates.keys()]
  let stubbed = 0
  let freedBytes = 0
  for (const path of ordered) {
    if (options.targetBytes !== undefined && freedBytes >= options.targetBytes) break
    const entry = candidates.get(path)
    if (!entry) continue
    const local = await files.readForSync(path, false)
    if (local.stub) continue
    const found = evictableStubFor(state, path, local, threshold)
    if (!found) continue
    const encrypted = ciphertextOf ? await ciphertextOf(found) : null
    // No answer for an encrypted file: it stays here this time.
    if (ciphertextOf && !encrypted) continue
    const stub = encrypted ? { ...found, encrypted } : found
    if (await files.evictToCloudStub(path, { size: entry.size, mtime: entry.mtime, sha256: local.sha256 }, stub)) {
      stubbed += 1
      freedBytes += entry.size
    }
  }
  return { stubbed, freedBytes }
}

/**
 * For an encrypted vault, what the service stores for a revision (the stub's
 * `encrypted`), read from its download answer: null for a readable vault, or a
 * lookup that answers null when the service would not say. A wrong answer
 * from a hostile service costs only a failed hydration, since the plaintext
 * is still checked against the stub's own hash.
 */
async function ciphertextLookup(
  vault: PortableVault
): Promise<((stub: CloudStubRecord) => Promise<CloudSyncEncryptedContent | null>) | null> {
  const link = await getMobileCloudVaultLink(vault)
  if (!link || !(await isMobileCloudVaultEncrypted(link.vault_id))) return null
  const client = await authenticatedClient()
  if (!(await client.negotiateContentReferences())) return async () => null
  return async (stub) => {
    try {
      const { content } = (await client.download(link.vault_id, stub.item_id, stub.revision)).data
      return content.encoding === 'aes-gcm' ? { sha256: content.sha256, byte_length: content.byte_length } : null
    } catch {
      return null
    }
  }
}

/** The pending settings question, if sync parked a cloud version. It lives
 *  in the vault rather than in memory, so closing the app does not answer
 *  it by accident (desktop parity; ported from the Android shell). */
export async function getMobileCloudSettingsConflict(
  vault: PortableVault
): Promise<CloudSyncSettingsConflict | null> {
  const parked = await vault.fs.statOrNull(CLOUD_SYNC_SETTINGS_CONFLICT_PATH)
  if (parked?.type !== 'file') return null
  const raw = await vault.fs.readTextOrNull(CLOUD_SYNC_SETTINGS_CONFLICT_PATH)
  if (raw === null) return null
  // The parsed copy lets the app show what differs and offer a per-section
  // answer (desktop parity, #816). A copy that does not parse is still a
  // pending question (the file is there, and sync will not touch vault.json
  // until it is gone), so it is reported without the contents and the app
  // asks whole-file.
  const cloudSettings = parseParkedSettings(raw)
  return {
    path: CLOUD_SYNC_VAULT_SETTINGS_PATH,
    cloud_path: CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
    ...(cloudSettings ? { cloud_settings: cloudSettings } : {})
  }
}

/** Answer it. Keeping this device's settings just drops the parked copy;
 *  the next sync pushes the local ones up. Taking the cloud's writes them
 *  through the vault's own normalizer, so a hand-edited or older-format
 *  file cannot land as broken settings. */
export async function resolveMobileCloudSettingsConflict(
  vault: PortableVault,
  choice: CloudSyncSettingsChoice
): Promise<void> {
  if (choice === 'cloud') {
    const raw = await vault.fs.readTextOrNull(CLOUD_SYNC_SETTINGS_CONFLICT_PATH)
    const parsed = raw === null ? null : parseParkedSettings(raw)
    if (!parsed) {
      throw new Error('The settings from the cloud could not be read, so nothing was changed.')
    }
    await vault.setVaultSettings(
      parsed as unknown as Parameters<PortableVault['setVaultSettings']>[0]
    )
  }
  await vault.fs.deleteFile(CLOUD_SYNC_SETTINGS_CONFLICT_PATH).catch(() => {})
}

function parseParkedSettings(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** Check the server cursor without scanning the vault or downloading attachment bytes. */
export async function hasMobileCloudVaultChanges(vault: PortableVault): Promise<boolean> {
  return service.hasRemoteChanges(hostVault(vault))
}

/** A sync run is going for this vault (any caller's: a link's first sync
 *  too). A sync() asked for now joins it. */
export function isMobileCloudVaultSyncing(vault: PortableVault): boolean {
  return service.isSyncing(vault.fs.syncKey)
}

export async function syncMobileCloudVault(vault: PortableVault): Promise<CloudSyncRunSummary> {
  // No emit here: the host service runs vault.rescan() after every sync
  // (cloud-sync-host-service run()'s finally), and rescan emits the one
  // 'resync' event app-core needs.
  return service.sync(hostVault(vault, true))
}

export async function getMobileCloudConflict(
  vault: PortableVault,
  conflictId: string
): Promise<CloudSyncPendingConflictDetails> {
  return service.getConflict(hostVault(vault), conflictId)
}

export async function getMobileCloudBootstrapConflict(
  vault: PortableVault,
  conflict: CloudSyncBootstrapConflict
): Promise<CloudSyncBootstrapConflictDetails> {
  return service.getBootstrapConflict(hostVault(vault), conflict)
}

export async function resolveMobileCloudBootstrapConflict(
  vault: PortableVault,
  resolution: CloudSyncBootstrapConflictResolution
): Promise<void> {
  await service.resolveBootstrapConflict(hostVault(vault), resolution)
}

export async function saveMobileCloudConflictDraft(
  vault: PortableVault,
  conflictId: string,
  draftText: string | null
): Promise<void> {
  await service.saveConflictDraft(hostVault(vault), conflictId, draftText)
}

export async function resolveMobileCloudConflict(
  vault: PortableVault,
  resolution: CloudSyncPendingConflictResolution
): Promise<void> {
  await service.resolveConflict(hostVault(vault), resolution)
}

export async function listMobileCloudBackups(vault: PortableVault): Promise<CloudBackupSnapshot[]> {
  return service.listBackups(hostVault(vault))
}

export async function getMobileCloudBackupSchedule(
  vault: PortableVault
): Promise<CloudBackupSchedule> {
  return service.backupSchedule(hostVault(vault))
}

export async function updateMobileCloudBackupSchedule(
  vault: PortableVault,
  enabled: boolean
): Promise<CloudBackupSchedule> {
  return service.updateBackupSchedule(hostVault(vault), enabled)
}

export async function listMobileCloudBackupItems(
  vault: PortableVault,
  backupId: string
): Promise<CloudBackupSnapshotItem[]> {
  return service.listBackupItems(hostVault(vault), backupId)
}

/** One page of a backup's notes, searched by path on the service, so the
 *  backup browser can reach notes past the first 50. */
export async function listMobileCloudBackupItemsPage(
  vault: PortableVault,
  backupId: string,
  query: CloudBackupItemsQuery
): Promise<CloudBackupItemsPage> {
  return service.listBackupItemsPage(hostVault(vault), backupId, query)
}

export async function createMobileCloudBackup(
  vault: PortableVault,
  label?: string
): Promise<CloudBackupSnapshot> {
  // A typed label would reach ZenNotes Cloud readable, so encrypted vaults
  // keep their backups unlabeled.
  const unlabeled = label !== undefined && await linksEncryptedVault(await service.linkedVault(hostVault(vault)))
  return service.createBackup(hostVault(vault), unlabeled ? undefined : label)
}

export async function deleteMobileCloudBackup(
  vault: PortableVault,
  backupId: string
): Promise<void> {
  await service.deleteBackup(hostVault(vault), backupId)
}

export async function downloadMobileCloudBackup(
  vault: PortableVault,
  backupId: string
): Promise<void> {
  const link = await service.linkedVault(hostVault(vault))
  if (!link) throw new Error('Link this local vault to a ZenNotes Cloud vault first.')
  const credential = await authenticatedCredential()
  if (link.base_url !== credential.base_url) {
    throw new Error('This vault is linked to a different ZenNotes Cloud account.')
  }
  // The phone shares the service's archive as it is, and an encrypted
  // vault's holds ciphertext under path ids; the desktop app decrypts it.
  if (await linksEncryptedVault(link)) throw new Error(ENCRYPTED_VAULT_BACKUP_DOWNLOAD_MESSAGE)

  const safeBackupId = backupId.replace(/[^a-zA-Z0-9-]/g, '')
  if (!safeBackupId) throw new Error('That backup identifier is invalid.')
  const url = `${credential.base_url}/api/v1/vaults/${encodeURIComponent(link.vault_id)}/backups/${encodeURIComponent(backupId)}/download`
  // The host saves or shares the archive (the phones download it to their
  // cache and open the share sheet; a dismissed sheet is not an error).
  await portableHost().shell.saveDownload({
    url,
    fileName: `zennotes-backup-${safeBackupId}.json.gz`,
    title: 'ZenNotes backup',
    headers: {
      Accept: 'application/gzip',
      Authorization: `Bearer ${credential.token}`,
      // Every request from a client that opens encrypted vaults says so, this
      // one too (Android's copy had dropped it).
      ...(MOBILE_END_TO_END_ENCRYPTION ? { [CLOUD_E2EE_HEADER]: CLOUD_E2EE_HEADER_VALUE } : {})
    },
    connectTimeout: 30_000,
    readTimeout: 120_000
  })
}

export async function restoreMobileCloudBackup(
  vault: PortableVault,
  backupId: string
): Promise<CloudBackupRestoreResult> {
  return service.restoreBackup(hostVault(vault), backupId)
}

export async function restoreMobileCloudBackupNote(
  vault: PortableVault,
  backupId: string,
  snapshotItemId: number
): Promise<CloudBackupNoteRestoreResult> {
  return service.restoreBackupNote(hostVault(vault), backupId, snapshotItemId)
}

/** Whether a link names an end-to-end encrypted vault; a locked device knows too. */
async function linksEncryptedVault(link: CloudVaultLink | null): Promise<boolean> {
  // Another account's link fails in the shared service with its own message.
  if (!link || link.base_url !== (await authenticatedCredential()).base_url) return false
  return isMobileCloudVaultEncrypted(link.vault_id)
}

function hostVault(vault: PortableVault, cacheScan = false): CloudSyncHostVault {
  const files = vault.fs
  // Folders this operation has made, so a pull asks for each one once rather
  // than before every file it renames into place.
  const folders = new Set<string>()
  const fs: PortableCloudSyncFileSystem = {
    // Strict on purpose: readdir maps failure to [], which scan()
    // would read as an empty vault and plan a delete for every tracked item.
    readdir: async (directory) =>
      (await files.readdirStrict(directory)).map((entry) => ({
        name: entry.name,
        type: entry.type === 'directory' ? 'directory' : 'file'
      })),
    // The contract's null means verified absence (it drives delete/conflict
    // decisions), and an evicted iCloud file must never read as deleted.
    stat: (path) => files.statVerified(path),
    readBase64: (path) => files.readBase64(path),
    writeText: (path, value) => files.writeText(path, value),
    writeBase64: (path, value) => files.writeBase64(path, value),
    deleteFile: (path) => files.deleteFile(path),
    rename: async (from, to) => {
      // A pulled move carries no write that would create the destination
      // folder, and Capacitor's rename fails on a missing parent.
      const parent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : ''
      if (parent && !folders.has(parent)) {
        await files.mkdir(parent)
        folders.add(parent)
      }
      try {
        await files.rename(from, to)
      } catch (error) {
        // The folder may have gone since: a rename into a missing folder
        // fails before it changes anything, and the next one makes it again.
        folders.delete(parent)
        throw error
      }
    }
  }

  // The contract requires a key stable per local vault, and the host names it
  // (VaultFileSystem.syncKey). On the iPhone a root label resolves to an
  // absolute container URI whose UUID iOS rotates on app update and restore;
  // ZenNotes/<name> survives both, and keeps the link when a vault migrates
  // between the local and iCloud tiers.
  const vaultKey = files.syncKey
  const state = refreshStates.get(vault) ?? { changed: false }
  refreshStates.set(vault, state)
  const changes = trackCloudSyncChanges(fs, () => vault.rescan(), state)
  if (!hasSyncFastPath(files)) {
    // No sync fast path: every file is read as base64 through the shared
    // repository, with no scan cache to skip unchanged ones.
    return { key: vaultKey, repository: new PortableCloudSyncRepository(changes.fs), refresh: changes.refresh }
  }
  // Review and restore actions want every file's real bytes, so a stub they
  // meet hydrates first; only a sync run writes new stubs.
  const native = cacheScan ? files : withStubsHydrated(files, vault)
  const stubs = cacheScan ? stubPolicy() : undefined
  return {
    key: vaultKey,
    repository: new CachedCloudSyncRepository(changes.fs, native, {
      // A transient failure here disables skipping for the run (full read),
      // the safe direction, rather than failing or, worse, mis-skipping.
      loadTracked: async () => {
        // Review/restore actions always receive real bytes, not scan placeholders.
        if (!cacheScan) return null
        return ((await linkedState(vaultKey)) ?? null) as CloudSyncState | null
      },
      // Review and restore actions want every file, so only a sync run asks.
      isFirstSync: async () => cacheScan && (await linkedState(vaultKey)) === null,
      loadCache: async () => readJson(await scanCachePath(vaultKey)),
      saveCache: async (cache: ScanCache) => writeJson(await scanCachePath(vaultKey), cache)
    }, changes.markChanged, stubs ? { stubs } : {}),
    refresh: changes.refresh
  }
}

/** The vault's sync files with every stub read hydrated first (outside the
 *  sync's own staging folder). */
function withStubsHydrated<F extends VaultFileSystem & SyncFastPath>(files: F, vault: PortableVault): F {
  if (!stubFiles(files)) return files
  const readForSync: SyncFastPath['readForSync'] = async (path, textCandidate, knownUri) => {
    const first = await files.readForSync(path, textCandidate, knownUri)
    if (!first.stub || path.startsWith('.zennotes/')) return first
    await hydrateMobileCloudStub(vault, path)
    return files.readForSync(path, textCandidate)
  }
  return new Proxy(files, {
    get(target, property, receiver) {
      if (property === 'readForSync') return readForSync
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/** The state stored for this vault's link: null if none yet, undefined with no link. */
async function linkedState(vaultKey: string): Promise<unknown> {
  const link = await readJson(await linkPath(vaultKey))
  if (!isRecord(link) || typeof link.base_url !== 'string' || typeof link.vault_id !== 'string') {
    return undefined
  }
  return readJson(await statePath(vaultKey, link.base_url, link.vault_id))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

async function scanCachePath(vaultKey: string): Promise<string> {
  return `${STORAGE_ROOT}/scan-cache/${await fingerprint(vaultKey)}.json`
}

async function linkPath(vaultKey: string): Promise<string> {
  return `${STORAGE_ROOT}/links/${await fingerprint(vaultKey)}.json`
}

async function statePath(vaultKey: string, baseUrl: string, vaultId: string): Promise<string> {
  return `${STORAGE_ROOT}/states/${await fingerprint(vaultKey)}/${await fingerprint(baseUrl)}/${await fingerprint(vaultId)}.json`
}

async function readJson(path: string): Promise<unknown> {
  // Only a verified not-found may read as "no link / no state" (HostStorage
  // answers null for nothing else): a transient read failure surfacing as
  // null would re-bootstrap the vault and forget acknowledged offline
  // deletions.
  const raw = await portableHost().storage.read(path)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await portableHost().storage.write(path, JSON.stringify(value))
}

async function deleteDataFile(path: string): Promise<void> {
  await portableHost().storage.remove(path)
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
