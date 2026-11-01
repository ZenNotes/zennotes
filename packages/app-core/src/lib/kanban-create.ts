/**
 * Where New Kanban puts the board when it is not run from a folder's own
 * menu (#1038): the palette, `Space k`, and `:kanban`.
 *
 * The sidebar row under the cursor wins while the sidebar holds the keyboard
 * (a folder row is that folder, a note row its note's folder), as it does
 * for the Gallery. Otherwise the board goes where new databases go
 * (Settings → Vault → Default Locations). Only a folder in the
 * notes area takes one: a board in Quick Notes, the Archive or the Trash, or
 * inside another database's `.base` folder, would be filed somewhere nobody
 * looks for it.
 */
import { isFormDirName } from '@shared/databases'
import { useStore } from '../store'
import {
  galleryFolderOfNote,
  resolveGalleryFolderArgument,
  type GalleryFolder
} from './folder-gallery'
import { sidebarCursorRow, sidebarHoldsFocus } from './sidebar-note-actions'
import { resolveSystemFolderLabels } from './system-folder-labels'
import { useToastStore } from './toast'

/** True when a Kanban created in `target` lands in the notes area, outside
 *  any database folder. */
export function canHoldKanban(target: GalleryFolder): boolean {
  if (target.folder !== 'inbox') return false
  return !target.subpath.split('/').some((segment) => isFormDirName(segment))
}

/** The folder under the sidebar cursor, while the sidebar has the keyboard
 *  and that folder can hold a Kanban; null means "where databases go". */
export function contextKanbanFolder(): GalleryFolder | null {
  const state = useStore.getState()
  if (typeof document === 'undefined' || !sidebarHoldsFocus(state)) return null
  const row = sidebarCursorRow(state.sidebarCursorIndex)
  let target: GalleryFolder | null = null
  if (row?.type === 'folder' && row.folder === 'inbox') {
    target = { folder: 'inbox', subpath: row.subpath ?? '' }
  } else if (row?.type === 'note' && row.path) {
    const note = state.notes.find((n) => n.path === row.path)
    if (note) target = galleryFolderOfNote(note, state.vaultSettings)
  }
  return target && canHoldKanban(target) ? target : null
}

/** New Kanban from the palette or `Space k`. */
export async function newContextKanban(): Promise<void> {
  const target = contextKanbanFolder()
  const state = useStore.getState()
  if (target) await state.createKanban(target.folder, target.subpath)
  else await state.newKanban()
}

/** `:kanban <folder>`: a board in the folder the argument names. A bare
 *  `:kanban` follows the context. */
export async function newKanbanFromArgument(arg: string): Promise<void> {
  if (!arg.trim()) {
    await newContextKanban()
    return
  }
  const state = useStore.getState()
  const target = resolveGalleryFolderArgument(
    arg,
    state.folders,
    state.vaultSettings,
    resolveSystemFolderLabels(state.systemFolderLabels)
  )
  if (!target) {
    useToastStore.getState().addToast(`No folder called "${arg.trim()}" in this vault`, 'info')
    return
  }
  if (!canHoldKanban(target)) {
    useToastStore.getState().addToast(`A Kanban can't go in "${arg.trim()}"`, 'info')
    return
  }
  await state.createKanban(target.folder, target.subpath)
}
