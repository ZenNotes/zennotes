import { Vim, getCM } from '@replit/codemirror-vim'
import { useStore } from '../store'
import { readSourceRevealEffect } from './cm-source-reveal'
import { hostOpensNotesToRead } from './editor-host'

/**
 * Return focus to the active editor pane, dropping out of vim insert
 * mode if applicable. Palette selections can swap tabs before the new
 * editor view has mounted, so focus is retried briefly instead of
 * falling through to sidebar keyboard navigation.
 */
export function focusEditorNormalMode(
  options: { attempts?: number; delayMs?: number } = {}
): void {
  const attempts = Math.max(1, options.attempts ?? 4)
  const delayMs = Math.max(0, options.delayMs ?? 16)

  const containsFocus = (
    view: NonNullable<ReturnType<typeof useStore.getState>['editorViewRef']>
  ): boolean => {
    if (typeof document === 'undefined') return true
    const active = document.activeElement
    return !!active && (active === view.dom || view.dom.contains(active))
  }

  const scheduleRetry = (remaining: number): void => {
    if (remaining <= 1) return
    window.setTimeout(() => run(remaining - 1), delayMs)
  }

  const run = (remaining: number): void => {
    const state = useStore.getState()
    const view = state.editorViewRef
    state.setFocusedPanel('editor')
    if (!view) {
      scheduleRetry(remaining)
      return
    }
    view.focus()
    if (state.vimMode) {
      const cm = getCM(view)
      if (cm?.state.vim?.insertMode) {
        Vim.exitInsertMode(cm as Parameters<typeof Vim.exitInsertMode>[0], true)
      }
    }
    if (!containsFocus(view)) scheduleRetry(remaining)
  }

  requestAnimationFrame(() => run(attempts))
}

/**
 * The hand-off after a pick in one of core's searches (the note search, Search
 * in all notes, the outline, the buffer switcher) put a note on screen or moved
 * within one. Desktop gives the editor the keyboard, so the next keystroke
 * edits or moves in the note. A host that opens notes to read (a phone; the
 * editor host's `openNotesToRead`) keeps it down: there the focus is the soft
 * keyboard over half the note, and the user came to read what they found. The
 * note stays at the pick with every line rendered, and a tap into the text
 * raises the keyboard as always.
 *
 * A palette closing hands the focus back to whatever had it when it opened,
 * which can be the editor itself (an iPhone keeps the focus in the text under
 * a tap on a button). The pick still ends with the note read and the keyboard
 * down: that hand-back is undone, a frame on, once the pick has landed.
 */
export function focusEditorAfterPick(): void {
  if (!hostOpensNotesToRead()) {
    focusEditorNormalMode()
    return
  }
  requestAnimationFrame(() => {
    const view = useStore.getState().editorViewRef
    if (!view) return
    if (view.hasFocus) view.contentDOM.blur()
    view.dispatch({ effects: readSourceRevealEffect() })
  })
}

/**
 * Closing one of those searches without a pick. Desktop gives the editor the
 * keyboard back, as it always has; a host that opens notes to read leaves the
 * focus where the palette returns it, to what had it before the search, so
 * backing out of a search over a note being read keeps the keyboard down.
 */
export function focusEditorAfterSearchClose(): void {
  if (!hostOpensNotesToRead()) focusEditorNormalMode()
}
