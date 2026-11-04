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

/** The scratch file `writeFileAtomic` renames from: `<name>.<pid>.<stamp>.tmp`.
 *  The Go server writes the same shape and both watchers filter on it, so the
 *  two must stay recognizable to each other. Requiring an epoch-length stamp is
 *  what keeps a file the user named `notes.2024.01.tmp` out of the filter:
 *  events dropped here are events no window ever hears about. */
const ATOMIC_WRITE_TEMP_PATTERN = /\.\d+\.\d{13,}\.tmp$/

export function isAtomicWriteTempPath(p: string): boolean {
  return ATOMIC_WRITE_TEMP_PATTERN.test(path.basename(p))
}

/** Same millisecond, same path, two writers: the stamp alone would name one
 *  temp file for both and let them interleave into it. */
let atomicWriteSequence = 0

/**
 * Atomically write a file: temp file + fsync + rename. The rename is atomic, so
 * readers never see a half-written file, which is what stops a note save from
 * being read back as an empty note by the watcher echo (#585). Exposed for the
 * databases feature (CSV + sidecar). No `.bak` is left behind: those files live
 * next to the user's data and are just clutter.
 *
 * A rename replaces the DIRECTORY ENTRY, so two things a plain `fs.writeFile`
 * gave for free have to be put back deliberately:
 *
 * - A symlink is written THROUGH, not over. Pointed straight at one, the rename
 *   would leave a regular file where the link was and detach it from its target
 *   for good: a note the user sees in two places becomes two files, and a
 *   `config.toml` managed by stow or chezmoi quietly stops being managed.
 * - An existing file keeps its own permissions. `fs.writeFile` only applies a
 *   mode when it creates the file, so a note someone chmod'ed to 0600 must not
 *   come back 0644 after an edit. Files this call creates are left to the
 *   default, exactly as before.
 */
export async function writeFileAtomic(absPath: string, data: string): Promise<void> {
  const target = await atomicWriteTarget(absPath)
  atomicWriteSequence = (atomicWriteSequence + 1) % 1000
  const stamp = `${Date.now()}${String(atomicWriteSequence).padStart(3, '0')}`
  const tmp = `${target}.${process.pid}.${stamp}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  const existingMode = await fs
    .stat(target)
    .then((s) => s.mode & 0o777)
    .catch(() => null)
  // 'wx' rather than 'w': a temp file that somehow already exists means another
  // writer is mid-flight, and failing the save (the note stays dirty and the
  // next save retries) beats two writers sharing one temp file.
  const handle = await fs.open(tmp, 'wx')
  try {
    try {
      await handle.writeFile(data, 'utf8')
      try {
        await handle.sync()
      } catch (syncErr) {
        console.warn('fsync failed for atomic write', syncErr)
      }
    } finally {
      await handle.close()
    }
    if (existingMode !== null) await fs.chmod(tmp, existingMode)
    await renameWithRetry(tmp, target)
  } catch (err) {
    try {
      await fs.unlink(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
}
