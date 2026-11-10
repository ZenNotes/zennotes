/**
 * The errors the browser vault speaks. A worker cannot post an Error with its
 * prototype intact, so every failure crosses as `{ name, message, code }` and
 * is rebuilt on the page with the same code. The code is what callers test:
 * `ZN-OPFS-NOT-FOUND` is the only failure that may read as absence (the
 * VaultFileSystem contract in @zennotes/portable-vault), and everything else
 * a storage failure that must not.
 */

export const OPFS_NOT_FOUND = 'ZN-OPFS-NOT-FOUND'
export const OPFS_EXISTS = 'ZN-OPFS-EXISTS'
export const OPFS_NOT_EMPTY = 'ZN-OPFS-NOT-EMPTY'
export const OPFS_IS_DIRECTORY = 'ZN-OPFS-IS-DIRECTORY'
export const OPFS_NOT_DIRECTORY = 'ZN-OPFS-NOT-DIRECTORY'
export const OPFS_BAD_NAME = 'ZN-OPFS-NAME'
export const OPFS_FENCED = 'ZN-OPFS-FENCED'
export const OPFS_QUOTA = 'ZN-OPFS-QUOTA'
export const OPFS_STORAGE = 'ZN-OPFS-STORAGE'
export const OPFS_CLOSED = 'ZN-OPFS-CLOSED'
/** A Cloud stub where bytes were asked for (copying one); `path` names it. */
export const OPFS_STUB = 'ZN-OPFS-STUB'
/** The package's code for a signed download or upload that failed; `status`
 *  is the storage host's answer, absent when none came. */
export const DIRECT_TRANSFER_FAILED = 'DIRECT_DOWNLOAD_FAILED'

export interface OpfsErrorShape {
  name: string
  message: string
  code: string
  status?: number
  path?: string
}

export class OpfsError extends Error {
  readonly code: string
  status?: number
  path?: string
  constructor(code: string, message: string, name = 'OpfsError', extra: { status?: number; path?: string } = {}) {
    super(message)
    this.code = code
    this.name = name
    if (extra.status !== undefined) this.status = extra.status
    if (extra.path !== undefined) this.path = extra.path
  }
}

export function notFound(path: string): OpfsError {
  return new OpfsError(OPFS_NOT_FOUND, `Not found in this browser's vault: ${path || '/'}`, 'NotFoundError')
}

/**
 * A DOMException (or anything thrown by the file system API) as one of the
 * codes above. NotFoundError is the only DOM failure that means "absent";
 * TypeMismatchError means the entry exists as the other kind, which callers
 * answer on their own before reaching here.
 */
export function toOpfsError(error: unknown, path = ''): OpfsError {
  if (error instanceof OpfsError) return error
  const name = (error as { name?: unknown } | null)?.name
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'NotFoundError') return notFound(path)
  if (name === 'QuotaExceededError') {
    return new OpfsError(OPFS_QUOTA, 'This browser has no room left for the vault.', 'QuotaExceededError')
  }
  if (name === 'TypeMismatchError') {
    return new OpfsError(OPFS_NOT_DIRECTORY, `${path || '/'} is not the kind of entry expected (${message})`, 'TypeMismatchError')
  }
  return new OpfsError(OPFS_STORAGE, message || 'The browser storage did not answer.', typeof name === 'string' ? name : 'Error')
}

export function serializeOpfsError(error: unknown): OpfsErrorShape {
  const opfs = toOpfsError(error)
  return {
    name: opfs.name,
    message: opfs.message,
    code: opfs.code,
    ...(opfs.status !== undefined ? { status: opfs.status } : {}),
    ...(opfs.path !== undefined ? { path: opfs.path } : {})
  }
}

export function deserializeOpfsError(shape: OpfsErrorShape): OpfsError {
  return new OpfsError(shape.code, shape.message, shape.name, { status: shape.status, path: shape.path })
}

export function isOpfsNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === OPFS_NOT_FOUND
}
