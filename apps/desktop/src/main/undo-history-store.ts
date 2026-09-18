import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

/**
 * Where undo history lives between launches, for the people who turn on
 * "Keep undo history after quitting" (Vim's `undofile`, #793).
 *
 * The files sit under the app's own user-data folder, never in the vault: undo
 * data is a machine-local convenience, it holds fragments of text the user
 * deleted, and inside `.zennotes/` it would sync to other machines and land in
 * the history of a git-backed vault. It is the same split Vim makes between a
 * file and its entry in `undodir`.
 *
 * One file per note, named by hashes, so a note path can never steer a write
 * outside this folder no matter what the renderer sends:
 *
 *   <userData>/undo-history/<sha256(vault)[:16]>/<sha256(note path)[:32]>.json
 *
 * The content is opaque here. The renderer decides what is in it and whether
 * it still fits the note; this module only bounds how much disk it can take.
 */

export const UNDO_HISTORY_DIR = 'undo-history'
/** One note's history. Beyond this the renderer trims its oldest steps first. */
export const MAX_UNDO_HISTORY_BYTES = 2 * 1024 * 1024
/** Notes remembered per vault; the ones written longest ago go first. */
export const MAX_UNDO_HISTORY_FILES = 400
/** A history nobody came back to for this long is not coming back. */
export const MAX_UNDO_HISTORY_AGE_MS = 90 * 24 * 60 * 60 * 1000
const MAX_NOTE_PATH_LENGTH = 4096

const digest = (value: string, length: number): string =>
  createHash('sha256').update(value).digest('hex').slice(0, length)

function vaultDir(baseDir: string, vaultIdentity: string): string {
  return path.join(baseDir, UNDO_HISTORY_DIR, digest(vaultIdentity, 16))
}

/** `null` for anything that is not a plausible note path. */
export function undoHistoryFile(
  baseDir: string,
  vaultIdentity: string,
  notePath: unknown
): string | null {
  if (typeof notePath !== 'string' || notePath.length === 0) return null
  if (notePath.length > MAX_NOTE_PATH_LENGTH || notePath.includes('\0')) return null
  return path.join(vaultDir(baseDir, vaultIdentity), `${digest(notePath, 32)}.json`)
}

export async function readUndoHistory(
  baseDir: string,
  vaultIdentity: string,
  notePath: unknown
): Promise<string | null> {
  const file = undoHistoryFile(baseDir, vaultIdentity, notePath)
  if (!file) return null
  // One handle for the size check and the read. Checking the path and then
  // reading the path again would let the file be swapped in between.
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(file, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    const stat = await handle.stat()
    if (stat.size > MAX_UNDO_HISTORY_BYTES) return null
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

/** `json === null` forgets the note's history. Oversized or non-string input is dropped. */
export async function writeUndoHistory(
  baseDir: string,
  vaultIdentity: string,
  notePath: unknown,
  json: unknown
): Promise<void> {
  const file = undoHistoryFile(baseDir, vaultIdentity, notePath)
  if (!file) return
  if (json === null) {
    await fsp.rm(file, { force: true })
    return
  }
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_UNDO_HISTORY_BYTES) return
  await fsp.mkdir(path.dirname(file), { recursive: true })
  // Written beside the target and renamed over it: a quit in the middle of a
  // write must not leave half a file for the next launch to parse.
  const partial = `${file}.${process.pid}.tmp`
  await fsp.writeFile(partial, json, 'utf8')
  await fsp.rename(partial, file)
}

/** Everything, for every vault: what turning the setting off promises. */
export async function clearUndoHistories(baseDir: string): Promise<void> {
  await fsp.rm(path.join(baseDir, UNDO_HISTORY_DIR), { recursive: true, force: true })
}

/**
 * Keep the folder bounded: drop histories older than the age limit, then the
 * oldest ones beyond the per-vault count, and any stray partial writes. Cheap
 * enough to run once per launch.
 */
export async function pruneUndoHistories(baseDir: string, now: number = Date.now()): Promise<void> {
  const root = path.join(baseDir, UNDO_HISTORY_DIR)
  let vaults: string[]
  try {
    vaults = await fsp.readdir(root)
  } catch {
    return
  }
  for (const vault of vaults) {
    const dir = path.join(root, vault)
    let names: string[]
    try {
      names = await fsp.readdir(dir)
    } catch {
      continue
    }
    const kept: Array<{ file: string; mtimeMs: number }> = []
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        const stat = await fsp.stat(file)
        const expired = now - stat.mtimeMs > MAX_UNDO_HISTORY_AGE_MS
        if (!name.endsWith('.json') || expired) await fsp.rm(file, { force: true })
        else kept.push({ file, mtimeMs: stat.mtimeMs })
      } catch {
        /* raced with a write or a clear; the next launch sees the result */
      }
    }
    kept.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const { file } of kept.slice(MAX_UNDO_HISTORY_FILES)) {
      await fsp.rm(file, { force: true }).catch(() => undefined)
    }
    if (kept.length === 0) await fsp.rmdir(dir).catch(() => undefined)
  }
}
