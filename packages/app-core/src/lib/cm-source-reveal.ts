import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type SelectionRange
} from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * Which lines live preview gives back their Markdown source.
 *
 * Live preview draws a note as it reads and shows the source markers (a
 * heading's `#`, `**`, `[[ ]]`, `==`, `$$`, a callout's `[!type]`, a fence)
 * where the user is editing, which it always took to mean the lines the
 * selection covers. But an editor has a selection whether or not anyone is
 * editing in it: a note opened to be read keeps its caret parked on line 1,
 * so a phone that opened a note with the keyboard down showed its title as a
 * raw `# Title`, and so did desktop's reference pane and a hovered link's
 * preview.
 *
 * So the selection's lines reveal their source only once the editor has taken
 * the keyboard focus since its note opened; until then every line renders.
 * The first focus turns revealing on, and a later blur leaves it on: a
 * palette, a menu or a dialog opening over a note being edited must not
 * redraw the line under the caret (and on a phone, the keyboard going down
 * while editing is not the end of editing). A note put into an editor in
 * place of another starts over, unless the editor holds the focus as it
 * changes (a tab switch or a followed link from the keyboard), where the
 * user is still editing.
 *
 * Desktop focuses the editor when it opens a note, and the focus is taken up
 * at once, not on CodeMirror's own focus notification ten milliseconds later:
 * by then a frame with the caret's line rendered could already be on screen,
 * and every opened note would flicker its first line.
 *
 * An editor without this extension reveals on the selection's lines as it
 * always did.
 */

/** Turns revealing on (the editor took the focus) or off (a new note). */
const setRevealing = StateEffect.define<boolean>()

const revealingField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setRevealing)) value = effect.value
    return value
  }
})

function reading(state: EditorState): boolean {
  return state.field(revealingField, false) === false
}

export const sourceRevealExtension: Extension = [
  revealingField,
  // CodeMirror's own notice of the focus, the path for every focus the
  // observer below did not already take up.
  EditorView.focusChangeEffect.of((state, focusing) =>
    focusing && reading(state) ? setRevealing.of(true) : null
  ),
  EditorView.domEventObservers({
    focus(_event, view) {
      if (!reading(view.state)) return
      // A microtask: it runs after this event's other listeners (a phone shell
      // that turns the focus straight back is one) and before the frame paints.
      queueMicrotask(() => {
        if (view.hasFocus && reading(view.state)) {
          view.dispatch({ effects: setRevealing.of(true) })
        }
      })
    }
  })
]

/**
 * The selection ranges whose lines and spans show their source: every range
 * once the editor is being edited, none while its note is being read.
 */
export function revealedSelectionRanges(state: EditorState): readonly SelectionRange[] {
  return reading(state) ? [] : state.selection.ranges
}

/** True when an update or transaction turned revealing on or off: the
 *  decorations that read `revealedSelectionRanges` redraw on it, the way they
 *  redraw on a selection change. */
export function sourceRevealChanged(update: {
  readonly startState: EditorState
  readonly state: EditorState
}): boolean {
  return reading(update.startState) !== reading(update.state)
}

/** For the transaction that puts another note into an editor: the new note is
 *  read until the editor takes the focus, unless the editor holds it already. */
export function sourceRevealForNewNote(view: EditorView): StateEffect<boolean> {
  return setRevealing.of(view.hasFocus)
}

/** A note left to be read (a phone's search pick): every line renders again
 *  until the next focus. */
export function readSourceRevealEffect(): StateEffect<boolean> {
  return setRevealing.of(false)
}
