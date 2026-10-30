import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { NoteFolder, NoteMeta } from '@shared/ipc'
import { parseTaskFile, parseTasksFromBody, type VaultTask } from '@shared/tasks'
import { isPathExcludedFromTasks, tasksFolderListsForSettings } from '@shared/tasks-excluded-folders'
import { folderForRelativePath, getVaultSettings, listNotes } from './vault'

/** Emit a note's file-task (if its frontmatter tags it `#task`) plus every
 *  inline `- [ ]` checkbox in its body. The file-task comes first so it heads
 *  the note's group in the Tasks list. */
function parseAllTasks(
  body: string,
  ctx: { path: string; title: string; folder: NoteFolder }
): VaultTask[] {
  const fileTask = parseTaskFile(body, ctx)
  const inline = parseTasksFromBody(body, ctx)
  return fileTask ? [fileTask, ...inline] : inline
}

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
  return parseAllTasks(body, {
    path: meta.path,
    title: meta.title,
    folder: meta.folder
  })
}

/** Walk the whole vault and parse every task out of every live (non-trash)
 *  note. Parallelized with `Promise.all` so a 500-note vault is IO-bound,
 *  not sequentially latent. Folders on the vault's `tasks.excludedFolders`
 *  list (#458), every folder outside its Task folders once
 *  `tasks.includedFolders` names any (#962), and the template folder, whose
 *  checkboxes are placeholders (#1024), are skipped before any file is read. */
export async function scanAllTasks(root: string): Promise<VaultTask[]> {
  const { excluded, included } = tasksFolderListsForSettings(await getVaultSettings(root))
  const metas = (await listNotes(root)).filter(
    (m) => includesFolder(m.folder) && !isPathExcludedFromTasks(m.path, excluded, included)
  )
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
  // Settings-aware: with remapped system folders (vault.json
  // `systemFolderPaths`) the bare classifier would file a remapped Trash's
  // notes under inbox and leak their checkboxes into the Tasks view.
  const settings = await getVaultSettings(root)
  const folder = folderForRelativePath(posix, settings)
  if (!folder || !LIVE_FOLDERS.has(folder)) return []
  // Same folder lists the full scan applies (#458, #962, #1024), or a
  // single-note rescan would resurrect a left-out folder's tasks on every edit.
  const { excluded, included } = tasksFolderListsForSettings(settings)
  if (isPathExcludedFromTasks(posix, excluded, included)) {
    return []
  }

  const abs = path.join(root, posix.split('/').join(path.sep))
  let body: string
  try {
    body = await fs.readFile(abs, 'utf8')
  } catch {
    return []
  }
  const title = path.basename(posix, path.extname(posix))
  return parseAllTasks(body, { path: posix, title, folder })
}
