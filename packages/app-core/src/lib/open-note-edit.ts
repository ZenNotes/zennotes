import { useStore } from '../store'
import { minimalTextChange } from './minimal-text-change'

/**
 * Apply `edit` to a note that is open, then save it. A note in the focused
 * editor takes the edit as a transaction, so `u` / Mod+Z takes it back like
 * any other change; any other open note (a background tab, another pane) takes
 * it through the store. Either way the buffer, unsaved typing included, is
 * what gets edited: writing the file instead would be overwritten by the
 * buffer's next save.
 *
 * Resolves true when the text changed, false when the note is not open, the
 * edit changed nothing, or the note is locked for editing.
 */
export async function editOpenNote(
  path: string,
  edit: (body: string) => string,
  userEvent: string
): Promise<boolean> {
  const state = useStore.getState()
  const content = state.noteContents[path]
  if (!content) return false
  const next = edit(content.body)
  if (next === content.body) return false
  const view = state.editorViewRef
  const viaEditor =
    !!view && state.selectedPath === path && !view.state.readOnly && view.state.doc.toString() === content.body
  if (view && viaEditor) {
    const change = minimalTextChange(content.body, next)
    if (change) view.dispatch({ changes: change, userEvent })
  } else {
    state.updateNoteBody(path, next)
  }
  // The editor's update listener has already handed the body to the store.
  if (useStore.getState().noteContents[path]?.body !== next) return false
  await useStore.getState().persistNote(path)
  return true
}
