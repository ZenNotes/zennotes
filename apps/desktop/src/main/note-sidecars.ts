// A note's two app-owned sidecars, and moving a note (or a folder) together
// with them. Comments live at `.zennotes/comments/<note>.comments.json` and
// the creation date at `.zennotes/note-metadata/<note>.metadata.json` (see
// note-creation-metadata.ts). Desktop main, the MCP server and the workflow
// applier all move notes, and the MCP server cannot import vault.ts (it pulls
// in Electron), so this stays free of Electron and is the one place that knows
// how a note's sidecars travel with it.
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { NOTE_COMMENTS_DIR, NOTE_COMMENTS_SUFFIX } from '@shared/note-comments'
import { noteMetadataPath, removeNoteCreation } from './note-creation-metadata'

const INTERNAL_VAULT_DIR = '.zennotes'

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/')
}

function resolveSafe(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  const rootAbs = path.resolve(root)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`Path escapes vault: ${rel}`)
  }
  return abs
}

export function noteCommentsRoot(root: string): string {
  return path.join(root, INTERNAL_VAULT_DIR, NOTE_COMMENTS_DIR)
}

export function noteCommentsPath(root: string, rel: string): string {
  return resolveSafe(noteCommentsRoot(root), `${toPosix(rel)}${NOTE_COMMENTS_SUFFIX}`)
}

/** The words a rename or move shows when an earlier note's comments sit on
 *  the destination name. Shared so every writer refuses the same way. */
export function leftoverCommentsMessage(root: string, noteAbs: string): string {
  const comments = noteCommentsPath(root, toPosix(path.relative(root, noteAbs)))
  return `Comments from an earlier note named “${path.parse(noteAbs).name}” are still in ${toPosix(path.relative(root, comments))}. Move or delete that file to use this name.`
}

/**
 * After a rename from `from` to `to`, keep a symlink pointing where it did.
 *
 * A link's relative text is read from the link's own folder, so a link moved
 * verbatim to another depth names a different file, or none: `../sources/X.md`
 * from `inbox/` becomes `inbox/sources/X.md` from `inbox/Topics/`. That is what
 * `mv` and Finder do, and it is wrong for a note, which the user expects to
 * keep reading the same file wherever it is filed. The text is re-based on the
 * target it named from the old folder, which is also what makes a rename back
 * (a rollback, an undo) land on the original text again. An absolute text
 * needs nothing; links inside a moved folder move with their folder and keep
 * resolving unless they pointed out of it, which this does not follow.
 */
export async function rebaseMovedLink(from: string, to: string): Promise<void> {
  let stats
  try {
    stats = await fs.lstat(to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stats.isSymbolicLink()) return
  const text = await fs.readlink(to)
  if (path.isAbsolute(text)) return
  const fromDir = path.dirname(from)
  const toDir = path.dirname(to)
  if (fromDir === toDir) return
  const next = path.relative(toDir, path.resolve(fromDir, text))
  if (next === text) return
  // A new link beside it, renamed over: no moment without a link at `to`.
  const temporary = `${to}_relink_tmp_${randomUUID()}`
  await fs.symlink(next, temporary)
  try {
    await fs.rename(temporary, to)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function renameDirectory(from: string, to: string): Promise<void> {
  if (from === to) return
  if (from.toLowerCase() !== to.toLowerCase()) {
    await fs.rename(from, to)
    await rebaseMovedLink(from, to)
    return
  }
  const temporary = `${from}_rename_tmp_${randomUUID()}`
  await fs.rename(from, temporary)
  try {
    await fs.rename(temporary, to)
  } catch (error) {
    try {
      await fs.rename(temporary, from)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'FOLDER_STATE_UNCERTAIN: Folder change could not be rolled back; reload the vault before editing'
      )
    }
    throw error
  }
}

export async function pathExists(abs: string): Promise<boolean> {
  return fs.lstat(abs).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    }
  )
}

/**
 * Move one note with its comments and its creation date. A creation date
 * already waiting at the destination with no note beside it belongs to
 * nobody: the note that owned it was moved or deleted outside ZenNotes (a
 * file manager, git, sync, an older ZenNotes). It is discarded, the way
 * `createNote` already discards it, or every rename and move onto that name
 * was refused for good, silently (#839). Leftover comments still refuse:
 * taking over another note's discussion and deleting it are both wrong, so
 * the error names the file to move aside.
 */
export async function relocateNote(
  root: string,
  fromRel: string,
  toAbs: string,
  persistSettings: () => Promise<unknown>
): Promise<void> {
  const toRel = toPosix(path.relative(root, toAbs))
  const toComments = noteCommentsPath(root, toRel)
  if (!(await pathExists(toAbs))) {
    if (await pathExists(toComments)) throw new Error(leftoverCommentsMessage(root, toAbs))
    await removeNoteCreation(root, toRel)
  }
  await relocateFolderTrees(
    [
      [resolveSafe(root, fromRel), toAbs],
      [noteCommentsPath(root, fromRel), toComments],
      [await noteMetadataPath(root, fromRel), await noteMetadataPath(root, toRel)]
    ],
    persistSettings
  )
}

/** Move content and its parallel comments together, retaining the originals on failure. */
export async function relocateFolderTrees(
  moves: Array<[string, string]>,
  persistSettings: () => Promise<unknown>
): Promise<void> {
  const present: Array<[string, string]> = []
  for (const [from, to] of moves) {
    let source
    try {
      source = await fs.stat(from)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      const target = await fs.stat(to)
      if (!source || source.ino !== target.ino || source.dev !== target.dev)
        throw new Error('The destination folder or its comments already exist')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (source) present.push([from, to])
  }
  const moved: Array<[string, string]> = []
  try {
    for (const [from, to] of present) {
      await fs.mkdir(path.dirname(to), { recursive: true })
      await renameDirectory(from, to)
      moved.push([from, to])
    }
    await persistSettings()
  } catch (error) {
    const failures: unknown[] = [error]
    for (const [from, to] of moved.reverse()) {
      try {
        await renameDirectory(to, from)
      } catch (rollbackError) {
        failures.push(rollbackError)
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        'FOLDER_STATE_UNCERTAIN: Folder change could not be rolled back; reload the vault before editing'
      )
    throw error
  }
}
