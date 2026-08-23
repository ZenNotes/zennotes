import type { EditorView } from '@codemirror/view'
import { getCM } from '@replit/codemirror-vim'

/**
 * Vim owns selections while it is in normal or visual mode. Showing the
 * generic formatting bubble for those ranges obscures visual-block feedback
 * and makes Ctrl+V look like a "Turn into" shortcut (discussion #597).
 */
export function shouldShowSelectionToolbar(view: EditorView, vimMode: boolean): boolean {
  if (!vimMode) return true
  return getCM(view)?.state.vim?.insertMode === true
}
