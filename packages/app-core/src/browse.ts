import { useSyncExternalStore } from 'react'
import type {
  AssetMeta,
  FolderEntry,
  ImportedAssetKind,
  VaultSettings
} from '@bridge-contract/ipc'
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
import { browseNoteComparator } from './lib/note-order'
import { assetBelongsToFolderView, assetFolderSubpath } from './lib/vault-layout'
import { assetTabPath } from './lib/asset-tabs'

export interface BrowseFolder {
  /** Relative to the primary notes area, not the vault root. */
  readonly directory: string
  readonly title: string
}

export interface BrowseDatabase extends BrowseFolder {
  /** Opaque application path; pass to the public navigation openNote action. */
  readonly path: string
}

/** A file other than a note or drawing, as the desktop sidebar lists it in its folder. */
export interface BrowseFile {
  /** Opaque application path; pass to the public navigation openNote action. */
  readonly path: string
  /** The folder holding the file, relative to the primary notes area; empty at its root. */
  readonly directory: string
  /** The file name with its extension. */
  readonly name: string
  readonly kind: ImportedAssetKind
  readonly updatedAt: number
}

export interface BrowseSnapshot {
  /** Display/change metadata. Native persistence uses the host's stable vault token. */
  readonly vault: ShellSnapshot['vault']
  readonly folders: readonly BrowseFolder[]
  readonly databases: readonly BrowseDatabase[]
  readonly notes: readonly ShellNote[]
  readonly files: readonly BrowseFile[]
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
  readonly files: readonly BrowseFile[]
}

let folderSource: readonly FolderEntry[] | undefined
let primaryDirectory = ''
let folders: readonly BrowseFolder[] = Object.freeze([])
let databases: readonly BrowseDatabase[] = Object.freeze([])
let fileSource: readonly AssetMeta[] | undefined
let fileLayout = ''
let files: readonly BrowseFile[] = Object.freeze([])
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
  // Every system folder's directory decides where a file belongs, not only
  // the primary one: a file under a remapped archive is the archive's.
  const layout = JSON.stringify([
    settings.primaryNotesLocation,
    ...(['inbox', 'quick', 'archive', 'trash'] as const).map((folder) =>
      resolveFolderPath(folder, settings.systemFolderPaths)
    )
  ])
  if (fileSource !== state.assetFiles || fileLayout !== layout) {
    fileSource = state.assetFiles
    fileLayout = layout
    const rows = browseFiles(state.assetFiles, settings)
    // Any non-note change re-reads the whole file index into a new array.
    // The same files read back keep the delivered rows, so subscribers are
    // not woken for nothing.
    if (!sameFiles(rows, files)) files = Object.freeze(rows)
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
    files,
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

/**
 * The desktop sidebar's files for the primary tree (its buildTree): the root
 * asset folders, the other system folders and `.zennotes` never reach a
 * folder, and a file inside a database stays out like the database's records.
 */
function browseFiles(assets: readonly AssetMeta[], settings: VaultSettings): BrowseFile[] {
  const rows: BrowseFile[] = []
  for (const asset of assets) {
    if (!assetBelongsToFolderView(asset, 'inbox', '', settings)) continue
    const directory = assetFolderSubpath(asset, settings)
    if (formDirContaining(directory)) continue
    rows.push(
      Object.freeze({
        path: assetTabPath(asset.path),
        directory,
        name: asset.name,
        kind: asset.kind,
        updatedAt: asset.updatedAt
      })
    )
  }
  return rows
}

function sameFiles(a: readonly BrowseFile[], b: readonly BrowseFile[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, index) => {
      const other = b[index]
      return (
        row.path === other.path &&
        row.directory === other.directory &&
        row.name === other.name &&
        row.kind === other.kind &&
        row.updatedAt === other.updatedAt
      )
    })
  )
}

/** Files follow the note sort. They carry no creation time, so the created
 *  orders use their last change, as the desktop note list orders files. */
function browseFileComparator(order: NoteSortOrder): (a: BrowseFile, b: BrowseFile) => number {
  const compare = browseNoteComparator(order)
  const sortable = (row: BrowseFile) => ({
    title: row.name,
    updatedAt: row.updatedAt,
    createdAt: row.updatedAt
  })
  return (a, b) => compare(sortable(a), sortable(b))
}

/** Immediate mobile Browse rows, with separate folder, database, note, and file groups. */
export function getBrowseDirectory(
  snapshot: BrowseSnapshot,
  directory = '',
  pins: BrowsePins = {}
): BrowseDirectory {
  if (formDirContaining(directory))
    return Object.freeze({
      folders: Object.freeze([]),
      databases: Object.freeze([]),
      notes: Object.freeze([]),
      files: Object.freeze([])
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
    notes: getBrowseNotes(snapshot, directory, pins.notes),
    files: Object.freeze(
      snapshot.files
        .filter((row) => row.directory === directory)
        .sort(browseFileComparator(snapshot.noteSortOrder))
    )
  })
}

export {
  createBrowseDatabase,
  openBrowseFolderGallery,
  requestRenameBrowseDatabase,
  requestCreateBrowseFolder,
  requestCreateBrowseNote,
  requestRenameBrowseFolder,
  requestMoveBrowseDirectory,
  requestDeleteBrowseDirectory,
  type BrowseActionHost,
  type BrowseActionResult
} from './lib/browse-actions'
