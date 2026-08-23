import type { EditorState } from '@codemirror/state'

export interface EditorCursorPosition {
  line: number
  column: number
}

/** Return the selection head as the 1-based position shown in editor status bars. */
export function editorCursorPosition(state: EditorState): EditorCursorPosition {
  const line = state.doc.lineAt(state.selection.main.head)
  return {
    line: line.number,
    column: state.selection.main.head - line.from + 1
  }
}
