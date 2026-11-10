/**
 * PortableCloudSyncRepository with a scan cache. The upstream portable scan
 * reads and hashes every file's full bytes across the native bridge on every
 * sync run, a 60-second background cadence on app-core's auto-sync, which
 * scales battery and memory cost with vault size. This subclass skips the
 * read for files that are provably not needed:
 *
 *   skip ⇔ (mtime AND size unchanged since the last real read)
 *          AND (that read's hash equals the acked sync state's hash)
 *          AND (the file is not involved in a pending conflict)
 *
 * The engine (cloud-sync-engine planCloudSyncMutations) touches
 * `content.data` only for items whose hash differs from the tracked state or
 * that the state does not know. The host disables skipping for review and
 * restore actions, which need real bytes even for acknowledged content.
 * A skipped item's `data` property THROWS if unexpectedly consumed, rather
 * than silently pushing content we never read.
 *
 * A lost cache or unknown timestamp causes a full read. Like other
 * metadata-based caches, this relies on the provider updating mtime or size
 * when content changes; same-size writes preserving mtime cannot be detected.
 *
 * A vault's first sync also holds back a Welcome note nobody has touched. The
 * coordinator raises a conflict for any local file a Cloud file disagrees
 * with, and on a first link it has no history to tell which is newer, so every
 * fresh install would stop on the text the app wrote for itself. Held back,
 * the seed takes Cloud's copy when there is one and goes up as a new note on
 * the run's next scan when there is not. It only ever leaves through the usual
 * vouched write, against the bytes scanned here, so words typed into it after
 * this scan still raise the conflict.
 */
import type {
  CloudSyncContent,
  CloudSyncItemKind
} from '@zennotes/bridge-contract/cloud-sync'
import {
  cloudSyncPathKey,
  normalizeCloudSyncPath,
  shouldSyncVaultPath,
  shouldTraverseCloudSyncDirectory
} from '@zennotes/shared-domain/cloud-sync'
import {
  PortableCloudSyncRepository,
  type PortableCloudSyncFileSystem
} from '@zennotes/shared-domain/cloud-sync-portable-filesystem'
import type {
  CloudSyncLocalItem,
  CloudSyncState,
  CloudSyncTrackedItem
} from '@zennotes/shared-domain/cloud-sync-engine'
import type { SyncFastPath, VaultFileSystem } from './host'
import { cloudSyncWorkBudget, decodeCloudSyncBase64 } from './cloud-sync-work'
import { CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES, rememberMobileUploadSource } from './mobile-direct-upload'
import { NativeCloudStaging, type CloudStagingNative } from './cloud-sync-staging'
import { randomUUID } from './uuid'
import { isUntouchedWelcomeSeed } from './welcome-note'

export interface ScanCacheEntry {
  mtime: number
  size: number
  sha256: string
  kind: CloudSyncItemKind
  byte_length: number
  media_type: string
}

export type ScanCache = Record<string, ScanCacheEntry>

type CloudSyncNativeFiles = Pick<VaultFileSystem, 'readdirStrict' | 'statOrNull' | 'isNotFound'> &
  Pick<SyncFastPath, 'readForSync' | 'copyForSync'> &
  Partial<CloudStagingNative> & Partial<Pick<SyncFastPath, 'sealForUpload'>>

export interface ScanCacheStore {
  loadTracked(): Promise<CloudSyncState | null>
  /** True only for a sync run that verifiably has no stored state yet. */
  isFirstSync(): Promise<boolean>
  loadCache(): Promise<unknown>
  saveCache(cache: ScanCache): Promise<void>
}

export class CachedCloudSyncRepository extends PortableCloudSyncRepository {
  private readonly contentFiles: NativeCloudSyncContent
  private readonly heldBackSeeds: HeldBackSeeds

  constructor(
    fs: PortableCloudSyncFileSystem,
    private readonly native: CloudSyncNativeFiles,
    private readonly store: ScanCacheStore,
    private readonly onChanged: () => void = () => {}
  ) {
    const contentFiles = new NativeCloudSyncContent(fs, native)
    const heldBackSeeds: HeldBackSeeds = new Map()
    const staging = isStagingNative(native)
      ? new NativeCloudStaging(native, (path) => TEXT_EXTENSIONS.has(extension(path)), (path) => contentFiles.read(path))
      : null
    const sourceAwareFs = {
      ...(staging ? {
        stageCloudContent: async (source: Parameters<NativeCloudStaging['stage']>[0]) => {
          await contentFiles.assertReady(true)
          return staging.stage(source)
        },
        // A staged publish keeps its own rollback copy, so the next read or
        // write looks for one again.
        applyStagedCloudContent: async (...[change, previous, file]: Parameters<NativeCloudStaging['apply']>) => {
          try {
            return await staging.apply(change, previous ?? heldBackSeedAsTracked(heldBackSeeds, change), file)
          } finally { contentFiles.recheckRecovery() }
        },
        resolveStagedCloudConflict: async (input: Parameters<NativeCloudStaging['resolve']>[0]) => {
          try { return await staging.resolve(input) } finally { contentFiles.recheckRecovery() }
        }
      } : {}),
      readdir: (path: string) => fs.readdir(path),
      stat: (path: string) => fs.stat(path),
      readBase64: (path: string) => fs.readBase64(path),
      writeText: (path: string, value: string) => fs.writeText(path, value),
      writeBase64: (path: string, value: string) => fs.writeBase64(path, value),
      deleteFile: (path: string) => fs.deleteFile(path),
      rename: (from: string, to: string) => fs.rename(from, to),
      readItem: (path: string) => contentFiles.read(path),
      validateContent: (content: CloudSyncContent) => contentFiles.validate(content),
      writeContent: (path: string, content: CloudSyncContent) => contentFiles.write(path, content)
    }
    super(sourceAwareFs)
    this.contentFiles = contentFiles
    this.heldBackSeeds = heldBackSeeds
    this.staging = staging
  }

  private readonly staging: NativeCloudStaging | null

  override async matchesCloudContent(path: string, reference: Parameters<NativeCloudStaging['matches']>[1]): Promise<boolean> {
    return this.staging ? this.staging.matches(path, reference) : super.matchesCloudContent(path, reference)
  }

  override async scan(): Promise<CloudSyncLocalItem[]> {
    await this.contentFiles.assertReady(true)
    const trackedSha = trackedShaByPath(await this.store.loadTracked().catch(() => null))
    const cache = normalizeScanCache(await this.store.loadCache().catch(() => null))
    // A state that cannot be read may hold this note, and a tracked note
    // missing from a scan would go up as a deletion, so doubt keeps it in view.
    const firstSync = await this.store.isFirstSync().catch(() => false)
    const nextCache: ScanCache = {}
    const items: CloudSyncLocalItem[] = []
    await this.walkCached('', trackedSha, cache, nextCache, items)
    if (Object.keys(cache).some((path) => !nextCache[path])) this.onChanged()
    // Cache loss is only a slow next scan, never let it fail the sync run.
    await this.store.saveCache(nextCache).catch(() => {})
    this.heldBackSeeds.clear()
    return items
      .filter((item) => {
        if (!firstSync || !isUntouchedWelcomeSeed(item.path, item.content.sha256)) return true
        this.heldBackSeeds.set(cloudSyncPathKey(item.path), item)
        return false
      })
      .sort((left, right) => left.path.localeCompare(right.path))
  }

  override async apply(...[change, previous]: Parameters<PortableCloudSyncRepository['apply']>) {
    return super.apply(change, previous ?? heldBackSeedAsTracked(this.heldBackSeeds, change))
  }

  private async walkCached(
    directory: string,
    trackedSha: Map<string, string>,
    cache: ScanCache,
    nextCache: ScanCache,
    items: CloudSyncLocalItem[]
  ): Promise<void> {
    // readdirStrict entries carry mtime and size, so validating the cache
    // costs no extra stat calls on a hit. Fresh reads are checked again
    // before their fingerprints can be reused on a later scan.
    const entries = await this.native.readdirStrict(directory)
    const checkpoint = cloudSyncWorkBudget()
    for (const entry of entries) {
      await checkpoint()
      const relPath = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (shouldTraverseCloudSyncDirectory(relPath)) {
          await this.walkCached(relPath, trackedSha, cache, nextCache, items)
        }
        continue
      }
      if (!shouldSyncVaultPath(relPath)) continue

      const path = normalizeCloudSyncPath(relPath)
      const cached = cache[path]
      if (
        cached &&
        cached.mtime === entry.mtime &&
        cached.size === entry.size &&
        trackedSha.get(cloudSyncPathKey(path)) === cached.sha256
      ) {
        nextCache[path] = cached
        items.push(itemFromCache(path, cached))
        continue
      }

      const item = await this.readItemFresh(path, entry.uri)
      if (!cached || cached.mtime !== entry.mtime || cached.size !== entry.size || cached.sha256 !== item.content.sha256) {
        this.onChanged()
      }
      // Never seed a reusable fingerprint from an unstable native read.
      // Unknown provider timestamps are deliberately always cache misses.
      const after = await this.native.statOrNull(path).catch(() => null)
      if (validFingerprint(entry) && after?.type === 'file' &&
          after.mtime === entry.mtime && after.size === entry.size &&
          item.content.byte_length === entry.size) nextCache[path] = {
        mtime: entry.mtime,
        size: entry.size,
        sha256: item.content.sha256,
        kind: item.kind,
        byte_length: item.content.byte_length,
        media_type: item.content.media_type
      }
      items.push(item)
    }
  }

  // ---------------------------------------------------------------------
  // Only inline-sized bodies cross the native bridge. Large files retain a
  // host-only source reference, like the desktop's disk-backed uploader.
  // ---------------------------------------------------------------------

  private async readItemFresh(path: string, uri?: string): Promise<CloudSyncLocalItem> {
    return this.contentFiles.read(path, uri)
  }
}

/** Large local content remains an identity-bound source, never an empty payload. */
class NativeCloudSyncContent {
  private readonly sources = new WeakMap<CloudSyncContent, { path: string; hash: string; bytes: number }>()
  private recoveryChecked = false

  constructor(private readonly fs: PortableCloudSyncFileSystem, private readonly native: CloudSyncNativeFiles) {}

  async assertReady(force = false): Promise<void> {
    if (this.recoveryChecked && !force) return
    const entries = await this.native.readdirStrict('.zennotes/sync').catch((error) => {
      if (!this.native.isNotFound(error)) throw error
      return []
    })
    const recovery = entries.find((entry) => entry.name.startsWith('rollback-'))
    if (recovery) {
      // Never turn a process-interrupted rename into a new local deletion.
      throw new Error(`Cloud sync needs recovery of .zennotes/sync/${recovery.name} before it can continue.`)
    }
    this.recoveryChecked = true
  }

  /** Something may have left a rollback file since the last listing. */
  recheckRecovery(): void {
    this.recoveryChecked = false
  }

  async read(path: string, uri?: string): Promise<CloudSyncLocalItem> {
    await this.assertReady()
    const file = await this.native.readForSync(path, TEXT_EXTENSIONS.has(extension(path)), uri)
    if (file.byteLength > CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES) {
      const seal = this.native.sealForUpload?.bind(this.native)
      const content = rememberMobileUploadSource({
        encoding: file.utf8 ? 'utf8' : 'base64', data: '', sha256: file.sha256,
        byte_length: file.byteLength, media_type: mediaType(path, file.utf8)
      }, file.uri, seal ? (keys) => seal(file.uri, keys) : undefined)
      this.sources.set(content, { path, hash: file.sha256, bytes: file.byteLength })
      return {
        path,
        kind: file.utf8 ? 'text' : 'binary',
        content
      }
    }
    if (file.inlineBase64 === undefined) throw new Error('Native file inspection omitted inline content.')
    const { bytes, base64 } = await decodeCloudSyncBase64(file.inlineBase64)
    const text = decodeText(path, bytes)
    return {
      path,
      kind: text === null ? 'binary' : 'text',
      content: {
        encoding: text === null ? 'base64' : 'utf8',
        data: text === null ? base64 : text,
        sha256: file.sha256,
        byte_length: bytes.byteLength,
        media_type: mediaType(path, text !== null)
      }
    }
  }

  async validate(content: CloudSyncContent): Promise<void> {
    if (content.encoding !== 'utf8' && content.encoding !== 'base64') {
      throw new Error('Encrypted cloud sync content must be decrypted before filesystem apply')
    }
    if (content.data !== '' || content.byte_length === 0) return
    const source = this.sources.get(content)
    if (!source || source.hash !== content.sha256 || source.bytes !== content.byte_length) {
      throw new Error('This file content has no recognized source bytes. Sync again and retry.')
    }
    await this.verify(source.path, content)
  }

  private async verify(path: string, content: CloudSyncContent): Promise<void> {
    // Resolve the current path again: a saved document URI may name a replaced file.
    const file = await this.native.readForSync(path, false)
    if (file.sha256 !== content.sha256 || file.byteLength !== content.byte_length) {
      throw new Error('The file source changed or its copy failed byte verification. Sync again and retry.')
    }
  }

  async write(path: string, content: CloudSyncContent): Promise<void> {
    await this.assertReady()
    await this.validate(content)
    const kind = await this.fs.stat(path)
    if (kind === 'directory') throw new Error('The destination is a directory.')
    const before = kind === 'file' ? await this.read(path) : null
    const temporary = `.zennotes/sync/write-${randomUUID()}${extension(path)}`
    const backup = `.zennotes/sync/rollback-${randomUUID()}${extension(path)}`
    let publishing = false
    let published = false
    let completed = false
    try {
      const source = this.sources.get(content)
      if (content.data === '' && content.byte_length > 0 && source) {
        await this.native.copyForSync(source.path, temporary, content.byte_length)
        await this.validate(content)
      } else if (content.encoding === 'utf8') {
        await this.fs.writeText(temporary, content.data)
      } else {
        await this.fs.writeBase64(temporary, content.data)
      }
      await this.verify(temporary, content)
      if (before) {
        await this.verify(path, before.content)
        await this.fs.rename(path, backup)
      } else if (await this.fs.stat(path) !== null) {
        throw new Error('The destination changed before its Cloud write.')
      }
      publishing = true
      await this.fs.rename(temporary, path)
      published = true
      await this.verify(path, content)
      completed = true
    } catch (error) {
      // Native operations may modify the destination and then reject. The
      // original is kept separately until the published bytes are verified.
      if (await this.fs.stat(backup) === 'file') {
        try {
          if (await this.fs.stat(path) !== null) await this.fs.deleteFile(path)
          await this.fs.rename(backup, path)
        } catch (rollbackError) {
          throw new Error(`Cloud write rollback failed; the original is preserved at ${backup}.`, { cause: rollbackError })
        }
      } else if (!before && publishing && await this.fs.stat(path) !== null) {
        await this.fs.deleteFile(path)
      }
      throw error
    } finally {
      // A write that completed and removed its backup leaves no rollback
      // file, so the listing it started from still holds.
      if (!completed) this.recoveryChecked = false
      // A rename that resolved moved the temporary onto the path.
      if (!published && await this.fs.stat(temporary) === 'file') await this.fs.deleteFile(temporary).catch(() => {})
      // There is a backup only when an original was moved aside.
      if (completed && before) await this.fs.deleteFile(backup).catch(() => { this.recoveryChecked = false })
    }
  }
}

type HeldBackSeeds = Map<string, CloudSyncLocalItem>

/** The held-back seed at a change's path, as what this device last knew of it. */
function heldBackSeedAsTracked(
  seeds: HeldBackSeeds,
  change: { item_id: string; path: string }
): CloudSyncTrackedItem | undefined {
  const seed = seeds.get(cloudSyncPathKey(change.path))
  return seed && {
    item_id: change.item_id,
    path: seed.path,
    kind: seed.kind,
    revision: 0,
    sha256: seed.content.sha256,
    byte_length: seed.content.byte_length,
    media_type: seed.content.media_type
  }
}

function isStagingNative(native: CloudSyncNativeFiles): native is CloudSyncNativeFiles & CloudStagingNative {
  return ['statVerified', 'download', 'rename', 'deleteFile', 'mkdir', 'readText']
    .every((method) => typeof (native as Record<string, unknown>)[method] === 'function')
}

function itemFromCache(path: string, cached: ScanCacheEntry): CloudSyncLocalItem {
  const content = {
    encoding: cached.kind === 'text' ? 'utf8' : 'base64',
    sha256: cached.sha256,
    byte_length: cached.byte_length,
    media_type: cached.media_type
  } as CloudSyncContent
  Object.defineProperty(content, 'data', {
    enumerable: true,
    get(): string {
      throw new Error(
        `Cloud sync tried to push ${path} from the scan cache without reading it: the engine's hash-equal items must never need content.`
      )
    }
  })
  return { path, kind: cached.kind, content }
}

function trackedShaByPath(state: CloudSyncState | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!state || state.version !== 1 || !state.items) return out
  for (const item of Object.values(state.items)) {
    if (item && typeof item.path === 'string' && typeof item.sha256 === 'string') {
      out.set(cloudSyncPathKey(item.path), item.sha256)
    }
  }
  // Conflict review/resolution consumes actual bytes, even if a version is
  // already acknowledged. Hash exclusions also cover moved local versions.
  const paths = new Set<string>()
  const hashes = new Set<string>()
  for (const conflict of Object.values(state.pending_conflicts ?? {})) {
    for (const snapshot of [conflict.base, conflict.local, conflict.cloud]) {
      if (snapshot?.path) paths.add(cloudSyncPathKey(snapshot.path))
      if (snapshot?.content?.sha256) hashes.add(snapshot.content.sha256)
    }
    for (const path of conflict.paused_paths ?? []) paths.add(cloudSyncPathKey(path))
  }
  for (const [path, hash] of out) {
    if (paths.has(path) || hashes.has(hash)) out.delete(path)
  }
  return out
}

function validFingerprint(entry: { mtime?: number; size?: number }): boolean {
  return typeof entry.mtime === 'number' && Number.isFinite(entry.mtime) && entry.mtime > 0 &&
    typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0
}

function normalizeScanCache(raw: unknown): ScanCache {
  if (!raw || typeof raw !== 'object') return {}
  const out: ScanCache = {}
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Partial<ScanCacheEntry> | null
    if (
      entry &&
      validFingerprint(entry) &&
      typeof entry.sha256 === 'string' &&
      (entry.kind === 'text' || entry.kind === 'binary') &&
      typeof entry.byte_length === 'number' &&
      typeof entry.media_type === 'string'
    ) {
      out[path] = entry as ScanCacheEntry
    }
  }
  return out
}

// Mirrored from upstream cloud-sync-portable-filesystem.ts, keep in lockstep.

const TEXT_EXTENSIONS = new Set([
  '.base',
  '.css',
  '.csv',
  '.excalidraw',
  '.htm',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
])

const MEDIA_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.toml': 'application/toml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml'
}

function decodeText(path: string, bytes: Uint8Array): string | null {
  if (!TEXT_EXTENSIONS.has(extension(path))) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

function mediaType(path: string, text: boolean): string {
  return MEDIA_TYPES[extension(path)] ?? (text ? 'text/plain' : 'application/octet-stream')
}
