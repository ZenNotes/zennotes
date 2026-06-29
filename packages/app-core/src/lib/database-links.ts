/**
 * Make CSV "databases" (`<Name>.base` folders) addressable by `[[wikilinks]]`,
 * the same way notes and assets are. A database isn't a note, so it lives in a
 * separate state slice (`folders`) and needs its own enumeration + resolver;
 * the wikilink completion lists them and the click handlers open the grid. (#238)
 */
import type { FolderEntry, NoteFolder, VaultSettings } from '@shared/ipc'
import { csvPathForFormDir, formTitleFromCsvPath, isFormDirName } from '@shared/databases'
import { isPrimaryNotesAtRoot } from './vault-layout'
import { stripWikilinkAnchor } from './wikilinks'

export interface DatabaseLinkTarget {
  /** Vault-relative path of the database's `data.csv` (its identity / cache key). */
  csvPath: string
  /** Display title — the `.base` folder name without the suffix. */
  title: string
}

/** Vault-relative path of a `<folder, subpath>` directory (mirrors the sidebar). */
function vaultRelativeFolderPath(
  folder: NoteFolder,
  subpath: string,
  vaultSettings: VaultSettings
): string {
  if (folder === 'inbox' && isPrimaryNotesAtRoot(vaultSettings)) return subpath
  return subpath ? `${folder}/${subpath}` : folder
}

/**
 * Every `.base` database in the vault, derived from the folder list (a database
 * folder is listed there but never descended into — see `listFolders`). Trash is
 * excluded so deleted databases aren't offered as link targets.
 */
export function listDatabaseLinkTargets(
  folders: FolderEntry[],
  vaultSettings: VaultSettings
): DatabaseLinkTarget[] {
  const out: DatabaseLinkTarget[] = []
  for (const folder of folders) {
    if (folder.folder === 'trash') continue
    if (!isFormDirName(folder.subpath)) continue
    const csvPath = csvPathForFormDir(
      vaultRelativeFolderPath(folder.folder, folder.subpath, vaultSettings)
    )
    out.push({ csvPath, title: formTitleFromCsvPath(csvPath) })
  }
  return out
}

/**
 * Resolve a wikilink target to a database, by title (case-insensitive). Any
 * `#heading`/`^block` anchor is stripped first — databases have no anchors, but
 * this keeps resolution consistent with note links. Returns null when nothing
 * matches so callers can fall back to note resolution / link creation.
 */
export function resolveDatabaseWikilink(
  databases: DatabaseLinkTarget[],
  target: string
): DatabaseLinkTarget | null {
  const needle = stripWikilinkAnchor(target).trim().toLowerCase()
  if (!needle) return null
  return databases.find((db) => db.title.toLowerCase() === needle) ?? null
}
