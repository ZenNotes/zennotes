import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { markdownSnippetTransaction } from './cm-markdown-snippets'

function applySnippet(doc: string, key: string, pos = doc.length): EditorState | null {
  const state = EditorState.create({ doc, selection: { anchor: pos } })
  const transaction = markdownSnippetTransaction(state, key)
  if (!transaction) return null
  return state.update(transaction).state
}

describe('markdownSnippetTransaction', () => {
  it('expands a backtick fence with Enter', () => {
    const state = applySnippet('```', 'Enter')

    expect(state?.doc.toString()).toBe('```\n\n```')
    expect(state?.selection.main.head).toBe(4)
  })

  it('does not expand block snippets with Space', () => {
    expect(applySnippet('```', 'Space')).toBeNull()
    expect(applySnippet('~~~', 'Space')).toBeNull()
    expect(applySnippet('$$', 'Space')).toBeNull()
  })

  it('preserves indentation for block snippets', () => {
    const state = applySnippet('  $$', 'Enter')

    expect(state?.doc.toString()).toBe('  $$\n  \n  $$')
    expect(state?.selection.main.head).toBe(7)
  })

  it('does not expand an already closed block', () => {
    expect(applySnippet('```\nbody\n```', 'Enter', 3)).toBeNull()
  })

  it('expands inline strong markup with Space', () => {
    const state = applySnippet('**', 'Space')

    expect(state?.doc.toString()).toBe('****')
    expect(state?.selection.main.head).toBe(2)
  })

  it('expands wikilinks with Space', () => {
    const state = applySnippet('[[', 'Space')

    expect(state?.doc.toString()).toBe('[[]]')
    expect(state?.selection.main.head).toBe(2)
  })

  it('does not expand inline markup that is already closed', () => {
    expect(applySnippet('****', 'Space', 2)).toBeNull()
  })

  it('does not treat closing delimiters as new openers', () => {
    expect(applySnippet('**text**', 'Space')).toBeNull()
    expect(applySnippet('`code`', 'Space')).toBeNull()
    expect(applySnippet('~~done~~', 'Space')).toBeNull()
    expect(applySnippet('%%comment%%', 'Space')).toBeNull()
  })

  it('still expands a later unmatched delimiter after a closed pair', () => {
    const state = applySnippet('**text** **', 'Space')

    expect(state?.doc.toString()).toBe('**text** ****')
    expect(state?.selection.main.head).toBe(11)
  })

  it('does not handle unrelated keys or text', () => {
    expect(applySnippet('**', 'Enter')).toBeNull()
    expect(applySnippet('hello', 'Space')).toBeNull()
  })
})
