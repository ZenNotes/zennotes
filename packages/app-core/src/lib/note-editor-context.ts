import type { EditorView } from '@codemirror/view'

// A selected path can change before React updates the editor. Keep the view's
// actual path available to integrations without publishing the view itself.
const noteEditors = new WeakMap<EditorView, { path: () => string | null; paneId: string }>()

export function registerNoteEditor(view: EditorView, path: () => string | null, paneId: string): void {
  noteEditors.set(view, { path, paneId })
}

export function noteEditorMatches(view: EditorView, path: string, paneId: string): boolean {
  const registered = noteEditors.get(view)
  return registered?.paneId === paneId && registered.path() === path
}

/** The note path a registered editor shows right now, or null. */
export function noteEditorPath(view: EditorView): string | null {
  return noteEditors.get(view)?.path() ?? null
}
