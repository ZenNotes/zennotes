import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { NoteFolder, NoteMeta } from '@shared/ipc'
import { parseTasksFromBody, type VaultTask } from '@shared/tasks'
import { folderForRelativePath, listNotes } from './vault'

// Trash is excluded — trashed notes should never surface as live tasks.
function includesFolder(folder: NoteFolder): boolean {
  return folder !== 'trash'
}

async function readOne(
  root: string,
  meta: NoteMeta
): Promise<VaultTask[]> {
  const abs = path.join(root, meta.path.split('/').join(path.sep))
  let body: string
  try {
    body = await fs.readFile(abs, 'utf8')
  } catch {
    return []
  }
  return parseTasksFromBody(body, {
    path: meta.path,
    title: meta.title,
    folder: meta.folder
  })
}

/** Walk the whole vault and parse every task out of every live (non-trash)
 *  note. Parallelized with `Promise.all` so a 500-note vault is IO-bound,
 *  not sequentially latent. */
export async function scanAllTasks(root: string): Promise<VaultTask[]> {
  const metas = (await listNotes(root)).filter((m) => includesFolder(m.folder))
  const batches = await Promise.all(metas.map((m) => readOne(root, m)))
  const out: VaultTask[] = []
  for (const b of batches) out.push(...b)
  return out
}

const LIVE_FOLDERS = new Set<NoteFolder>(['inbox', 'quick', 'archive'])

/** Rescan a single note's tasks. Derives folder from the first path segment
 *  so we don't re-walk the vault for one file change. Returns an empty array
 *  if the file is missing or lives outside a live folder — the caller still
 *  uses the return to drop stale rows. */
export async function scanTasksForPath(
  root: string,
  relPath: string
): Promise<VaultTask[]> {
  const posix = relPath.split(path.sep).join('/')
  const folder = folderForRelativePath(posix)
  if (!folder || !LIVE_FOLDERS.has(folder)) return []

  const abs = path.join(root, posix.split('/').join(path.sep))
  let body: string
  try {
    body = await fs.readFile(abs, 'utf8')
  } catch {
    return []
  }
  const title = path.basename(posix, path.extname(posix))
  return parseTasksFromBody(body, { path: posix, title, folder })
}
