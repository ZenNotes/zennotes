import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { editorCursorPosition } from './editor-cursor-position'

describe('editorCursorPosition — discussion #597', () => {
  it('reports a 1-based line and column from the selection head', () => {
    const state = EditorState.create({
      doc: 'alpha\nbeta\ngamma',
      selection: EditorSelection.single(1, 13)
    })

    expect(editorCursorPosition(state)).toEqual({ line: 3, column: 3 })
  })
})
