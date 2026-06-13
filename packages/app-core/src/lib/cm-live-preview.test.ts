// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { livePreviewPlugin } from './cm-live-preview'

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

function mountEditor(doc: string, anchor: number): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), livePreviewPlugin]
    })
  })
}

describe('livePreviewPlugin', () => {
  it('reveals link markdown only when the selection is inside the link', () => {
    const doc = 'Paragraph start with a [visible link](https://example.com) and trailing text.'
    const view = mountEditor(doc, 0)

    expect(view.dom.textContent).toContain('visible link')
    expect(view.dom.textContent).not.toContain('https://example.com')

    view.dispatch({
      selection: { anchor: doc.indexOf('visible link') + 2 }
    })

    expect(view.dom.textContent).toContain('[visible link](https://example.com)')

    view.destroy()
  })

  it('reveals heading markers when the cursor is anywhere on the heading line', () => {
    // Obsidian-style: the active line shows its raw source, so the leading
    // `# ` reappears even when the caret is on the heading text (not the mark).
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, doc.indexOf('Code'))

    expect(view.dom.textContent).toContain('# Code blocks')

    view.destroy()
  })

  it('reveals heading markers when the selection is on the marker', () => {
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, 0)

    expect(view.dom.textContent).toContain('# Code blocks')

    view.destroy()
  })

  it('replaces an unchecked task marker with a checkbox widget', () => {
    const doc = '- [ ] Buy milk'
    // Cursor at end of line, off the marker.
    const view = mountEditor(doc, doc.length)

    const inputs = view.dom.querySelectorAll<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.checked).toBe(false)
    // The raw `[ ]` is replaced by the widget, so it's no longer in the
    // rendered text. The task body remains.
    expect(view.dom.textContent).not.toContain('[ ]')
    expect(view.dom.textContent).toContain('Buy milk')

    view.destroy()
  })

  it('replaces a checked task marker with a checked checkbox', () => {
    const doc = '- [x] Done\n- [X] Also done'
    const view = mountEditor(doc, doc.length)

    const inputs = view.dom.querySelectorAll<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.checked).toBe(true)
    expect(inputs[1]?.checked).toBe(true)
    expect(view.dom.textContent).not.toContain('[x]')
    expect(view.dom.textContent).not.toContain('[X]')

    view.destroy()
  })

  it('reveals the raw marker when the cursor lands inside it', () => {
    const doc = '- [ ] Edit me'
    // Position 3 sits between `[` and `]` — i.e. on the state character.
    const view = mountEditor(doc, 3)

    expect(view.dom.querySelectorAll('input.cm-task-checkbox-input')).toHaveLength(0)
    expect(view.dom.textContent).toContain('[ ]')

    view.destroy()
  })

  it('toggles the underlying marker when the checkbox is clicked', () => {
    const doc = '- [ ] Buy milk'
    const view = mountEditor(doc, doc.length)

    const input = view.dom.querySelector<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(input).toBeTruthy()
    input!.click()

    expect(view.state.doc.toString()).toBe('- [x] Buy milk')

    view.destroy()
  })

  it('toggles back to unchecked from a `[x]` marker', () => {
    const doc = '- [x] Already done'
    const view = mountEditor(doc, doc.length)

    const input = view.dom.querySelector<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(input).toBeTruthy()
    input!.click()

    expect(view.state.doc.toString()).toBe('- [ ] Already done')

    view.destroy()
  })

  it('renders checkboxes for ordered, nested, and quoted tasks', () => {
    // Task variants the TASK_LINE_RE in shared/tasklists supports.
    const doc = ['1. [ ] Ordered', '   - [x] Nested', '> - [ ] Quoted'].join('\n')
    const view = mountEditor(doc, doc.length)

    const inputs = view.dom.querySelectorAll<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(inputs).toHaveLength(3)
    expect(inputs[0]?.checked).toBe(false)
    expect(inputs[1]?.checked).toBe(true)
    expect(inputs[2]?.checked).toBe(false)

    view.destroy()
  })
})
