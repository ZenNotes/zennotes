// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { livePreviewPlugin } from './cm-live-preview'
import { useStore } from '../store'

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

  it('keeps the colon visible in a reference-link definition (#188)', () => {
    // The `:` parses as a LinkMark; live preview must not hide it, or the
    // definition reads as a broken `[label] url`.
    const doc = 'intro\n\n[Markdown Lang]: https://www.markdownlang.com'
    const view = mountEditor(doc, 0) // cursor on "intro" → definition line inactive

    expect(view.dom.textContent).toContain('[Markdown Lang]: https://www.markdownlang.com')

    view.destroy()
  })

  it('keeps heading markers hidden when editing the heading text', () => {
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, doc.indexOf('Code'))

    expect(view.dom.textContent).toContain('Code blocks')
    expect(view.dom.textContent).not.toContain('# Code blocks')

    view.destroy()
  })

  it('reveals heading markers when the selection is on the marker', () => {
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, 0)

    expect(view.dom.textContent).toContain('# Code blocks')

    view.destroy()
  })

  it('replaces an unchecked task marker with a checkbox widget', () => {
    // Cursor on the intro line — the task line is inactive, so it renders.
    const doc = 'intro\n\n- [ ] Buy milk'
    const view = mountEditor(doc, 0)

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
    const doc = 'intro\n\n- [x] Done\n- [X] Also done'
    const view = mountEditor(doc, 0)

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
    const doc = 'intro\n\n- [ ] Buy milk'
    const view = mountEditor(doc, 0)

    const input = view.dom.querySelector<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(input).toBeTruthy()
    input!.click()

    expect(view.state.doc.toString()).toBe('intro\n\n- [x] Buy milk')

    view.destroy()
  })

  it('toggles back to unchecked from a `[x]` marker', () => {
    const doc = 'intro\n\n- [x] Already done'
    const view = mountEditor(doc, 0)

    const input = view.dom.querySelector<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(input).toBeTruthy()
    input!.click()

    expect(view.state.doc.toString()).toBe('intro\n\n- [ ] Already done')

    view.destroy()
  })

  it('collapses the host-line strut on a hidden-source image, restores it when editing (#261)', () => {
    // The image widget is an inline (side:1) decoration, so its host line would
    // otherwise reserve a full text line-box above/below the block figure. The
    // plugin stamps `cm-image-embed-line` only while the source is hidden.
    const store = useStore.getState() as unknown as {
      vault: unknown
      activeNote: unknown
      assetFiles: Array<{ path: string }>
    }
    const original = { vault: store.vault, activeNote: store.activeNote, assetFiles: store.assetFiles }
    ;(window as unknown as { zen: unknown }).zen = {
      resolveVaultAssetUrl: () => 'asset://pic.png',
      resolveLocalAssetUrl: () => 'asset://pic.png'
    }
    store.vault = { root: '/vault' }
    store.activeNote = { path: 'inbox/Image Note.md' }
    store.assetFiles = [{ path: 'inbox/pic.png' }]
    try {
      const doc = 'Above\n\n![sample](pic.png)\n\nBelow'
      const view = mountEditor(doc, 0) // cursor on "Above" → image line inactive

      const figure = view.dom.querySelector('.cm-local-image-embed')
      expect(figure).toBeTruthy()
      const hostLine = figure!.closest('.cm-line')
      expect(hostLine?.classList.contains('cm-image-embed-line')).toBe(true)
      // Raw markdown stays hidden while the line is inactive.
      expect(view.dom.textContent).not.toContain('![sample](pic.png)')

      // Move the caret onto the image line: source revealed, strut class gone.
      view.dispatch({ selection: { anchor: doc.indexOf('![sample]') + 2 } })
      expect(view.dom.textContent).toContain('![sample](pic.png)')
      const revealed = [...view.dom.querySelectorAll('.cm-line')].find((l) =>
        (l.textContent || '').includes('![sample](pic.png)')
      )
      expect(revealed).toBeTruthy()
      expect(revealed!.classList.contains('cm-image-embed-line')).toBe(false)

      view.destroy()
    } finally {
      store.vault = original.vault
      store.activeNote = original.activeNote
      store.assetFiles = original.assetFiles
      delete (window as unknown as { zen?: unknown }).zen
    }
  })

  it('renders checkboxes for ordered, nested, and quoted tasks', () => {
    // Task variants the TASK_LINE_RE in shared/tasklists supports. Cursor on
    // the intro line so every task line is inactive (and thus rendered).
    const doc = ['intro', '1. [ ] Ordered', '   - [x] Nested', '> - [ ] Quoted'].join('\n')
    const view = mountEditor(doc, 0)

    const inputs = view.dom.querySelectorAll<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(inputs).toHaveLength(3)
    expect(inputs[0]?.checked).toBe(false)
    expect(inputs[1]?.checked).toBe(true)
    expect(inputs[2]?.checked).toBe(false)

    view.destroy()
  })
})
