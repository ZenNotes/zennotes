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
 */
import { base64ToBytes, bytesToBase64 } from '@zennotes/portable-vault/base64'
import type { PortableVaultFiles, VaultDirEntry, VaultStat } from '@zennotes/portable-vault/host'
import type { OpfsDispatcher, OpfsOp, OpfsOpenResult, OpfsRequest, OpfsResponse } from './opfs-dispatch'
import { deserializeOpfsError, isOpfsNotFound, OPFS_CLOSED, OpfsError } from './opfs-errors'
import type { OpfsEntry, OpfsStat } from './opfs-store'
import { vaultAssetUrl } from './opfs-paths'

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

export class OpfsVaultFileSystem implements PortableVaultFiles {
  writeGeneration = 0
  /** Whether this engine folds case and normalization in this vault (Safari
   *  on a Mac). Learned in init(). */
  foldsCase = false

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

  private async changing<T>(change: () => Promise<T>): Promise<T> {
    this.writeGeneration += 1
    try {
      return await change()
    } finally {
      this.writeGeneration += 1
    }
  }

  private async bytes(relPath: string): Promise<Uint8Array> {
    return (await this.transport.call('read', [relPath])) as Uint8Array
  }

  private async put(relPath: string, bytes: Uint8Array): Promise<void> {
    // The copy keeps a caller's buffer usable: the transfer detaches it.
    const owned = bytes.slice()
    await this.changing(() => this.transport.call('write', [relPath, owned], [owned.buffer]))
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
    return bytesToBase64(await this.bytes(relPath))
  }

  async readBytes(relPath: string): Promise<Uint8Array> {
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
    await this.changing(() => this.transport.call('copy', [fromRel, toRel]))
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
}
