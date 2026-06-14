import type { FolderEntry, NoteMeta } from '@shared/ipc'
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
  t: (s: string) => string
): PromptSuggestion[] {
  const byValue = new Map<string, PromptSuggestion>()
  const push = (value: string, detail?: string): void => {
    if (!byValue.has(value)) byValue.set(value, { value, detail })
  }

  push('inbox', t('Root'))
  push('archive', t('Root'))

  for (const folder of folders) {
    if (folder.folder !== 'inbox' && folder.folder !== 'archive') continue
    const value = folder.subpath ? `${folder.folder}/${folder.subpath}` : folder.folder
    push(value, folder.subpath ? folder.folder : t('Root'))
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
function buildNotesFolderSuggestions(
  folders: FolderEntry[],
  t: (s: string) => string
): PromptSuggestion[] {
  const out: PromptSuggestion[] = [{ value: '', label: t('Vault root') }]
  const seen = new Set<string>([''])
  for (const folder of folders) {
    if (folder.folder !== 'inbox') continue // notes area only
    const sub = normalizeMoveTarget(folder.subpath)
    if (!sub || seen.has(sub)) continue
    seen.add(sub)
    const parts = sub.split('/')
    out.push({ value: sub, detail: parts.slice(0, -1).join('/') || t('Vault root') })
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
  folders: FolderEntry[],
  t: (s: string) => string
): PromptOptions {
  return {
    title: t('New note in…'),
    description: t(
      'Press Enter to create at the vault root, or type / pick a folder like Work/Research.'
    ),
    initialValue: normalizeMoveTarget(initialPath),
    placeholder: t('Vault root — type a folder to change'),
    okLabel: t('Create'),
    allowEmptySubmit: true,
    suggestions: buildNotesFolderSuggestions(folders, t),
    suggestionsHint: t('Empty = vault root · ↑↓ pick a folder · Enter create')
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
  folders: FolderEntry[],
  t: (s: string) => string
): PromptOptions {
  return {
    title: t('Create "{name}" in…').replace('{name}', templateName),
    description: t(
      'Press Enter to create at the vault root, or type / pick a folder like Work/Research.'
    ),
    initialValue: normalizeMoveTarget(initialPath),
    placeholder: t('Vault root — type a folder to change'),
    okLabel: t('Create'),
    allowEmptySubmit: true,
    suggestions: buildNotesFolderSuggestions(folders, t),
    suggestionsHint: t('Empty = vault root · ↑↓ pick a folder · Enter create')
  }
}

export function buildMoveNotePrompt(
  note: Pick<NoteMeta, 'title' | 'path'>,
  folders: FolderEntry[],
  t: (s: string) => string
): PromptOptions {
  return {
    title: t('Move "{title}" to…').replace('{title}', note.title),
    description: t('Enter a folder path, e.g. inbox/Work/Research'),
    initialValue: initialTargetFromPath(note.path),
    placeholder: 'inbox/Work',
    okLabel: t('Move'),
    suggestions: buildMoveNoteSuggestions(folders, t),
    suggestionsHint: t('↑↓ pick a folder · Enter to move'),
    validate: validateMoveNoteTarget
  }
}
