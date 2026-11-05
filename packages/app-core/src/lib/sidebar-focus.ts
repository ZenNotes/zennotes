import type { NoteFolder } from '@shared/ipc'
import { useStore } from '../store'

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
