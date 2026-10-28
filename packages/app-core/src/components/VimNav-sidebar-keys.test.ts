// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { dispatchKeyboardContextMenu } from '../lib/keyboard-context-menu'
import { VimNav } from './VimNav'

// jsdom refuses the MouseEvent the real dispatch builds (its `view`); the
// menu itself is the row's business, so what matters here is which row the
// key opened it on.
vi.mock('../lib/keyboard-context-menu', async (importActual) => ({
  ...(await importActual<typeof import('../lib/keyboard-context-menu')>()),
  dispatchKeyboardContextMenu: vi.fn()
}))
const menuOpenedOn = vi.mocked(dispatchKeyboardContextMenu)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The focused sidebar answers the universal keys with Vim mode off (arrows,
// Enter, Escape, Home / End, the page keys, the menu keys) through the same
// handler Vim mode uses, while the typed Vim keys stay off. Vim mode keeps
// every key it had.

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      platformSync: () => 'darwin',
      getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop' }),
      getCapabilities: vi.fn().mockReturnValue({
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: false
      })
    }
  })
}

const ROW_HEIGHT = 24

/** A sidebar the way the DOM walkers read it: Tasks, the Inbox and Projects
 *  folders, then the Projects notes, one row under the other. jsdom has no
 *  layout, so every row is given its box by hand. */
function renderSidebar(noteCount = 8): void {
  const notes = Array.from(
    { length: noteCount },
    (_, i) =>
      `<button data-sidebar-idx="${20 + i}" data-sidebar-type="note" data-sidebar-path="inbox/Projects/P${i + 1}.md">P${i + 1}</button>`
  ).join('')
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="zn-sidebar-scroll">
      <button data-sidebar-idx="1" data-sidebar-type="tasks">Tasks</button>
      <div role="button" data-sidebar-idx="9" data-sidebar-type="folder" data-sidebar-folder="inbox" data-sidebar-subpath="" data-sidebar-key="inbox:">Inbox</div>
      <div role="button" data-sidebar-idx="12" data-sidebar-type="folder" data-sidebar-folder="inbox" data-sidebar-subpath="Projects" data-sidebar-key="inbox:Projects">Projects</div>
      ${notes}
    </div>`
  )
  document.querySelectorAll<HTMLElement>('[data-sidebar-idx]').forEach((el, i) => {
    el.getClientRects = (() => [{ width: 200, height: ROW_HEIGHT }] as unknown as DOMRectList) as never
    el.getBoundingClientRect = (() =>
      ({
        top: i * ROW_HEIGHT,
        bottom: (i + 1) * ROW_HEIGHT,
        left: 0,
        right: 200,
        width: 200,
        height: ROW_HEIGHT
      }) as DOMRect) as never
    el.scrollIntoView = (() => {}) as never
  })
  // Five rows show at a time.
  Object.defineProperty(document.querySelector('.zn-sidebar-scroll'), 'clientHeight', {
    configurable: true,
    value: ROW_HEIGHT * 5
  })
}

const rowIdx = (path: string): number =>
  Number(document.querySelector<HTMLElement>(`[data-sidebar-path="${path}"]`)?.dataset.sidebarIdx)

function press(key: string, code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init })
  act(() => {
    document.body.dispatchEvent(event)
  })
  return event
}

const cursor = (): number => useStore.getState().sidebarCursorIndex

describe('sidebar keys in VimNav', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let selectNote: ReturnType<typeof vi.fn>
  let toggleCollapseFolder: ReturnType<typeof vi.fn>
  let setView: ReturnType<typeof vi.fn>
  let setSearchOpen: ReturnType<typeof vi.fn>

  const mount = (vimMode: boolean): void => {
    useStore.setState({ vimMode } as never)
    act(() => root.render(createElement(VimNav)))
  }

  beforeEach(() => {
    installZen()
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    renderSidebar()
    selectNote = vi.fn().mockResolvedValue(undefined)
    toggleCollapseFolder = vi.fn()
    setView = vi.fn()
    setSearchOpen = vi.fn()
    menuOpenedOn.mockClear()
    useStore.setState({
      focusedPanel: 'sidebar',
      sidebarOpen: true,
      sidebarCursorIndex: rowIdx('inbox/Projects/P1.md'),
      collapsedFolders: [],
      selectNote,
      toggleCollapseFolder,
      setView,
      setSearchOpen,
      editorViewRef: null
    } as never)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
    useStore.setState(originalState, true)
  })

  describe('with Vim mode off', () => {
    it('moves the cursor with the arrows and takes the key', () => {
      mount(false)
      const down = press('ArrowDown', 'ArrowDown')
      expect(down.defaultPrevented).toBe(true)
      expect(cursor()).toBe(rowIdx('inbox/Projects/P2.md'))
      press('ArrowDown', 'ArrowDown')
      press('ArrowUp', 'ArrowUp')
      expect(cursor()).toBe(rowIdx('inbox/Projects/P2.md'))
    })

    it('jumps to the ends with Home and End, and a screenful with the page keys', () => {
      mount(false)
      press('End', 'End')
      expect(cursor()).toBe(rowIdx('inbox/Projects/P8.md'))
      press('Home', 'Home')
      expect(cursor()).toBe(1)
      // Five rows show; a page is four, so the row left behind stays in view.
      press('PageDown', 'PageDown')
      expect(cursor()).toBe(rowIdx('inbox/Projects/P2.md'))
      press('PageDown', 'PageDown')
      expect(cursor()).toBe(rowIdx('inbox/Projects/P6.md'))
      press('PageDown', 'PageDown')
      expect(cursor()).toBe(rowIdx('inbox/Projects/P8.md'))
      press('PageUp', 'PageUp')
      expect(cursor()).toBe(rowIdx('inbox/Projects/P4.md'))
    })

    it('opens the note under the cursor with Enter and hands the keyboard to the editor', () => {
      mount(false)
      press('ArrowDown', 'ArrowDown')
      expect(press('Enter', 'Enter').defaultPrevented).toBe(true)
      expect(selectNote).toHaveBeenCalledWith('inbox/Projects/P2.md')
      expect(useStore.getState().focusedPanel).toBe('editor')
    })

    it('expands a folder with ArrowRight and collapses it with ArrowLeft, staying in the sidebar', () => {
      useStore.setState({ collapsedFolders: ['inbox:Projects'], sidebarCursorIndex: 12 } as never)
      mount(false)
      press('ArrowRight', 'ArrowRight')
      expect(toggleCollapseFolder).toHaveBeenCalledWith('inbox:Projects')
      expect(useStore.getState().focusedPanel).toBe('sidebar')

      toggleCollapseFolder.mockClear()
      useStore.setState({ collapsedFolders: [] } as never)
      press('ArrowLeft', 'ArrowLeft')
      expect(toggleCollapseFolder).toHaveBeenCalledWith('inbox:Projects')
      // ← used to hand the keyboard back to the editor from any row.
      expect(useStore.getState().focusedPanel).toBe('sidebar')
    })

    it('steps from a note to its folder with ArrowLeft', () => {
      useStore.setState({ collapsedFolders: ['inbox:Projects'] } as never)
      mount(false)
      press('ArrowDown', 'ArrowDown')
      press('ArrowLeft', 'ArrowLeft')
      expect(cursor()).toBe(12)
      expect(useStore.getState().focusedPanel).toBe('sidebar')
    })

    it('returns to the editor with Escape', () => {
      mount(false)
      expect(press('Escape', 'Escape').defaultPrevented).toBe(true)
      expect(useStore.getState().focusedPanel).toBe('editor')
    })

    it('opens the row menu with the Context Menu key and Shift+F10', () => {
      mount(false)
      const row = document.querySelector('[data-sidebar-path="inbox/Projects/P1.md"]')
      expect(press('ContextMenu', 'ContextMenu').defaultPrevented).toBe(true)
      expect(press('F10', 'F10', { shiftKey: true }).defaultPrevented).toBe(true)
      expect(menuOpenedOn.mock.calls).toEqual([[row], [row]])
    })

    it.each([
      ['j', 'KeyJ'],
      ['k', 'KeyK'],
      ['l', 'KeyL'],
      ['h', 'KeyH'],
      ['o', 'KeyO'],
      ['x', 'KeyX'],
      ['d', 'KeyD'],
      ['m', 'KeyM'],
      ['g', 'KeyG'],
      ['G', 'KeyG'],
      ['/', 'Slash']
    ])('leaves the typed key %s alone', (key, code) => {
      mount(false)
      const before = cursor()
      const event = press(key, code, key === 'G' ? { shiftKey: true } : {})
      if (key === 'g') press('g', 'KeyG')
      expect(event.defaultPrevented).toBe(false)
      expect(cursor()).toBe(before)
      expect(selectNote).not.toHaveBeenCalled()
      expect(toggleCollapseFolder).not.toHaveBeenCalled()
      expect(setSearchOpen).not.toHaveBeenCalled()
      expect(menuOpenedOn).not.toHaveBeenCalled()
      expect(useStore.getState().focusedPanel).toBe('sidebar')
    })

    it('leaves chords to the app', () => {
      mount(false)
      expect(press('ArrowDown', 'ArrowDown', { altKey: true }).defaultPrevented).toBe(false)
      expect(press('ArrowDown', 'ArrowDown', { metaKey: true }).defaultPrevented).toBe(false)
      expect(cursor()).toBe(rowIdx('inbox/Projects/P1.md'))
    })

    it('does nothing unless the sidebar holds the keyboard', () => {
      useStore.setState({ focusedPanel: 'editor' } as never)
      mount(false)
      expect(press('ArrowDown', 'ArrowDown').defaultPrevented).toBe(false)
      expect(cursor()).toBe(rowIdx('inbox/Projects/P1.md'))
    })

    it('stands down while a dialog or menu is open', () => {
      mount(false)
      const dialog = document.createElement('div')
      dialog.setAttribute('aria-modal', 'true')
      document.body.append(dialog)
      expect(press('ArrowDown', 'ArrowDown').defaultPrevented).toBe(false)
      expect(press('Enter', 'Enter').defaultPrevented).toBe(false)
      dialog.remove()
      const menu = document.createElement('div')
      menu.setAttribute('data-ctx-menu', '')
      document.body.append(menu)
      expect(press('ArrowDown', 'ArrowDown').defaultPrevented).toBe(false)
      expect(cursor()).toBe(rowIdx('inbox/Projects/P1.md'))
      expect(selectNote).not.toHaveBeenCalled()
    })

    it('leaves a text field its keys', () => {
      mount(false)
      const input = document.createElement('input')
      document.querySelector('.zn-sidebar-scroll')!.append(input)
      const event = new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true })
      act(() => {
        input.dispatchEvent(event)
      })
      expect(event.defaultPrevented).toBe(false)
      expect(cursor()).toBe(rowIdx('inbox/Projects/P1.md'))
    })
  })

  describe('with Vim mode on', () => {
    it('keeps j / k, G and gg', () => {
      mount(true)
      press('j', 'KeyJ')
      press('j', 'KeyJ')
      expect(cursor()).toBe(rowIdx('inbox/Projects/P3.md'))
      press('k', 'KeyK')
      expect(cursor()).toBe(rowIdx('inbox/Projects/P2.md'))
      press('G', 'KeyG', { shiftKey: true })
      expect(cursor()).toBe(rowIdx('inbox/Projects/P8.md'))
      press('g', 'KeyG')
      press('g', 'KeyG')
      expect(cursor()).toBe(1)
    })

    it('keeps l to open, the arrows, Escape and /', () => {
      mount(true)
      press('ArrowDown', 'ArrowDown')
      press('l', 'KeyL')
      expect(selectNote).toHaveBeenCalledWith('inbox/Projects/P2.md')
      useStore.setState({ focusedPanel: 'sidebar' } as never)
      press('/', 'Slash')
      expect(setSearchOpen).toHaveBeenCalledWith(true)
      press('Escape', 'Escape')
      expect(useStore.getState().focusedPanel).toBe('editor')
    })

    it('leaves Home, End and the page keys as they were', () => {
      mount(true)
      for (const key of ['Home', 'End', 'PageDown', 'PageUp']) {
        expect(press(key, key).defaultPrevented).toBe(false)
      }
      expect(cursor()).toBe(rowIdx('inbox/Projects/P1.md'))
    })
  })
})
