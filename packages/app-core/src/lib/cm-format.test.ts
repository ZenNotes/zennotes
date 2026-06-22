// @vitest-environment jsdom

import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { setBlockType, toggleWrap, wrapLink } from './cm-format'

const views: EditorView[] = []
function mount(doc: string, from: number, to: number): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: EditorSelection.range(from, to) })
  })
  views.push(view)
  return view
}

afterEach(() => {
  while (views.length) views.pop()!.destroy()
})

describe('toggleWrap', () => {
  it('wraps the selection and keeps it selected', () => {
    const view = mount('hello world', 6, 11) // "world"
    toggleWrap(view, '**')
    expect(view.state.doc.toString()).toBe('hello **world**')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'world'
    )
  })

  it('unwraps when the markers sit just outside the selection', () => {
    const view = mount('hello **world**', 8, 13) // "world" inside the **…**
    toggleWrap(view, '**')
    expect(view.state.doc.toString()).toBe('hello world')
  })

  it('unwraps when the selection itself includes the markers', () => {
    const view = mount('a *italic* b', 2, 10) // "*italic*"
    toggleWrap(view, '*')
    expect(view.state.doc.toString()).toBe('a italic b')
  })

  it('inserts an empty pair with the cursor between on an empty selection', () => {
    const view = mount('x', 1, 1)
    toggleWrap(view, '==')
    expect(view.state.doc.toString()).toBe('x====')
    expect(view.state.selection.main.empty).toBe(true)
    expect(view.state.selection.main.head).toBe(3) // between == and ==
  })

  it('works for the other markers', () => {
    for (const [marker, expected] of [
      ['~~', 'a ~~b~~ c'],
      ['`', 'a `b` c'],
      ['$', 'a $b$ c']
    ] as const) {
      const view = mount('a b c', 2, 3)
      toggleWrap(view, marker)
      expect(view.state.doc.toString()).toBe(expected)
    }
  })
})

describe('setBlockType', () => {
  it('turns a paragraph into a heading', () => {
    const view = mount('hello', 0, 5)
    setBlockType(view, 'h1')
    expect(view.state.doc.toString()).toBe('# hello')
  })

  it('re-types an existing block, replacing its marker', () => {
    const view = mount('## hello', 0, 0)
    setBlockType(view, 'h3')
    expect(view.state.doc.toString()).toBe('### hello')
  })

  it('turns a list item back into plain text', () => {
    const view = mount('- item', 0, 0)
    setBlockType(view, 'paragraph')
    expect(view.state.doc.toString()).toBe('item')
  })

  it('makes a to-do and a quote', () => {
    const todo = mount('task', 0, 4)
    setBlockType(todo, 'todo')
    expect(todo.state.doc.toString()).toBe('- [ ] task')

    const quote = mount('wisdom', 0, 6)
    setBlockType(quote, 'quote')
    expect(quote.state.doc.toString()).toBe('> wisdom')
  })

  it('numbers a multi-line selection sequentially', () => {
    const view = mount('a\nb\nc', 0, 5)
    setBlockType(view, 'numbered')
    expect(view.state.doc.toString()).toBe('1. a\n2. b\n3. c')
  })

  it('preserves indentation when re-typing', () => {
    const view = mount('  - nested', 0, 0)
    setBlockType(view, 'bullet')
    expect(view.state.doc.toString()).toBe('  - nested')
  })

  it('wraps the selection in a fenced code block', () => {
    const view = mount('print(1)', 0, 8)
    setBlockType(view, 'code')
    expect(view.state.doc.toString()).toBe('```\nprint(1)\n```')
  })
})

describe('wrapLink', () => {
  it('wraps the selection as [text]() with the cursor in the parens', () => {
    const view = mount('see docs here', 4, 8) // "docs"
    wrapLink(view)
    expect(view.state.doc.toString()).toBe('see [docs]() here')
    // Cursor sits between ( and ): after "see [docs](" = index 11.
    expect(view.state.selection.main.head).toBe(11)
  })
})
