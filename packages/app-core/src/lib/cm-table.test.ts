// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { tablePlugin } from './cm-table'

const TABLE_DOC = `Intro text.

| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |

Outro text.`

function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), tablePlugin]
    })
  })
  // Ensure the GFM table node is parsed, then nudge the field to rebuild.
  forceParsing(view, doc.length, 5000)
  view.dispatch({ changes: { from: 0, insert: ' ' } })
  view.dispatch({ changes: { from: 0, to: 1 } })
  return view
}

describe('tablePlugin', () => {
  it('renders a GFM table as an editable table widget without throwing', () => {
    const view = mount(TABLE_DOC)
    const widget = view.dom.querySelector('.cm-table-widget')
    expect(widget).toBeTruthy()
    const cells = widget?.querySelectorAll('.cm-table-cell') ?? []
    // 2 header + 4 body cells.
    expect(cells.length).toBe(6)
    expect(view.dom.textContent).toContain('Alice')
    expect(view.dom.textContent).toContain('Age')
    // One row grip per body row (2), one column grip per column (2).
    expect(widget?.querySelectorAll('.cm-table-row-handle').length).toBe(2)
    expect(widget?.querySelectorAll('.cm-table-col-handle').length).toBe(2)
    view.destroy()
  })

  it('renders a plain doc with no table widget', () => {
    const view = mount('Just a paragraph, no table here.')
    expect(view.dom.querySelector('.cm-table-widget')).toBeNull()
    view.destroy()
  })
})
