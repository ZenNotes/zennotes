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

  it('keeps a half-typed link readable while the target is written (#471)', () => {
    // `[Example](` parses as `Link[0,9]`: the node stops at `]` because the
    // target is unclosed, so the brackets used to be hidden and the label
    // rendered as `Example(`. Nothing collapses until the `)` lands.
    const steps = ['[Example](', '[Example](h', '[Example](https://example.com']
    for (const doc of steps) {
      const view = mountEditor(doc, doc.length)
      expect(view.dom.textContent).toBe(doc)
      view.destroy()
    }

    // The closing paren completes the link: now it renders as the label alone.
    const done = mountEditor('[Example](https://example.com)\n\nfar', 32)
    expect(done.dom.textContent).toContain('Example')
    expect(done.dom.textContent).not.toContain('https://example.com')
    done.destroy()
  })

  it('keeps a pasted URL visible in a half-typed link even off the caret line (#471)', () => {
    // The URL parses as a GFM autolink hanging off the paragraph, not as the
    // link destination. It follows a `(`, which used to be enough to hide it,
    // so the pasted URL disappeared outright.
    const doc = 'see [Example](https://example.com\n\nfar away'
    const view = mountEditor(doc, doc.length)

    expect(view.dom.textContent).toContain('see [Example](https://example.com')

    view.destroy()
  })

  it('treats a half-typed image target the same way (#471)', () => {
    const doc = '![alt](https://example.com'
    const view = mountEditor(doc, doc.length)

    expect(view.dom.textContent).toBe(doc)

    view.destroy()
  })

  it('counts nested parens when deciding a link target is closed (#471)', () => {
    // CommonMark destinations may contain balanced parens, so the first `)`
    // is not necessarily the end of the target.
    const open = '[wiki](https://en.wikipedia.org/wiki/Foo_(bar'
    const half = mountEditor(`${open}\n\nfar`, open.length + 5)
    expect(half.dom.textContent).toContain(open)
    half.destroy()

    const closed = mountEditor(`${open}))\n\nfar`, open.length + 7)
    expect(closed.dom.textContent).toContain('wiki')
    expect(closed.dom.textContent).not.toContain('en.wikipedia.org')
    closed.destroy()
  })

  it('keeps a parenthesised bare URL visible (#471)', () => {
    // `(https://…)` is an autolink wrapped in prose parens, not a link target.
    const doc = 'a (https://parens.example) b\n\nfar away'
    const view = mountEditor(doc, doc.length)

    expect(view.dom.textContent).toContain('a (https://parens.example) b')

    view.destroy()
  })

  it('keeps hiding the destination of a completed link (#471 regression guard)', () => {
    const doc = '[label](https://a.com) tail\n\nfar away'
    const view = mountEditor(doc, doc.length)

    expect(view.dom.textContent).toContain('label tail')
    expect(view.dom.textContent).not.toContain('https://a.com')

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

  it('reveals heading markers with the cursor anywhere in the heading', () => {
    // Consistent with list/quote/task markers: the active line reads as source.
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, doc.indexOf('blocks'))

    expect(view.dom.textContent).toContain('# Code blocks')

    view.destroy()
  })

  it('reveals heading markers when the selection is on the marker', () => {
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, 0)

    expect(view.dom.textContent).toContain('# Code blocks')

    view.destroy()
  })

  it('hides heading markers when the cursor is on another line', () => {
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, doc.indexOf('Body'))

    expect(view.dom.textContent).toContain('Code blocks')
    expect(view.dom.textContent).not.toContain('# Code blocks')

    view.destroy()
  })

  it('hides a standalone block id off-cursor and reveals it on its line (#601)', () => {
    const doc = 'Named paragraph.\n\n^standalone\n\nAfter.'
    const view = mountEditor(doc, doc.indexOf('After'))

    expect(view.dom.textContent).toContain('Named paragraph.')
    expect(view.dom.textContent).not.toContain('^standalone')

    view.dispatch({ selection: { anchor: doc.indexOf('^standalone') + 2 } })
    expect(view.dom.textContent).toContain('^standalone')

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

  it('marks a completed task’s text with cm-task-done and leaves incomplete tasks alone', () => {
    // Cursor on the intro line so both task lines are inactive (rendered). The
    // CSS (gated by the completedTaskStyle setting) then strikes/grays the mark.
    const doc = ['intro', '- [x] finished item', '- [ ] pending item'].join('\n')
    const view = mountEditor(doc, 0)

    const marked = Array.from(view.dom.querySelectorAll('.cm-task-done'))
      .map((el) => el.textContent)
      .join(' ')
    expect(marked).toContain('finished item')
    expect(marked).not.toContain('pending item')

    view.destroy()
  })

  it('renders a `- [/]` in-progress marker without striking the text (#512)', () => {
    // `[/]` parses as a broken link, not a TaskMarker, so the plugin replaces
    // the node itself. Cursor on the intro line keeps the task line inactive.
    const doc = ['intro', '- [/] started item', '- [ ] pending item'].join('\n')
    const view = mountEditor(doc, 0)

    expect(view.dom.querySelectorAll('.cm-task-in-progress-marker')).toHaveLength(1)
    // The raw `[/]` is replaced, and the text after it is untouched: no strike
    // mark (that belongs to done/cancelled), and the content still reads.
    expect(view.dom.textContent).toContain('started item')
    expect(view.dom.textContent).not.toContain('[/]')
    expect(view.dom.querySelectorAll('.cm-task-done')).toHaveLength(0)
    expect(view.dom.querySelectorAll('.cm-task-cancelled')).toHaveLength(0)

    view.destroy()
  })

  it('reveals the raw `[/]` while the cursor is on the line', () => {
    const doc = ['intro', '- [/] started item'].join('\n')
    const view = mountEditor(doc, doc.indexOf('started'))

    expect(view.dom.textContent).toContain('[/]')
    expect(view.dom.querySelectorAll('.cm-task-in-progress-marker')).toHaveLength(0)

    view.destroy()
  })
})
