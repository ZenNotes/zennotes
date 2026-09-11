// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { completionStatus, startCompletion } from '@codemirror/autocomplete'
import { getCM } from '@replit/codemirror-vim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickCaptureApp } from './QuickCaptureApp'

describe('Quick Capture Escape handling (#765)', () => {
  let host: HTMLDivElement
  let root: Root
  const windowClose = vi.fn()
  const createNote = vi.fn()
  const writeNote = vi.fn()

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    localStorage.clear()
    // jsdom has no layout; Vim/CodeMirror still request caret rectangles.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => []
    })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect()
    })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    })
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: {
        listNotes: vi.fn(async () => []),
        onVaultChange: vi.fn(() => vi.fn()),
        getQuickCapturePinned: vi.fn(async () => false),
        platformSync: () => 'linux',
        windowClose,
        createNote,
        writeNote
      }
    })
    createNote.mockResolvedValue({ path: 'Quick/Draft.md', title: 'Draft', folder: 'quick' })
    writeNote.mockResolvedValue(undefined)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    localStorage.clear()
  })

  async function mount(): Promise<EditorView> {
    await act(async () => root.render(createElement(QuickCaptureApp)))
    const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!
    act(() => {
      view.dispatch({ changes: { from: 0, insert: 'Draft\nSome text to select' } })
      view.focus()
    })
    return view
  }

  async function press(
    view: EditorView, key: string, keyCode: number, modifiers: KeyboardEventInit = {}
  ): Promise<void> {
    await act(async () => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        key, keyCode, bubbles: true, cancelable: true, ...modifiers
      }))
    })
  }

  it.each([
    ['character', 'v', {}],
    ['line', 'V', { shiftKey: true }],
    ['block', 'v', { ctrlKey: true }]
  ] as const)('cancels a Vim %s selection without saving or closing the window', async (_, key, modifiers) => {
    const view = await mount()
    await press(view, key, 86, modifiers)
    await press(view, 'l', 76)
    expect(getCM(view)?.state.vim?.visualMode).toBe(true)
    expect(view.state.selection.main.empty).toBe(false)

    await press(view, 'Escape', 27)

    expect(getCM(view)?.state.vim?.visualMode).toBe(false)
    expect(view.state.doc.toString()).toBe('Draft\nSome text to select')
    expect(createNote).not.toHaveBeenCalled()
    expect(windowClose).not.toHaveBeenCalled()

    // A second Escape, now in normal mode, retains the save-and-hide shortcut.
    await press(view, 'Escape', 27)
    expect(writeNote).toHaveBeenCalledWith('Quick/Draft.md', 'Draft\nSome text to select\n')
    expect(windowClose).toHaveBeenCalledOnce()
  })

  it('leaves Vim insert mode without closing the window', async () => {
    const view = await mount()
    await press(view, 'i', 73)
    expect(getCM(view)?.state.vim?.insertMode).toBe(true)

    await press(view, 'Escape', 27)

    expect(getCM(view)?.state.vim?.insertMode).toBe(false)
    expect(createNote).not.toHaveBeenCalled()
    expect(windowClose).not.toHaveBeenCalled()
  })

  it('still saves and hides on an unhandled Escape with Vim disabled', async () => {
    localStorage.setItem('zen:prefs:v2', JSON.stringify({ vimMode: false }))
    const view = await mount()

    await press(view, 'Escape', 27)

    expect(writeNote).toHaveBeenCalledWith('Quick/Draft.md', 'Draft\nSome text to select\n')
    expect(windowClose).toHaveBeenCalledOnce()
  })

  it('collapses a non-Vim selection before a second Escape saves and hides', async () => {
    localStorage.setItem('zen:prefs:v2', JSON.stringify({ vimMode: false }))
    const view = await mount()
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }))

    await press(view, 'Escape', 27)

    expect(view.state.selection.main.empty).toBe(true)
    expect(createNote).not.toHaveBeenCalled()
    expect(windowClose).not.toHaveBeenCalled()
    await press(view, 'Escape', 27)
    expect(windowClose).toHaveBeenCalledOnce()
  })

  it('dismisses the note picker without saving or closing Quick Capture', async () => {
    await mount()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', ctrlKey: true, bubbles: true, cancelable: true
    })))
    const input = host.querySelector<HTMLInputElement>('input')!
    expect(input.placeholder).toContain('Search notes')

    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', keyCode: 27, bubbles: true, cancelable: true
    })))

    expect(host.querySelector('input')).toBeNull()
    expect(createNote).not.toHaveBeenCalled()
    expect(windowClose).not.toHaveBeenCalled()
  })

  it('keeps the explicit save-and-close chord independent of editor default prevention', async () => {
    const view = await mount()
    await press(view, 'v', 86)
    await press(view, 'l', 76)

    // Only Escape should defer at the window boundary, not every shortcut.
    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true
      })
      event.preventDefault()
      window.dispatchEvent(event)
    })

    expect(writeNote).toHaveBeenCalledWith('Quick/Draft.md', 'Draft\nSome text to select\n')
    expect(windowClose).toHaveBeenCalledOnce()
  })

  it('dismisses slash completions without saving or hiding the window', async () => {
    localStorage.setItem('zen:prefs:v2', JSON.stringify({ vimMode: false }))
    const view = await mount()
    await act(async () => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '/' },
        selection: { anchor: 1 }
      })
      startCompletion(view)
      await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
    })

    await press(view, 'Escape', 27)

    expect(completionStatus(view.state)).toBeNull()
    expect(view.state.doc.toString()).toBe('/')
    expect(createNote).not.toHaveBeenCalled()
    expect(windowClose).not.toHaveBeenCalled()
  })

  it('still hides an empty capture without creating a note', async () => {
    localStorage.setItem('zen:prefs:v2', JSON.stringify({ vimMode: false }))
    const view = await mount()
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } }))

    await press(view, 'Escape', 27)

    expect(createNote).not.toHaveBeenCalled()
    expect(windowClose).toHaveBeenCalledOnce()
  })
})
