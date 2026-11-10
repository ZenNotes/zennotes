/**
 * The slice of the File System Access API the browser vault uses, typed here
 * rather than taken from lib.dom: `move()` is not in TypeScript's DOM types,
 * `createSyncAccessHandle()` exists only in workers, and the vitest fake
 * (test/opfs-fake.ts) implements exactly this shape and no more. Real OPFS
 * handles satisfy it structurally.
 */

export interface OpfsSyncAccessHandle {
  write(buffer: Uint8Array, options?: { at?: number }): number
  truncate(size: number): void
  getSize(): number
  flush(): void
  close(): void
}

export interface OpfsWritable {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

export interface OpfsFileSnapshot {
  readonly size: number
  readonly lastModified: number
  readonly type?: string
  arrayBuffer(): Promise<ArrayBuffer>
  slice?(start?: number, end?: number, contentType?: string): Blob
}

interface OpfsHandleBase {
  readonly name: string
  isSameEntry(other: OpfsHandle): Promise<boolean>
}

export interface OpfsFileHandle extends OpfsHandleBase {
  readonly kind: 'file'
  getFile(): Promise<OpfsFileSnapshot>
  /** Dedicated workers only. */
  createSyncAccessHandle?(): Promise<OpfsSyncAccessHandle>
  createWritable?(): Promise<OpfsWritable>
  /** Always called with two arguments: Safari refuses the one-argument form. */
  move?(destination: OpfsDirectoryHandle, name: string): Promise<void>
}

export interface OpfsDirectoryHandle extends OpfsHandleBase {
  readonly kind: 'directory'
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  entries(): AsyncIterableIterator<[string, OpfsHandle]>
}

export type OpfsHandle = OpfsFileHandle | OpfsDirectoryHandle

/** The origin's OPFS root, as this module types it. */
export async function originOpfsRoot(): Promise<OpfsDirectoryHandle> {
  return (await navigator.storage.getDirectory()) as unknown as OpfsDirectoryHandle
}
