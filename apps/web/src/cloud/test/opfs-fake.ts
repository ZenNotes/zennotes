/**
 * An in-memory OPFS with each engine's quirks as the November 10 spikes
 * measured them (cloud-in-browser-spike-results.md, section 1), so the
 * browser host's tests run the store against Chrome, Firefox and Safari:
 *
 * - Chrome: no `move()` on folders; a backslash in a name is refused.
 * - Firefox: a folder moved onto an existing one replaces it.
 * - Safari (macOS): names fold case and Unicode normalization; a name over
 *   255 UTF-8 bytes fails with UnknownError; `move()` replaces a file even
 *   while another sync handle has it open; folders moved onto existing ones
 *   merge; `isSameEntry` compares the paths the two handles were opened with,
 *   so one file reached under two spellings is not "the same entry" (seen in
 *   Safari 27.2, cloud-in-browser-safari-report.md failure A).
 * - Every engine: `move(dir, name)` replaces an existing file; a second sync
 *   handle on one file is refused; a handle follows its file after a move.
 *
 * `breakStorage` makes every call fail the way storage fails (not with
 * NotFoundError); `failNextSyncWrite` makes the next sync-handle write throw
 * after writing half its bytes; `failMoveAfter(n)` lets n more file moves
 * succeed and fails the next.
 */
import type {
  OpfsDirectoryHandle,
  OpfsFileHandle,
  OpfsFileSnapshot,
  OpfsHandle,
  OpfsSyncAccessHandle
} from '../opfs-handles'

export type FakeEngine = 'chrome' | 'firefox' | 'safari'

interface FileNode {
  kind: 'file'
  name: string
  bytes: Uint8Array
  mtime: number
  parent: DirNode | null
  syncOpen: boolean
}

interface DirNode {
  kind: 'directory'
  name: string
  children: Map<string, FileNode | DirNode>
  parent: DirNode | null
}

type Node = FileNode | DirNode

const encoder = new TextEncoder()

function domError(name: string, message = name): DOMException {
  return new DOMException(message, name)
}

export class FakeOpfs {
  readonly root: OpfsDirectoryHandle
  private readonly rootNode: DirNode = { kind: 'directory', name: '', children: new Map(), parent: null }
  private outage: unknown = null
  private failSyncWrite = false
  private movesLeft: number | null = null
  private clock = 1_000
  moveCalls = 0

  constructor(readonly engine: FakeEngine) {
    this.root = this.dirHandle(this.rootNode, '')
  }

  breakStorage(error: unknown = domError('InvalidStateError', 'The storage is not answering.')): void {
    this.outage = error
  }

  restoreStorage(): void {
    this.outage = null
  }

  failNextSyncWrite(): void {
    this.failSyncWrite = true
  }

  failMoveAfter(moves: number): void {
    this.movesLeft = moves
  }

  /** Every path in the tree, folders with a trailing slash, as stored. */
  paths(node: DirNode = this.rootNode, prefix = ''): string[] {
    const out: string[] = []
    for (const child of node.children.values()) {
      const path = `${prefix}${child.name}`
      if (child.kind === 'directory') out.push(`${path}/`, ...this.paths(child, `${path}/`))
      else out.push(path)
    }
    return out.sort()
  }

  openSyncHandles(node: DirNode = this.rootNode): number {
    let count = 0
    for (const child of node.children.values()) {
      if (child.kind === 'directory') count += this.openSyncHandles(child)
      else if (child.syncOpen) count += 1
    }
    return count
  }

  private key(name: string): string {
    return this.engine === 'safari' ? name.normalize('NFC').toLowerCase() : name
  }

  private enter(): void {
    if (this.outage) throw this.outage
  }

  private checkName(name: string, creating: boolean): void {
    if (!name || name === '.' || name === '..' || name.includes('/')) throw new TypeError(`Name is not allowed: ${name}`)
    if (this.engine === 'chrome' && name.includes('\\')) throw new TypeError(`Name is not allowed: ${name}`)
    if (creating && this.engine === 'safari' && encoder.encode(name).byteLength > 255) {
      throw domError('UnknownError', 'The operation failed for an unknown transient reason')
    }
  }

  /** Whether two handles are the same entry, as this engine answers it. */
  private same(node: Node, path: string, other: OpfsHandle): boolean {
    const theirs = other as unknown as { __node?: Node; __path?: string }
    return this.engine === 'safari' ? theirs.__path === path : theirs.__node === node
  }

  private dirHandle(node: DirNode, path: string): OpfsDirectoryHandle {
    const fake = this
    const at = (name: string): string => (path ? `${path}/${name}` : name)
    const handle: OpfsDirectoryHandle & { move?: (dir: OpfsDirectoryHandle, name: string) => Promise<void> } = {
      kind: 'directory',
      get name() {
        return node.name
      },
      async isSameEntry(other: OpfsHandle) {
        return fake.same(node, path, other)
      },
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        fake.enter()
        fake.checkName(name, !!options?.create)
        const found = node.children.get(fake.key(name))
        if (found) {
          if (found.kind !== 'directory') throw domError('TypeMismatchError')
          return fake.dirHandle(found, at(name))
        }
        if (!options?.create) throw domError('NotFoundError')
        const created: DirNode = { kind: 'directory', name, children: new Map(), parent: node }
        node.children.set(fake.key(name), created)
        return fake.dirHandle(created, at(name))
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        fake.enter()
        fake.checkName(name, !!options?.create)
        const found = node.children.get(fake.key(name))
        if (found) {
          if (found.kind !== 'file') throw domError('TypeMismatchError')
          return fake.fileHandle(found, at(name))
        }
        if (!options?.create) throw domError('NotFoundError')
        const created: FileNode = { kind: 'file', name, bytes: new Uint8Array(), mtime: (fake.clock += 1), parent: node, syncOpen: false }
        node.children.set(fake.key(name), created)
        return fake.fileHandle(created, at(name))
      },
      async removeEntry(name: string, options?: { recursive?: boolean }) {
        fake.enter()
        const found = node.children.get(fake.key(name))
        if (!found) throw domError('NotFoundError')
        if (found.kind === 'directory' && found.children.size > 0 && !options?.recursive) {
          throw domError('InvalidModificationError')
        }
        if (found.kind === 'file' && found.syncOpen) throw domError('NoModificationAllowedError')
        node.children.delete(fake.key(name))
        found.parent = null
      },
      async *entries(): AsyncIterableIterator<[string, OpfsHandle]> {
        fake.enter()
        for (const child of [...node.children.values()]) {
          yield [child.name, child.kind === 'directory' ? fake.dirHandle(child, at(child.name)) : fake.fileHandle(child, at(child.name))]
        }
      }
    }
    Object.defineProperty(handle, '__node', { value: node })
    Object.defineProperty(handle, '__path', { value: path })
    if (this.engine !== 'chrome') {
      handle.move = async (destination, name) => {
        fake.enter()
        const target = (destination as unknown as { __node: DirNode }).__node
        const existing = target.children.get(fake.key(name))
        if (existing && existing !== node) {
          if (fake.engine === 'firefox') target.children.delete(fake.key(name))
          else if (existing.kind === 'directory') {
            for (const [key, child] of node.children) {
              existing.children.set(key, child)
              child.parent = existing
            }
            node.parent?.children.delete(fake.key(node.name))
            return
          }
        }
        node.parent?.children.delete(fake.key(node.name))
        node.name = name
        node.parent = target
        target.children.set(fake.key(name), node)
      }
    }
    return handle
  }

  private fileHandle(node: FileNode, path: string): OpfsFileHandle {
    const fake = this
    const handle: OpfsFileHandle = {
      kind: 'file',
      get name() {
        return node.name
      },
      async isSameEntry(other: OpfsHandle) {
        return fake.same(node, path, other)
      },
      async getFile(): Promise<OpfsFileSnapshot> {
        fake.enter()
        if (!node.parent) throw domError('NotFoundError')
        return new File([node.bytes.slice()], node.name, { lastModified: node.mtime })
      },
      async createSyncAccessHandle(): Promise<OpfsSyncAccessHandle> {
        fake.enter()
        if (node.syncOpen) throw domError(fake.engine === 'safari' ? 'InvalidStateError' : 'NoModificationAllowedError')
        node.syncOpen = true
        let open = true
        const guard = (): void => {
          if (!open) throw domError('InvalidStateError', 'The access handle was closed')
        }
        return {
          write(buffer, options) {
            guard()
            const at = options?.at ?? 0
            let chunk = buffer
            const failing = fake.failSyncWrite
            if (failing) {
              fake.failSyncWrite = false
              chunk = buffer.subarray(0, Math.floor(buffer.byteLength / 2))
            }
            const next = new Uint8Array(Math.max(node.bytes.byteLength, at + chunk.byteLength))
            next.set(node.bytes)
            next.set(chunk, at)
            node.bytes = next
            node.mtime = fake.clock += 1
            if (failing) throw domError('QuotaExceededError', 'The disk is full')
            return chunk.byteLength
          },
          truncate(size) {
            guard()
            node.bytes = node.bytes.slice(0, size)
          },
          getSize() {
            guard()
            return node.bytes.byteLength
          },
          flush() {
            guard()
          },
          close() {
            if (open) node.syncOpen = false
            open = false
          }
        }
      },
      async move(destination: OpfsDirectoryHandle, name: string) {
        fake.enter()
        fake.moveCalls += 1
        if (fake.movesLeft !== null) {
          if (fake.movesLeft <= 0) {
            fake.movesLeft = null
            throw domError('InvalidStateError', 'The move was interrupted')
          }
          fake.movesLeft -= 1
        }
        if (node.syncOpen) throw domError('NoModificationAllowedError')
        fake.checkName(name, true)
        const target = (destination as unknown as { __node: DirNode }).__node
        const existing = target.children.get(fake.key(name))
        if (existing && existing !== node) {
          if (existing.kind === 'directory') throw domError('InvalidModificationError')
          if (existing.syncOpen && fake.engine !== 'safari') throw domError('NoModificationAllowedError')
          existing.parent = null
          target.children.delete(fake.key(name))
        }
        node.parent?.children.delete(fake.key(node.name))
        node.name = name
        node.parent = target
        target.children.set(fake.key(name), node)
      }
    }
    Object.defineProperty(handle, '__node', { value: node })
    Object.defineProperty(handle, '__path', { value: path })
    return handle
  }
}
