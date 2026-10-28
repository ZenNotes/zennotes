// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { livePreviewPlugin } from './cm-live-preview'
import { highlightExtension } from './cm-highlight'
import { mathRenderExtension } from './cm-math-render'
import {
  readSourceRevealEffect,
  revealedSelectionRanges,
  sourceRevealExtension,
  sourceRevealForNewNote
} from './cm-source-reveal'

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

const NOTE = '# Garden plan\n\nThe **tomatoes** go in the sunny bed.\n\n## Herbs\n\nBasil and thyme.'

const views: EditorView[] = []
function mount(doc: string, extensions: Extension[] = [sourceRevealExtension]): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdown({ base: markdownLanguage }), livePreviewPlugin, ...extensions]
    })
  })
  forceParsing(view, doc.length, 1000)
  views.push(view)
  return view
}

const firstLine = (view: EditorView): string | null =>
  view.contentDOM.querySelector('.cm-line')?.textContent ?? null
const lineText = (view: EditorView, n: number): string | null =>
  view.contentDOM.querySelectorAll('.cm-line')[n - 1]?.textContent ?? null
/** The microtask the focus observer queues, and nothing later. */
const microtasks = (): Promise<void> => Promise.resolve().then(() => undefined)

beforeEach(() => {
  // jsdom reports no window focus; CodeMirror's hasFocus asks for it.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => {
  while (views.length) views.pop()!.destroy()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('source reveal', () => {
  it('renders the selection line of a note that has not been focused', () => {
    const view = mount(NOTE)
    expect(view.state.selection.main.head).toBe(0)
    expect(firstLine(view)).toBe('Garden plan')
    expect(revealedSelectionRanges(view.state)).toEqual([])
  })

  it('an editor without the extension reveals on the selection line as it always did', () => {
    const view = mount(NOTE, [])
    expect(firstLine(view)).toBe('# Garden plan')
    expect(revealedSelectionRanges(view.state)).toEqual(view.state.selection.ranges)
  })

  it('the first focus reveals the line before the frame paints, not on the 10 ms focus notice', async () => {
    vi.useFakeTimers()
    try {
      const view = mount(NOTE)
      view.focus()
      expect(view.hasFocus).toBe(true)
      await microtasks()
      // No timer has run: this is the focus observer, not CodeMirror's
      // delayed focus-change transaction.
      expect(firstLine(view)).toBe('# Garden plan')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a blur keeps revealing, so a palette over a note being edited redraws nothing', async () => {
    const view = mount(NOTE)
    view.focus()
    await microtasks()
    view.dispatch({ selection: { anchor: NOTE.indexOf('Herbs') } })
    expect(lineText(view, 5)).toBe('## Herbs')
    view.contentDOM.blur()
    await new Promise((r) => setTimeout(r, 30))
    expect(view.hasFocus).toBe(false)
    expect(lineText(view, 5)).toBe('## Herbs')
    expect(firstLine(view)).toBe('Garden plan')
  })

  it('a focus turned straight back by the host never reveals', async () => {
    const view = mount(NOTE)
    // A phone shell's read-open guard undoes a focus that lands while held.
    const refuse = (event: FocusEvent): void => {
      if (event.target === view.contentDOM) view.contentDOM.blur()
    }
    document.addEventListener('focusin', refuse, true)
    try {
      view.focus()
      await new Promise((r) => setTimeout(r, 30))
      expect(view.hasFocus).toBe(false)
      expect(firstLine(view)).toBe('Garden plan')
    } finally {
      document.removeEventListener('focusin', refuse, true)
    }
  })

  it('another note put in while unfocused is read; put in while focused it reveals', async () => {
    const view = mount(NOTE)
    view.focus()
    await microtasks()
    view.contentDOM.blur()
    const next = '# Reading list\n\nA **short** list.'
    // A list opened the note: the editor is not focused as it arrives.
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      selection: { anchor: 0 },
      effects: sourceRevealForNewNote(view)
    })
    forceParsing(view, next.length, 1000)
    expect(firstLine(view)).toBe('Reading list')

    // A tab switch from the keyboard: the editor keeps the focus throughout.
    view.focus()
    await microtasks()
    expect(firstLine(view)).toBe('# Reading list')
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: NOTE },
      selection: { anchor: 0 },
      effects: sourceRevealForNewNote(view)
    })
    forceParsing(view, NOTE.length, 1000)
    expect(firstLine(view)).toBe('# Garden plan')
  })

  it('a note left to be read renders its selection line again until the next focus', async () => {
    const view = mount(NOTE)
    view.focus()
    await microtasks()
    expect(firstLine(view)).toBe('# Garden plan')
    view.contentDOM.blur()
    view.dispatch({ effects: readSourceRevealEffect() })
    expect(firstLine(view)).toBe('Garden plan')
    view.focus()
    await microtasks()
    expect(firstLine(view)).toBe('# Garden plan')
  })

  it('gates the span reveals too: highlights and inline math on the selection line', async () => {
    const doc = 'A ==marked== word and $x^2$ here.\n\nNext line.'
    const view = mount(doc, [sourceRevealExtension, highlightExtension, mathRenderExtension('katex')])
    view.dispatch({ selection: { anchor: doc.indexOf('marked') + 2 } })
    expect(firstLine(view)).not.toContain('==')
    view.dispatch({ selection: { anchor: doc.indexOf('x^2') + 1 } })
    expect(view.contentDOM.querySelector('.cm-line')?.textContent).not.toContain('$x^2$')

    view.focus()
    await microtasks()
    // Now being edited: the math under the caret reads as source again.
    expect(firstLine(view)).toContain('$x^2$')
    view.dispatch({ selection: { anchor: doc.indexOf('marked') + 2 } })
    expect(firstLine(view)).toContain('==marked==')
  })
})
