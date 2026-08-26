// @vitest-environment jsdom

import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appMarkdownSnippetExtension } from './markdown-snippets-config'
import { useStore } from '../store'

// #468: verify the Backspace keymap wiring end-to-end — pressing Backspace
// between empty formatting markers must delete the whole pair, winning over the
// default single-character delete.

const views: EditorView[] = []
function mount(doc: string, cursor: number): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      // Real composition order: our extension before the default keymap.
      extensions: [appMarkdownSnippetExtension(), keymap.of(defaultKeymap)]
    })
  })
  views.push(view)
  return view
}

function pressBackspace(view: EditorView): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 8, bubbles: true, cancelable: true })
  )
}

beforeEach(() => {
  // The handler is gated by `isTyping` (Vim off, or Vim insert mode); the store
  // defaults to Vim on. Drive the non-Vim path for this wiring test.
  useStore.setState({ vimMode: false })
})

afterEach(() => {
  while (views.length) views.pop()!.destroy()
  useStore.setState({ vimMode: true })
})

describe('#468 — Backspace deletes the whole empty formatting snippet', () => {
  it('removes both markers of `**|**` in one press', () => {
    const view = mount('****', 2)
    pressBackspace(view)
    expect(view.state.doc.toString()).toBe('')
  })

  it('removes `` `|` `` inline code in one press', () => {
    const view = mount('``', 1)
    pressBackspace(view)
    expect(view.state.doc.toString()).toBe('')
  })

  it('falls back to the default single-char delete for a non-empty snippet', () => {
    const view = mount('**b**', 3) // cursor after the b — not an empty pair
    pressBackspace(view)
    // Default backspace removes one char (the b), leaving the markers.
    expect(view.state.doc.toString()).toBe('****')
  })
})

// #678: with auto-pairs on (the store default) the pair rule also answers
// Backspace between `(` and `)`; the whole-scaffold rule must win the race.
describe('#678 — Backspace inside an empty `[](|)` link removes the whole scaffold', () => {
  it('beats the auto-pair rule from the URL hole', () => {
    const view = mount('See []()', 7)
    pressBackspace(view)
    expect(view.state.doc.toString()).toBe('See ')
    expect(view.state.selection.main.head).toBe(4)
  })

  it('beats the auto-pair rule from the text hole', () => {
    const view = mount('[]()', 1)
    pressBackspace(view)
    expect(view.state.doc.toString()).toBe('')
  })

  it('still lets auto-pairs delete `()` once the link has text', () => {
    const view = mount('[docs]()', 7)
    pressBackspace(view)
    expect(view.state.doc.toString()).toBe('[docs]')
  })
})
