// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { wikilinkRenderExtension } from './cm-wikilink-render'

function mount(doc: string, anchor: number): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), wikilinkRenderExtension]
    })
  })
}

/** Mount and force a full markdown parse so code-context detection is reliable. */
function mountParsed(doc: string, anchor: number): EditorView {
  const view = mount(doc, anchor)
  forceParsing(view, doc.length, 5000)
  // Nudge a no-op change so decorations rebuild against the parsed tree.
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  return view
}

describe('wikilinkRenderExtension', () => {
  it('hides the [[ ]] brackets and shows the label, with the target on the mark', () => {
    const doc = 'see [[Foo]] and [[Bar|baz]] end'
    const view = mount(doc, doc.length)
    const links = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-wikilink'))
    expect(links.map((e) => e.textContent)).toEqual(['Foo', 'baz'])
    expect(links.map((e) => e.dataset.target)).toEqual(['Foo', 'Bar'])
    expect(view.dom.textContent).not.toContain('[[')
    expect(view.dom.textContent).not.toContain('Bar|')
    view.destroy()
  })

  it('reveals the raw [[...]] on the wikilink the cursor is in', () => {
    const doc = 'see [[Foo]] end'
    const view = mount(doc, doc.indexOf('Foo'))
    expect(view.dom.textContent).toContain('[[Foo]]')
    view.destroy()
  })

  it('leaves embeds (![[...]]) alone', () => {
    const doc = 'pic ![[image.png]] end'
    const view = mount(doc, doc.length)
    expect(view.dom.querySelector('.cm-wikilink')).toBeNull()
    view.destroy()
  })

  it('leaves [[...]] inside an inline code span as literal code (#248)', () => {
    const doc = 'use `[[Linux-Backup]]` here'
    const view = mountParsed(doc, doc.length)
    expect(view.dom.querySelector('.cm-wikilink')).toBeNull()
    expect(view.dom.textContent).toContain('[[Linux-Backup]]')
    view.destroy()
  })

  it('leaves [[...]] inside a fenced code block as literal code (#248)', () => {
    const doc = '```\n[[Foo]]\n```'
    const view = mountParsed(doc, doc.length)
    expect(view.dom.querySelector('.cm-wikilink')).toBeNull()
    expect(view.dom.textContent).toContain('[[Foo]]')
    view.destroy()
  })

  it('still renders a real [[wikilink]] outside code', () => {
    const doc = 'see [[Foo]] and `[[Bar]]` end'
    const view = mountParsed(doc, doc.length)
    const links = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-wikilink'))
    expect(links.map((e) => e.textContent)).toEqual(['Foo'])
    view.destroy()
  })
})
