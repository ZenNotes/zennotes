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
  focusEditorAfterPick,
  focusEditorAfterSearchClose,
  focusEditorNormalMode
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

  it('a pick focuses the editor where the host does not open notes to read (desktop)', async () => {
    focusEditorAfterPick()
    await vi.advanceTimersByTimeAsync(0)
    expect(view!.hasFocus).toBe(true)
    expect(storeState.current.setFocusedPanel).toHaveBeenCalledWith('editor')
  })

  it('a host that answers no, or throws, keeps the desktop hand-off', async () => {
    host = installNoteEditorHost({
      openNotesToRead: () => {
        throw new Error('gone')
      }
    })
    focusEditorAfterPick()
    await vi.advanceTimersByTimeAsync(0)
    expect(view!.hasFocus).toBe(true)
  })

  it('a pick on a host that opens notes to read leaves the keyboard down and the note read', async () => {
    host = installNoteEditorHost({ openNotesToRead: () => true })
    focusEditorAfterPick()
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
    focusEditorAfterPick()
    await vi.advanceTimersByTimeAsync(50)
    expect(view!.hasFocus).toBe(false)
    expect(revealedSelectionRanges(view!.state)).toEqual([])
  })

  it('closing a search gives the editor the keyboard on desktop, and leaves the focus alone on a reading host', async () => {
    focusEditorAfterSearchClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(view!.hasFocus).toBe(true)
    view!.contentDOM.blur()

    host = installNoteEditorHost({ openNotesToRead: () => true })
    focusEditorAfterSearchClose()
    await vi.advanceTimersByTimeAsync(50)
    expect(view!.hasFocus).toBe(false)
  })
})
