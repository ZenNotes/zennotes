// The vault's template folder (#1024): a folder of ordinary notes whose every
// note is a template, the way Obsidian's core Templates plugin reads one. It
// is stored in `.zennotes/vault.json` as `templates.folder`, a vault-relative
// directory path exactly as it exists on disk (the shape of the Tasks folder
// lists), so remapped system folders (#115) need no translation and a vault
// that moves from Obsidian keeps the path it already had.
//
// Its notes are templates IN ADDITION to the built-ins and the files in
// `.zennotes/templates/`, and three things follow from what they are:
//   - a template is a placeholder for the note it will make, so its `- [ ]`
//     lines are not work and never feed Tasks (every scanner adds the folder
//     to its excluded list through `tasksFolderListsForSettings`);
//   - nobody searching their notes is looking for one, so search leaves them
//     out (Search notes brings them back once the query names the folder),
//     and their tags are not the vault's: the tag surfaces skip them too
//     (`outsideTemplateFolder`);
//   - they stay ordinary notes otherwise: they sync, they show in the sidebar,
//     and they are edited in the editor like any other note.
//
// The folder is a path rather than a name matched at any depth (the Typst
// preamble folder's shape) because a template folder is one place, and an
// Obsidian vault names it by path. A segment that starts with a dot is
// refused: hidden directories are not listed as notes on any runtime, so such
// a folder would hold no templates, and `.zennotes` is the app's own.
//
// Desktop main, the MCP server and the renderer import these helpers; the Go
// server mirrors them in internal/vault/template_folder.go. Change them
// together and keep the rules byte-compatible.

/** Longest folder path accepted, in UTF-16 code units (the Tasks lists' cap). */
export const MAX_TEMPLATE_FOLDER_LENGTH = 512

/** Validate a configured template folder: forward slashes, no empty segments
 *  kept, no traversal, no hidden segment. Returns the cleaned path, or null
 *  when the value is unusable (the vault then has no template folder). */
export function normalizeTemplateFolder(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parts: string[] = []
  for (const seg of value.replace(/\\/g, '/').split('/')) {
    const s = seg.trim()
    if (!s) continue
    // Covers `.` and `..` as well as hidden directories such as `.zennotes`.
    if (s.startsWith('.')) return null
    parts.push(s)
  }
  if (parts.length === 0) return null
  const joined = parts.join('/')
  return joined.length > MAX_TEMPLATE_FOLDER_LENGTH ? null : joined
}

/**
 * Carry `templates` through a vault.json round trip. Returns undefined when no
 * usable folder is set, so an untouched vault.json never grows an empty stub
 * (the Tasks and Typst settings normalize the same way). Only the folder is
 * kept; the object exists so later template settings can land beside it.
 */
export function normalizeTemplateFolderSettings(raw: unknown): { folder: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const folder = normalizeTemplateFolder((raw as { folder?: unknown }).folder)
  return folder ? { folder } : undefined
}

/** The template folder in effect for a vault's settings (as read off
 *  vault.json, normalized or not), or null when it has none. */
export function resolveTemplateFolder(
  settings: { templates?: unknown } | null | undefined
): string | null {
  const templates = settings?.templates
  if (!templates || typeof templates !== 'object') return null
  return normalizeTemplateFolder((templates as { folder?: unknown }).folder)
}

/** Whether a vault-relative POSIX path is inside the template folder. A
 *  whole-segment prefix match, case-sensitive like the rest of the vault
 *  layer: `Templates` holds `Templates/a.md` and `Templates/Work/b.md`, never
 *  `Templates Old/c.md`. No folder matches nothing. */
export function isPathInTemplateFolder(
  relPath: string,
  folder: string | null | undefined
): boolean {
  if (!folder) return false
  return relPath === folder || relPath.startsWith(folder + '/')
}

/**
 * The notes outside the template folder: what the vault's tag surfaces count
 * and search by tag (the tag list, the Tags view, tag completion, a database
 * field's tag options, MCP `list_tags` and `search_by_tag`, `zn tag`). A
 * template's tags are the note it will make, not the vault's, so they never
 * show as the vault's own. Title search and plain listings keep the folder,
 * and so does renaming a tag, which rewrites it inside templates too so they
 * stay in step. The same list comes back when the vault has no folder.
 */
export function outsideTemplateFolder<T extends { path: string }>(
  notes: readonly T[],
  folder: string | null | undefined
): readonly T[] {
  if (!folder) return notes
  return notes.filter((note) => !isPathInTemplateFolder(note.path, folder))
}

/** What names a note inside the template folder: its path below the folder
 *  without the `.md` extension (`Work/Standup`). Stable when the folder itself
 *  is renamed, so it is what a template-folder template's id is built from.
 *  Null for a path outside the folder. */
export function templateFolderEntryKey(relPath: string, folder: string): string | null {
  if (!folder || !relPath.startsWith(folder + '/')) return null
  const inside = relPath.slice(folder.length + 1)
  return inside ? inside.replace(/\.md$/i, '') : null
}

/** The setting after a folder rename or move: a template folder named by the
 *  renamed folder, or sitting inside it, follows it to the new path. Anything
 *  else comes back as it was (the same object). */
export function rewriteTemplateFolderForRename<T extends { folder?: string }>(
  templates: T | undefined,
  oldRel: string,
  newRel: string
): T | undefined {
  if (!templates?.folder || !oldRel || !newRel || oldRel === newRel) return templates
  const folder = templates.folder
  if (folder !== oldRel && !folder.startsWith(oldRel + '/')) return templates
  const moved = normalizeTemplateFolder(newRel + folder.slice(oldRel.length))
  if (!moved) return templates
  return { ...templates, folder: moved }
}
