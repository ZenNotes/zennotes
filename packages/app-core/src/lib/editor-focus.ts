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
    caretIntoNewNoteBody(view)
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
 * The hand-off after a note was opened to be read, or a place in one: a pick
 * in one of core's searches (the note search, Search in all notes, the
 * outline, the buffer switcher), or a command that only goes to a note that
 * already exists (Go Back, Reopen Closed Tab, today's daily note when it is
 * there already; see `Command.opensToRead`). Desktop gives the editor the
 * keyboard, so the next keystroke edits or moves in the note, with the same
 * retries the caller would have asked of `focusEditorNormalMode`. A host that
 * opens notes to read (a phone; the editor host's `openNotesToRead`) keeps it
 * down: there the focus is the soft keyboard over half the note, and the user
 * came to read it. The note stays where it opened with every line rendered,
 * and a tap into the text raises the keyboard as always.
 *
 * A palette closing hands the focus back to whatever had it when it opened,
 * which can be the editor itself (an iPhone keeps the focus in the text under
 * a tap on a button). The open still ends with the note read and the keyboard
 * down: that hand-back is undone, a frame on, once the note has landed.
 */
export function focusEditorAfterReadOpen(
  options: { attempts?: number; delayMs?: number } = {}
): void {
  if (!hostOpensNotesToRead()) {
    focusEditorNormalMode(options)
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
 * Closing a palette without a pick: the searches above, the command palette,
 * the template palette, the drawing palette. Desktop gives the editor the
 * keyboard back, as it always has; a host that opens notes to read leaves the
 * focus where the palette returns it, to what had it before the palette
 * opened, so backing out over a note being read keeps the keyboard down and
 * backing out over a note being written keeps it up.
 */
export function focusEditorAfterPaletteClose(): void {
  if (!hostOpensNotesToRead()) focusEditorNormalMode()
}

/**
 * Where the caret goes when a note that holds only its `# Title` heading (one
 * just made) is handed the keyboard: its editor starts with the caret at the
 * very start, so the first keys typed went in front of the heading
 * (`Body# My note`), whether the name field handed off (#214) or a New Note
 * command focused the editor itself. It goes to the end, on the empty line
 * under the heading. Null leaves the caret where it is: a note with more in
 * it, a heading with no line under it, a selection, or a caret already placed.
 */
export function newNoteBodyCaret(text: string, head: number, empty: boolean): number | null {
  if (!empty || head !== 0) return null
  const headingEnd = text.indexOf('\n')
  if (headingEnd === -1 || !/^#\s/.test(text.slice(0, headingEnd))) return null
  if (text.slice(headingEnd).trim() !== '') return null
  return text.length
}

/** Drop the caret into a new note's body as the editor takes the keyboard
 *  (see newNoteBodyCaret). A rename's heading rewrite is a minimal change, so
 *  a caret at the end stays at the end whichever lands first. */
export function caretIntoNewNoteBody(
  view: ReturnType<typeof useStore.getState>['editorViewRef'] = useStore.getState().editorViewRef
): void {
  if (!view?.state) return
  const { main } = view.state.selection
  const at = newNoteBodyCaret(view.state.doc.toString(), main.head, main.empty)
  if (at !== null) view.dispatch({ selection: { anchor: at } })
}
