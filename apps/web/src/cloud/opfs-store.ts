/**
 * One vault's folder in the origin's private file system (OPFS), with the
 * rules the spikes found every engine needs (docs/ideas/cloud-in-browser.md,
 * "The OPFS vault"):
 *
 * - A write goes to a temp file in the same folder, is flushed and closed,
 *   then moved over the target with `move(dir, name)`. `move()` replaces a
 *   file in every engine, so a failed write leaves the old file. Safari takes
 *   only the two-argument form, and it replaces a file another handle still
 *   has open, so no handle outlives the operation that opened it and the ones
 *   on a target are closed before anything moves onto it.
 * - A folder rename creates the target (which must not exist), moves every
 *   file into it, then removes the source. Chrome has no `move()` for
 *   folders, Firefox replaces an existing destination and Safari merges into
 *   it, so the folder form is never used. A journal outside the vault records
 *   the move first, and the next open finishes a move a closed tab stopped.
 * - Case: Safari's OPFS is plain files on the host disk, so on a Mac it folds
 *   case and normalization. `probeCase` asks once per vault; renames compare
 *   entries with `isSameEntry`, the way desktop's macOS rename compares file
 *   identity, so a case-only rename works and a rename onto another file
 *   never does.
 * - Names over 255 bytes or with a backslash are refused (opfs-paths.ts).
 *
 * The store runs inside the OPFS worker (opfs-worker.ts), which serializes
 * every call, and in vitest over the fake in test/opfs-fake.ts. `fence` runs
 * before every change: it throws once another tab owns the vault.
 */
import {
  DIRECT_TRANSFER_FAILED,
  notFound,
  OPFS_EXISTS,
  OPFS_STUB,
  OPFS_IS_DIRECTORY,
  OPFS_NOT_DIRECTORY,
  OPFS_NOT_EMPTY,
  OPFS_BAD_NAME,
  OpfsError,
  isOpfsNotFound,
  toOpfsError
} from './opfs-errors'
import type {
  OpfsDirectoryHandle,
  OpfsFileHandle,
  OpfsFileSnapshot,
  OpfsHandle,
  OpfsSyncAccessHandle
} from './opfs-handles'
import { createSHA256 } from 'hash-wasm'
import {
  CloudE2eeError,
  ZNE1_CHUNK_BYTES,
  ZNE1_HEADER_BYTES,
  ZNE1_SEALED_CHUNK_BYTES,
  ZNE1_TAG_BYTES,
  constantTimeEqual,
  createZne1ChunkDecryptor,
  createZne1ChunkEncryptor,
  fromBase64,
  type Bytes,
  type Zne1ChunkCipherParams
} from '@zennotes/shared-domain/cloud-e2ee'
import { CLOUD_STUB_MAX_BYTES, decodeCloudStub, encodeCloudStub, type CloudStubRecord } from '@zennotes/portable-vault/cloud-stub-format'
import {
  assertStorableName,
  isValidVaultKey,
  joinSegments,
  nameProblem,
  splitVaultPath,
  TEMP_PREFIX,
  VAULTS_DIR
} from './opfs-paths'

export interface OpfsStat {
  type: 'file' | 'directory'
  size: number
  mtime: number
}

export interface OpfsEntry extends OpfsStat {
  name: string
}

export interface OpfsVaultStoreOptions {
  /** Throws when this tab no longer owns the vault. Runs before every change. */
  fence?: () => Promise<void>
  randomId?: () => string
  /** The worker's fetch (tests pass their own). */
  fetch?: typeof fetch
}

/** What the sync fast path learns about one file (SyncFastPath.readForSync). */
export interface OpfsFingerprint {
  sha256: string
  byteLength: number
  utf8: boolean
  /** The bytes, for a file no larger than the inline limit asked for. */
  inline?: Uint8Array
  /** A Cloud stub: the fingerprint above is the one it records. */
  stub?: CloudStubRecord
}

/** What the sync fast path gets to open or seal one ZNE1 file, as base64: the
 *  phones' native loops take the same three (Zne1NativeKeys). */
export interface OpfsZne1Keys {
  header: string
  objectKey: string
  aad: string
}

export interface OpfsSealedFile {
  byteLength: number
  sha256: string
  plaintextByteLength: number
  plaintextSha256: string
}

/** Bytes hashed per read of a large file. */
const HASH_CHUNK_BYTES = 8 * 1024 * 1024
/** ZNE1 chunks read per pass over a large file; memory stays near this. */
const ZNE1_CHUNKS_PER_READ = 64
/** Staged by sealFile, and swept when the vault next opens. */
const STAGING_FOLDERS = ['.zennotes/sync/downloads', '.zennotes/sync/uploads']
/** A signed download that sends nothing for this long is dropped and
 *  retried by the caller. */
const DOWNLOAD_STALL_MS = 60_000

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function chunkParams(keys: OpfsZne1Keys): Zne1ChunkCipherParams {
  return { header: fromBase64(keys.header), objectKey: fromBase64(keys.objectKey), aad: fromBase64(keys.aad) }
}

function stubsEqual(left: CloudStubRecord, right: CloudStubRecord): boolean {
  return left.item_id === right.item_id && left.revision === right.revision &&
    left.sha256 === right.sha256 && left.byte_length === right.byte_length &&
    left.media_type === right.media_type &&
    (left.encrypted?.sha256 ?? null) === (right.encrypted?.sha256 ?? null) &&
    (left.encrypted?.byte_length ?? null) === (right.encrypted?.byte_length ?? null)
}

function transferFailed(message: string, status?: number): OpfsError {
  return new OpfsError(DIRECT_TRANSFER_FAILED, message, 'CloudTransferError', status === undefined ? {} : { status })
}

interface Located {
  parent: OpfsDirectoryHandle | null
  name: string
  handle: OpfsHandle
}

interface MoveJournal {
  from: string
  to: string
}

const JOURNALS_DIR = '.zn-journal'

function isNamed(error: unknown, name: string): boolean {
  return (error as { name?: unknown } | null)?.name === name
}

function defaultRandomId(): string {
  return globalThis.crypto.randomUUID()
}

async function listChildren(dir: OpfsDirectoryHandle): Promise<Array<[string, OpfsHandle]>> {
  const out: Array<[string, OpfsHandle]> = []
  for await (const entry of dir.entries()) out.push(entry)
  return out
}

export class OpfsVaultStore {
  private readonly fence: () => Promise<void>
  private readonly randomId: () => string
  private readonly fetchImpl: typeof fetch
  /** Sync access handles open right now, by the path they are on. */
  private readonly openHandles = new Map<string, OpfsSyncAccessHandle>()
  private foldsCase: boolean | null = null

  private constructor(
    private readonly root: OpfsDirectoryHandle,
    private readonly journals: OpfsDirectoryHandle,
    options: OpfsVaultStoreOptions
  ) {
    this.fence = options.fence ?? (async () => {})
    this.randomId = options.randomId ?? defaultRandomId
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args))
  }

  /** `vaults/<vaultKey>/` under the origin root, made on first use. */
  static async open(
    originRoot: OpfsDirectoryHandle,
    vaultKey: string,
    options: OpfsVaultStoreOptions & { create?: boolean } = {}
  ): Promise<OpfsVaultStore> {
    if (!isValidVaultKey(vaultKey)) {
      throw new OpfsError(OPFS_BAD_NAME, `“${vaultKey}” is not a vault name this browser can use.`, 'OpfsNameError')
    }
    // A reader (the export window) opens only what is there and never makes
    // a folder; its store has no journals to write either.
    const create = options.create ?? true
    try {
      const vaults = await originRoot.getDirectoryHandle(VAULTS_DIR, { create })
      const root = await vaults.getDirectoryHandle(vaultKey, { create })
      const journals = create
        ? await (await vaults.getDirectoryHandle(JOURNALS_DIR, { create: true })).getDirectoryHandle(vaultKey, { create: true })
        : root
      return new OpfsVaultStore(root, journals, options)
    } catch (error) {
      throw toOpfsError(error, vaultKey)
    }
  }

  /** What opening the vault does before its first walk: finish folder moves
   *  a closed tab left half done, drop temp files of interrupted writes, and
   *  learn whether this engine folds case. */
  async prepare(): Promise<{ foldsCase: boolean }> {
    await this.finishInterruptedMoves()
    await this.sweepTemps(this.root)
    await this.sweepStaging()
    return { foldsCase: await this.probeCase() }
  }

  // -------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------

  private async directory(segments: readonly string[], create: boolean, path: string): Promise<OpfsDirectoryHandle> {
    let dir = this.root
    for (const name of segments) {
      if (create) assertStorableName(name, path)
      else if (nameProblem(name)) throw notFound(path)
      try {
        dir = await dir.getDirectoryHandle(name, { create })
      } catch (error) {
        if (isNamed(error, 'TypeMismatchError')) {
          if (!create) throw notFound(path)
          throw new OpfsError(OPFS_NOT_DIRECTORY, `A file is in the way of the folder “${path}”.`, 'TypeMismatchError')
        }
        throw toOpfsError(error, path)
      }
    }
    return dir
  }

  /** The entry named `name` in `dir`, null only when it is verifiably absent. */
  private async child(dir: OpfsDirectoryHandle, name: string, path: string): Promise<OpfsHandle | null> {
    if (nameProblem(name)) return null
    try {
      return await dir.getFileHandle(name)
    } catch (error) {
      if (isNamed(error, 'NotFoundError')) return null
      if (!isNamed(error, 'TypeMismatchError')) throw toOpfsError(error, path)
    }
    try {
      return await dir.getDirectoryHandle(name)
    } catch (error) {
      if (isNamed(error, 'NotFoundError')) return null
      throw toOpfsError(error, path)
    }
  }

  private async locate(path: string): Promise<Located | null> {
    const segments = splitVaultPath(path)
    if (segments.length === 0) return { parent: null, name: '', handle: this.root }
    let parent: OpfsDirectoryHandle
    try {
      parent = await this.directory(segments.slice(0, -1), false, path)
    } catch (error) {
      if (isOpfsNotFound(error)) return null
      throw error
    }
    const name = segments[segments.length - 1]!
    const handle = await this.child(parent, name, path)
    return handle ? { parent, name, handle } : null
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  async read(path: string): Promise<Uint8Array> {
    const found = await this.locate(path)
    if (!found) throw notFound(path)
    if (found.handle.kind !== 'file') {
      throw new OpfsError(OPFS_IS_DIRECTORY, `“${path}” is a folder.`, 'TypeMismatchError')
    }
    try {
      return new Uint8Array(await (await found.handle.getFile()).arrayBuffer())
    } catch (error) {
      throw toOpfsError(error, path)
    }
  }

  async stat(path: string): Promise<OpfsStat | null> {
    const found = await this.locate(path)
    if (!found) return null
    if (found.handle.kind === 'directory') return { type: 'directory', size: 0, mtime: 0 }
    try {
      const file = await found.handle.getFile()
      return { type: 'file', size: file.size, mtime: file.lastModified }
    } catch (error) {
      if (isNamed(error, 'NotFoundError')) return null
      throw toOpfsError(error, path)
    }
  }

  /** Strict: a missing folder or a failed listing throws. */
  async list(path: string): Promise<OpfsEntry[]> {
    const found = await this.locate(path)
    if (!found) throw notFound(path)
    if (found.handle.kind !== 'directory') {
      throw new OpfsError(OPFS_NOT_DIRECTORY, `“${path}” is not a folder.`, 'TypeMismatchError')
    }
    let children: Array<[string, OpfsHandle]>
    try {
      children = await listChildren(found.handle)
    } catch (error) {
      throw toOpfsError(error, path)
    }
    const entries: OpfsEntry[] = []
    for (const [name, handle] of children) {
      if (name.startsWith(TEMP_PREFIX)) continue
      if (handle.kind === 'directory') {
        entries.push({ name, type: 'directory', size: 0, mtime: 0 })
        continue
      }
      try {
        const file = await handle.getFile()
        entries.push({ name, type: 'file', size: file.size, mtime: file.lastModified })
      } catch (error) {
        // Removed between the listing and the stat: it is not there.
        if (isNamed(error, 'NotFoundError')) continue
        throw toOpfsError(error, path ? `${path}/${name}` : name)
      }
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  // -------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------

  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.fence()
    const segments = splitVaultPath(path)
    if (segments.length === 0) throw new OpfsError(OPFS_IS_DIRECTORY, 'The vault root is a folder.', 'TypeMismatchError')
    for (const segment of segments) assertStorableName(segment, path)
    const parent = await this.directory(segments.slice(0, -1), true, path)
    const name = segments[segments.length - 1]!
    await this.writeInto(parent, name, bytes, path)
  }

  private async writeInto(parent: OpfsDirectoryHandle, name: string, bytes: Uint8Array, path: string): Promise<void> {
    const existing = await this.child(parent, name, path)
    if (existing?.kind === 'directory') {
      throw new OpfsError(OPFS_IS_DIRECTORY, `“${path}” is a folder.`, 'TypeMismatchError')
    }
    const tempName = `${TEMP_PREFIX}${this.randomId()}`
    let temp: OpfsFileHandle
    try {
      temp = await parent.getFileHandle(tempName, { create: true })
    } catch (error) {
      throw toOpfsError(error, path)
    }
    try {
      await this.writeAll(temp, bytes, `${path}#temp`)
      // Ownership can move while the bytes were being written.
      await this.fence()
      this.closeHandlesOn(path)
      if (typeof temp.move !== 'function') {
        throw new OpfsError('ZN-OPFS-STORAGE', 'This browser cannot replace files in place.', 'NotSupportedError')
      }
      await temp.move(parent, name)
    } catch (error) {
      await parent.removeEntry(tempName).catch(() => undefined)
      throw toOpfsError(error, path)
    }
  }

  private async writeAll(handle: OpfsFileHandle, bytes: Uint8Array, key: string): Promise<void> {
    if (typeof handle.createSyncAccessHandle === 'function') {
      const access = await handle.createSyncAccessHandle()
      this.openHandles.set(key, access)
      try {
        access.truncate(0)
        let written = 0
        while (written < bytes.byteLength) {
          written += access.write(bytes.subarray(written), { at: written })
        }
        access.flush()
      } finally {
        this.openHandles.delete(key)
        access.close()
      }
      return
    }
    // The main thread (tests, a page without a worker) has only writables.
    if (typeof handle.createWritable !== 'function') {
      throw new OpfsError('ZN-OPFS-STORAGE', 'This browser cannot write to its private storage.', 'NotSupportedError')
    }
    const writable = await handle.createWritable()
    try {
      await writable.write(bytes)
      await writable.close()
    } catch (error) {
      await writable.abort?.().catch(() => undefined)
      throw error
    }
  }

  /** Every sync handle this store holds on `path` or under it, closed. The
   *  worker runs one call at a time and each call closes what it opened, so
   *  this finds nothing in practice; it is the rule Safari needs made
   *  explicit, so a future long-lived handle cannot break it. */
  private closeHandlesOn(path: string): void {
    for (const [key, handle] of [...this.openHandles]) {
      const target = key.replace(/#temp$/, '')
      if (target === path || target.startsWith(`${path}/`)) {
        try {
          handle.close()
        } catch {
          // already closed
        }
        this.openHandles.delete(key)
      }
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.fence()
    await this.directory(splitVaultPath(path), true, path)
  }

  async deleteFile(path: string): Promise<void> {
    await this.fence()
    const found = await this.locate(path)
    if (!found || !found.parent) throw notFound(path)
    if (found.handle.kind !== 'file') {
      throw new OpfsError(OPFS_IS_DIRECTORY, `“${path}” is a folder.`, 'TypeMismatchError')
    }
    this.closeHandlesOn(path)
    try {
      await found.parent.removeEntry(found.name)
    } catch (error) {
      throw toOpfsError(error, path)
    }
  }

  async rmdir(path: string): Promise<void> {
    await this.fence()
    const found = await this.locate(path)
    if (!found || !found.parent) throw notFound(path)
    if (found.handle.kind !== 'directory') {
      throw new OpfsError(OPFS_NOT_DIRECTORY, `“${path}” is not a folder.`, 'TypeMismatchError')
    }
    this.closeHandlesOn(path)
    try {
      await found.parent.removeEntry(found.name, { recursive: true })
    } catch (error) {
      throw toOpfsError(error, path)
    }
  }

  async rmdirIfEmpty(path: string): Promise<void> {
    await this.fence()
    const found = await this.locate(path)
    if (!found || !found.parent) throw notFound(path)
    if (found.handle.kind !== 'directory') {
      throw new OpfsError(OPFS_NOT_DIRECTORY, `“${path}” is not a folder.`, 'TypeMismatchError')
    }
    const children = await listChildren(found.handle).catch((error) => {
      throw toOpfsError(error, path)
    })
    if (children.some(([name]) => !name.startsWith(TEMP_PREFIX))) {
      throw new OpfsError(OPFS_NOT_EMPTY, `“${path}” is not empty.`, 'InvalidModificationError')
    }
    await this.sweepTemps(found.handle)
    try {
      await found.parent.removeEntry(found.name)
    } catch (error) {
      throw toOpfsError(error, path)
    }
  }

  /**
   * Moves a file or folder. Like the phones' native rename: the target's
   * folder must exist, and nothing may be at the target unless it is the
   * same entry under another spelling (a case-only rename on a store that
   * folds case).
   */
  async rename(from: string, to: string): Promise<void> {
    await this.fence()
    const source = await this.locate(from)
    if (!source || !source.parent) throw notFound(from)
    const toSegments = splitVaultPath(to)
    if (toSegments.length === 0) throw new OpfsError(OPFS_EXISTS, 'The vault root already exists.', 'InvalidModificationError')
    for (const segment of toSegments) assertStorableName(segment, to)
    const fromSegments = splitVaultPath(from)
    if (
      source.handle.kind === 'directory' &&
      toSegments.length > fromSegments.length &&
      fromSegments.every((segment, index) => toSegments[index] === segment)
    ) {
      throw new OpfsError(OPFS_EXISTS, `“${from}” cannot move inside itself.`, 'InvalidModificationError')
    }
    const targetParent = await this.directory(toSegments.slice(0, -1), false, to)
    const targetName = toSegments[toSegments.length - 1]!
    const existing = await this.child(targetParent, targetName, to)
    let sameEntry = false
    if (existing) {
      sameEntry = await existing.isSameEntry(source.handle).catch(() => false)
      if (!sameEntry) {
        throw new OpfsError(OPFS_EXISTS, `“${to}” already exists.`, 'InvalidModificationError')
      }
    }
    if (sameEntry && source.name === targetName && joinSegments(fromSegments) === joinSegments(toSegments)) return

    this.closeHandlesOn(from)
    if (source.handle.kind === 'file') {
      if (typeof source.handle.move !== 'function') {
        throw new OpfsError('ZN-OPFS-STORAGE', 'This browser cannot move files.', 'NotSupportedError')
      }
      try {
        await source.handle.move(targetParent, targetName)
      } catch (error) {
        throw toOpfsError(error, to)
      }
      return
    }

    if (sameEntry) {
      // A case-only folder rename where the store folds case: creating the
      // new spelling would find the old folder, so detour through a name
      // nothing else holds.
      const detour = `${TEMP_PREFIX}mv-${this.randomId()}`
      const detourPath = joinSegments([...fromSegments.slice(0, -1), detour])
      await this.moveDirectory(source.parent, source.name, from, source.parent, detour, detourPath)
      await this.moveDirectory(source.parent, detour, detourPath, targetParent, targetName, to)
      return
    }
    await this.moveDirectory(source.parent, source.name, from, targetParent, targetName, to)
  }

  private async moveDirectory(
    fromParent: OpfsDirectoryHandle,
    fromName: string,
    fromPath: string,
    toParent: OpfsDirectoryHandle,
    toName: string,
    toPath: string
  ): Promise<void> {
    const journalName = `${this.randomId()}.json`
    await this.writeInto(this.journals, journalName, new TextEncoder().encode(JSON.stringify({ from: fromPath, to: toPath } satisfies MoveJournal)), `journal ${journalName}`)
    try {
      await this.moveTree(fromParent, fromName, toParent, toName, false)
    } catch (error) {
      // The journal stays: the next open finishes what is left.
      throw toOpfsError(error, toPath)
    }
    await this.journals.removeEntry(journalName).catch(() => undefined)
  }

  private async moveTree(
    fromParent: OpfsDirectoryHandle,
    fromName: string,
    toParent: OpfsDirectoryHandle,
    toName: string,
    resuming: boolean
  ): Promise<void> {
    const source = await fromParent.getDirectoryHandle(fromName)
    if (!resuming && (await this.child(toParent, toName, toName))) {
      throw new OpfsError(OPFS_EXISTS, `“${toName}” already exists.`, 'InvalidModificationError')
    }
    const target = await toParent.getDirectoryHandle(toName, { create: true })
    for (const [name, handle] of await listChildren(source)) {
      if (name.startsWith(TEMP_PREFIX) && handle.kind === 'file') {
        await source.removeEntry(name).catch(() => undefined)
        continue
      }
      if (handle.kind === 'file') {
        if (typeof handle.move !== 'function') {
          throw new OpfsError('ZN-OPFS-STORAGE', 'This browser cannot move files.', 'NotSupportedError')
        }
        await handle.move(target, name)
      } else {
        await this.moveTree(source, name, target, name, true)
      }
    }
    await fromParent.removeEntry(fromName)
  }

  private async finishInterruptedMoves(): Promise<void> {
    let journals: Array<[string, OpfsHandle]>
    try {
      journals = await listChildren(this.journals)
    } catch {
      return
    }
    for (const [name, handle] of journals) {
      if (handle.kind !== 'file' || name.startsWith(TEMP_PREFIX)) {
        await this.journals.removeEntry(name, { recursive: true }).catch(() => undefined)
        continue
      }
      try {
        const record = JSON.parse(new TextDecoder().decode(await (await handle.getFile()).arrayBuffer())) as Partial<MoveJournal>
        if (typeof record.from === 'string' && typeof record.to === 'string') {
          const source = await this.locate(record.from)
          if (source?.parent && source.handle.kind === 'directory') {
            const toSegments = splitVaultPath(record.to)
            const targetParent = await this.directory(toSegments.slice(0, -1), true, record.to)
            await this.moveTree(source.parent, source.name, targetParent, toSegments[toSegments.length - 1]!, true)
          }
        }
        await this.journals.removeEntry(name).catch(() => undefined)
      } catch (error) {
        // Never fails an open; the journal is kept for the next one.
        console.warn('[zen] could not finish an interrupted folder move', error)
      }
    }
  }

  /** Copies a file over whatever is at the target, or a folder into a new
   *  one. A Cloud stub is never copied: a copy of one would be a new file
   *  with no bytes behind it, so the caller hydrates it first (OPFS_STUB). */
  async copy(from: string, to: string): Promise<void> {
    await this.fence()
    const source = await this.locate(from)
    if (!source) throw notFound(from)
    if (source.handle.kind === 'file') {
      const bytes = await this.read(from)
      if (decodeCloudStub(bytes)) {
        throw new OpfsError(OPFS_STUB, `“${from}” is only in ZenNotes Cloud on this device.`, 'CloudStubError', { path: from })
      }
      await this.write(to, bytes)
      return
    }
    await this.mkdir(to)
    for (const entry of await this.list(from)) {
      await this.copy(`${from}/${entry.name}`, `${to}/${entry.name}`)
    }
  }

  // -------------------------------------------------------------------
  // Cloud sync fast path (the package's SyncFastPath, in JavaScript)
  // -------------------------------------------------------------------

  private async fileAt(path: string): Promise<OpfsFileSnapshot> {
    const found = await this.locate(path)
    if (!found) throw notFound(path)
    if (found.handle.kind !== 'file') {
      throw new OpfsError(OPFS_IS_DIRECTORY, `“${path}” is a folder.`, 'TypeMismatchError')
    }
    try {
      return await found.handle.getFile()
    } catch (error) {
      throw toOpfsError(error, path)
    }
  }

  /** The bytes of a file no larger than `max`, else null (a stub is small). */
  async readSmall(path: string, max = CLOUD_STUB_MAX_BYTES): Promise<Uint8Array | null> {
    const file = await this.fileAt(path)
    if (file.size > max) return null
    return new Uint8Array(await file.arrayBuffer())
  }

  async readStub(path: string): Promise<CloudStubRecord | null> {
    const bytes = await this.readSmall(path)
    return bytes ? decodeCloudStub(bytes) : null
  }

  /**
   * SHA-256, length and (for a text candidate) whether the bytes are UTF-8,
   * with the bytes themselves for a file up to `inlineLimit`. Large files are
   * hashed in slices, never held whole. A stub answers with what it records.
   */
  async fingerprint(path: string, textCandidate: boolean, inlineLimit: number): Promise<OpfsFingerprint> {
    const file = await this.fileAt(path)
    let small: Uint8Array<ArrayBuffer> | null = null
    if (file.size <= CLOUD_STUB_MAX_BYTES) {
      small = new Uint8Array(await file.arrayBuffer())
      const stub = decodeCloudStub(small)
      if (stub) return { sha256: stub.sha256, byteLength: stub.byte_length, utf8: false, stub }
    }
    if (file.size <= inlineLimit) {
      // Most notes are small: the read that ruled out a stub is the one hashed.
      const bytes = small ?? new Uint8Array(await file.arrayBuffer())
      const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes))
      let utf8 = false
      if (textCandidate) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          utf8 = true
        } catch {
          utf8 = false
        }
      }
      return { sha256, byteLength: bytes.byteLength, utf8, inline: bytes }
    }
    const hasher = await createSHA256()
    hasher.init()
    const decoder = textCandidate ? new TextDecoder('utf-8', { fatal: true }) : null
    let utf8 = textCandidate
    for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
      if (!file.slice) throw new OpfsError('ZN-OPFS-STORAGE', 'This browser cannot read large files in parts.', 'NotSupportedError')
      const chunk = new Uint8Array(await file.slice(offset, Math.min(offset + HASH_CHUNK_BYTES, file.size)).arrayBuffer())
      hasher.update(chunk)
      if (decoder && utf8) {
        try {
          decoder.decode(chunk, { stream: offset + HASH_CHUNK_BYTES < file.size })
        } catch {
          utf8 = false
        }
      }
    }
    return { sha256: hasher.digest('hex'), byteLength: file.size, utf8 }
  }

  /** A file's whole bytes for an upload, after checking they are the ones
   *  the scan fingerprinted (never a stub). */
  async fileForUpload(path: string, sha256: string, byteLength: number): Promise<OpfsFileSnapshot> {
    const print = await this.fingerprint(path, false, 0)
    if (print.stub) {
      throw new OpfsError(OPFS_STUB, `“${path}” is only in ZenNotes Cloud on this device.`, 'CloudStubError', { path })
    }
    if (print.sha256 !== sha256 || print.byteLength !== byteLength) {
      throw new OpfsError('ZN-OPFS-CHANGED', `“${path}” changed since it was read for sync. Sync again.`, 'CloudSourceChangedError')
    }
    return await this.fileAt(path)
  }

  /** A verified copy into a new path (SyncFastPath.copyForSync). */
  async copyForSync(from: string, to: string, byteLength: number): Promise<void> {
    await this.fence()
    const bytes = await this.read(from)
    if (decodeCloudStub(bytes)) {
      throw new OpfsError(OPFS_STUB, `“${from}” is only in ZenNotes Cloud on this device.`, 'CloudStubError', { path: from })
    }
    if (bytes.byteLength !== byteLength) {
      throw new OpfsError('ZN-OPFS-CHANGED', `“${from}” changed before it could be copied.`, 'CloudSourceChangedError')
    }
    if (await this.locate(to)) throw new OpfsError(OPFS_EXISTS, `“${to}” already exists.`, 'InvalidModificationError')
    await this.write(to, bytes)
  }

  /**
   * Streams a signed Cloud download into `to`, a new path: into a temp file
   * first, hashed as it arrives, moved into place only when its length and
   * SHA-256 are the ones expected. A failure says whether the storage host
   * answered (`status`), which is what decides a retry.
   */
  async download(options: { url: string; headers: Record<string, string>; to: string; byteLength: number; sha256: string }): Promise<void> {
    await this.fence()
    const segments = splitVaultPath(options.to)
    if (segments.length === 0) throw new OpfsError(OPFS_IS_DIRECTORY, 'The vault root is a folder.', 'TypeMismatchError')
    for (const segment of segments) assertStorableName(segment, options.to)
    const parent = await this.directory(segments.slice(0, -1), true, options.to)
    const name = segments[segments.length - 1]!
    if (await this.child(parent, name, options.to)) {
      throw new OpfsError(OPFS_EXISTS, `“${options.to}” already exists.`, 'InvalidModificationError')
    }
    const controller = new AbortController()
    let stall: ReturnType<typeof setTimeout> | null = null
    const watch = (): void => {
      if (stall) clearTimeout(stall)
      stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS)
    }
    let response: Response
    try {
      watch()
      response = await this.fetchImpl(options.url, {
        method: 'GET',
        headers: options.headers,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal
      })
    } catch (error) {
      if (stall) clearTimeout(stall)
      throw transferFailed(`ZenNotes could not reach Cloud storage (${error instanceof Error ? error.message : String(error)}).`)
    }
    if (!response.ok || !response.body) {
      if (stall) clearTimeout(stall)
      await response.body?.cancel().catch(() => undefined)
      throw transferFailed(`Cloud storage answered ${response.status}.`, response.status)
    }
    const tempName = `${TEMP_PREFIX}${this.randomId()}`
    let temp: OpfsFileHandle
    try {
      temp = await parent.getFileHandle(tempName, { create: true })
    } catch (error) {
      if (stall) clearTimeout(stall)
      await response.body.cancel().catch(() => undefined)
      throw toOpfsError(error, options.to)
    }
    const hasher = await createSHA256()
    hasher.init()
    let written = 0
    try {
      const reader = response.body.getReader()
      const sink = await this.openSink(temp, `${options.to}#temp`)
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>
          try {
            chunk = await reader.read()
          } catch (error) {
            throw transferFailed(`The Cloud download stopped (${error instanceof Error ? error.message : String(error)}).`)
          }
          if (chunk.done) break
          watch()
          written += chunk.value.byteLength
          if (written > options.byteLength) throw new Error('Cloud download failed length or SHA-256 verification.')
          hasher.update(chunk.value)
          await sink.write(chunk.value)
        }
      } finally {
        await sink.close()
      }
      if (written !== options.byteLength || hasher.digest('hex') !== options.sha256) {
        throw new Error('Cloud download failed length or SHA-256 verification.')
      }
      await this.fence()
      this.closeHandlesOn(options.to)
      if (typeof temp.move !== 'function') {
        throw new OpfsError('ZN-OPFS-STORAGE', 'This browser cannot replace files in place.', 'NotSupportedError')
      }
      await temp.move(parent, name)
    } catch (error) {
      await parent.removeEntry(tempName).catch(() => undefined)
      throw error instanceof OpfsError ? error : toOpfsError(error, options.to)
    } finally {
      if (stall) clearTimeout(stall)
    }
  }

  /** Writes a file in order, by sync access handle in the worker or a
   *  writable on the main thread (tests). */
  private async openSink(handle: OpfsFileHandle, key: string): Promise<{ write(bytes: Uint8Array): Promise<void>; close(): Promise<void> }> {
    if (typeof handle.createSyncAccessHandle === 'function') {
      const access = await handle.createSyncAccessHandle()
      this.openHandles.set(key, access)
      access.truncate(0)
      let at = 0
      return {
        async write(bytes) {
          let done = 0
          while (done < bytes.byteLength) done += access.write(bytes.subarray(done), { at: at + done })
          at += bytes.byteLength
        },
        close: async () => {
          this.openHandles.delete(key)
          try {
            access.flush()
          } finally {
            access.close()
          }
        }
      }
    }
    if (typeof handle.createWritable !== 'function') {
      throw new OpfsError('ZN-OPFS-STORAGE', 'This browser cannot write to its private storage.', 'NotSupportedError')
    }
    const writable = await handle.createWritable()
    return {
      write: (bytes) => writable.write(bytes),
      close: () => writable.close()
    }
  }

  /** Up to `length` leading bytes of a file, without reading the rest. */
  async readHead(path: string, length: number): Promise<Uint8Array> {
    const file = await this.fileAt(path)
    if (!file.slice) return new Uint8Array(await file.arrayBuffer()).subarray(0, length)
    return new Uint8Array(await file.slice(0, Math.min(length, file.size)).arrayBuffer())
  }

  /**
   * Opens a staged ZNE1 file into `to`, a new path (SyncFastPath.decryptFile).
   * Chunks are authenticated one by one into a temp file, which is moved into
   * place only after the last one, so a tampered or short file leaves nothing.
   * The header was checked against its key on the page; here it must still be
   * the header at the front of this file.
   */
  async decryptFile(options: { from: string; to: string } & OpfsZne1Keys): Promise<{ byteLength: number; sha256: string }> {
    await this.fence()
    if (options.from === options.to) throw new OpfsError(OPFS_EXISTS, 'Cloud decryption needs a separate destination.', 'InvalidModificationError')
    const params = chunkParams(options)
    const file = await this.fileAt(options.from)
    if (!file.slice) throw new OpfsError('ZN-OPFS-STORAGE', 'This browser cannot read large files in parts.', 'NotSupportedError')
    if (file.size < ZNE1_HEADER_BYTES + ZNE1_TAG_BYTES) throw new CloudE2eeError('malformed', 'The encrypted data is too short.')
    const head = new Uint8Array(await file.slice(0, ZNE1_HEADER_BYTES).arrayBuffer())
    if (!constantTimeEqual(head, params.header)) throw new CloudE2eeError('tampered', 'The encrypted data changed while it was being opened.')
    const loop = await createZne1ChunkDecryptor(params)
    const hasher = await createSHA256()
    hasher.init()
    let written = 0
    const slab = ZNE1_SEALED_CHUNK_BYTES * ZNE1_CHUNKS_PER_READ
    await this.writeNewFile(options.to, async (sink) => {
      for (let offset = ZNE1_HEADER_BYTES; offset < file.size; offset += slab) {
        const end = Math.min(offset + slab, file.size)
        const bytes = new Uint8Array(await file.slice!(offset, end).arrayBuffer())
        for (let at = 0; at < bytes.byteLength; at += ZNE1_SEALED_CHUNK_BYTES) {
          const stop = Math.min(at + ZNE1_SEALED_CHUNK_BYTES, bytes.byteLength)
          const opened = await loop.decryptChunk(bytes.subarray(at, stop), offset + stop === file.size)
          hasher.update(opened)
          await sink.write(opened)
          written += opened.byteLength
        }
      }
    })
    return { byteLength: written, sha256: hasher.digest('hex') }
  }

  /**
   * Seals a vault file into `to` for an encrypted vault's direct upload
   * (SyncFastPath.sealForUpload): the service must be told the ciphertext's
   * length and hash before the bytes go. Reports the plaintext's too, so the
   * caller refuses a file that changed since sync read it. Never a stub.
   */
  async sealFile(from: string, to: string, keys: OpfsZne1Keys): Promise<OpfsSealedFile> {
    await this.fence()
    const params = chunkParams(keys)
    const file = await this.fileAt(from)
    if (!file.slice) throw new OpfsError('ZN-OPFS-STORAGE', 'This browser cannot read large files in parts.', 'NotSupportedError')
    if (file.size <= CLOUD_STUB_MAX_BYTES && decodeCloudStub(new Uint8Array(await file.arrayBuffer()))) {
      throw new OpfsError(OPFS_STUB, `“${from}” is only in ZenNotes Cloud on this device.`, 'CloudStubError', { path: from })
    }
    const loop = await createZne1ChunkEncryptor(params)
    const plain = await createSHA256()
    const sealed = await createSHA256()
    plain.init()
    sealed.init()
    let byteLength = 0
    const put = async (sink: { write(bytes: Uint8Array): Promise<void> }, bytes: Bytes): Promise<void> => {
      sealed.update(bytes)
      await sink.write(bytes)
      byteLength += bytes.byteLength
    }
    const slab = ZNE1_CHUNK_BYTES * ZNE1_CHUNKS_PER_READ
    await this.writeNewFile(to, async (sink) => {
      await put(sink, params.header)
      // An empty file is one empty chunk.
      if (file.size === 0) await put(sink, await loop.encryptChunk(new Uint8Array(0), true))
      for (let offset = 0; offset < file.size; offset += slab) {
        const end = Math.min(offset + slab, file.size)
        const bytes = new Uint8Array(await file.slice!(offset, end).arrayBuffer())
        plain.update(bytes)
        for (let at = 0; at < bytes.byteLength; at += ZNE1_CHUNK_BYTES) {
          const stop = Math.min(at + ZNE1_CHUNK_BYTES, bytes.byteLength)
          await put(sink, await loop.encryptChunk(bytes.subarray(at, stop), offset + stop === file.size))
        }
      }
    })
    return { byteLength, sha256: sealed.digest('hex'), plaintextByteLength: file.size, plaintextSha256: plain.digest('hex') }
  }

  /** Streams a new file into `to` through a temp file, moved into place only
   *  when `produce` finishes; anything else leaves no file behind. */
  private async writeNewFile(
    to: string,
    produce: (sink: { write(bytes: Uint8Array): Promise<void> }) => Promise<void>
  ): Promise<void> {
    const segments = splitVaultPath(to)
    if (segments.length === 0) throw new OpfsError(OPFS_IS_DIRECTORY, 'The vault root is a folder.', 'TypeMismatchError')
    for (const segment of segments) assertStorableName(segment, to)
    const parent = await this.directory(segments.slice(0, -1), true, to)
    const name = segments[segments.length - 1]!
    if (await this.child(parent, name, to)) throw new OpfsError(OPFS_EXISTS, `“${to}” already exists.`, 'InvalidModificationError')
    const tempName = `${TEMP_PREFIX}${this.randomId()}`
    let temp: OpfsFileHandle
    try {
      temp = await parent.getFileHandle(tempName, { create: true })
    } catch (error) {
      throw toOpfsError(error, to)
    }
    try {
      const sink = await this.openSink(temp, `${to}#temp`)
      try {
        await produce(sink)
      } finally {
        await sink.close()
      }
      await this.fence()
      this.closeHandlesOn(to)
      if (typeof temp.move !== 'function') {
        throw new OpfsError('ZN-OPFS-STORAGE', 'This browser cannot replace files in place.', 'NotSupportedError')
      }
      await temp.move(parent, name)
    } catch (error) {
      await parent.removeEntry(tempName).catch(() => undefined)
      throw toOpfsError(error, to)
    }
  }

  /** Writes a stub file (attachments on open). */
  async writeStub(path: string, stub: CloudStubRecord): Promise<void> {
    await this.write(path, encodeCloudStub(stub))
  }

  /**
   * Moves `from` over `to` only while `to` is still the stub `expected`, in
   * one call, so no write of this tab lands between the check and the move.
   */
  async replaceStub(from: string, to: string, expected: CloudStubRecord): Promise<boolean> {
    await this.fence()
    const current = await this.readStub(to).catch((error) => {
      if (isOpfsNotFound(error)) return null
      throw error
    })
    if (!current || !stubsEqual(current, expected)) return false
    const source = await this.locate(from)
    const target = await this.locate(to)
    if (!source?.parent || source.handle.kind !== 'file' || !target?.parent) return false
    this.closeHandlesOn(to)
    this.closeHandlesOn(from)
    if (typeof source.handle.move !== 'function') {
      throw new OpfsError('ZN-OPFS-STORAGE', 'This browser cannot move files.', 'NotSupportedError')
    }
    try {
      await source.handle.move(target.parent, target.name)
    } catch (error) {
      throw toOpfsError(error, to)
    }
    return true
  }

  /**
   * Turns a synced attachment back into its stub to free space, only while
   * the file is the one the caller checked (same size and time, the hash it
   * was read with).
   */
  async evictToStub(path: string, expected: { size: number; mtime: number; sha256: string }, stub: CloudStubRecord): Promise<boolean> {
    await this.fence()
    const before = await this.stat(path)
    if (before?.type !== 'file' || before.size !== expected.size || before.mtime !== expected.mtime) return false
    if (stub.sha256 !== expected.sha256 || stub.byte_length !== expected.size) return false
    await this.write(path, encodeCloudStub(stub))
    return true
  }

  // -------------------------------------------------------------------
  // Upkeep
  // -------------------------------------------------------------------

  private async sweepTemps(dir: OpfsDirectoryHandle): Promise<void> {
    let children: Array<[string, OpfsHandle]>
    try {
      children = await listChildren(dir)
    } catch {
      return
    }
    for (const [name, handle] of children) {
      if (handle.kind === 'file') {
        if (name.startsWith(TEMP_PREFIX)) await dir.removeEntry(name).catch(() => undefined)
      } else if (!name.startsWith(TEMP_PREFIX)) {
        await this.sweepTemps(handle)
      }
    }
  }

  /** What a closed tab left in the sync staging folders: sealed uploads and
   *  half-finished downloads. No sync is running while the vault opens. */
  private async sweepStaging(): Promise<void> {
    for (const path of STAGING_FOLDERS) {
      const found = await this.locate(path).catch(() => null)
      if (found?.handle.kind !== 'directory') continue
      for (const [name] of await listChildren(found.handle).catch(() => [] as Array<[string, OpfsHandle]>)) {
        await found.handle.removeEntry(name, { recursive: true }).catch(() => undefined)
      }
    }
  }

  /** Whether `Aa` and `aA` are one file here: create one, look up the other. */
  async probeCase(): Promise<boolean> {
    if (this.foldsCase !== null) return this.foldsCase
    const id = this.randomId()
    const created = `${TEMP_PREFIX}case-${id}-Aa`
    await this.root.getFileHandle(created, { create: true }).catch((error) => {
      throw toOpfsError(error, created)
    })
    let folds = false
    try {
      await this.root.getFileHandle(`${TEMP_PREFIX}case-${id}-aA`)
      folds = true
    } catch {
      // NotFoundError on a case-sensitive store; the iOS simulator answers
      // UnknownError here, which is no proof of folding either.
      folds = false
    } finally {
      await this.root.removeEntry(created).catch(() => undefined)
    }
    this.foldsCase = folds
    return folds
  }
}
