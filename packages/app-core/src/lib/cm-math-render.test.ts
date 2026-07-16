// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState, type EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { mathRenderExtension } from './cm-math-render'

function mount(doc: string, selection?: EditorSelection | { anchor: number }): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: selection ?? { anchor: 0 },
      extensions: [markdown({ base: markdownLanguage }), mathRenderExtension]
    })
  })
  forceParsing(view, doc.length, 5000)
  // Nudge a rebuild so decorations reflect the fully parsed tree.
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  return view
}

describe('mathRenderExtension', () => {
  it('renders inline $…$ formulas', () => {
    const view = mount('start\n\nInline $a^2+b^2=c^2$ and $x_1$ here.\n\nend')
    expect(view.dom.querySelectorAll('.cm-math-inline').length).toBe(2)
    view.destroy()
  })

  it('renders block $$…$$ formulas whose fences own their lines', () => {
    const view = mount('start\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nend')
    expect(view.dom.querySelectorAll('.cm-math-block').length).toBe(1)
    view.destroy()
  })

  it('leaves currency literal (space before the closing $)', () => {
    const view = mount('I paid $5 and got $10 back.\n\nend')
    expect(view.dom.querySelectorAll('.cm-math-inline').length).toBe(0)
    view.destroy()
  })

  it('leaves math inside inline code literal', () => {
    const view = mount('Use `$x^2$` verbatim.\n\nend')
    expect(view.dom.querySelectorAll('.cm-math-inline').length).toBe(0)
    view.destroy()
  })

  it('reveals the raw source of the formula under the cursor', () => {
    // Cursor at offset 4 sits inside `$a+b$` (positions 2..7).
    const view = mount('x $a+b$ y', { anchor: 4 })
    expect(view.dom.querySelectorAll('.cm-math-inline').length).toBe(0)
    view.destroy()
  })
})
