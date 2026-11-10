/**
 * The browser vault as @zennotes/portable-vault's VaultFileSystem: every call
 * goes to the OPFS worker (opfs-worker.ts) and comes back with the worker's
 * error codes intact. What the contract asks (vault-fs-contract.ts) and how
 * this answers it:
 *
 * - `statVerified`/`readTextOrNull` answer null only for ZN-OPFS-NOT-FOUND;
 *   any other failure throws.
 * - `readdirStrict` throws on any failed listing; `readdir` maps failure to [].
 * - `writeGeneration` moves before and after every change.
 * - `syncKey` is `browser/<vaultKey>`: the key is the vault's folder name
 *   under `vaults/`, which nothing renames, so it survives reloads and
 *   updates.
 *
 * `fileSrc` hands out `/_vault/<vaultKey>/<path>`, which the service worker
 * answers from OPFS (sw.ts).
 *
 * It is also the package's SyncFastPath, in JavaScript: the worker hashes
 * files in slices, streams signed downloads into staging and checks them, and
 * hands a verified File to an upload, so large files never sit whole in the
 * page. That gives the browser the phones' scan cache, content references and
 * staged publishing (CachedCloudSyncRepository).
 *
 * Attachments on open: the Cloud layer writes large binary attachments as
 * stubs (portable-vault cloud-sync-stubs.ts). Every read of a file's bytes
 * here (readBase64, readBytes, copy) hydrates a stub first through the
 * hydrator the host installs, so export, publish, duplicate and copy never
 * see one. Notes are never stubs.
 */
import { base64ToBytes, bytesToBase64 } from '@zennotes/portable-vault/base64'
import { CLOUD_STUB_MAX_BYTES, decodeCloudStub, type CloudStubRecord } from '@zennotes/portable-vault/cloud-stub-format'
import { CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES } from '@zennotes/portable-vault/direct-upload'
import type {
  CloudDownloadToFile,
  CloudFileFingerprint,
  PortableVaultFiles,
  SyncFastPath,
  VaultDirEntry,
  VaultStat,
  Zne1NativeKeys,
  Zne1NativeSealedFile
} from '@zennotes/portable-vault/host'
import type { OpfsDispatcher, OpfsOp, OpfsOpenResult, OpfsRequest, OpfsResponse } from './opfs-dispatch'
import { deserializeOpfsError, isOpfsNotFound, OPFS_CLOSED, OPFS_QUOTA, OPFS_STUB, OpfsError } from './opfs-errors'
import type { OpfsFileSnapshot } from './opfs-handles'
import type { OpfsEntry, OpfsFingerprint, OpfsStat } from './opfs-store'
import { vaultAssetUrl } from './opfs-paths'

const URI_PREFIX = 'opfs-vault:'
const ENCRYPTED_NOT_YET =
  'This vault is end-to-end encrypted, which ZenNotes in the browser cannot open yet. Use the ZenNotes app for it for now.'

/** Hydrates the stub at a path: true when the file now holds its bytes. */
export type StubHydrator = (relPath: string) => Promise<boolean>

export interface OpfsTransport {
  call(op: OpfsOp, args: unknown[], transfer?: Transferable[]): Promise<unknown>
  close(): void
}

/** Calls into a dedicated worker running opfs-worker.ts. */
export function workerTransport(worker: Worker): OpfsTransport {
  let nextId = 1
  let closed = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>()
  worker.onmessage = (event: MessageEvent<OpfsResponse>) => {
    const waiting = pending.get(event.data.id)
    if (!waiting) return
    pending.delete(event.data.id)
    if (event.data.ok) waiting.resolve(event.data.value)
    else waiting.reject(deserializeOpfsError(event.data.error))
  }
  worker.onerror = (event) => {
    const error = new OpfsError('ZN-OPFS-STORAGE', `The vault worker stopped: ${event.message || 'unknown error'}`, 'WorkerError')
    for (const waiting of pending.values()) waiting.reject(error)
    pending.clear()
  }
  return {
    call(op, args, transfer = []) {
      if (closed) return Promise.reject(new OpfsError(OPFS_CLOSED, 'This tab no longer has the vault open.', 'InvalidStateError'))
      const id = nextId++
      const request: OpfsRequest = { id, op, args }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker.postMessage(request, transfer)
      })
    },
    close() {
      closed = true
      worker.terminate()
      const error = new OpfsError(OPFS_CLOSED, 'This tab no longer has the vault open.', 'InvalidStateError')
      for (const waiting of pending.values()) waiting.reject(error)
      pending.clear()
    }
  }
}

/** Calls the dispatcher in process: vitest, with the OPFS fake. */
export function directTransport(dispatcher: OpfsDispatcher): OpfsTransport {
  let nextId = 1
  let closed = false
  return {
    async call(op, args) {
      if (closed) throw new OpfsError(OPFS_CLOSED, 'This tab no longer has the vault open.', 'InvalidStateError')
      const response = await dispatcher.handle({ id: nextId++, op, args })
      if (response.ok) return response.value
      throw deserializeOpfsError(response.error)
    },
    close() {
      closed = true
    }
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

export interface OpfsVaultFileSystemOptions {
  /** The fencing generation this tab holds for the vault (vault-lock.ts). */
  generation: number
}

export class OpfsVaultFileSystem implements PortableVaultFiles, SyncFastPath {
  writeGeneration = 0
  /** Whether this engine folds case and normalization in this vault (Safari
   *  on a Mac). Learned in init(). */
  foldsCase = false
  private hydrator: StubHydrator | null = null
  private quotaPressure: (() => Promise<void>) | null = null
  private readonly writeListeners = new Set<() => void>()

  constructor(
    readonly vaultKey: string,
    private readonly transport: OpfsTransport,
    private readonly options: OpfsVaultFileSystemOptions
  ) {}

  get syncKey(): string {
    return `browser/${this.vaultKey}`
  }

  get rootLabel(): string {
    return `opfs://vaults/${this.vaultKey}`
  }

  async init(): Promise<void> {
    const result = (await this.transport.call('open', [this.vaultKey, this.options.generation])) as OpfsOpenResult
    this.foldsCase = result.foldsCase
  }

  /** Stops every later call; the worker is terminated. */
  close(): void {
    this.transport.close()
  }

  /** How a stub this vault holds gets its bytes (the Cloud layer's one
   *  hydration function). Without one, reading a stub's bytes fails. */
  setStubHydrator(hydrator: StubHydrator | null): void {
    this.hydrator = hydrator
  }

  /** Runs when a write finds the browser out of space, before one retry:
   *  the host turns synced attachments back into stubs. */
  setQuotaPressureHandler(handler: (() => Promise<void>) | null): void {
    this.quotaPressure = handler
  }

  /** Every change this vault makes, after it lands (the unsynced-changes
   *  mark and the leave-page guard read it). */
  onWrite(listener: () => void): () => void {
    this.writeListeners.add(listener)
    return () => this.writeListeners.delete(listener)
  }

  private async changing<T>(change: () => Promise<T>): Promise<T> {
    this.writeGeneration += 1
    try {
      return await change()
    } finally {
      this.writeGeneration += 1
      for (const listener of this.writeListeners) listener()
    }
  }

  private async bytes(relPath: string): Promise<Uint8Array> {
    return (await this.transport.call('read', [relPath])) as Uint8Array
  }

  /** A file's bytes, a stub's after it hydrates. */
  private async hydratedBytes(relPath: string): Promise<Uint8Array> {
    const bytes = await this.bytes(relPath)
    if (bytes.byteLength > CLOUD_STUB_MAX_BYTES || !decodeCloudStub(bytes)) return bytes
    await this.hydrate(relPath)
    const after = await this.bytes(relPath)
    if (after.byteLength <= CLOUD_STUB_MAX_BYTES && decodeCloudStub(after)) throw this.stubError(relPath)
    return after
  }

  private stubError(relPath: string): OpfsError {
    return new OpfsError(OPFS_STUB, `“${relPath}” is only in ZenNotes Cloud on this device. Connect to the internet to open it.`, 'CloudStubError', { path: relPath })
  }

  private async hydrate(relPath: string): Promise<void> {
    if (!this.hydrator) throw this.stubError(relPath)
    await this.hydrator(relPath)
  }

  private async put(relPath: string, bytes: Uint8Array): Promise<void> {
    const send = () => {
      // The copy keeps a caller's buffer usable: the transfer detaches it.
      const owned = bytes.slice()
      return this.transport.call('write', [relPath, owned], [owned.buffer])
    }
    await this.changing(async () => {
      try {
        await send()
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== OPFS_QUOTA || !this.quotaPressure) throw error
        // Out of space: synced attachments go back to stubs, then one more
        // try. A note is never dropped; a second refusal says so.
        await this.quotaPressure()
        await send()
      }
    })
  }

  isNotFound(error: unknown): boolean {
    return isOpfsNotFound(error)
  }

  fileSrc(relPath: string): string | null {
    try {
      return vaultAssetUrl(this.vaultKey, relPath)
    } catch {
      return null
    }
  }

  async readText(relPath: string): Promise<string> {
    return decoder.decode(await this.bytes(relPath))
  }

  async readTextOrNull(relPath: string): Promise<string | null> {
    try {
      return await this.readText(relPath)
    } catch (error) {
      if (!this.isNotFound(error)) throw error
      return null
    }
  }

  async readBase64(relPath: string): Promise<string> {
    return bytesToBase64(await this.hydratedBytes(relPath))
  }

  async readBytes(relPath: string): Promise<Uint8Array> {
    return await this.hydratedBytes(relPath)
  }

  /** The bytes as they are on disk, a stub's own included (export of a
   *  vault that cannot reach Cloud, tests). */
  async readStoredBytes(relPath: string): Promise<Uint8Array> {
    return await this.bytes(relPath)
  }

  async writeText(relPath: string, body: string): Promise<void> {
    await this.put(relPath, encoder.encode(body))
  }

  async writeBase64(relPath: string, base64Data: string): Promise<void> {
    await this.put(relPath, base64ToBytes(base64Data))
  }

  async writeBytes(relPath: string, bytes: Uint8Array): Promise<void> {
    await this.put(relPath, bytes)
  }

  async statOrNull(relPath: string): Promise<VaultStat | null> {
    const stat = (await this.transport.call('stat', [relPath])) as OpfsStat | null
    return stat ? { type: stat.type, size: stat.size, mtime: stat.mtime, ctime: null } : null
  }

  async statVerified(relPath: string): Promise<'file' | 'directory' | null> {
    return (await this.statOrNull(relPath))?.type ?? null
  }

  async readdir(relPath: string): Promise<VaultDirEntry[]> {
    try {
      return await this.readdirStrict(relPath)
    } catch {
      return []
    }
  }

  async readdirStrict(relPath: string): Promise<VaultDirEntry[]> {
    const entries = (await this.transport.call('list', [relPath])) as OpfsEntry[]
    return entries.map((entry) => ({ name: entry.name, type: entry.type, size: entry.size, mtime: entry.mtime }))
  }

  async mkdir(relPath: string): Promise<void> {
    await this.changing(() => this.transport.call('mkdir', [relPath]))
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    await this.changing(() => this.transport.call('rename', [fromRel, toRel]))
  }

  async copy(fromRel: string, toRel: string): Promise<void> {
    // The worker refuses to copy a stub and names it; it hydrates, and the
    // copy runs again (a folder copy meets its stubs one by one).
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      try {
        await this.changing(() => this.transport.call('copy', [fromRel, toRel]))
        return
      } catch (error) {
        const stub = error as { code?: unknown; path?: unknown } | null
        if (stub?.code !== OPFS_STUB || typeof stub.path !== 'string') throw error
        await this.hydrate(stub.path)
      }
    }
    throw new Error('Copying this folder kept meeting attachments that are only in ZenNotes Cloud.')
  }

  async deleteFile(relPath: string): Promise<void> {
    await this.changing(() => this.transport.call('deleteFile', [relPath]))
  }

  async rmdir(relPath: string): Promise<void> {
    await this.changing(() => this.transport.call('rmdir', [relPath]))
  }

  async rmdirIfEmpty(relPath: string): Promise<void> {
    await this.changing(() => this.transport.call('rmdirIfEmpty', [relPath]))
  }

  async exists(relPath: string): Promise<boolean> {
    return (await this.statOrNull(relPath)) !== null
  }

  // -------------------------------------------------------------------
  // SyncFastPath (the package's host interface)
  // -------------------------------------------------------------------

  uriFor(relPath: string): string {
    return `${URI_PREFIX}${this.vaultKey}/${relPath}`
  }

  /** The vault path a `uriFor` URI names in this vault, else null. */
  pathForUri(uri: string): string | null {
    const prefix = `${URI_PREFIX}${this.vaultKey}/`
    return uri.startsWith(prefix) ? uri.slice(prefix.length) : null
  }

  async readForSync(relPath: string, textCandidate: boolean): Promise<CloudFileFingerprint> {
    const print = (await this.transport.call('fingerprint', [relPath, textCandidate, CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES])) as OpfsFingerprint
    return {
      uri: this.uriFor(relPath),
      sha256: print.sha256,
      byteLength: print.byteLength,
      utf8: print.utf8,
      ...(print.inline ? { inlineBase64: bytesToBase64(print.inline) } : {}),
      ...(print.stub ? { stub: { mediaType: print.stub.media_type } } : {})
    }
  }

  async copyForSync(fromRel: string, toRel: string, byteLength: number): Promise<void> {
    await this.changing(() => this.transport.call('copyForSync', [fromRel, toRel, byteLength]))
  }

  async download(options: CloudDownloadToFile): Promise<void> {
    await this.changing(() => this.transport.call('download', [options]))
  }

  async readHeader(relPath: string, length: number): Promise<string> {
    return bytesToBase64((await this.bytes(relPath)).subarray(0, length))
  }

  async decryptFile(_options: { from: string; to: string } & Zne1NativeKeys): Promise<{ byteLength: number; sha256: string }> {
    throw new Error(ENCRYPTED_NOT_YET)
  }

  async sealForUpload(_sourceUri: string, _keys: Zne1NativeKeys): Promise<Zne1NativeSealedFile> {
    throw new Error(ENCRYPTED_NOT_YET)
  }

  async writeCloudStub(relPath: string, stub: CloudStubRecord): Promise<void> {
    await this.changing(() => this.transport.call('writeStub', [relPath, stub]))
  }

  async readCloudStub(relPath: string): Promise<CloudStubRecord | null> {
    try {
      return (await this.transport.call('readStub', [relPath])) as CloudStubRecord | null
    } catch (error) {
      if (this.isNotFound(error)) return null
      throw error
    }
  }

  async replaceCloudStub(fromRel: string, toRel: string, expected: CloudStubRecord): Promise<boolean> {
    return (await this.changing(() => this.transport.call('replaceStub', [fromRel, toRel, expected]))) as boolean
  }

  async evictToCloudStub(relPath: string, expected: { size: number; mtime: number; sha256: string }, stub: CloudStubRecord): Promise<boolean> {
    return (await this.changing(() => this.transport.call('evictToStub', [relPath, expected, stub]))) as boolean
  }

  /** The file behind a `uriFor` URI, checked against the fingerprint an
   *  upload was planned with; a stub is refused. */
  async fileForUpload(uri: string, sha256: string, byteLength: number): Promise<OpfsFileSnapshot> {
    const path = this.pathForUri(uri)
    if (path === null) throw new Error('That upload source is not in this vault.')
    return (await this.transport.call('fileForUpload', [path, sha256, byteLength])) as OpfsFileSnapshot
  }
}
