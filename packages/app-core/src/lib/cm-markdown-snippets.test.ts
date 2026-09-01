import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
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

// #405: a fenced/math block opened inside a bullet list must auto-close with the
// content and closing fence indented to the fence column, not escape to col 0.
describe('block snippets inside list items (#405)', () => {
  it('expands a fence in a bullet item, indented to the fence column', () => {
    const state = typeThenTrigger('- ', '```bash', 'Enter')
    expect(state?.doc.toString()).toBe('- ```bash\n  \n  ```')
    expect(state?.selection.main.head).toBe(12) // caret on the indented middle line
  })

  it('indents to the deeper column for a nested list item', () => {
    const state = typeThenTrigger('  - ', '```py', 'Enter')
    expect(state?.doc.toString()).toBe('  - ```py\n    \n    ```')
  })

  it('expands a math block inside a list item too', () => {
    const state = typeThenTrigger('- ', '$$', 'Enter')
    expect(state?.doc.toString()).toBe('- $$\n  \n  $$')
  })

  it('expands a fence inside an ordered list item', () => {
    const state = typeThenTrigger('1. ', '```', 'Enter')
    expect(state?.doc.toString()).toBe('1. ```\n   \n   ```')
  })

  it('does not auto-close the closing fence of an open list block as a new opener', () => {
    // The list fence above is still open; typing its closing ``` must not be
    // mistaken for a new opener (that was the "adds another trio" symptom).
    const doc = '- ```bash\n  code\n  '
    const typed = typeInput(createState(doc, doc.length), '```')
    expect(markdownSnippetTransaction(typed, 'Enter')).toBeNull()
  })

  it('still opens a new fence on a fresh list item after a closed block', () => {
    const state = typeThenTrigger('- ```bash\n  x\n  ```\n- ', '```', 'Enter')
    expect(state?.doc.toString()).toBe('- ```bash\n  x\n  ```\n- ```\n  \n  ```')
  })
})

// #718: no snippet may fire inside code. The plain harness above has no
// markdown parser, so its states carry no FencedCode/InlineCode nodes; this
// one parses the doc the way the real editor does.
describe('markdownSnippetTransaction inside code (#718)', () => {
  function createParsedState(doc: string, pos = doc.length): EditorState {
    const state = EditorState.create({
      doc,
      selection: { anchor: pos },
      extensions: [markdownSnippetExtension(), markdown({ base: markdownLanguage })]
    })
    ensureSyntaxTree(state, state.doc.length, 5000)
    return state
  }

  function parsedTrigger(doc: string, typed: string, key: string, pos = doc.length): EditorState | null {
    let state = createParsedState(doc, pos)
    for (const char of typed) {
      const head = state.selection.main.head
      state = state.update({
        changes: { from: head, to: head, insert: char },
        selection: { anchor: head + 1 },
        userEvent: 'input.type'
      }).state
    }
    ensureSyntaxTree(state, state.doc.length, 5000)
    const transaction = markdownSnippetTransaction(state, key)
    return transaction ? state.update(transaction).state : null
  }

  it('== followed by Space in a fenced code block stays code', () => {
    // The report: typing a comparison in a code block wrapped == into a
    // highlight pair the moment Space followed it.
    expect(parsedTrigger('```js\nif (a ==', '', 'Space')).toBeNull()
  })

  it('other inline pairs stay quiet in a fenced block too', () => {
    expect(parsedTrigger('```\nbold **', '', 'Space')).toBeNull()
    expect(parsedTrigger('```\nstrike ~~', '', 'Space')).toBeNull()
    expect(parsedTrigger('```\ntick `', '', 'Space')).toBeNull()
    expect(parsedTrigger('```\nlink [[', '', 'Space')).toBeNull()
  })

  it('== inside an inline code span stays code', () => {
    const doc = '`a ==` rest'
    expect(parsedTrigger(doc, '', 'Space', doc.indexOf('`', 1))).toBeNull()
  })

  it('$$ typed inside an open fence does not become a math block', () => {
    expect(parsedTrigger('```\n', '$$', 'Enter')).toBeNull()
  })

  it('a fence opener still expands with Enter when the parser is live', () => {
    // The opener line parses as an unclosed FencedCode the moment it is typed;
    // it must stay exempt or the Enter-to-close feature dies with the fix.
    const state = parsedTrigger('', '```', 'Enter')
    expect(state?.doc.toString()).toBe('```\n\n```')
  })

  it('== after a closed code block fires again', () => {
    const state = parsedTrigger('```\nx\n```\n\n==', '', 'Space')
    expect(state?.doc.toString()).toBe('```\nx\n```\n\n====')
  })
})
