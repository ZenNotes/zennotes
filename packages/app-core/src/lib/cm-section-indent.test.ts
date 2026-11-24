import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { sectionHeadingsForTest } from './cm-section-indent'

describe('section headings in the editor', () => {
  it('finds headings by line and skips a # line inside a code fence', () => {
    const doc = ['# Top', 'text', '## Sub', '```', '# not a heading', '```', '### Deeper'].join('\n')
    const state = EditorState.create({ doc, extensions: [markdown()] })
    ensureSyntaxTree(state, state.doc.length, 1000)
    expect(sectionHeadingsForTest(state)).toEqual([
      { line: 1, level: 1 },
      { line: 3, level: 2 },
      { line: 7, level: 3 }
    ])
  })
})
