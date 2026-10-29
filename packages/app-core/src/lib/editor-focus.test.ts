// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  current: {
    editorViewRef: null as null | Record<string, unknown>,
    vimMode: false,
    setFocusedPanel: vi.fn()
  }
}))

vi.mock('../store', () => ({
  useStore: {
    getState: () => storeState.current
  }
}))

vi.mock('@replit/codemirror-vim', () => ({
  Vim: {
    exitInsertMode: vi.fn()
  },
  getCM: vi.fn(() => null)
}))

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  caretIntoNewNoteBody,
  focusEditorAfterReadOpen,
  focusEditorAfterPaletteClose,
  focusEditorNormalMode,
  newNoteBodyCaret
} from './editor-focus'
import { installNoteEditorHost } from './editor-host'
import { revealedSelectionRanges, sourceRevealExtension } from './cm-source-reveal'

describe('focusEditorNormalMode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    storeState.current = {
      editorViewRef: null,
      vimMode: false,
      setFocusedPanel: vi.fn()
    }
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      return window.setTimeout(() => callback(performance.now()), 0)
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => window.clearTimeout(handle))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('retries focus when the editor view appears after a palette closes', async () => {
    focusEditorNormalMode({ attempts: 3, delayMs: 5 })

    await vi.advanceTimersByTimeAsync(0)
    expect(storeState.current.setFocusedPanel).toHaveBeenCalledWith('editor')

    const dom = document.createElement('div')
    dom.tabIndex = -1
    document.body.appendChild(dom)
    const focus = vi.fn(() => dom.focus())
    storeState.current.editorViewRef = { dom, focus }

    await vi.advanceTimersByTimeAsync(5)

    expect(focus).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(dom)
  })

  it('hands a just-made note the keyboard on the line under its heading, however it was opened', async () => {
    const view = new EditorView({ state: EditorState.create({ doc: '# Untitled\n\n' }), parent: document.body })
    storeState.current.editorViewRef = view as unknown as Record<string, unknown>
    focusEditorNormalMode()
    await vi.advanceTimersByTimeAsync(0)
    expect(view.state.selection.main.head).toBe(12)
    view.dispatch(view.state.replaceSelection('Body'))
    expect(view.state.doc.toString()).toBe('# Untitled\n\nBody')
    view.destroy()
  })

  it('leaves the caret of a note with a body where it was', async () => {
    const view = new EditorView({ state: EditorState.create({ doc: '# Plan\n\nfirst\n' }), parent: document.body })
    storeState.current.editorViewRef = view as unknown as Record<string, unknown>
    focusEditorNormalMode()
    await vi.advanceTimersByTimeAsync(0)
    expect(view.state.selection.main.head).toBe(0)
    view.destroy()
  })
})

describe('search hand-offs', () => {
  let host: { dispose(): void } | null = null
  let view: EditorView | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      return window.setTimeout(() => callback(performance.now()), 0)
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id))
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({ doc: '# Title\n\nBody', extensions: [sourceRevealExtension] })
    })
    storeState.current = { editorViewRef: view as never, vimMode: false, setFocusedPanel: vi.fn() }
  })

  afterEach(() => {
    host?.dispose()
    host = null
    view?.destroy()
    view = null
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('a read open focuses the editor where the host does not open notes to read (desktop)', async () => {
    focusEditorAfterReadOpen()
    await vi.advanceTimersByTimeAsync(0)
    expect(view!.hasFocus).toBe(true)
    expect(storeState.current.setFocusedPanel).toHaveBeenCalledWith('editor')
  })

  it('on desktop a read open keeps the retries its caller asked for', async () => {
    // The daily-note request retries 10 times, 24 ms apart: the note's editor
    // can mount after the first frames.
    storeState.current.editorViewRef = null
    focusEditorAfterReadOpen({ attempts: 10, delayMs: 24 })
    await vi.advanceTimersByTimeAsync(24 * 5)
    expect(view!.hasFocus).toBe(false)
    storeState.current.editorViewRef = view as never
    await vi.advanceTimersByTimeAsync(24 * 2)
    expect(view!.hasFocus).toBe(true)
  })

  it('a host that answers no, or throws, keeps the desktop hand-off', async () => {
    host = installNoteEditorHost({
      openNotesToRead: () => {
        throw new Error('gone')
      }
    })
    focusEditorAfterReadOpen()
    await vi.advanceTimersByTimeAsync(0)
    expect(view!.hasFocus).toBe(true)
  })

  it('a read open on a host that opens notes to read leaves the keyboard down and the note read', async () => {
    host = installNoteEditorHost({ openNotesToRead: () => true })
    focusEditorAfterReadOpen()
    await vi.advanceTimersByTimeAsync(50)
    expect(view!.hasFocus).toBe(false)
    expect(storeState.current.setFocusedPanel).not.toHaveBeenCalled()
    expect(revealedSelectionRanges(view!.state)).toEqual([])
  })

  it('undoes the focus a closing palette handed back to the editor that opened it', async () => {
    host = installNoteEditorHost({ openNotesToRead: () => true })
    view!.focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(revealedSelectionRanges(view!.state)).not.toEqual([])
    focusEditorAfterReadOpen()
    await vi.advanceTimersByTimeAsync(50)
    expect(view!.hasFocus).toBe(false)
    expect(revealedSelectionRanges(view!.state)).toEqual([])
  })

  it('closing a palette gives the editor the keyboard on desktop, and leaves the focus alone on a reading host', async () => {
    focusEditorAfterPaletteClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(view!.hasFocus).toBe(true)
    view!.contentDOM.blur()

    host = installNoteEditorHost({ openNotesToRead: () => true })
    focusEditorAfterPaletteClose()
    await vi.advanceTimersByTimeAsync(50)
    expect(view!.hasFocus).toBe(false)
  })
})

describe('a new note drops into its body after the name field', () => {
  it('moves a caret still at the start of a heading-only note to the line under it', () => {
    expect(newNoteBodyCaret('# Untitled\n\n', 0, true)).toBe(12)
    expect(newNoteBodyCaret('# Untitled\n', 0, true)).toBe(11)
  })

  it('leaves a note with more in it, a placed caret or a selection alone', () => {
    expect(newNoteBodyCaret('# Plan\n\nfirst line\n', 0, true)).toBeNull()
    expect(newNoteBodyCaret('# Untitled\n\n', 4, true)).toBeNull()
    expect(newNoteBodyCaret('# Untitled\n\n', 0, false)).toBeNull()
    expect(newNoteBodyCaret('# Untitled', 0, true)).toBeNull()
    expect(newNoteBodyCaret('---\ntags: a\n---\n# Untitled\n', 0, true)).toBeNull()
  })

  it('keeps the caret on the empty line when the rename rewrites the heading afterwards', () => {
    const view = new EditorView({ state: EditorState.create({ doc: '# Untitled\n\n' }) })
    storeState.current.editorViewRef = view as unknown as Record<string, unknown>
    caretIntoNewNoteBody()
    view.dispatch({ changes: { from: 2, to: 10, insert: 'Caret check' } })
    view.dispatch(view.state.replaceSelection('Body'))
    expect(view.state.doc.toString()).toBe('# Caret check\n\nBody')
    view.destroy()
    storeState.current.editorViewRef = null
  })
})
