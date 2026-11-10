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
  notFound,
  OPFS_EXISTS,
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
  OpfsHandle,
  OpfsSyncAccessHandle
} from './opfs-handles'
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

  /** Copies a file over whatever is at the target, or a folder into a new one. */
  async copy(from: string, to: string): Promise<void> {
    await this.fence()
    const source = await this.locate(from)
    if (!source) throw notFound(from)
    if (source.handle.kind === 'file') {
      await this.write(to, await this.read(from))
      return
    }
    await this.mkdir(to)
    for (const entry of await this.list(from)) {
      await this.copy(`${from}/${entry.name}`, `${to}/${entry.name}`)
    }
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
