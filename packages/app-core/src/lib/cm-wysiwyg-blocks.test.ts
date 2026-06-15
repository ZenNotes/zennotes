// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { wysiwygBlocksPlugin } from './cm-wysiwyg-blocks'

const DOC = `# Title

- first
- second

> a quote line

---

End.`

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    // Caret at the very end, away from the list / quote / hr.
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdown({ base: markdownLanguage }), wysiwygBlocksPlugin]
    })
  })
  forceParsing(view, doc.length, 5000)
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  return view
}

describe('wysiwygBlocksPlugin', () => {
  it('renders bullets, an hr, and a blockquote bar without throwing', () => {
    const view = mount(DOC)
    expect(view.dom.querySelectorAll('.cm-wq-bullet').length).toBe(2)
    expect(view.dom.querySelector('.cm-wq-hr')).toBeTruthy()
    expect(view.dom.querySelector('.cm-wq-quote')).toBeTruthy()
    view.destroy()
  })

  it('hides the ``` fences when the cursor is outside the code block', () => {
    const view = mount('before\n\n```js\nconst x = 1\n```\n\nafter')
    expect(view.dom.textContent).not.toContain('```js')
    expect(view.dom.textContent).not.toMatch(/```\s*$/)
    expect(view.dom.textContent).toContain('const x = 1')
    view.destroy()
  })

  it('adds a rendered block gap when text runs directly into a code block', () => {
    const view = mount('before\n```js\nconst x = 1\n```\n\nafter')
    expect(view.dom.querySelectorAll('.cm-code-block-gap')).toHaveLength(1)
    view.destroy()
  })

  it('does not add a second block gap when a blank line already separates code', () => {
    const view = mount('before\n\n```js\nconst x = 1\n```\n\nafter')
    expect(view.dom.querySelectorAll('.cm-code-block-gap')).toHaveLength(0)
    view.destroy()
  })

  it('reveals the raw list marker on the active line', () => {
    const view = mount(DOC)
    const firstItem = DOC.indexOf('- first')
    view.dispatch({ selection: { anchor: firstItem + 3 } })
    // The active list line shows its `-`; only the second item stays a bullet.
    expect(view.dom.querySelectorAll('.cm-wq-bullet').length).toBe(1)
    view.destroy()
  })
})
