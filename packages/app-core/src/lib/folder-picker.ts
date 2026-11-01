import type { FolderEntry, NoteFolder, VaultSettings } from '@shared/ipc'
import { formDirContaining } from '@shared/databases'
import { normalizeTypstPreambleFolder } from '@shared/typst-preamble-folder'
import { reservedCreateFolderTop, vaultRelativeFolderPath } from './vault-layout'

/**
 * The folder picker: a text field that lists the vault's folders, narrows
 * them as you type, and still takes a typed path for a folder that does not
 * exist yet. The New note form's Folder field (#826) and the Settings fields
 * that name a folder (#1033) share it. This is the pure half: which folders a
 * field offers, in the form that field stores, and how typing narrows them.
 * Every field keeps its own validation; a row is only a faster way to type.
 */

export interface FolderChoice {
  /** The text the field takes when this row is picked. */
  value: string
  /** How the row reads. */
  label: string
}

/** How many rows the New note form shows. */
export const DEFAULT_FOLDER_PICKER_ROWS = 12

/**
 * Narrow the rows to what the field says: an exact value, then values and
 * labels that start with the text, then anything containing it. Empty text
 * lists everything, in the order the choices came in.
 */
export function filterFolderChoices<T extends FolderChoice>(
  choices: readonly T[],
  text: string,
  limit: number = DEFAULT_FOLDER_PICKER_ROWS
): T[] {
  const query = text.trim().toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!query) return choices.slice(0, limit)
  return choices
    .map((choice, index) => {
      const value = choice.value.toLowerCase()
      const label = choice.label.toLowerCase()
      const rank =
        value === query
          ? 0
          : value.startsWith(query)
            ? 1
            : label.startsWith(query)
              ? 2
              : value.includes(query) || label.includes(query)
                ? 3
                : null
      return rank === null ? null : { choice, rank, index }
    })
    .filter((entry): entry is { choice: T; rank: number; index: number } => !!entry)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.choice)
}

/**
 * The highlight after one step of the arrows (or Ctrl+N / Ctrl+P). It cycles
 * through the typed value (-1) and rows 0 to n-1, and wraps at both ends, so
 * a typed path is always one step from the first and the last row.
 */
export function stepPickerIndex(current: number, delta: number, rows: number): number {
  if (rows <= 0) return current
  const next = current + delta
  if (next < -1) return rows - 1
  if (next >= rows) return -1
  return next
}

/** Areas a picker offers, in the order the sidebar shows them. Never the Trash. */
export const PICKER_AREAS: readonly Exclude<NoteFolder, 'trash'>[] = ['inbox', 'quick', 'archive']

/** One area's subfolders, top level first, then by name. Database folders
 *  (`.base`) are left out: they hold rows, and the sidebar shows them as
 *  databases, not folders. */
export function areaSubfolders(folders: readonly FolderEntry[], area: NoteFolder): string[] {
  const seen = new Set<string>()
  return folders
    .filter((entry) => entry.folder === area && entry.subpath && !formDirContaining(entry.subpath))
    .map((entry) => entry.subpath)
    .filter((subpath) => !seen.has(subpath) && !!seen.add(subpath))
    .sort((a, b) => {
      const depth = a.split('/').length - b.split('/').length
      return depth || a.localeCompare(b)
    })
}

/**
 * Folders as their path from the vault root, the form the Task folder lists
 * and the template folder store (`inbox/Projects`, or `Projects` in a vault
 * that keeps its notes at the root). `areaRoots` also offers the areas
 * themselves (`inbox`, `archive`); the root of a vault that keeps its notes at
 * the root has no path and is never offered.
 */
export function vaultFolderPathChoices(
  folders: readonly FolderEntry[],
  settings: VaultSettings | null | undefined,
  options: { areaRoots: boolean }
): FolderChoice[] {
  const out: FolderChoice[] = []
  const seen = new Set<string>()
  const push = (area: NoteFolder, subpath: string): void => {
    const path = vaultRelativeFolderPath(area, subpath, settings)
    if (!path || seen.has(path)) return
    seen.add(path)
    out.push({ value: path, label: path })
  }
  for (const area of PICKER_AREAS) {
    if (options.areaRoots) push(area, '')
    for (const subpath of areaSubfolders(folders, area)) push(area, subpath)
  }
  return out
}

/**
 * Folders inside the primary notes area, the form the `Specific folder` and
 * Kanban folder root fields store (`Projects/Alpha`, never `inbox/…`). A folder
 * whose top would send new files somewhere else (`assets`, a hidden folder) is
 * left out, since picking it could never mean what the row says.
 */
export function primaryFolderChoices(
  folders: readonly FolderEntry[],
  settings: VaultSettings | null | undefined
): FolderChoice[] {
  return areaSubfolders(folders, 'inbox')
    .filter((subpath) => !reservedCreateFolderTop(subpath, settings))
    .map((subpath) => ({ value: subpath, label: subpath }))
}

/**
 * Folder names, for a field that stores one name matched at any depth (the
 * Typst preamble folder). Each name once, in any case, and only names the
 * field would accept.
 */
export function folderNameChoices(folders: readonly FolderEntry[]): FolderChoice[] {
  const byKey = new Map<string, string>()
  for (const area of PICKER_AREAS) {
    for (const subpath of areaSubfolders(folders, area)) {
      const name = normalizeTypstPreambleFolder(subpath.split('/').pop() ?? '')
      if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name)
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ value: name, label: name }))
}
