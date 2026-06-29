import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { markdownSnippetExtension, markdownSnippetTransaction } from './cm-markdown-snippets'

function createState(doc: string, pos = doc.length): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [markdownSnippetExtension()]
  })
}

function typeInput(state: EditorState, text: string): EditorState {
  const pos = state.selection.main.head
  return state.update({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'input.type'
  }).state
}

function typeChars(state: EditorState, text: string): EditorState {
  let next = state
  for (const char of text) next = typeInput(next, char)
  return next
}

function selectionOnlyUpdate(state: EditorState): EditorState {
  return state.update({
    selection: { anchor: state.selection.main.head }
  }).state
}

function triggerSnippet(state: EditorState, key: string): EditorState | null {
  const transaction = markdownSnippetTransaction(state, key)
  if (!transaction) return null
  return state.update(transaction).state
}

function typeThenTrigger(doc: string, typed: string, key: string, pos = doc.length): EditorState | null {
  return triggerSnippet(typeInput(createState(doc, pos), typed), key)
}

function applySnippet(doc: string, key: string, pos = doc.length): EditorState | null {
  return triggerSnippet(createState(doc, pos), key)
}

describe('markdownSnippetTransaction', () => {
  it('expands a backtick fence with Enter', () => {
    const state = typeThenTrigger('', '```', 'Enter')

    expect(state?.doc.toString()).toBe('```\n\n```')
    expect(state?.selection.main.head).toBe(4)
  })

  it('expands a backtick fence after character-by-character typing', () => {
    const state = triggerSnippet(typeChars(createState(''), '```'), 'Enter')

    expect(state?.doc.toString()).toBe('```\n\n```')
    expect(state?.selection.main.head).toBe(4)
  })

  it('keeps a pending block snippet across selection-only updates', () => {
    const state = triggerSnippet(selectionOnlyUpdate(typeChars(createState(''), '```')), 'Enter')

    expect(state?.doc.toString()).toBe('```\n\n```')
    expect(state?.selection.main.head).toBe(4)
  })

  it('does not expand block snippets with Space', () => {
    expect(applySnippet('```', 'Space')).toBeNull()
    expect(applySnippet('~~~', 'Space')).toBeNull()
    expect(applySnippet('$$', 'Space')).toBeNull()
  })

  it('preserves indentation for block snippets', () => {
    const state = typeThenTrigger('', '  $$', 'Enter')

    expect(state?.doc.toString()).toBe('  $$\n  \n  $$')
    expect(state?.selection.main.head).toBe(7)
  })

  it('does not expand an already closed block', () => {
    expect(applySnippet('```\nbody\n```', 'Enter', 3)).toBeNull()
  })

  it('does not treat a closing block delimiter as a new opener', () => {
    expect(typeThenTrigger('```\ncode\n', '```', 'Enter')).toBeNull()
    expect(typeThenTrigger('``` js\ncode\n', '```', 'Enter')).toBeNull()
    expect(typeThenTrigger('```js\ncode\n', '```', 'Enter')).toBeNull()
    expect(typeThenTrigger('$$\nmath\n', '$$', 'Enter')).toBeNull()
  })

  it('still expands a later block delimiter after a closed block', () => {
    const state = typeThenTrigger('```\ncode\n```\n', '```', 'Enter')

    expect(state?.doc.toString()).toBe('```\ncode\n```\n```\n\n```')
    expect(state?.selection.main.head).toBe(17)
  })

  it('expands after a prior fenced code block with an info string', () => {
    const state = typeThenTrigger('```ts\nconst mode = "preview"\n```\n', '```', 'Enter')

    expect(state?.doc.toString()).toBe('```ts\nconst mode = "preview"\n```\n```\n\n```')
  })

  it('expands before an existing fenced code block with an info string', () => {
    const doc = '\n```ts\nconst mode = "preview"\n```'
    const state = typeThenTrigger(doc, '```', 'Enter', 0)

    expect(state?.doc.toString()).toBe('```\n\n```\n```ts\nconst mode = "preview"\n```')
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
