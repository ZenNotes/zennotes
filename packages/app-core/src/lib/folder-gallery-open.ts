/**
 * Which folder a Gallery opener means, for the openers that are not on a
 * folder already (the folder's own menu is): Open Folder Gallery in the
 * palette, the Vim leader key, and a bare `:gallery`.
 *
 * The sidebar row under the cursor wins while the sidebar holds the keyboard
 * (a folder row is that folder, a note row its note's folder), the way the
 * palette's Move Note to Trash follows the sidebar (#972). Otherwise the
 * open note's folder, an open Gallery's own folder, and last the top of the
 * main notes area.
 */
import type { NoteFolder } from '@shared/ipc'
import { useStore } from '../store'
import {
  galleryFolderFromTabPath,
  galleryFolderOfNote,
  resolveGalleryFolderArgument,
  type GalleryFolder
} from './folder-gallery'
import { findLeaf } from './pane-layout'
import { sidebarCursorRow, sidebarHoldsFocus } from './sidebar-note-actions'
import { resolveSystemFolderLabels } from './system-folder-labels'
import { useToastStore } from './toast'

const NOTE_FOLDERS: readonly string[] = ['inbox', 'quick', 'archive', 'trash']

function isNoteFolder(value: string | null): value is NoteFolder {
  return value !== null && NOTE_FOLDERS.includes(value)
}

export function contextGalleryFolder(): GalleryFolder {
  const state = useStore.getState()
  if (typeof document !== 'undefined' && sidebarHoldsFocus(state)) {
    const row = sidebarCursorRow(state.sidebarCursorIndex)
    if (row?.type === 'folder' && isNoteFolder(row.folder)) {
      return { folder: row.folder, subpath: row.subpath ?? '' }
    }
    if (row?.type === 'archive') return { folder: 'archive', subpath: '' }
    if (row?.type === 'note' && row.path) {
      const note = state.notes.find((n) => n.path === row.path)
      if (note) return galleryFolderOfNote(note, state.vaultSettings)
    }
  }
  if (state.activeNote) return galleryFolderOfNote(state.activeNote, state.vaultSettings)
  const open = galleryFolderFromTabPath(findLeaf(state.paneLayout, state.activePaneId)?.activeTab)
  if (open) return open
  return { folder: 'inbox', subpath: '' }
}

/** Open the Gallery of the folder the context means. */
export async function openContextGallery(): Promise<void> {
  const target = contextGalleryFolder()
  await useStore.getState().openFolderGallery(target.folder, target.subpath)
}

/** `:gallery <path>`: the folder the argument names, or a note saying none
 *  does. A bare `:gallery` follows the context. */
export async function openGalleryFromArgument(arg: string): Promise<void> {
  if (!arg.trim()) {
    await openContextGallery()
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
  await state.openFolderGallery(target.folder, target.subpath)
}
