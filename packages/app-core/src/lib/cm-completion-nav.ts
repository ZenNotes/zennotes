import {
  acceptCompletion,
  completionStatus,
  moveCompletionSelection,
  selectedCompletion
} from '@codemirror/autocomplete'
import { Prec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * Direction a Ctrl-based chord should move the autocomplete selection,
 * or `null` when the event isn't one of our nav chords.
 *
 *   Ctrl+N / Ctrl+J → 'next'
 *   Ctrl+P / Ctrl+K → 'previous'
 *
 * Pulled out as a pure function so it can be unit-tested without
 * standing up a live EditorView with an open completion tooltip.
 */
export function completionNavDirection(event: KeyboardEvent): 'next' | 'previous' | null {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null
  switch (event.key.toLowerCase()) {
    case 'n':
    case 'j':
      return 'next'
    case 'p':
    case 'k':
      return 'previous'
    default:
      return null
  }
}

/**
 * Vim/Emacs-style navigation for autocomplete tooltips — the `[[`
 * reference picker, slash commands, date shortcuts, template variables.
 *
 * CodeMirror's default `completionKeymap` only binds the arrow keys, so
 * Ctrl+N/Ctrl+P never moved the selection. Worse, Ctrl+P then bubbled to
 * the window-level shortcut handler where, on Linux/Windows, it matches
 * the global "search notes" chord (Mod+P resolves to Ctrl+P) and yanked
 * the user into the search palette instead of moving down the list.
 *
 * We intercept the chord here, but only while a completion is actually
 * open, move the selection, and stop the event so it never reaches the
 * global handler. When no completion is open we return false and the key
 * keeps its normal meaning (e.g. Ctrl+P still opens search).
 *
 * `Prec.highest` ensures this runs before the built-in `completionKeymap`
 * and any other editor keydown handler.
 */
export const completionNavKeymap = Prec.highest(
  EditorView.domEventHandlers({
    keydown: (event, view) => {
      const direction = completionNavDirection(event)
      if (direction) {
        if (completionStatus(view.state) !== 'active') return false
        if (!moveCompletionSelection(direction === 'next')(view)) return false
        event.preventDefault()
        event.stopPropagation()
        return true
      }

      const noMods = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

      // Enter — accept the highlighted completion whenever the popup is open,
      // the universal "menu open → Enter selects" behavior. This must run at
      // `Prec.highest` because the markdown Enter binding
      // (`insertNewlineContinueMarkup`) outranks the built-in completion accept
      // inside a blockquote — so without this, Enter in a callout header
      // (`> [!warn`) continues the quote instead of picking the type. When no
      // completion is open we bail and Enter keeps its normal meaning.
      if (event.key === 'Enter' && noMods) {
        if (completionStatus(view.state) !== 'active') return false
        if (!acceptCompletion(view)) return false
        event.preventDefault()
        event.stopPropagation()
        return true
      }

      // Ctrl+Y — accept the highlighted completion (Vim-style).
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'y'
      ) {
        if (completionStatus(view.state) !== 'active') return false
        if (!acceptCompletion(view)) return false
        event.preventDefault()
        event.stopPropagation()
        return true
      }

      // Tab — accept, but for a note/asset wikilink keep the caret *inside* the
      // `[[…]]` so you can keep typing (e.g. a `#heading` anchor). Headings,
      // slash commands, etc. accept normally; with no completion Tab indents.
      if (event.key === 'Tab' && noMods) {
        if (completionStatus(view.state) !== 'active') return false
        const completion = selectedCompletion(view.state) as
          | { _kind?: string; _target?: string }
          | null
        if (!acceptCompletion(view)) return false
        const keepsLinkOpen = completion?._kind === 'wikilink' && completion._target != null
        if (keepsLinkOpen) {
          const pos = view.state.selection.main.head
          if (view.state.doc.sliceString(pos - 2, pos) === ']]') {
            view.dispatch({ selection: { anchor: pos - 2 } })
          }
        }
        event.preventDefault()
        event.stopPropagation()
        return true
      }

      return false
    }
  })
)
