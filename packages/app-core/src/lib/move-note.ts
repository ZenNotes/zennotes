import type { FolderEntry, NoteMeta } from '@shared/ipc'
import { formDirContaining, formTitleFromDir } from '@shared/databases'
import type { PromptOptions, PromptSuggestion } from '../components/PromptModal'

export type MoveNoteDestination = {
  folder: 'inbox' | 'archive'
  subpath: string
}

function normalizeMoveTarget(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

function initialTargetFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  const top = parts[0]
  if (top === 'inbox' || top === 'archive') {
    return parts.slice(0, -1).join('/')
  }
  return 'inbox'
}

function buildMoveNoteSuggestions(
  folders: FolderEntry[],
  roots: readonly MoveNoteDestination['folder'][] = ['inbox', 'archive']
): PromptSuggestion[] {
  const byValue = new Map<string, PromptSuggestion>()
  const push = (value: string, detail?: string): void => {
    if (!byValue.has(value)) byValue.set(value, { value, detail })
  }

  for (const root of roots) push(root, 'Root')

  for (const folder of folders) {
    if (!roots.some((root) => root === folder.folder)) continue
    const value = folder.subpath ? `${folder.folder}/${folder.subpath}` : folder.folder
    push(value, folder.subpath ? folder.folder : 'Root')
  }

  return [...byValue.values()].sort((a, b) => {
    const aDepth = a.value.split('/').length
    const bDepth = b.value.split('/').length
    return aDepth - bDepth || a.value.localeCompare(b.value)
  })
}

export function validateMoveNoteTarget(value: string): string | null {
  const normalized = normalizeMoveTarget(value)
  if (!normalized) return 'Folder path required'
  const [top] = normalized.split('/')
  if (top !== 'inbox' && top !== 'archive') {
    return 'Top-level folder must be inbox or archive'
  }
  return null
}

export function parseMoveNoteTarget(value: string): MoveNoteDestination {
  const normalized = normalizeMoveTarget(value)
  const [folder, ...rest] = normalized.split('/')
  return {
    folder: folder as MoveNoteDestination['folder'],
    subpath: rest.join('/')
  }
}

/**
 * Resolve the destination chosen in the template destination prompt. The value
 * is a folder path relative to the notes area (what the sidebar shows): empty
 * means the vault root. The notes root is `inbox` internally, so a leading
 * `inbox/` (or bare `inbox`) is treated as the root too.
 */
export function parseTemplateDestination(value: string): MoveNoteDestination {
  let sub = normalizeMoveTarget(value)
  if (sub === 'inbox') sub = ''
  else if (sub.startsWith('inbox/')) sub = sub.slice('inbox/'.length)
  return { folder: 'inbox', subpath: sub }
}

/**
 * Folder suggestions for creating a new note, mirroring the sidebar NOTES tree:
 * the vault root plus its real subfolders. Excludes `archive` (a separate
 * lifecycle area) and the redundant bare `inbox` (which is the root itself).
 */
function buildNotesFolderSuggestions(folders: FolderEntry[]): PromptSuggestion[] {
  const out: PromptSuggestion[] = [{ value: '', label: 'Vault root' }]
  const seen = new Set<string>([''])
  for (const folder of folders) {
    if (folder.folder !== 'inbox') continue // notes area only
    const sub = normalizeMoveTarget(folder.subpath)
    if (!sub || seen.has(sub)) continue
    seen.add(sub)
    const parts = sub.split('/')
    out.push({ value: sub, detail: parts.slice(0, -1).join('/') || 'Vault root' })
  }
  return out.sort((a, b) => {
    const aDepth = a.value === '' ? -1 : a.value.split('/').length
    const bDepth = b.value === '' ? -1 : b.value.split('/').length
    return aDepth - bDepth || a.value.localeCompare(b.value)
  })
}

/**
 * Prompt for where a new note should be created. Defaults to `initialPath`
 * (empty = vault root): pressing Enter creates there immediately, or type /
 * pick a folder (the ones shown in the sidebar) to place it elsewhere.
 */
export function buildNoteDestinationPrompt(
  initialPath: string,
  folders: FolderEntry[]
): PromptOptions {
  return {
    title: 'New note in…',
    description: 'Press Enter to create at the vault root, or type / pick a folder like Work/Research.',
    initialValue: normalizeMoveTarget(initialPath),
    placeholder: 'Vault root — type a folder to change',
    okLabel: 'Create',
    allowEmptySubmit: true,
    suggestions: buildNotesFolderSuggestions(folders),
    autoHighlightFirst: true,
    suggestionsHint: 'Empty = vault root · ↑↓ or ⌃J/⌃K pick a folder · Enter create'
  }
}

/**
 * Prompt for where a new template note should be created. Defaults to the
 * vault root: pressing Enter creates there immediately. Type a path or use the
 * suggestions (the folders you see in the sidebar) to quickly pick a folder.
 */
export function buildTemplateDestinationPrompt(
  templateName: string,
  initialPath: string,
  folders: FolderEntry[]
): PromptOptions {
  return {
    title: `Create "${templateName}" in…`,
    description: 'Press Enter to create at the vault root, or type / pick a folder like Work/Research.',
    initialValue: normalizeMoveTarget(initialPath),
    placeholder: 'Vault root — type a folder to change',
    okLabel: 'Create',
    allowEmptySubmit: true,
    suggestions: buildNotesFolderSuggestions(folders),
    autoHighlightFirst: true,
    suggestionsHint: 'Empty = vault root · ↑↓ or ⌃J/⌃K pick a folder · Enter create'
  }
}

export function buildMoveNotePrompt(
  note: Pick<NoteMeta, 'title' | 'path'>,
  folders: FolderEntry[]
): PromptOptions {
  return {
    title: `Move "${note.title}" to…`,
    description: 'Enter a folder path, e.g. inbox/Work/Research',
    initialValue: initialTargetFromPath(note.path),
    placeholder: 'inbox/Work',
    okLabel: 'Move',
    suggestions: buildMoveNoteSuggestions(folders),
    autoHighlightFirst: true,
    suggestionsHint: '↑↓ or ⌃J/⌃K pick a folder · Enter to move',
    validate: validateMoveNoteTarget
  }
}

/**
 * Why `value` cannot receive the folder or database at `directory`, or null.
 * Directories move within the notes area only, so the destination is an
 * existing `inbox[/sub]` folder, written the way the move-note prompt writes
 * it. `folders` is the live list: the prompt validates against what exists
 * when the user submits, not when it opened.
 */
export function validateMoveDirectoryTarget(
  directory: string,
  value: string,
  folders: FolderEntry[]
): string | null {
  const normalized = normalizeMoveTarget(value)
  if (!normalized) return 'Folder path required'
  const [top, ...rest] = normalized.split('/')
  if (top !== 'inbox') return 'Folders and databases move within inbox'
  const subpath = rest.join('/')
  if (/[\u0000-\u001f]/.test(value) || rest.some((part) => part.startsWith('.')))
    return 'Choose a folder without hidden names or parent-directory segments.'
  if (subpath === directory || subpath.startsWith(`${directory}/`))
    return 'A folder cannot move into itself.'
  if (formDirContaining(subpath)) return 'Databases are not move destinations.'
  const exists = (path: string): boolean =>
    folders.some((entry) => entry.folder === 'inbox' && entry.subpath === path)
  if (subpath && !exists(subpath)) return 'Choose an existing folder.'
  const leaf = directory.split('/').pop()!
  const moved = subpath ? `${subpath}/${leaf}` : leaf
  if (moved !== directory && exists(moved))
    return `"${formTitleFromDir(leaf)}" already exists in that folder.`
  return null
}

/**
 * Prompt for where a folder or database should move. The field starts empty:
 * touch devices show the suggestion list instead of a keyboard, and a
 * prefilled path would filter that list down to the folder it already is in.
 * The folder itself, everything under it, and databases are never offered.
 */
export function buildMoveDirectoryPrompt(directory: string, folders: FolderEntry[]): PromptOptions {
  const destinations = folders.filter(
    (entry) =>
      entry.subpath !== directory &&
      !entry.subpath.startsWith(`${directory}/`) &&
      !formDirContaining(entry.subpath)
  )
  return {
    title: `Move "${formTitleFromDir(directory)}" to…`,
    description: 'Pick a folder, or enter a path like inbox/Work/Research',
    placeholder: 'inbox/Work',
    okLabel: 'Move',
    suggestions: buildMoveNoteSuggestions(destinations, ['inbox']),
    autoHighlightFirst: true,
    suggestionsHint: '↑↓ or ⌃J/⌃K pick a folder · Enter to move'
  }
}
