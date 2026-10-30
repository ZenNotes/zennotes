// The vault-level folder lists for Tasks. `tasks.excludedFolders` (#458) keeps
// folders out; `tasks.includedFolders`, the Task folders (#962), narrows Tasks
// to the folders it names, and an empty list means the whole vault. Both live
// in `.zennotes/vault.json` as vault-relative directory paths exactly as they
// exist on disk, so remapped system folders (#115) need no translation: every
// scanner matches against a note's real relative path. Desktop main, the MCP
// server, and the iPhone bridge all import these helpers; the Go server
// mirrors them in internal/vault/tasks_exclude.go and the Go CLI in
// internal/vault/settings.go: change them together and keep the rules
// byte-compatible.

import { resolveTemplateFolder } from './template-folder'

/** Validate one excluded-folder entry: forward slashes, no empty or dot
 *  segments, no traversal. Returns the cleaned path or null when invalid. */
export function normalizeTasksExcludedFolder(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parts: string[] = []
  for (const seg of value.replace(/\\/g, '/').split('/')) {
    const s = seg.trim()
    if (!s) continue
    if (s === '.' || s === '..') return null
    parts.push(s)
  }
  if (parts.length === 0) return null
  const joined = parts.join('/')
  return joined.length > 512 ? null : joined
}

/** Normalize the whole list: invalid entries drop, duplicates collapse,
 *  order is preserved. Never throws; a malformed vault.json value yields []. */
export function normalizeTasksExcludedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const cleaned = normalizeTasksExcludedFolder(entry)
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
  }
  return out
}

/** The Task folders list (#962) is validated exactly like the excluded one. */
export const normalizeTasksIncludedFolder = normalizeTasksExcludedFolder
export const normalizeTasksIncludedFolders = normalizeTasksExcludedFolders

/** Whether a vault-relative POSIX path is kept out of Tasks by the folder
 *  lists. Segment-prefix match, case-sensitive like the rest of the vault
 *  layer: `inbox/Books` excludes `inbox/Books/x.md` and `inbox/Books/sub/y.md`,
 *  never `inbox/Bookshelf.md`. Once `included` names folders, a path outside
 *  all of them is out as well; `excluded` still applies inside them, so
 *  `Projects` with `Projects/Archive` excluded leaves the archive out. A caller
 *  that passes no `included` list gets the exclusion rule alone. */
export function isPathExcludedFromTasks(
  relPath: string,
  excluded: readonly string[],
  included: readonly string[] = []
): boolean {
  if (included.length > 0 && !isInsideAnyFolder(relPath, included)) return true
  return isInsideAnyFolder(relPath, excluded)
}

/**
 * The folder lists every Tasks scanner applies, read off vault settings (raw
 * or normalized): the excluded folders and the Task folders, validated, with
 * the template folder (#1024) added to the excluded ones. A template's
 * `- [ ]` lines are placeholders for the note it will make, never work, so the
 * template folder is left out even inside a Task folder. Callers that scan
 * past the lists on request (MCP's `includeExcluded`) skip this helper and so
 * reach the template folder as well.
 */
export function tasksFolderListsForSettings(
  settings: { tasks?: unknown; templates?: unknown } | null | undefined
): { excluded: string[]; included: string[] } {
  const tasks =
    settings?.tasks && typeof settings.tasks === 'object'
      ? (settings.tasks as { excludedFolders?: unknown; includedFolders?: unknown })
      : undefined
  const excluded = normalizeTasksExcludedFolders(tasks?.excludedFolders)
  const included = normalizeTasksIncludedFolders(tasks?.includedFolders)
  const templateFolder = resolveTemplateFolder(settings)
  if (templateFolder && !excluded.includes(templateFolder)) excluded.push(templateFolder)
  return { excluded, included }
}

function isInsideAnyFolder(relPath: string, folders: readonly string[]): boolean {
  for (const folder of folders) {
    if (relPath === folder || relPath.startsWith(folder + '/')) return true
  }
  return false
}

/** Repoint one list's entries after a folder rename or move: an entry naming
 *  the folder, or a folder inside it, follows it to its new path. */
function rewriteFolderList(list: readonly string[], oldRel: string, newRel: string): string[] {
  return normalizeTasksExcludedFolders(
    list.map((entry) =>
      entry === oldRel || entry.startsWith(oldRel + '/') ? newRel + entry.slice(oldRel.length) : entry
    )
  )
}

/** Both folder lists after a folder rename or move, so they keep naming the
 *  same folders. A renamed Task folder (#962) left behind would match nothing,
 *  and once it was the only one, Tasks would go empty. */
export function rewriteTasksFoldersForRename<
  T extends { excludedFolders?: string[]; includedFolders?: string[] }
>(tasks: T | undefined, oldRel: string, newRel: string): T | undefined {
  if (!tasks || !oldRel || !newRel || oldRel === newRel) return tasks
  return {
    ...tasks,
    ...(tasks.excludedFolders
      ? { excludedFolders: rewriteFolderList(tasks.excludedFolders, oldRel, newRel) }
      : {}),
    ...(tasks.includedFolders
      ? { includedFolders: rewriteFolderList(tasks.includedFolders, oldRel, newRel) }
      : {})
  }
}
