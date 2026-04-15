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

function buildMoveNoteSuggestions(folders: FolderEntry[]): PromptSuggestion[] {
  const byValue = new Map<string, PromptSuggestion>()
  const push = (value: string, detail?: string): void => {
    if (!byValue.has(value)) byValue.set(value, { value, detail })
  }

  push('inbox', 'Root')
  push('archive', 'Root')

  for (const folder of folders) {
    if (folder.folder !== 'inbox' && folder.folder !== 'archive') continue
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
    suggestionsHint: 'Tab browse folders, ↑↓ move, Enter accept',
    validate: validateMoveNoteTarget
  }
}
