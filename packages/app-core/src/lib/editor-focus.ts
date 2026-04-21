import { Vim, getCM } from '@replit/codemirror-vim'
import { useStore } from '../store'

/**
 * Return focus to the active editor pane, dropping out of vim insert
 * mode if applicable. Shared by every surface that wants to hand the
 * keyboard back to the editor (rename commit, escape from preview).
 */
export function focusEditorNormalMode(): void {
  requestAnimationFrame(() => {
    const state = useStore.getState()
    const view = state.editorViewRef
    state.setFocusedPanel('editor')
    if (!view) return
    view.focus()
    if (state.vimMode) {
      const cm = getCM(view)
      if (cm?.state.vim?.insertMode) {
        Vim.exitInsertMode(cm as Parameters<typeof Vim.exitInsertMode>[0], true)
      }
    }
  })
}
