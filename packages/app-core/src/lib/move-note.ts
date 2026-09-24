import type { FolderEntry, NoteMeta, VaultSettings } from '@shared/ipc'
import { formDirContaining, formTitleFromDir } from '@shared/databases'
import { resolveFolderPath } from '@shared/system-folder-paths'
import type { PromptOptions, PromptSuggestion } from '../components/PromptModal'
import { resolveSystemFolderLabels, type SystemFolderLabels } from './system-folder-labels'
import { isPrimaryNotesAtRoot, noteFolderSubpath } from './vault-layout'

export type MoveNoteDestination = {
  folder: 'inbox' | 'archive'
  subpath: string
}

/**
 * How a destination is spelled on this vault: the sidebar's language, not the
 * bucket's.
 *
 * A destination is a path inside the notes area, the way the NOTES tree shows
 * it: `Work/Research`, or nothing at all for the notes root, which is the
 * Inbox on an Inbox vault and the vault itself when the primary notes live at
 * the root. The Archive is reached as `archive/…`, its bucket id, whatever the
 * folder is called on disk or in the sidebar. Spelling `inbox/Work` for the
 * notes area is the older form the manual taught; it still works on an Inbox
 * vault, and on a root vault too unless a real folder named `inbox` sits at
 * the root, in which case it means that folder (#844).
 */
export interface MoveNoteVocabulary {
  settings: VaultSettings | null | undefined
  /** The notes area is the vault root (Settings → Vault, "Vault root"). */
  atRoot: boolean
  /** What the notes root is called on the surface: "Vault root", or the inbox's label. */
  rootLabel: string
  /** The same, as it reads inside a sentence. */
  rootPhrase: string
  archiveLabel: string
  /** The Archive's directory name, lowercased, so a typed `Shelf/Old` on a
   *  vault that keeps its archive in `Shelf/` still means the Archive. */
  archiveDir: string
  /** Top-level names that are system folders rather than places to move a
   *  note: Quick Notes and the Trash, by their bucket ids and their directory
   *  names. Reaching them is a different action, with its own confirmation. */
  reserved: Set<string>
  /** A real folder named `inbox` at the root of a root vault, so `inbox/…`
   *  means that folder rather than the notes area. */
  inboxIsFolder: boolean
}

export function moveNoteVocabulary(
  settings: VaultSettings | null | undefined,
  labels: SystemFolderLabels | null | undefined,
  folders: readonly FolderEntry[]
): MoveNoteVocabulary {
  const atRoot = isPrimaryNotesAtRoot(settings)
  const resolved = resolveSystemFolderLabels(labels)
  const dir = (folder: 'quick' | 'trash' | 'archive'): string =>
    resolveFolderPath(folder, settings?.systemFolderPaths).toLowerCase()
  return {
    settings,
    atRoot,
    rootLabel: atRoot ? 'Vault root' : resolved.inbox,
    rootPhrase: atRoot ? 'the vault root' : resolved.inbox,
    archiveLabel: resolved.archive,
    archiveDir: dir('archive'),
    reserved: new Set(['quick', 'trash', dir('quick'), dir('trash')]),
    inboxIsFolder:
      atRoot &&
      folders.some((entry) => entry.folder === 'inbox' && entry.subpath.toLowerCase() === 'inbox')
  }
}

function normalizeMoveTarget(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

interface ReadMoveTarget extends MoveNoteDestination {
  /** Written as `inbox/…`, the older spelling of the notes area. */
  viaInboxPrefix: boolean
}

function readMoveTarget(value: string, vocabulary: MoveNoteVocabulary): ReadMoveTarget {
  const normalized = normalizeMoveTarget(value)
  if (!normalized) return { folder: 'inbox', subpath: '', viaInboxPrefix: false }
  const [top, ...rest] = normalized.split('/')
  const lower = top.toLowerCase()
  if (lower === 'archive' || lower === vocabulary.archiveDir) {
    return { folder: 'archive', subpath: rest.join('/'), viaInboxPrefix: false }
  }
  if (lower === 'inbox' && !vocabulary.inboxIsFolder) {
    return { folder: 'inbox', subpath: rest.join('/'), viaInboxPrefix: true }
  }
  return { folder: 'inbox', subpath: normalized, viaInboxPrefix: false }
}

/** Where a typed or picked destination points. Empty means the notes root. */
export function parseMoveNoteTarget(
  value: string,
  vocabulary: MoveNoteVocabulary
): MoveNoteDestination {
  const { folder, subpath } = readMoveTarget(value, vocabulary)
  return { folder, subpath }
}

/**
 * Why `value` is not a place a note can move to, or null. Empty is the notes
 * root, so it is a destination; a segment that starts with a dot is a hidden
 * name or a parent reference, neither of which a note belongs in; and the
 * Quick Notes and Trash are reached by their own actions, so their names are
 * refused rather than quietly turned into folders of that name.
 */
export function validateMoveNoteTarget(
  value: string,
  vocabulary: MoveNoteVocabulary
): string | null {
  if (/[\u0000-\u001f]/.test(value)) {
    return 'Choose a folder without hidden names or parent-directory segments.'
  }
  const target = readMoveTarget(value, vocabulary)
  const segments = target.subpath.split('/').filter(Boolean)
  if (segments.some((part) => part.startsWith('.'))) {
    return 'Choose a folder without hidden names or parent-directory segments.'
  }
  if (
    target.folder === 'inbox' &&
    !target.viaInboxPrefix &&
    segments.length > 0 &&
    vocabulary.reserved.has(segments[0].toLowerCase())
  ) {
    return `Notes move within ${vocabulary.rootPhrase} or into archive/…; Quick Notes and the Trash have their own actions.`
  }
  return null
}

/** `Work/Research` reads as a child of `Work`; a top-level folder, of the root. */
function parentDetail(subpath: string, root: string): string {
  const parts = subpath.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : root
}

function buildMoveNoteSuggestions(
  folders: readonly FolderEntry[],
  vocabulary: MoveNoteVocabulary,
  roots: readonly MoveNoteDestination['folder'][] = ['inbox', 'archive']
): PromptSuggestion[] {
  const notesArea = new Map<string, PromptSuggestion>()
  const archive = new Map<string, PromptSuggestion>()
  if (roots.includes('inbox')) notesArea.set('', { value: '', label: vocabulary.rootLabel })
  if (roots.includes('archive')) archive.set('archive', { value: 'archive', detail: vocabulary.archiveLabel })
  for (const folder of folders) {
    const sub = normalizeMoveTarget(folder.subpath)
    if (!sub) continue
    if (folder.folder === 'inbox' && roots.includes('inbox') && !notesArea.has(sub)) {
      notesArea.set(sub, { value: sub, detail: parentDetail(sub, vocabulary.rootLabel) })
    } else if (folder.folder === 'archive' && roots.includes('archive')) {
      const value = `archive/${sub}`
      if (!archive.has(value)) {
        archive.set(value, { value, detail: parentDetail(value, vocabulary.archiveLabel) })
      }
    }
  }
  const byDepth = (a: PromptSuggestion, b: PromptSuggestion): number => {
    const depth = (value: string): number => (value === '' ? -1 : value.split('/').length)
    return depth(a.value) - depth(b.value) || a.value.localeCompare(b.value)
  }
  return [...[...notesArea.values()].sort(byDepth), ...[...archive.values()].sort(byDepth)]
}

/** Where the note is now, spelled the way the prompt spells destinations. */
function currentMoveTarget(
  note: Pick<NoteMeta, 'folder' | 'path'>,
  vocabulary: MoveNoteVocabulary
): string {
  const subpath = noteFolderSubpath(note, vocabulary.settings)
  if (note.folder === 'archive') return subpath ? `archive/${subpath}` : 'archive'
  if (note.folder === 'inbox') return subpath
  return ''
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

/**
 * Prompt for where a note should move. It opens on the note's current folder,
 * spelled the way the suggestions are: a folder of the notes area with no
 * prefix, empty for the notes root, `archive/…` for the Archive.
 */
export function buildMoveNotePrompt(
  note: Pick<NoteMeta, 'title' | 'path' | 'folder'>,
  folders: FolderEntry[],
  vocabulary: MoveNoteVocabulary
): PromptOptions {
  return {
    title: `Move "${note.title}" to…`,
    description: `Pick a folder, or type a path like Work/Research (empty = ${vocabulary.rootLabel}) or archive/Reference.`,
    initialValue: currentMoveTarget(note, vocabulary),
    placeholder: `${vocabulary.rootLabel} (type a folder to change)`,
    okLabel: 'Move',
    allowEmptySubmit: true,
    suggestions: buildMoveNoteSuggestions(folders, vocabulary),
    autoHighlightFirst: true,
    suggestionsHint: `Empty = ${vocabulary.rootLabel} · ↑↓ or ⌃J/⌃K pick a folder · Enter to move`,
    validate: (value) => validateMoveNoteTarget(value, vocabulary)
  }
}

/**
 * Why `value` cannot receive the folder or database at `directory`, or null.
 * Directories move within the notes area only, so the destination is an
 * existing folder of it, written the way the move-note prompt writes it.
 * `folders` is the live list: the prompt validates against what exists when
 * the user submits, not when it opened.
 */
export function validateMoveDirectoryTarget(
  directory: string,
  value: string,
  folders: FolderEntry[],
  vocabulary: MoveNoteVocabulary
): string | null {
  const problem = validateMoveNoteTarget(value, vocabulary)
  if (problem) return problem
  const target = readMoveTarget(value, vocabulary)
  if (target.folder !== 'inbox') {
    return `Folders and databases move within ${vocabulary.rootPhrase}, not the Archive.`
  }
  const subpath = target.subpath
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
export function buildMoveDirectoryPrompt(
  directory: string,
  folders: FolderEntry[],
  vocabulary: MoveNoteVocabulary
): PromptOptions {
  const destinations = folders.filter(
    (entry) =>
      entry.subpath !== directory &&
      !entry.subpath.startsWith(`${directory}/`) &&
      !formDirContaining(entry.subpath)
  )
  return {
    title: `Move "${formTitleFromDir(directory)}" to…`,
    description: `Pick a folder, or type a path like Work/Research (empty = ${vocabulary.rootLabel}).`,
    placeholder: `${vocabulary.rootLabel} (type a folder to change)`,
    okLabel: 'Move',
    allowEmptySubmit: true,
    suggestions: buildMoveNoteSuggestions(destinations, vocabulary, ['inbox']),
    autoHighlightFirst: true,
    suggestionsHint: `Empty = ${vocabulary.rootLabel} · ↑↓ or ⌃J/⌃K pick a folder · Enter to move`
  }
}
