// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetMeta, NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { wikilinkRenderExtension } from './cm-wikilink-render'

const createNoteFromLinkNow = vi.hoisted(() => vi.fn())
const offerCreateNoteFromLink = vi.hoisted(() => vi.fn())
vi.mock('./create-note-from-link', () => ({ createNoteFromLinkNow, offerCreateNoteFromLink }))

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

// #768: a wikilink at a note that does not exist yet is drawn apart from a live
// one, and a modifier click on it creates the note without the prompt.
describe('wikilinkRenderExtension: unresolved links (#768)', () => {
  const note = (path: string, title: string): NoteMeta =>
    ({ path, title, folder: 'inbox' }) as unknown as NoteMeta

  afterEach(() => {
    useStore.setState({ notes: [], assetFiles: [], selectedPath: null })
    createNoteFromLinkNow.mockClear()
    offerCreateNoteFromLink.mockClear()
  })

  it('marks a link whose note is missing, and leaves a resolved one alone', () => {
    useStore.setState({ notes: [note('inbox/Foo.md', 'Foo')] })
    const doc = 'see [[Foo]] and [[Nope]] and [[#Heading]] end'
    const view = mount(doc, doc.length)
    const links = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-wikilink'))
    expect(links.map((e) => [e.textContent, e.classList.contains('cm-wikilink-broken')])).toEqual([
      ['Foo', false],
      ['Nope', true],
      ['#Heading', false]
    ])
    view.destroy()
  })

  it('treats a wikilink at a vault file as live, not as a note to create', () => {
    useStore.setState({
      assetFiles: [{ path: 'assets/diagram.png' }] as unknown as AssetMeta[],
      selectedPath: 'inbox/Current.md'
    })
    const doc = 'see [[assets/diagram.png]] end'
    const view = mount(doc, doc.length)
    const link = view.dom.querySelector<HTMLElement>('.cm-wikilink')
    expect(link?.classList.contains('cm-wikilink-broken')).toBe(false)
    view.destroy()
  })

  it('re-decorates when the note arrives, without an edit', () => {
    const doc = 'see [[Later]] end'
    const view = mount(doc, doc.length)
    expect(view.dom.querySelector('.cm-wikilink-broken')).not.toBeNull()

    useStore.setState({ notes: [note('inbox/Later.md', 'Later')] })

    expect(view.dom.querySelector('.cm-wikilink')).not.toBeNull()
    expect(view.dom.querySelector('.cm-wikilink-broken')).toBeNull()
    view.destroy()
  })

  it('creates the note at once on a Cmd/Ctrl click, and asks on a plain click', () => {
    const doc = 'see [[Nope]] end'
    const view = mount(doc, doc.length)
    const link = view.dom.querySelector<HTMLElement>('.cm-wikilink')!

    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: true }))
    expect(createNoteFromLinkNow).toHaveBeenCalledWith('Nope')
    expect(offerCreateNoteFromLink).not.toHaveBeenCalled()

    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(offerCreateNoteFromLink).toHaveBeenCalledWith('Nope')
    view.destroy()
  })
})
