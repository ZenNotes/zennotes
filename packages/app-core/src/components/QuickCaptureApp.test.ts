// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { completionStatus, startCompletion } from '@codemirror/autocomplete'
import { getCM } from '@replit/codemirror-vim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickCaptureApp } from './QuickCaptureApp'
import { getKeymapDisplay } from '../lib/keymaps'

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
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
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

describe('Quick Capture close shortcut (#893)', () => {
  let host: HTMLDivElement
  let root: Root
  let platform: NodeJS.Platform
  const windowClose = vi.fn()
  const createNote = vi.fn()
  const writeNote = vi.fn()

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    localStorage.clear()
    platform = 'darwin'
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => []
    })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect()
    })
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
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
        platformSync: () => platform,
        windowClose,
        createNote,
        writeNote
      }
    })
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
      view.dispatch({ changes: { from: 0, insert: 'Draft\nStill thinking' } })
      view.focus()
    })
    return view
  }

  async function press(target: EventTarget, init: KeyboardEventInit): Promise<void> {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    })
  }

  const cmdW: KeyboardEventInit = { key: 'w', code: 'KeyW', keyCode: 87, metaKey: true }

  it('hides the window on Cmd+W like its close button, keeping the draft', async () => {
    const view = await mount()
    await press(view.contentDOM, cmdW)

    expect(windowClose).toHaveBeenCalledOnce()
    // The close button hides without saving; the draft waits in the buffer.
    expect(createNote).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('Draft\nStill thinking')
  })

  it('keeps Cmd+W while the note picker is open', async () => {
    await mount()
    await press(window, { key: 'p', code: 'KeyP', metaKey: true })
    const input = host.querySelector<HTMLInputElement>('input')!
    expect(input.placeholder).toContain('Search notes')

    await press(input, cmdW)

    expect(windowClose).not.toHaveBeenCalled()
    expect(host.querySelector('input')).not.toBeNull()
  })

  // The chords below are claimed in a capture-phase listener on window, because
  // codemirror-vim consumes Mod+N / Mod+P / Mod+W as normal-mode chords and stops
  // propagation, so those chords only reach the bubble listener in insert mode.
  // The fix moved them into a capture-phase listener on window. Dispatching on
  // document is what makes these tests exercise that phase: the capture path
  // still starts at window, so the listener runs, while the editor never sees
  // the key and Vim cannot stand in for it.
  const onWindow = (init: KeyboardEventInit): Promise<void> => press(document, init)
  const modP: KeyboardEventInit = { key: 'p', code: 'KeyP', keyCode: 80, metaKey: true }
  const modN: KeyboardEventInit = { key: 'n', code: 'KeyN', keyCode: 78, metaKey: true }
  const modShiftP: KeyboardEventInit = {
    key: 'p', code: 'KeyP', keyCode: 80, metaKey: true, shiftKey: true
  }
  // Navigation inside an overlay is Ctrl-only. isPalettePreviousKey requires
  // ctrlKey and rejects metaKey outright, on every platform, which is why the
  // footer reads Ctrl and not Mod. Mod+N/P only open the overlays.
  const ctrlP: KeyboardEventInit = { key: 'p', code: 'KeyP', keyCode: 80, ctrlKey: true }
  const ctrlN: KeyboardEventInit = { key: 'n', code: 'KeyN', keyCode: 78, ctrlKey: true }

  const overlayInput = (): HTMLInputElement | null =>
    host.querySelector<HTMLInputElement>('input')
  const footerHints = (): string =>
    (host.querySelector('footer')?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const rows = (): HTMLButtonElement[] =>
    [...host.querySelectorAll<HTMLButtonElement>('[data-qc-idx]')]
  // Exact class token, not a substring match: the inactive row carries
  // `hover:bg-paper-200/60`, which contains "bg-paper-200" as a substring.
  const activeRow = (): HTMLButtonElement =>
    rows().find((r) => r.classList.contains('bg-paper-200')) ?? rows()[0]

  /** `window.zen` is installed by defineProperty without `writable`, so seeding
   *  notes has to go through the same door rather than by assignment. */
  function seedNotes(notes: { path: string; title: string; folder: string }[]): void {
    const zen = (window as unknown as { zen: Record<string, unknown> }).zen
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: {
        ...zen,
        listNotes: vi.fn(async () =>
          notes.map((n, i) => ({
            ...n,
            siblingOrder: i,
            createdAt: 0,
            updatedAt: 0,
            size: 0,
            tags: [],
            wikilinks: [],
            hasAttachments: false,
            assetEmbeds: [],
            excerpt: ''
          }))
        )
      }
    })
  }

  /** CodeMirror starts in insert mode here, so one Escape puts Vim in normal
   *  mode, which is the state where the chords used to be swallowed. */
  async function toNormalMode(view: EditorView): Promise<void> {
    await press(view.contentDOM, { key: 'Escape', keyCode: 27 })
  }

  it('opens the note picker on Mod+P in normal mode, where Vim would take it', async () => {
    const view = await mount()
    await toNormalMode(view)

    await onWindow(modP)

    expect(overlayInput()?.placeholder).toContain('Search notes')
    // Vim's cursor-up never ran, and nothing was saved or closed on the way.
    expect(windowClose).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('starts a new note on Mod+N in normal mode', async () => {
    const view = await mount()
    await toNormalMode(view)

    await onWindow(modN)

    expect(createNote).toHaveBeenCalled()
    expect(overlayInput()).toBeNull()
  })

  it('hides the window on Mod+W in normal mode, keeping the draft', async () => {
    const view = await mount()
    await toNormalMode(view)

    await onWindow(cmdW)

    expect(windowClose).toHaveBeenCalledOnce()
  })

  it('opens the command palette on Mod+Shift+P in normal mode', async () => {
    const view = await mount()
    await toNormalMode(view)

    await onWindow(modShiftP)

    expect(overlayInput()?.placeholder).toContain('Run a command')
  })

  describe('how the picker names a folder', () => {
    function seedLayout(primaryNotesLocation: 'inbox' | 'root'): void {
      const zen = (window as unknown as { zen: Record<string, unknown> }).zen
      Object.defineProperty(window, 'zen', {
        configurable: true,
        value: { ...zen, getVaultSettings: vi.fn(async () => ({ primaryNotesLocation })) }
      })
    }
    const areas = (): string[] =>
      [...document.querySelectorAll('[data-picker-area]')].map((row) => row.textContent ?? '')

    afterEach(() => localStorage.removeItem('zen:prefs:v2'))

    it('names none for a note of a vault that keeps notes at its root', async () => {
      seedNotes([
        { path: 'Plan.md', title: 'Plan', folder: 'inbox' },
        { path: 'archive/Old.md', title: 'Old', folder: 'archive' }
      ])
      seedLayout('root')
      const view = await mount()
      await toNormalMode(view)
      await onWindow(modP)
      expect(areas()).toEqual(['Archive'])
    })

    it('uses a custom label in a vault with an Inbox', async () => {
      localStorage.setItem('zen:prefs:v2', JSON.stringify({ systemFolderLabels: { inbox: 'Desk' } }))
      seedNotes([{ path: 'inbox/Plan.md', title: 'Plan', folder: 'inbox' }])
      seedLayout('inbox')
      const view = await mount()
      await toNormalMode(view)
      await onWindow(modP)
      expect(areas()).toEqual(['Desk'])
    })
  })

  it('moves down rather than toggling once the picker has focus', async () => {
    seedNotes([
      { path: 'inbox/Alpha.md', title: 'Alpha', folder: 'inbox' },
      { path: 'inbox/Beta.md', title: 'Beta', folder: 'inbox' }
    ])
    await mount()
    await onWindow(modP)
    expect(rows()).toHaveLength(2)
    expect(activeRow().textContent).toContain('Alpha')

    // The chord targets the focused input, which is where a real keystroke
    // lands. The window capture listener stands aside while an overlay is
    // open, so the overlay's own handler navigates rather than the chord
    // re-entering the capture handler and closing the picker.
    await press(overlayInput()!, ctrlN)

    expect(overlayInput()?.placeholder).toContain('Search notes')
    expect(rows()).toHaveLength(2)
    expect(activeRow().textContent).toContain('Beta')
  })

  it('holds at the top row on Ctrl+P instead of closing the picker', async () => {
    seedNotes([
      { path: 'inbox/Alpha.md', title: 'Alpha', folder: 'inbox' },
      { path: 'inbox/Beta.md', title: 'Beta', folder: 'inbox' }
    ])
    await mount()
    await onWindow(modP)
    const input = overlayInput()!
    await press(input, ctrlN) // move off the top row first

    // Ctrl+P is previous. From the top row it clamps rather than toggling the
    // overlay shut, which is the specific failure being fixed.
    await press(input, ctrlP)
    expect(overlayInput()?.placeholder).toContain('Search notes')
    expect(activeRow().textContent).toContain('Alpha')

    // And it does go up when there is somewhere to go.
    await press(input, ctrlN)
    await press(input, ctrlP)
    expect(activeRow().textContent).toContain('Alpha')
  })

  it('stops moving at the last row instead of wrapping or closing', async () => {
    seedNotes([
      { path: 'inbox/Alpha.md', title: 'Alpha', folder: 'inbox' },
      { path: 'inbox/Beta.md', title: 'Beta', folder: 'inbox' }
    ])
    await mount()
    await onWindow(modP)
    const input = overlayInput()!
    await press(input, ctrlN) // onto Beta, the last row
    await press(input, ctrlN) // one past the end

    expect(rows()).toHaveLength(2)
    expect(activeRow().textContent).toContain('Beta')
  })

  it('swaps the footer hints while an overlay is open', async () => {
    await mount()
    const idle = footerHints()
    expect(idle).toContain('notes')
    expect(idle).toContain('close')

    await onWindow(modP)
    const open = footerHints()
    expect(open).toContain('move')
    expect(open).toContain('esc close')
    // Ctrl, not Mod. Cmd+N/P do not navigate in any palette, so advertising
    // them here would be the same lie Bug B was about, reintroduced.
    expect(open).toContain('Ctrl+N/P')
    expect(open).not.toContain('⌘N/P')
    // The chords that no longer apply inside an overlay are not offered.
    expect(open).not.toContain('new')
    expect(open).not.toContain('cmd')
  })

  it('names the close key the way Close active tab is bound', async () => {
    localStorage.setItem(
      'zen:prefs:v2',
      JSON.stringify({ keymapOverrides: { 'global.closeActiveTab': 'Shift+Mod+W' } })
    )
    await mount()
    const rebound = getKeymapDisplay(
      { 'global.closeActiveTab': 'Shift+Mod+W' },
      'global.closeActiveTab'
    )
    expect(footerHints()).toContain(`${rebound} close`)
  })

  it('does not advertise a close key once Close active tab is unbound', async () => {
    localStorage.setItem(
      'zen:prefs:v2',
      JSON.stringify({ keymapOverrides: { 'global.closeActiveTab': '' } })
    )
    await mount()
    expect(footerHints()).toContain('notes')
    expect(footerHints()).not.toContain('close')
  })

  it('drops the two command hints that no longer run inside the command palette', async () => {
    await mount()
    await onWindow(modShiftP)

    const listed = rows().map((r) => r.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    expect(listed.some((t) => t.startsWith('Save and start a new note'))).toBe(true)
    expect(listed.some((t) => t.startsWith('Open another note'))).toBe(true)
    // Mod+Enter is not a navigation chord, so its hint stays.
    expect(rows()[0].textContent).toContain('↩')
  })

  it('scrolls the active row into view in both overlays', async () => {
    seedNotes([
      { path: 'inbox/Alpha.md', title: 'Alpha', folder: 'inbox' },
      { path: 'inbox/Beta.md', title: 'Beta', folder: 'inbox' }
    ])
    const scrolled = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>

    await mount()

    await onWindow(modP)
    scrolled.mockClear()
    await press(overlayInput()!, ctrlN)
    expect(activeRow().textContent).toContain('Beta')
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' })

    // Dismiss, then the same check for the command overlay. Its effect is
    // keyed on the same `active`, but it is a separate component.
    await press(overlayInput()!, { key: 'Escape', keyCode: 27 })
    await onWindow(modShiftP)
    scrolled.mockClear()
    await press(overlayInput()!, ctrlN)
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('shows only the subpath beside the filename', async () => {
    seedNotes([
      {
        path: 'inbox/ZenNotes/Enhancements/Calendar Panel Tasks Placement.md',
        title: 'Calendar Panel Tasks Placement',
        folder: 'inbox'
      }
    ])
    await mount()
    await onWindow(modP)

    const bidiControls = /[\u202A-\u202E]/g
    const cells = [...rows()[0].querySelectorAll('span')].map(
      (s) => s.textContent?.replace(bidiControls, '').trim() ?? ''
    )
    expect(cells).toContain('Calendar Panel Tasks Placement')
    expect(cells).toContain('ZenNotes/Enhancements')
    // Neither the folder nor the filename is repeated in the path column.
    expect(cells.filter((c) => c === 'Inbox')).toHaveLength(1)
    expect(cells.some((c) => c.endsWith('.md'))).toBe(false)
    // The column is right to left so its ellipsis lands on the left, and the
    // path inside it is embedded left to right, as in Open Buffers: without
    // that, a subpath that starts with digits, such as 2026/Planning, displays
    // as Planning/2026.
    expect(rows()[0].querySelector('[dir="rtl"]')?.textContent).toBe(
      '\u202AZenNotes/Enhancements\u202C'
    )
  })

  it('follows a rebind of Close active tab', async () => {
    localStorage.setItem(
      'zen:prefs:v2',
      JSON.stringify({ keymapOverrides: { 'global.closeActiveTab': 'Shift+Mod+W' } })
    )
    const view = await mount()
    await press(view.contentDOM, cmdW)
    expect(windowClose).not.toHaveBeenCalled()

    await press(view.contentDOM, { key: 'W', code: 'KeyW', keyCode: 87, metaKey: true, shiftKey: true })
    expect(windowClose).toHaveBeenCalledOnce()
  })

  it('hides on Ctrl+W on Linux and Windows', async () => {
    platform = 'linux'
    localStorage.setItem('zen:prefs:v2', JSON.stringify({ vimMode: false }))
    const view = await mount()
    await press(view.contentDOM, { key: 'w', code: 'KeyW', keyCode: 87, ctrlKey: true })
    expect(windowClose).toHaveBeenCalledOnce()
    expect(writeNote).not.toHaveBeenCalled()
  })
})
