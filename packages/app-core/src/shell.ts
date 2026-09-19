import { noteTagsForCount } from './lib/tags'
import { resolveTypstPreambleFolder } from './lib/typst-preamble'
import { useSyncExternalStore } from 'react'
import type {
  NoteFolder,
  NoteMeta,
  VaultInfo,
  WorkspaceMode
} from '@bridge-contract/ipc'
import { formDirContaining } from '@shared/databases'
import { resolveFolderPath } from '@shared/system-folder-paths'
import { useStore } from './store'
import { parentDirOf } from './lib/manual-order'
import { browseNoteComparator, type NoteSortOrder } from './lib/note-order'
import { notePathWithinFolder } from './lib/vault-layout'

export type { NoteSortOrder } from './lib/note-order'

export interface ShellNote {
  readonly path: string
  readonly title: string
  readonly folder: NoteFolder
  /** Parent directory relative to this note's logical folder; empty at its root. */
  readonly directory: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ShellSnapshot {
  /** Display/change metadata. Persist native state under the host's stable vault token. */
  readonly vault: Readonly<VaultInfo> | null
  readonly workspaceMode: WorkspaceMode
  /** Workspace restoration state; native note-index readiness remains host-owned. */
  readonly workspaceRestored: boolean
  readonly notes: readonly ShellNote[]
  readonly selectedPath: string | null
  /** Null for Home, virtual pages, or a path absent from the note index. */
  readonly selectedNote: ShellNote | null
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly noteSortOrder: NoteSortOrder
  /**
   * The vault's Favorites in display order, as stored in vault settings: a
   * note's path, or an opaque key for a favorited folder. `includes(path)`
   * answers whether a note is a favorite; toggle through
   * `requestToggleNoteFavorite`. (#810)
   */
  readonly favorites: readonly string[]
}

let notesSource: readonly NoteMeta[] | undefined
let notesLayout = ''
let notes: readonly ShellNote[] = Object.freeze([])
let vault: ShellSnapshot['vault'] = null
let favorites: readonly string[] = Object.freeze([])
let snapshot: ShellSnapshot | undefined

// Every settings save rebuilds the favorites array, so compare contents:
// a saved folder color must not wake shell subscribers over unchanged
// favorites.
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Read frozen shell metadata, without note bodies, credentials, or mutable store values. */
export function getShellSnapshot(): ShellSnapshot {
  const state = useStore.getState()
  const settings = state.vaultSettings
  const layout = JSON.stringify([
    settings.primaryNotesLocation,
    ...(['inbox', 'quick', 'archive', 'trash'] as const).map((folder) =>
      resolveFolderPath(folder, settings.systemFolderPaths)
    )
  ])
  if (notesSource !== state.notes || notesLayout !== layout) {
    notesSource = state.notes
    notesLayout = layout
    notes = Object.freeze(
      state.notes.map((note) =>
        Object.freeze({
          path: note.path,
          title: note.title,
          folder: note.folder,
          directory: parentDirOf(
            notePathWithinFolder(note.path, note.folder, settings)
          ),
          createdAt: note.createdAt,
          updatedAt: note.updatedAt
        })
      )
    )
  }
  if (!state.vault) vault = null
  else if (
    vault?.root !== state.vault.root ||
    vault.name !== state.vault.name ||
    vault.temporary !== state.vault.temporary
  ) {
    vault = Object.freeze({
      root: state.vault.root,
      name: state.vault.name,
      temporary: state.vault.temporary
    })
  }
  if (!sameStrings(favorites, settings.favorites)) {
    favorites = Object.freeze([...settings.favorites])
  }
  const next: ShellSnapshot = {
    vault,
    notes,
    workspaceMode: state.workspaceMode,
    workspaceRestored: state.workspaceRestored && !state.workspaceTransitioning,
    selectedPath: state.selectedPath,
    selectedNote:
      snapshot?.notes === notes && snapshot.selectedPath === state.selectedPath
        ? snapshot.selectedNote
        : (notes.find((note) => note.path === state.selectedPath) ?? null),
    canGoBack: state.noteBackstack.length > 0,
    canGoForward: state.noteForwardstack.length > 0,
    noteSortOrder: state.noteSortOrder,
    favorites
  }
  if (
    !snapshot ||
    (Object.keys(next) as Array<keyof ShellSnapshot>).some(
      (key) => next[key] !== snapshot![key]
    )
  ) {
    snapshot = Object.freeze(next)
  }
  return snapshot
}

/** Notify after a public snapshot changes. Does not emit an initial notification. */
export function subscribeShell(
  listener: (snapshot: ShellSnapshot, previous: ShellSnapshot) => void
): () => void {
  let previous = getShellSnapshot()
  return useStore.subscribe(() => {
    // An earlier subscriber can synchronously correct a transition, such as the
    // Home guard after a rescan. Read current state rather than a stale event.
    const next = getShellSnapshot()
    if (next === previous) return
    const before = previous
    previous = next
    listener(next, before)
  })
}

function subscribeReact(notify: () => void): () => void {
  return subscribeShell(() => notify())
}

export function useShellSnapshot(): ShellSnapshot {
  return useSyncExternalStore(
    subscribeReact,
    getShellSnapshot,
    getShellSnapshot
  )
}

/** Immediate primary-folder notes in mobile Browse order. Pins remain host-owned. */
export function getBrowseNotes(
  snapshot: Pick<ShellSnapshot, 'notes' | 'noteSortOrder'>,
  directory = '',
  pinnedPaths: readonly string[] = []
): readonly ShellNote[] {
  if (formDirContaining(directory)) return Object.freeze([])
  const rows = snapshot.notes
    .filter((note) => note.folder === 'inbox' && note.directory === directory)
    .sort(browseNoteComparator(snapshot.noteSortOrder))
  const pins = new Set(pinnedPaths)
  return Object.freeze([
    ...rows.filter((note) => pins.has(note.path)),
    ...rows.filter((note) => !pins.has(note.path))
  ])
}

/** Find a Browse sibling without opening it or wrapping at either end. */
export function getAdjacentNotePath(
  snapshot: ShellSnapshot,
  path: string,
  direction: 'previous' | 'next',
  pinnedPaths: readonly string[] = []
): string | null {
  const note = snapshot.notes.find((note) => note.path === path)
  if (!note || note.folder !== 'inbox') return null
  const rows = getBrowseNotes(snapshot, note.directory, pinnedPaths)
  const index = rows.findIndex((note) => note.path === path)
  return index < 0
    ? null
    : (rows[index + (direction === 'next' ? 1 : -1)]?.path ?? null)
}


export interface TagPresenceSnapshot {
  readonly vaultRoot: string | null
  readonly hasTags: boolean
}
let tagNotes: unknown, tagActive: unknown, tagFolder: string | undefined
let tagPresence: TagPresenceSnapshot | undefined
/** Tag presence includes the live editor and excludes Typst preambles. */
export function getTagPresenceSnapshot(): TagPresenceSnapshot {
  const state = useStore.getState()
  const folder = resolveTypstPreambleFolder(state.vaultSettings.typstPreambles?.folder)
  if (tagNotes === state.notes && tagActive === state.activeNote && tagFolder === folder && tagPresence?.vaultRoot === (state.vault?.root ?? null)) return tagPresence!
  tagNotes = state.notes; tagActive = state.activeNote; tagFolder = folder
  const hasTags = state.notes.some(note => note.folder !== 'trash' && noteTagsForCount(note, state.activeNote, folder).length > 0)
  const vaultRoot = state.vault?.root ?? null
  if (!tagPresence || tagPresence.vaultRoot !== vaultRoot || tagPresence.hasTags !== hasTags)
    tagPresence = Object.freeze({ vaultRoot, hasTags })
  return tagPresence
}
export function subscribeTagPresence(listener: (next: TagPresenceSnapshot) => void): () => void {
  let previous = getTagPresenceSnapshot()
  return useStore.subscribe(() => {
    const next = getTagPresenceSnapshot()
    if (next === previous) return
    previous = next; listener(next)
  })
}
export function setNoteSortOrder(order: NoteSortOrder): void { useStore.getState().setNoteSortOrder(order) }
