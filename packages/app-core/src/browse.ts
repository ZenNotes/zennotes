import { useSyncExternalStore } from 'react'
import type { FolderEntry } from '@bridge-contract/ipc'
import {
  csvPathForFormDir,
  databaseTabPath,
  formDirContaining,
  formTitleFromDir,
  isFormDirName
} from '@shared/databases'
import { resolveFolderPath } from '@shared/system-folder-paths'
import { useStore } from './store'
import {
  getBrowseNotes,
  getShellSnapshot,
  type NoteSortOrder,
  type ShellNote,
  type ShellSnapshot
} from './shell'
import { parentDirOf } from './lib/manual-order'

export interface BrowseFolder {
  /** Relative to the primary notes area, not the vault root. */
  readonly directory: string
  readonly title: string
}

export interface BrowseDatabase extends BrowseFolder {
  /** Opaque application path; pass to the public navigation openNote action. */
  readonly path: string
}

export interface BrowseSnapshot {
  /** Display/change metadata. Native persistence uses the host's stable vault token. */
  readonly vault: ShellSnapshot['vault']
  readonly folders: readonly BrowseFolder[]
  readonly databases: readonly BrowseDatabase[]
  readonly notes: readonly ShellNote[]
  readonly noteSortOrder: NoteSortOrder
  /** Enabled directory settings, unchanged; null when disabled. Patterns are not expanded. */
  readonly dateDirectories: Readonly<{
    daily: string | null
    weekly: string | null
    monthly: string | null
  }>
}

export interface BrowsePins {
  readonly notes?: readonly string[]
  readonly folders?: readonly string[]
}

export interface BrowseDirectory {
  readonly folders: readonly BrowseFolder[]
  readonly databases: readonly BrowseDatabase[]
  readonly notes: readonly ShellNote[]
}

let folderSource: readonly FolderEntry[] | undefined
let primaryDirectory = ''
let folders: readonly BrowseFolder[] = Object.freeze([])
let databases: readonly BrowseDatabase[] = Object.freeze([])
let dates: BrowseSnapshot['dateDirectories'] = Object.freeze({
  daily: null,
  weekly: null,
  monthly: null
})
let snapshot: BrowseSnapshot | undefined

export function getBrowseSnapshot(): BrowseSnapshot {
  const state = useStore.getState()
  const shell = getShellSnapshot()
  const settings = state.vaultSettings
  const primary =
    settings.primaryNotesLocation === 'root'
      ? ''
      : resolveFolderPath('inbox', settings.systemFolderPaths)
  if (folderSource !== state.folders || primaryDirectory !== primary) {
    folderSource = state.folders
    primaryDirectory = primary
    const folderRows = new Map<string, BrowseFolder>()
    const databaseRows = new Map<string, BrowseDatabase>()
    for (const entry of state.folders) {
      const directory = entry.subpath
      if (entry.folder !== 'inbox' || !directory || formDirContaining(parentDirOf(directory)))
        continue
      if (isFormDirName(directory)) {
        const path = primary ? `${primary}/${directory}` : directory
        databaseRows.set(
          directory,
          Object.freeze({
            directory,
            title: formTitleFromDir(directory),
            path: databaseTabPath(csvPathForFormDir(path))
          })
        )
      } else {
        folderRows.set(directory, Object.freeze({ directory, title: directory.split('/').pop()! }))
      }
    }
    folders = Object.freeze([...folderRows.values()])
    databases = Object.freeze([...databaseRows.values()])
  }
  const daily = settings.dailyNotes.enabled ? settings.dailyNotes.directory : null
  const weekly = settings.weeklyNotes.enabled ? settings.weeklyNotes.directory : null
  const monthly = settings.monthlyNotes.enabled ? settings.monthlyNotes.directory : null
  if (daily !== dates.daily || weekly !== dates.weekly || monthly !== dates.monthly)
    dates = Object.freeze({ daily, weekly, monthly })
  const next: BrowseSnapshot = {
    vault: shell.vault,
    notes: shell.notes,
    noteSortOrder: shell.noteSortOrder,
    folders,
    databases,
    dateDirectories: dates
  }
  if (
    !snapshot ||
    (Object.keys(next) as Array<keyof BrowseSnapshot>).some((key) => next[key] !== snapshot![key])
  )
    snapshot = Object.freeze(next)
  return snapshot
}

/** Observe Browse data changes without notifications for editor selection or cursor changes. */
export function subscribeBrowse(
  listener: (snapshot: BrowseSnapshot, previous: BrowseSnapshot) => void
): () => void {
  let previous = getBrowseSnapshot()
  return useStore.subscribe(() => {
    const next = getBrowseSnapshot()
    if (next === previous) return
    const before = previous
    previous = next
    listener(next, before)
  })
}

function subscribeReact(notify: () => void): () => void {
  return subscribeBrowse(() => notify())
}

export function useBrowseSnapshot(): BrowseSnapshot {
  return useSyncExternalStore(subscribeReact, getBrowseSnapshot, getBrowseSnapshot)
}

/** Immediate mobile Browse rows, with separate folder, database, and note groups. */
export function getBrowseDirectory(
  snapshot: BrowseSnapshot,
  directory = '',
  pins: BrowsePins = {}
): BrowseDirectory {
  if (formDirContaining(directory))
    return Object.freeze({
      folders: Object.freeze([]),
      databases: Object.freeze([]),
      notes: Object.freeze([])
    })
  const childFolders = snapshot.folders
    .filter((row) => parentDirOf(row.directory) === directory)
    .sort((a, b) => a.title.localeCompare(b.title))
  const pinned = new Set(pins.folders)
  return Object.freeze({
    folders: Object.freeze([
      ...childFolders.filter((row) => pinned.has(row.directory)),
      ...childFolders.filter((row) => !pinned.has(row.directory))
    ]),
    databases: Object.freeze(
      snapshot.databases
        .filter((row) => parentDirOf(row.directory) === directory)
        .sort((a, b) => a.title.localeCompare(b.title))
    ),
    notes: getBrowseNotes(snapshot, directory, pins.notes)
  })
}

export {
  createBrowseDatabase,
  requestRenameBrowseDatabase,
  requestCreateBrowseFolder,
  requestRenameBrowseFolder,
  requestMoveBrowseDirectory,
  requestDeleteBrowseDirectory,
  type BrowseActionHost,
  type BrowseActionResult
} from './lib/browse-actions'
