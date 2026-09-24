import { isWorkspaceTransitionPending } from './workspace-transition'
import {
  csvPathForFormDir,
  formDirContaining,
  formTitleFromDir,
  isFormDirName
} from '@shared/databases'
import { resolveFolderPath } from '@shared/system-folder-paths'
import { useStore } from '../store'
import { getConfirmRequest, confirmApp } from './confirm-requests'
import { getPromptRequest, promptApp } from './prompt-requests'
import { parentDirOf } from './manual-order'
import {
  buildMoveDirectoryPrompt,
  moveNoteVocabulary,
  type MoveNoteVocabulary,
  parseMoveNoteTarget,
  validateMoveDirectoryTarget
} from './move-note'
import { resolveCreateLocation } from './vault-layout'

export interface BrowseActionHost {
  /** Capture the native vault token before requesting a dialog, then compare it here. */
  isCurrent(): boolean
}

/** Host errors reject the promise; stale work never starts another mutation. */
export type BrowseActionResult = 'completed' | 'cancelled' | 'stale' | 'unavailable'

let pending = false

function findDirectory(directory: string) {
  if (!directory || formDirContaining(parentDirOf(directory))) return undefined
  return useStore
    .getState()
    .folders.find((row) => row.folder === 'inbox' && row.subpath === directory)
}

function primaryDirectory(): string {
  const settings = useStore.getState().vaultSettings
  return settings.primaryNotesLocation === 'root'
    ? ''
    : resolveFolderPath('inbox', settings.systemFolderPaths)
}

function start(host: BrowseActionHost, directory: string, allowRoot = false) {
  if (pending || getPromptRequest() || getConfirmRequest()) return null
  const vault = useStore.getState().vault
  const bridge = window.zen
  const primary = primaryDirectory()
  const isCurrent = (): boolean => {
    try {
      return (
        !isWorkspaceTransitionPending() &&
        !!vault &&
        useStore.getState().vault === vault &&
        window.zen === bridge &&
        primaryDirectory() === primary &&
        host.isCurrent()
      )
    } catch {
      return false
    }
  }
  const targetExists = () => (allowRoot && directory === '') || !!findDirectory(directory)
  if (!isCurrent() || !targetExists()) return null
  pending = true
  return { isCurrent, targetExists }
}

function validateName(value: string): string | null {
  const name = value.trim()
  if (!name || name === '.' || name === '..' || /[\\/\u0000-\u001f]/.test(name))
    return 'Enter a folder name without / or \\.'
  if (isFormDirName(name)) return 'The .base suffix is reserved for databases.'
  return null
}

/** Prompt for a child of a primary-notes directory. An empty directory means its root. */
export async function requestCreateBrowseFolder(
  host: BrowseActionHost,
  directory = ''
): Promise<BrowseActionResult> {
  if (formDirContaining(directory)) return 'unavailable'
  const context = start(host, directory, true)
  if (!context) return 'unavailable'
  const { isCurrent, targetExists } = context
  try {
    const leaf = directory.split('/').pop()
    const name = (
      await promptApp({
        title: leaf ? `New folder in ${leaf}` : 'New folder',
        placeholder: 'Folder name',
        okLabel: 'Create',
        validate: validateName
      })
    )?.trim()
    if (!name || validateName(name)) return 'cancelled'
    if (!isCurrent() || !targetExists()) return 'stale'
    await useStore
      .getState()
      .createFolder('inbox', directory ? `${directory}/${name}` : name, isCurrent)
    return isCurrent() ? 'completed' : 'stale'
  } finally {
    pending = false
  }
}

/** Prompt for an ordinary folder's leaf name. Database renaming uses its own feature. */
export async function requestRenameBrowseFolder(
  host: BrowseActionHost,
  directory: string
): Promise<BrowseActionResult> {
  if (formDirContaining(directory)) return 'unavailable'
  const context = start(host, directory)
  if (!context) return 'unavailable'
  const { isCurrent, targetExists } = context
  try {
    const title = directory.split('/').pop()!
    const name = (
      await promptApp({
        title: 'Rename folder',
        initialValue: title,
        okLabel: 'Rename',
        validate: validateName
      })
    )?.trim()
    if (!name || name === title || validateName(name)) return 'cancelled'
    if (!isCurrent() || !targetExists()) return 'stale'
    const parent = parentDirOf(directory)
    await useStore
      .getState()
      .renameFolder('inbox', directory, parent ? `${parent}/${name}` : name, isCurrent)
    return isCurrent() ? 'completed' : 'stale'
  } finally {
    pending = false
  }
}

/**
 * Prompt for a new parent for an ordinary folder or a whole database
 * directory. The leaf name, and so a database's .base suffix, is kept. The
 * store action is the one desktop's sidebar drag uses: it carries open tabs
 * (database tabs included), folder icons and colors, favorites, and manual
 * order to the new path, and the host refuses to overwrite an existing folder.
 */
export async function requestMoveBrowseDirectory(
  host: BrowseActionHost,
  directory: string
): Promise<BrowseActionResult> {
  const context = start(host, directory)
  if (!context) return 'unavailable'
  const { isCurrent, targetExists } = context
  try {
    const vocabulary = (): MoveNoteVocabulary => {
      const state = useStore.getState()
      return moveNoteVocabulary(state.vaultSettings, state.systemFolderLabels, state.folders)
    }
    const validate = (value: string): string | null =>
      validateMoveDirectoryTarget(directory, value, useStore.getState().folders, vocabulary())
    const target = await promptApp({
      ...buildMoveDirectoryPrompt(directory, useStore.getState().folders, vocabulary()),
      validate
    })
    // Empty is an answer (the notes root); only null is the Cancel.
    if (target === null || validate(target)) return 'cancelled'
    const parent = parseMoveNoteTarget(target, vocabulary()).subpath
    if (parent === parentDirOf(directory)) return 'cancelled'
    if (!isCurrent() || !targetExists()) return 'stale'
    const leaf = directory.split('/').pop()!
    await useStore
      .getState()
      .renameFolder('inbox', directory, parent ? `${parent}/${leaf}` : leaf, isCurrent)
    return isCurrent() ? 'completed' : 'stale'
  } finally {
    pending = false
  }
}

/** Confirm permanent deletion of an ordinary folder or a whole database directory. */
export async function requestDeleteBrowseDirectory(
  host: BrowseActionHost,
  directory: string
): Promise<BrowseActionResult> {
  const context = start(host, directory)
  if (!context) return 'unavailable'
  const { isCurrent, targetExists } = context
  try {
    const database = isFormDirName(directory)
    const title = database ? formTitleFromDir(directory) : directory.split('/').pop()!
    const confirmed = await confirmApp({
      title: `Delete "${title}"?`,
      description: database
        ? 'All records will be permanently deleted. This cannot be undone.'
        : 'Everything inside will be permanently deleted. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!confirmed) return 'cancelled'
    if (!isCurrent() || !targetExists()) return 'stale'
    await useStore.getState().deleteFolder('inbox', directory, isCurrent)
    return isCurrent() ? 'completed' : 'stale'
  } finally {
    pending = false
  }
}

/** Omit directory for configured placement; an explicit directory is primary-relative. */
export async function createBrowseDatabase(
  host: BrowseActionHost,
  directory?: string
): Promise<BrowseActionResult> {
  const state = useStore.getState()
  const target =
    directory === undefined
      ? resolveCreateLocation(
          state.vaultSettings.databasesLocation,
          state.activeNote,
          state.vaultSettings
        )
      : { folder: 'inbox' as const, subpath: directory }
  if (directory !== undefined && formDirContaining(target.subpath)) return 'unavailable'
  const context = start(host, directory ?? '', true)
  if (!context) return 'unavailable'
  try {
    await useStore
      .getState()
      .createDatabase(target.folder, target.subpath, undefined, context.isCurrent)
    return context.isCurrent() ? 'completed' : 'stale'
  } finally {
    pending = false
  }
}

/** Rename a database by its Browse directory, retaining the host's collision behavior. */
export async function requestRenameBrowseDatabase(
  host: BrowseActionHost,
  directory: string
): Promise<BrowseActionResult> {
  if (!isFormDirName(directory)) return 'unavailable'
  const context = start(host, directory)
  if (!context) return 'unavailable'
  const { isCurrent, targetExists } = context
  try {
    const title = formTitleFromDir(directory)
    const validate = (value: string): string | null =>
      value.trim().startsWith('.') ? 'Database names cannot start with a dot.' :
      !value.trim() || /[\\/\u0000-\u001f]/.test(value)
        ? 'Enter a database name without / or \\.'
        : null
    const name = (
      await promptApp({
        title: 'Rename database',
        initialValue: title,
        okLabel: 'Rename',
        validate
      })
    )?.trim()
    if (!name || name === title || validate(name)) return 'cancelled'
    if (!isCurrent() || !targetExists()) return 'stale'
    const primary = primaryDirectory()
    const csv = csvPathForFormDir(primary ? `${primary}/${directory}` : directory)
    await useStore.getState().renameDatabase(csv, name, isCurrent)
    return isCurrent() ? 'completed' : 'stale'
  } finally {
    pending = false
  }
}
