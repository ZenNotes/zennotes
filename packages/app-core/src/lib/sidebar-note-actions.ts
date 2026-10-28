/**
 * Moving notes to the Trash (and the Archive) from the sidebar by keyboard
 * (#972).
 *
 * The keys: `x` (nav.delete) with Vim on, and Mod+Backspace
 * (nav.sidebarTrash) in either mode, act on the row under the sidebar's
 * cursor while the sidebar holds focus. The palette's Move Note to Trash and
 * Move Note to Archive, and a key the user gave either of them (#971), follow
 * the same row while the sidebar holds focus and its cursor is on a note,
 * instead of the note open in the editor.
 *
 * What each row does:
 * - A note: Move to Trash, after the same confirm the Archive view and the
 *   palette show. A note already in the Trash is deleted for good, after the
 *   Trash view's confirm (keys only; the palette command says it is there
 *   already).
 * - A note inside a multi-selection: the whole selection, with one confirm
 *   ("Move 3 notes to Trash?"), through the batch path the sidebar's
 *   selection menu uses.
 * - A folder: nothing, and a note says why. Deleting a folder takes
 *   everything inside with it and cannot be undone, while the same key on a
 *   note is a reversible move; one key meaning both on rows that sit side by
 *   side is how a j/k walk ends in a deleted folder. The folder menu keeps it.
 * - Any other row (a tag, Tasks, the Trash row itself): nothing, and a note.
 *
 * The sidebar owns its selection (React state), so it registers a host here
 * that hands over a snapshot of it, clears it after a batch, and holds the
 * cursor in place while the action runs (closing the trashed note's tab
 * changes the open note, which the sidebar would otherwise reveal).
 */
import type { NoteFolder, NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { runNoteBatchAction, runNoteLifecycleAction } from './note-lifecycle-actions'
import { resolveSystemFolderLabels } from './system-folder-labels'
import { useToastStore } from './toast'
import { isChordEvent, matchesShortcut, type KeymapOverrides } from './keymaps'
import { chordHeldByApp, listViewBindingMatches } from './list-view-keys'
import { commandKeymapsStandDown } from './command-keymap-dispatch'

export type SidebarNoteAction = 'trash' | 'archive'

/** What a sidebar row is, read off its data attributes. */
export interface SidebarRowRef {
  type: string | null
  path: string | null
  folder: string | null
  subpath: string | null
}

/** The sidebar's multi-selection, as the planner needs it. */
export interface SidebarSelectionSnapshot {
  /** Selected rows, notes and folders together. */
  count: number
  /** Every selected note's path. */
  notePaths: ReadonlySet<string>
  /** The selected notes a batch acts on: the selection menu's own set, which
   *  leaves out notes inside a selected folder. */
  actionNotePaths: readonly string[]
  /** Selected folders. */
  folderCount: number
}

export type SidebarNotePlan =
  | {
      kind: 'run'
      action: 'trash' | 'delete' | 'archive'
      paths: string[]
      /** True when the selection is the target: one confirm for all, and the
       *  selection clears afterwards. */
      batch: boolean
    }
  | { kind: 'refuse'; reason: string }

type FolderLabels = Record<NoteFolder, string>

export function readSidebarRow(el: Element | null | undefined): SidebarRowRef | null {
  if (!el) return null
  return {
    type: el.getAttribute('data-sidebar-type'),
    path: el.getAttribute('data-sidebar-path'),
    folder: el.getAttribute('data-sidebar-folder'),
    subpath: el.getAttribute('data-sidebar-subpath')
  }
}

/** The row under the sidebar's cursor, or null when no row has its number. */
export function sidebarCursorRow(
  cursorIndex: number,
  root: ParentNode = document
): SidebarRowRef | null {
  if (!Number.isInteger(cursorIndex) || cursorIndex < 0) return null
  return readSidebarRow(root.querySelector(`[data-sidebar-idx="${cursorIndex}"]`))
}

const isLive = (folder: NoteFolder): boolean => folder !== 'trash'
const isArchivable = (folder: NoteFolder): boolean => folder === 'inbox' || folder === 'quick'

/**
 * What an action on the note row at `path` does. `permanentForTrashed` is
 * the keys' rule (a trashed note is deleted for good); the palette's Move
 * Note to Trash refuses instead, since its name says what it does.
 */
export function planSidebarNoteAction(input: {
  action: SidebarNoteAction
  path: string
  notes: readonly Pick<NoteMeta, 'path' | 'folder'>[]
  selection: SidebarSelectionSnapshot | null
  labels: FolderLabels
  vimMode: boolean
  permanentForTrashed: boolean
}): SidebarNotePlan {
  const { action, path, labels } = input
  const folderOf = new Map(input.notes.map((note) => [note.path, note.folder]))
  const folder = folderOf.get(path)
  if (!folder) return { kind: 'refuse', reason: 'That note is no longer in the vault' }

  const selection = input.selection
  if (selection && selection.count > 1 && selection.notePaths.has(path)) {
    if (selection.folderCount > 0) {
      return {
        kind: 'refuse',
        reason: `The selection includes folders, which can't go to the ${labels.trash}. Use the selection's menu (${menuKey(input.vimMode)}) instead`
      }
    }
    const candidates = selection.actionNotePaths.filter((p) => folderOf.has(p))
    if (action === 'archive') {
      const archivable = candidates.filter((p) => isArchivable(folderOf.get(p)!))
      if (archivable.length === 0) {
        return {
          kind: 'refuse',
          reason: `None of the selected notes is in ${labels.inbox} or ${labels.quick}`
        }
      }
      return { kind: 'run', action: 'archive', paths: archivable, batch: archivable.length > 1 }
    }
    const live = candidates.filter((p) => isLive(folderOf.get(p)!))
    if (live.length > 0) {
      return { kind: 'run', action: 'trash', paths: live, batch: live.length > 1 }
    }
    if (!input.permanentForTrashed) {
      return { kind: 'refuse', reason: `These notes are already in the ${labels.trash}` }
    }
    return { kind: 'run', action: 'delete', paths: candidates, batch: candidates.length > 1 }
  }

  if (action === 'archive') {
    if (isArchivable(folder)) return { kind: 'run', action: 'archive', paths: [path], batch: false }
    return {
      kind: 'refuse',
      reason:
        folder === 'archive'
          ? `This note is already in the ${labels.archive}`
          : `Move Note to ${labels.archive} works on a note in ${labels.inbox} or ${labels.quick}`
    }
  }
  if (isLive(folder)) return { kind: 'run', action: 'trash', paths: [path], batch: false }
  if (!input.permanentForTrashed) {
    return { kind: 'refuse', reason: `This note is already in the ${labels.trash}` }
  }
  return { kind: 'run', action: 'delete', paths: [path], batch: false }
}

function menuKey(vimMode: boolean): string {
  return vimMode ? 'm' : 'right-click'
}

/** Why the keys do nothing on a row that is not a note. */
export function sidebarRowRefusal(
  row: SidebarRowRef | null,
  labels: FolderLabels,
  vimMode: boolean
): string {
  if (row?.type === 'folder' && row.subpath) {
    return `A folder can't go to the ${labels.trash}. Delete it from its menu (${menuKey(vimMode)}); that can't be undone`
  }
  return `Only a note can go to the ${labels.trash} from here`
}

/* ------------------------------------------------------------------------ */
/* The sidebar's side                                                        */
/* ------------------------------------------------------------------------ */

export interface SidebarActionHost {
  selection: () => SidebarSelectionSnapshot
  clearSelection: () => void
  /** Run an action with the sidebar's cursor held where its anchoring puts
   *  it: a change of open note while it runs is not a pick to reveal. */
  holdCursor: <T>(run: () => Promise<T>) => Promise<T>
}

let host: SidebarActionHost | null = null

/** The sidebar registers itself on mount; the returned function unregisters. */
export function registerSidebarActionHost(next: SidebarActionHost): () => void {
  host = next
  return () => {
    if (host === next) host = null
  }
}

interface SidebarFocusState {
  focusedPanel: string | null
  sidebarOpen: boolean
  sidebarCursorIndex: number
}

/** The sidebar holds the keyboard: the panel the keys route to. */
export function sidebarHoldsFocus(state: SidebarFocusState): boolean {
  return state.focusedPanel === 'sidebar' && state.sidebarOpen
}

function folderLabels(): FolderLabels {
  const labels = resolveSystemFolderLabels(useStore.getState().systemFolderLabels)
  return { inbox: labels.inbox, quick: labels.quick, archive: labels.archive, trash: labels.trash }
}

/**
 * The plan for a palette command while the sidebar holds focus with its
 * cursor on a note row, or null when the sidebar does not own the target
 * (the command then acts on the open note, as it always has).
 */
export function sidebarCommandPlan(action: SidebarNoteAction): SidebarNotePlan | null {
  if (typeof document === 'undefined') return null
  const state = useStore.getState()
  if (!sidebarHoldsFocus(state)) return null
  const row = sidebarCursorRow(state.sidebarCursorIndex)
  if (row?.type !== 'note' || !row.path) return null
  return planSidebarNoteAction({
    action,
    path: row.path,
    notes: state.notes,
    selection: host?.selection() ?? null,
    labels: folderLabels(),
    vimMode: state.vimMode,
    permanentForTrashed: false
  })
}

/** Carry out a plan: the confirm, the move, a cleared selection after a
 *  batch, or the note that says why nothing happened. */
export async function runSidebarNotePlan(plan: SidebarNotePlan): Promise<boolean> {
  if (plan.kind === 'refuse') {
    useToastStore.getState().addToast(plan.reason, 'info')
    return false
  }
  const run = async (): Promise<boolean> => {
    if (plan.batch) {
      const ok = await runNoteBatchAction(plan.paths, plan.action)
      if (ok) host?.clearSelection()
      return ok
    }
    const result = await runNoteLifecycleAction(plan.paths[0], plan.action)
    return result === 'completed'
  }
  return host ? host.holdCursor(run) : run()
}

/** Trash (or delete for good) what the sidebar's cursor is on, as the keys
 *  do. A row that is not a note gets a note saying so. */
export async function trashSidebarCursorRow(): Promise<boolean> {
  const state = useStore.getState()
  const labels = folderLabels()
  const row = sidebarCursorRow(state.sidebarCursorIndex)
  if (row?.type !== 'note' || !row.path) {
    useToastStore.getState().addToast(sidebarRowRefusal(row, labels, state.vimMode), 'info')
    return false
  }
  return runSidebarNotePlan(
    planSidebarNoteAction({
      action: 'trash',
      path: row.path,
      notes: state.notes,
      selection: host?.selection() ?? null,
      labels,
      vimMode: state.vimMode,
      permanentForTrashed: true
    })
  )
}

/* ------------------------------------------------------------------------ */
/* Keys                                                                      */
/* ------------------------------------------------------------------------ */

/** Whether the keydown is one of the sidebar's trash keys: Mod+Backspace
 *  (or what it was rebound to) in either mode, and `x` (nav.delete) with Vim
 *  on, or in either mode when it was rebound to a chord. */
export function isSidebarTrashKey(
  event: KeyboardEvent,
  overrides: KeymapOverrides | null | undefined,
  vimMode: boolean
): boolean {
  return (
    matchesShortcut(event, overrides, 'nav.sidebarTrash') ||
    listViewBindingMatches(event, overrides, 'nav.delete', vimMode)
  )
}

type SidebarKeyState = SidebarFocusState &
  Parameters<typeof commandKeymapsStandDown>[0] & {
    keymapOverrides: KeymapOverrides
    vimMode: boolean
  }

/**
 * The capture-phase handler for the chord forms of the trash keys. Returns
 * true when it took the key.
 *
 * Typed keys (`x`) are VimNav's, after its leader and pane-prefix machinery,
 * so `Space x` still reaches a leader binding; this listener only takes a
 * chord or a named key such as Delete, in either mode.
 */
export function handleSidebarTrashChord(
  event: KeyboardEvent,
  getState: () => SidebarKeyState,
  run: () => unknown = trashSidebarCursorRow
): boolean {
  if (event.isComposing) return false
  if (!isChordEvent(event) && event.key.length === 1) return false
  const state = getState()
  if (!sidebarHoldsFocus(state)) return false
  if (!isSidebarTrashKey(event, state.keymapOverrides, state.vimMode)) return false
  if (commandKeymapsStandDown(state)) return false
  // A global shortcut keeps its key here too (see list-view-keys.ts).
  if (chordHeldByApp(event, state.keymapOverrides, state.vimMode)) return false
  // Focus in a text field or the editor is typing, whatever the store's
  // panel says: Mod+Backspace there deletes text.
  const target = event.target instanceof HTMLElement ? event.target : null
  if (
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  ) {
    return false
  }
  event.preventDefault()
  event.stopImmediatePropagation()
  // Holding the chord must not trash row after row.
  if (event.repeat) return true
  void run()
  return true
}

let installed: (() => void) | null = null

/**
 * Install the chord listener once on `window`, capture phase. App calls it at
 * import time, after the command keymap dispatcher (a key the user gave a
 * command still wins) and before any component's listener, so a list view
 * that stays active behind a focused sidebar never sees the chord first.
 */
export function installSidebarTrashKeys(getState: () => SidebarKeyState): () => void {
  if (installed) return installed
  if (typeof window === 'undefined') return () => {}
  const listener = (event: KeyboardEvent): void => {
    handleSidebarTrashChord(event, getState)
  }
  window.addEventListener('keydown', listener, true)
  installed = () => {
    window.removeEventListener('keydown', listener, true)
    installed = null
  }
  return installed
}
