import type { NoteFolder } from '@shared/ipc'
import { useStore } from '../store'
import { sidebarRevealTarget } from './vault-layout'

/**
 * Hand the keyboard to the sidebar for real: set the focused panel AND move
 * DOM focus into the sidebar container. Mirrors focusEditorNormalMode's
 * retry: a closing modal (command palette) restores focus to whatever held
 * it before opening on unmount, which can be a self-keyed surface like the
 * database grid. That restore both re-steals the keys and re-claims the
 * focused panel, so a single unretried focus() loses the race and "Focus
 * Sidebar" silently does nothing.
 */
export function focusSidebarPanel(
  options: { attempts?: number; delayMs?: number } = {}
): void {
  const attempts = Math.max(1, options.attempts ?? 4)
  const delayMs = Math.max(0, options.delayMs ?? 16)

  // The store write happens NOW, not inside the rAF: the palette's run
  // epilogue reads focusedPanel right after the command returns to decide
  // whether to hand focus to the editor, and a deferred write makes it see
  // the old 'editor' value and start a competing focus-retry loop that the
  // sidebar then loses.
  useStore.getState().setFocusedPanel('sidebar')

  const run = (remaining: number): void => {
    useStore.getState().setFocusedPanel('sidebar')
    const aside = document.querySelector<HTMLElement>('[data-zen-sidebar]')
    aside?.focus()
    const settled =
      !!aside && !!document.activeElement && aside.contains(document.activeElement)
    if (!settled && remaining > 1) {
      window.setTimeout(() => run(remaining - 1), delayMs)
    }
  }

  requestAnimationFrame(() => run(attempts))
}

/**
 * Goes to a system folder that has no page of its own: its row, opened and under
 * the cursor. The note list shows a folder when that layout is on; without it,
 * `setView` changed nothing on screen except the title and the status bar, which
 * went blank while the note stayed open.
 */
export function revealSystemFolderInSidebar(folder: NoteFolder): void {
  const state = useStore.getState()
  if (!state.unifiedSidebar && state.noteListOpen) {
    state.setView({ kind: 'folder', folder, subpath: '' })
    return
  }
  if (!state.sidebarOpen) state.toggleSidebar()
  const key = `${folder}:`
  if (state.collapsedFolders.includes(key)) {
    state.setCollapsedFolders(state.collapsedFolders.filter((other) => other !== key))
  }
  focusSidebarPanel()
  // After the render the focus causes, whose reveal puts the cursor on the open note.
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(
      `[data-sidebar-type="folder"][data-sidebar-key="${key}"]`
    )
    const idx = Number(row?.dataset.sidebarIdx)
    if (Number.isFinite(idx)) useStore.getState().setSidebarCursorIndex(idx)
    row?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * Goes to a note's row: its folders opened and the cursor on it, or on the nearest
 * folder when the row is not drawn (a long folder's list is windowed). The folder
 * comes from the vault's layout, never from the path's first segment, which names
 * nothing in a vault that keeps its notes at the root or has moved a system folder.
 */
export function revealNoteInSidebar(path: string): void {
  const state = useStore.getState()
  const target = sidebarRevealTarget(path, state.vaultSettings)
  if (!target) return
  const subpath = target.parts.slice(0, -1).join('/')
  if (!state.unifiedSidebar && state.noteListOpen) {
    state.setView({ kind: 'folder', folder: target.folder, subpath })
    return
  }
  if (!state.sidebarOpen) state.toggleSidebar()
  const closed = new Set(target.ancestors)
  const expanded = state.collapsedFolders.filter((key) => !closed.has(key))
  if (expanded.length !== state.collapsedFolders.length) state.setCollapsedFolders(expanded)
  focusSidebarPanel()
  requestAnimationFrame(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-sidebar-idx]')]
    const row =
      rows.find((el) => el.dataset.sidebarType === 'note' && el.dataset.sidebarPath === path) ??
      rows.find(
        (el) =>
          el.dataset.sidebarType === 'folder' &&
          el.dataset.sidebarKey === `${target.folder}:${subpath}`
      )
    const idx = Number(row?.dataset.sidebarIdx)
    if (Number.isFinite(idx)) useStore.getState().setSidebarCursorIndex(idx)
    row?.scrollIntoView({ block: 'nearest' })
  })
}
