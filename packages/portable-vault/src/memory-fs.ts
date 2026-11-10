/**
 * A VaultFileSystem held in memory: the test double for every host, shaped
 * after the phones' NativeFs over Capacitor Filesystem so a test that passes
 * here exercises the behavior a phone sees. What it copies on purpose:
 *
 * - writes create their parent folders (Capacitor's `recursive: true`);
 * - a rename into a folder that does not exist fails, and so does a rename
 *   over an existing file or folder (sync relies on both);
 * - reading or deleting a missing file throws a not-found error carrying
 *   Capacitor's iOS code, which isNotFound recognizes, and nothing else does;
 * - `readdir` answers [] for a missing folder and `readdirStrict` throws;
 * - every change moves `writeGeneration` before and after.
 *
 * `failNext` makes the next call of one method throw, for the failure paths
 * (a write that fails between two steps must leave the vault as it was), and
 * `breakStorage` makes every call throw until `restoreStorage`, the outage the
 * VaultFileSystem contract (vault-fs-contract.ts) runs against.
 */
import { base64ToBytes, bytesToBase64 } from './base64'
import type { PortableVaultFiles, VaultDirEntry, VaultStat } from './host'

interface MemoryFile {
  bytes: Uint8Array
  mtime: number
  ctime: number
}

export const MEMORY_NOT_FOUND_CODE = 'OS-PLUG-FILE-0008'

export class MemoryNotFoundError extends Error {
  readonly code = MEMORY_NOT_FOUND_CODE
  constructor(path: string) {
    super(`File does not exist: ${path || '/'}`)
    this.name = 'MemoryNotFoundError'
  }
}

type MethodName = keyof PortableVaultFiles

function normalize(path: string): string {
  return path.split('/').filter((segment) => segment && segment !== '.').join('/')
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

export class MemoryVaultFileSystem implements PortableVaultFiles {
  readonly files = new Map<string, MemoryFile>()
  readonly directories = new Set<string>([''])
  readonly calls = new Map<string, number>()
  writeGeneration = 0
  clock = 1_000
  private failures = new Map<string, unknown>()
  private outage: unknown = undefined

  constructor(
    readonly syncKey = 'memory/vault',
    readonly rootLabel = 'memory://vault'
  ) {}

  /** Seeds a file without counting it as a change the vault made. */
  put(path: string, body: string | Uint8Array, mtime?: number): void {
    const rel = normalize(path)
    this.ensureParents(rel)
    const time = mtime ?? (this.clock += 1)
    this.files.set(rel, { bytes: typeof body === 'string' ? encoder.encode(body) : body, mtime: time, ctime: time })
  }

  text(path: string): string | undefined {
    const file = this.files.get(normalize(path))
    return file ? decoder.decode(file.bytes) : undefined
  }

  failNext(method: MethodName, error: unknown = new Error(`${String(method)} failed`)): void {
    this.failures.set(String(method), error)
  }

  breakStorage(error: unknown = new Error('The storage is not answering.')): void {
    this.outage = error
  }

  restoreStorage(): void {
    this.outage = undefined
  }

  private enter(method: MethodName): void {
    this.calls.set(String(method), (this.calls.get(String(method)) ?? 0) + 1)
    if (this.outage !== undefined) throw this.outage
    const failure = this.failures.get(String(method))
    if (failure !== undefined) {
      this.failures.delete(String(method))
      throw failure
    }
  }

  private async changing<T>(change: () => T): Promise<T> {
    this.writeGeneration += 1
    try {
      return change()
    } finally {
      this.writeGeneration += 1
    }
  }

  private ensureParents(rel: string): void {
    let parent = parentOf(rel)
    while (parent && !this.directories.has(parent)) {
      this.directories.add(parent)
      parent = parentOf(parent)
    }
  }

  private isDirectory(rel: string): boolean {
    return this.directories.has(rel)
  }

  async init(): Promise<void> {
    this.enter('init')
  }

  isNotFound(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === MEMORY_NOT_FOUND_CODE
  }

  fileSrc(relPath: string): string | null {
    return `memory://vault/${normalize(relPath).split('/').map(encodeURIComponent).join('/')}`
  }

  async readText(relPath: string): Promise<string> {
    this.enter('readText')
    const file = this.files.get(normalize(relPath))
    if (!file) throw new MemoryNotFoundError(relPath)
    return decoder.decode(file.bytes)
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
    this.enter('readBase64')
    const file = this.files.get(normalize(relPath))
    if (!file) throw new MemoryNotFoundError(relPath)
    return bytesToBase64(file.bytes)
  }

  async writeText(relPath: string, body: string): Promise<void> {
    this.enter('writeText')
    await this.changing(() => this.put(relPath, body))
  }

  async writeBase64(relPath: string, base64Data: string): Promise<void> {
    this.enter('writeBase64')
    await this.changing(() => this.put(relPath, base64ToBytes(base64Data)))
  }

  async statOrNull(relPath: string): Promise<VaultStat | null> {
    this.enter('statOrNull')
    const rel = normalize(relPath)
    const file = this.files.get(rel)
    if (file) return { type: 'file', size: file.bytes.byteLength, mtime: file.mtime, ctime: file.ctime, uri: this.fileSrc(rel) ?? undefined }
    if (this.isDirectory(rel)) return { type: 'directory', size: 0, mtime: 0, ctime: null, uri: this.fileSrc(rel) ?? undefined }
    return null
  }

  async statVerified(relPath: string): Promise<'file' | 'directory' | null> {
    this.enter('statVerified')
    const rel = normalize(relPath)
    if (this.files.has(rel)) return 'file'
    return this.isDirectory(rel) ? 'directory' : null
  }

  async readdir(relPath: string): Promise<VaultDirEntry[]> {
    try {
      return await this.readdirStrict(relPath)
    } catch {
      return []
    }
  }

  async readdirStrict(relPath: string): Promise<VaultDirEntry[]> {
    this.enter('readdirStrict')
    const rel = normalize(relPath)
    if (!this.isDirectory(rel)) throw new MemoryNotFoundError(relPath)
    const prefix = rel ? `${rel}/` : ''
    const entries = new Map<string, VaultDirEntry>()
    for (const dir of this.directories) {
      if (!dir.startsWith(prefix) || dir === rel) continue
      const name = dir.slice(prefix.length).split('/')[0]!
      if (!entries.has(name)) entries.set(name, { name, type: 'directory', size: 0, mtime: 0, uri: this.fileSrc(`${prefix}${name}`) ?? undefined })
    }
    for (const [path, file] of this.files) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (rest.includes('/')) continue
      entries.set(rest, { name: rest, type: 'file', size: file.bytes.byteLength, mtime: file.mtime, ctime: file.ctime, uri: this.fileSrc(path) ?? undefined })
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async mkdir(relPath: string): Promise<void> {
    this.enter('mkdir')
    const rel = normalize(relPath)
    await this.changing(() => {
      if (this.files.has(rel)) throw new Error(`A file exists at ${rel}`)
      this.ensureParents(`${rel}/x`)
    })
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    this.enter('rename')
    const from = normalize(fromRel)
    const to = normalize(toRel)
    await this.changing(() => {
      if (!this.isDirectory(parentOf(to))) throw new MemoryNotFoundError(parentOf(to))
      const file = this.files.get(from)
      if (file) {
        if (this.files.has(to) && to.toLowerCase() !== from.toLowerCase()) throw new Error(`Destination exists: ${to}`)
        this.files.delete(from)
        this.files.set(to, file)
        return
      }
      if (!this.isDirectory(from) || from === '') throw new MemoryNotFoundError(fromRel)
      // A device refuses to move a folder onto one that exists; merging the
      // two trees here would hide a vault that tried.
      if (this.isDirectory(to) && to.toLowerCase() !== from.toLowerCase()) throw new Error(`Destination exists: ${to}`)
      this.moveTree(from, to, true)
    })
  }

  async copy(fromRel: string, toRel: string): Promise<void> {
    this.enter('copy')
    const from = normalize(fromRel)
    const to = normalize(toRel)
    await this.changing(() => {
      const file = this.files.get(from)
      if (file) {
        this.ensureParents(to)
        const time = (this.clock += 1)
        this.files.set(to, { bytes: file.bytes.slice(), mtime: time, ctime: time })
        return
      }
      if (!this.isDirectory(from)) throw new MemoryNotFoundError(fromRel)
      this.moveTree(from, to, false)
    })
  }

  private moveTree(from: string, to: string, removeSource: boolean): void {
    const prefix = `${from}/`
    for (const dir of [...this.directories]) {
      if (dir !== from && !dir.startsWith(prefix)) continue
      this.directories.add(to + dir.slice(from.length))
      if (removeSource) this.directories.delete(dir)
    }
    for (const [path, file] of [...this.files]) {
      if (!path.startsWith(prefix)) continue
      const target = to + path.slice(from.length)
      this.files.set(target, removeSource ? file : { ...file, bytes: file.bytes.slice() })
      if (removeSource) this.files.delete(path)
    }
    this.ensureParents(`${to}/x`)
  }

  async deleteFile(relPath: string): Promise<void> {
    this.enter('deleteFile')
    const rel = normalize(relPath)
    await this.changing(() => {
      if (!this.files.delete(rel)) throw new MemoryNotFoundError(relPath)
    })
  }

  async rmdir(relPath: string): Promise<void> {
    this.enter('rmdir')
    const rel = normalize(relPath)
    await this.changing(() => {
      if (!this.isDirectory(rel) || rel === '') throw new MemoryNotFoundError(relPath)
      const prefix = `${rel}/`
      for (const path of [...this.files.keys()]) if (path.startsWith(prefix)) this.files.delete(path)
      for (const dir of [...this.directories]) if (dir === rel || dir.startsWith(prefix)) this.directories.delete(dir)
    })
  }

  async rmdirIfEmpty(relPath: string): Promise<void> {
    this.enter('rmdirIfEmpty')
    const rel = normalize(relPath)
    await this.changing(() => {
      if (!this.isDirectory(rel) || rel === '') throw new MemoryNotFoundError(relPath)
      const prefix = `${rel}/`
      const occupied = [...this.files.keys()].some((path) => path.startsWith(prefix)) ||
        [...this.directories].some((dir) => dir.startsWith(prefix))
      if (occupied) throw new Error(`Folder is not empty: ${rel}`)
      this.directories.delete(rel)
    })
  }

  async exists(relPath: string): Promise<boolean> {
    return (await this.statOrNull(relPath)) !== null
  }
}
