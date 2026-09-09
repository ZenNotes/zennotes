import { promises as fs } from 'node:fs'
import path from 'node:path'

const ATOMIC_RENAME_ATTEMPTS = 20

function transientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY'
}

/** Wait out a reader that temporarily denies replacing the destination. */
export async function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => Promise<void> = fs.rename,
  pause: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs))
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= ATOMIC_RENAME_ATTEMPTS || !transientRenameError(error)) throw error
      await pause(Math.min(2 ** (attempt - 1), 25))
    }
  }
}

/** Follow a symlink to the file it points at, so an atomic write lands on the
 *  target instead of replacing the link. A dangling link resolves to the path
 *  it names, which is where a plain write would have created the file. */
export async function atomicWriteTarget(absPath: string): Promise<string> {
  let stats
  try {
    stats = await fs.lstat(absPath)
  } catch {
    return absPath
  }
  if (!stats.isSymbolicLink()) return absPath
  try {
    return await fs.realpath(absPath)
  } catch {
    return path.resolve(path.dirname(absPath), await fs.readlink(absPath))
  }
}

