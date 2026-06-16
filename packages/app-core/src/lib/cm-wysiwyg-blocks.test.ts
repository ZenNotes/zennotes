// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { livePreviewPlugin } from './cm-live-preview'
import { wysiwygBlocksPlugin } from './cm-wysiwyg-blocks'

vi.mock('../store', () => {
  const state = {
    activeNote: null,
    assetFiles: [],
    noteRefs: {},
    pdfEmbedInEditMode: 'compact',
    pinnedRefKind: 'note',
    pinnedRefPath: null,
    vault: null
  }
  const useStore = Object.assign(() => null, {
    getState: () => state,
    subscribe: () => () => {}
  })
  return { useStore }
})

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

function mountLivePreview(doc: string, anchor = doc.length): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), livePreviewPlugin, wysiwygBlocksPlugin]
    })
  })
  forceParsing(view, doc.length, 5000)
  view.focus()
  const nudge = anchor < doc.length ? anchor + 1 : Math.max(0, anchor - 1)
  if (nudge !== anchor) {
    view.dispatch({ selection: { anchor: nudge } })
    view.dispatch({ selection: { anchor } })
  }
  return view
}

describe('wysiwygBlocksPlugin', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

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
    expect(view.dom.querySelectorAll('.cm-wysiwyg-block-gap')).toHaveLength(1)
    view.destroy()
  })

  it('does not add a second block gap when a blank line already separates code', () => {
    const view = mount('before\n\n```js\nconst x = 1\n```\n\nafter')
    expect(view.dom.querySelectorAll('.cm-wysiwyg-block-gap')).toHaveLength(0)
    view.destroy()
  })

  it('adds a block gap before a heading that runs directly under text', () => {
    const view = mount('intro text\n## Heading\n\nbody')
    expect(view.dom.querySelectorAll('.cm-wysiwyg-block-gap')).toHaveLength(1)
    view.destroy()
  })

  it('adds a block gap before a list that runs directly under a paragraph', () => {
    const view = mount('a paragraph\n- first\n- second')
    expect(view.dom.querySelectorAll('.cm-wysiwyg-block-gap')).toHaveLength(1)
    view.destroy()
  })

  it('does not add a block gap before the first block', () => {
    const view = mount('# Title\n\nbody')
    expect(view.dom.querySelectorAll('.cm-wysiwyg-block-gap')).toHaveLength(0)
    view.destroy()
  })

  it('does not stack a block gap on the block right after the H1 rhythm', () => {
    const view = mount('# Title\nbody runs straight into the title')
    expect(view.dom.querySelectorAll('.cm-wysiwyg-block-gap')).toHaveLength(0)
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

  it('hides task list markers when the checkbox widget is rendered', () => {
    const view = mountLivePreview('- [ ] Buy milk\n1. [x] Done')

    expect(view.dom.querySelectorAll('input.cm-task-checkbox-input')).toHaveLength(2)
    expect(view.dom.querySelectorAll('.cm-wq-bullet')).toHaveLength(0)
    expect(view.dom.textContent).not.toContain('-')
    expect(view.dom.textContent).not.toContain('1.')
    expect(view.dom.textContent).not.toContain('[ ]')
    expect(view.dom.textContent).not.toContain('[x]')
    expect(view.dom.textContent).toContain('Buy milk')
    expect(view.dom.textContent).toContain('Done')

    view.destroy()
  })

  it('reveals task list source when the cursor is on the marker', () => {
    const doc = '- [ ] Edit me'
    const view = mountLivePreview(doc, doc.indexOf('[ ]') + 1)

    expect(view.dom.querySelectorAll('input.cm-task-checkbox-input')).toHaveLength(0)
    expect(view.dom.textContent).toContain('- [ ] Edit me')

    view.destroy()
  })
})
