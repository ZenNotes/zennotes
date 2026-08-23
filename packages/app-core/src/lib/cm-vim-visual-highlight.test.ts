// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { visualBlockMarkRanges } from './cm-vim-visual-highlight'

describe('Vim visual-block highlight (discussion #597)', () => {
  it('paints every row in a Ctrl+V rectangular selection', () => {
    const state = EditorState.create({ doc: 'alpha\nbeta\ngamma' })
    const ranges = visualBlockMarkRanges(
      state.doc,
      { line: 0, ch: 0 },
      { line: 2, ch: 2 }
    )

    expect(ranges.map((range) => state.doc.sliceString(range.from, range.to))).toEqual([
      'alp',
      'bet',
      'gam'
    ])
  })

  it('clamps the rectangle to short lines without inventing virtual text', () => {
    const state = EditorState.create({ doc: 'alpha\nx\ngamma' })

    expect(
      visualBlockMarkRanges(state.doc, { line: 0, ch: 1 }, { line: 2, ch: 3 }).map((range) =>
        state.doc.sliceString(range.from, range.to)
      )
    ).toEqual(['lph', 'amm'])
  })
})
