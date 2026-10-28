// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { dispatchKeyboardContextMenu } from '../lib/keyboard-context-menu'
import { getConfirmRequest, settleConfirmRequest } from '../lib/confirm-requests'
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

// The note list, connections, outline and comments panels answer the
// universal keys with Vim mode off (arrows, Enter, Escape, Home / End, the
// page keys, the menu keys where a row has a menu, Backspace / Delete in
// comments) through the handler Vim mode uses, with the typed Vim keys off.
// Vim mode keeps every key it had; deleting a comment from the keyboard
// asks first in both modes.

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

/** jsdom has no layout: give each row its box by hand, one under the other,
 *  and the scroll box a height of five rows. */
function layOut(selector: string, heights?: number[]): void {
  let top = 0
  document.querySelectorAll<HTMLElement>(selector).forEach((el, i) => {
    const rowTop = top
    const height = heights?.[i] ?? ROW_HEIGHT
    el.getClientRects = (() => [{ width: 200, height }] as unknown as DOMRectList) as never
    el.getBoundingClientRect = (() =>
      ({ top: rowTop, bottom: rowTop + height, left: 0, right: 200, width: 200, height }) as DOMRect) as never
    el.scrollIntoView = (() => {}) as never
    top += height
  })
  const box = document.querySelector('[data-panel-scroll]')
  if (box) Object.defineProperty(box, 'clientHeight', { configurable: true, value: ROW_HEIGHT * 5 })
}

function press(key: string, code: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

const TYPED_KEYS: Array<[string, string]> = [
  ['j', 'KeyJ'],
  ['k', 'KeyK'],
  ['l', 'KeyL'],
  ['h', 'KeyH'],
  ['o', 'KeyO'],
  ['m', 'KeyM'],
  ['p', 'KeyP'],
  ['e', 'KeyE'],
  ['r', 'KeyR'],
  ['a', 'KeyA'],
  ['d', 'KeyD'],
  ['n', 'KeyN'],
  ['x', 'KeyX'],
  ['+', 'Equal'],
  ['g', 'KeyG'],
  ['G', 'KeyG'],
  ['/', 'Slash']
]

const pressTyped = (key: string, code: string): KeyboardEvent => {
  const event = press(key, code, key === 'G' ? { shiftKey: true } : {})
  if (key === 'g') press('g', 'KeyG')
  return event
}

/** A dialog over the panel, the way the shared Modal and ContextMenu mark
 *  theirs; returns the remover. */
function openOverlay(kind: 'dialog' | 'menu'): () => void {
  const el = document.createElement('div')
  if (kind === 'dialog') el.setAttribute('aria-modal', 'true')
  else el.setAttribute('data-ctx-menu', '')
  document.body.append(el)
  return () => el.remove()
}

let host: HTMLDivElement
let root: Root
let originalState: ReturnType<typeof useStore.getState>
let selectNote: ReturnType<typeof vi.fn>
let setSearchOpen: ReturnType<typeof vi.fn>
let setConnectionPreview: ReturnType<typeof vi.fn>

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
  selectNote = vi.fn().mockResolvedValue(undefined)
  setSearchOpen = vi.fn()
  setConnectionPreview = vi.fn()
  menuOpenedOn.mockClear()
  useStore.setState({
    sidebarOpen: true,
    selectNote,
    setSearchOpen,
    setConnectionPreview,
    editorViewRef: null
  } as never)
})

afterEach(() => {
  const pending = getConfirmRequest()
  if (pending) settleConfirmRequest(pending, false)
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useStore.setState(originalState, true)
})

const focused = (): string | null => useStore.getState().focusedPanel

// ---------------------------------------------------------------------------
// Note list
// ---------------------------------------------------------------------------

describe('note list keys in VimNav', () => {
  const TOTAL = 40
  const RENDERED = 10
  let fileClicks: number

  /** The column as NoteList renders it: forty entries, the first ten on
   *  screen (the list is virtual), the last of those a file. */
  beforeEach(() => {
    const rows = Array.from({ length: RENDERED }, (_, i) =>
      i === RENDERED - 1
        ? `<button data-notelist-idx="${i}" data-notelist-type="asset" data-notelist-path="inbox/Projects/diagram.png">diagram.png</button>`
        : `<button data-notelist-idx="${i}" data-notelist-type="note" data-notelist-path="inbox/Projects/P${i}.md">P${i}</button>`
    ).join('')
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div data-notelist-count="${TOTAL}" data-panel-scroll>${rows}</div>`
    )
    layOut('[data-notelist-idx]')
    fileClicks = 0
    document
      .querySelector('[data-notelist-type="asset"]')!
      .addEventListener('click', () => (fileClicks += 1))
    useStore.setState({ focusedPanel: 'notelist', noteListCursorIndex: 0 } as never)
  })

  const cursor = (): number => useStore.getState().noteListCursorIndex

  describe('with Vim mode off', () => {
    it('moves with the arrows, jumps with Home and End, and pages a screenful', () => {
      mount(false)
      expect(press('ArrowDown', 'ArrowDown').defaultPrevented).toBe(true)
      press('ArrowDown', 'ArrowDown')
      press('ArrowUp', 'ArrowUp')
      expect(cursor()).toBe(1)
      // Five rows show; a page is four, so the row left behind stays in view.
      press('PageDown', 'PageDown')
      expect(cursor()).toBe(5)
      press('PageUp', 'PageUp')
      expect(cursor()).toBe(1)
      // End reaches the last entry, not the last row on screen.
      press('End', 'End')
      expect(cursor()).toBe(TOTAL - 1)
      press('PageUp', 'PageUp')
      expect(cursor()).toBe(TOTAL - 5)
      press('Home', 'Home')
      expect(cursor()).toBe(0)
    })

    it('opens the note with ArrowRight or Enter and hands the keyboard to the editor', () => {
      mount(false)
      press('ArrowDown', 'ArrowDown')
      expect(press('ArrowRight', 'ArrowRight').defaultPrevented).toBe(true)
      expect(selectNote).toHaveBeenCalledWith('inbox/Projects/P1.md')
      expect(focused()).toBe('editor')

      useStore.setState({ focusedPanel: 'notelist' } as never)
      press('ArrowDown', 'ArrowDown')
      press('Enter', 'Enter')
      expect(selectNote).toHaveBeenLastCalledWith('inbox/Projects/P2.md')
    })

    it('opens a file row the way its click does, never as a note', () => {
      useStore.setState({ noteListCursorIndex: RENDERED - 1 } as never)
      mount(false)
      press('Enter', 'Enter')
      expect(fileClicks).toBe(1)
      expect(selectNote).not.toHaveBeenCalled()
    })

    it('goes back to the sidebar with ArrowLeft, as h does', () => {
      mount(false)
      expect(press('ArrowLeft', 'ArrowLeft').defaultPrevented).toBe(true)
      expect(focused()).toBe('sidebar')
    })

    it('returns to the editor with Escape', () => {
      mount(false)
      expect(press('Escape', 'Escape').defaultPrevented).toBe(true)
      expect(focused()).toBe('editor')
    })

    it('opens the row menu with Shift+F10 and the Context Menu key', () => {
      useStore.setState({ noteListCursorIndex: 2 } as never)
      mount(false)
      const row = document.querySelector('[data-notelist-idx="2"]')
      expect(press('F10', 'F10', { shiftKey: true }).defaultPrevented).toBe(true)
      expect(press('ContextMenu', 'ContextMenu').defaultPrevented).toBe(true)
      expect(menuOpenedOn.mock.calls).toEqual([[row], [row]])
    })

    it.each(TYPED_KEYS)('leaves the typed key %s alone', (key, code) => {
      mount(false)
      const event = pressTyped(key, code)
      expect(event.defaultPrevented).toBe(false)
      expect(cursor()).toBe(0)
      expect(selectNote).not.toHaveBeenCalled()
      expect(setSearchOpen).not.toHaveBeenCalled()
      expect(menuOpenedOn).not.toHaveBeenCalled()
      expect(focused()).toBe('notelist')
    })

    it('leaves chords, other panels and text fields their keys', () => {
      mount(false)
      expect(press('ArrowDown', 'ArrowDown', { altKey: true }).defaultPrevented).toBe(false)
      const input = document.createElement('input')
      document.body.append(input)
      expect(press('ArrowDown', 'ArrowDown', {}, input).defaultPrevented).toBe(false)
      useStore.setState({ focusedPanel: 'editor' } as never)
      expect(press('ArrowDown', 'ArrowDown').defaultPrevented).toBe(false)
      expect(cursor()).toBe(0)
    })

    it('stands down while a dialog or a menu is open', () => {
      mount(false)
      for (const kind of ['dialog', 'menu'] as const) {
        const close = openOverlay(kind)
        expect(press('ArrowDown', 'ArrowDown').defaultPrevented).toBe(false)
        expect(press('Enter', 'Enter').defaultPrevented).toBe(false)
        expect(press('F10', 'F10', { shiftKey: true }).defaultPrevented).toBe(false)
        close()
      }
      expect(cursor()).toBe(0)
      expect(selectNote).not.toHaveBeenCalled()
      expect(menuOpenedOn).not.toHaveBeenCalled()
    })
  })

  describe('with Vim mode on', () => {
    it('keeps j / k, G, gg, l, h, m and /', () => {
      mount(true)
      press('j', 'KeyJ')
      press('j', 'KeyJ')
      press('k', 'KeyK')
      expect(cursor()).toBe(1)
      press('G', 'KeyG', { shiftKey: true })
      expect(cursor()).toBe(TOTAL - 1)
      press('g', 'KeyG')
      press('g', 'KeyG')
      expect(cursor()).toBe(0)
      press('m', 'KeyM')
      expect(menuOpenedOn).toHaveBeenCalledTimes(1)
      press('/', 'Slash')
      expect(setSearchOpen).toHaveBeenCalledWith(true)
      press('h', 'KeyH')
      expect(focused()).toBe('sidebar')
      useStore.setState({ focusedPanel: 'notelist' } as never)
      press('l', 'KeyL')
      expect(selectNote).toHaveBeenCalledWith('inbox/Projects/P0.md')
    })

    it('opens a file row the way its click does with l and Enter too', () => {
      // Vim mode used to hand the file to selectNote, which opened the image
      // as a note's text.
      useStore.setState({ noteListCursorIndex: RENDERED - 1 } as never)
      mount(true)
      press('l', 'KeyL')
      useStore.setState({ focusedPanel: 'notelist' } as never)
      press('Enter', 'Enter')
      expect(fileClicks).toBe(2)
      expect(selectNote).not.toHaveBeenCalled()
    })

    it('leaves Home, End and the page keys as they were', () => {
      mount(true)
      for (const key of ['Home', 'End', 'PageDown', 'PageUp']) {
        expect(press(key, key).defaultPrevented).toBe(false)
      }
      expect(cursor()).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

describe('connections keys in VimNav', () => {
  beforeEach(() => {
    const rows = Array.from(
      { length: 12 },
      (_, i) =>
        `<button data-connections-idx="${i}" data-connections-type="note" data-connections-path="inbox/C${i}.md">C${i}</button>`
    ).join('')
    document.body.insertAdjacentHTML('beforeend', `<aside data-connections-panel><div data-panel-scroll>${rows}</div></aside>`)
    layOut('[data-connections-idx]')
    useStore.setState({
      focusedPanel: 'connections',
      connectionsCursorIndex: 0,
      notes: [{ path: 'inbox/C0.md', title: 'C0' }]
    } as never)
  })

  const cursor = (): number => useStore.getState().connectionsCursorIndex

  describe('with Vim mode off', () => {
    it('moves with the arrows, jumps with Home and End, and pages a screenful', () => {
      mount(false)
      expect(press('ArrowDown', 'ArrowDown').defaultPrevented).toBe(true)
      expect(cursor()).toBe(1)
      press('PageDown', 'PageDown')
      expect(cursor()).toBe(5)
      press('End', 'End')
      expect(cursor()).toBe(11)
      press('PageUp', 'PageUp')
      expect(cursor()).toBe(7)
      press('Home', 'Home')
      expect(cursor()).toBe(0)
      press('ArrowUp', 'ArrowUp')
      expect(cursor()).toBe(0)
    })

    it('opens the row with ArrowRight and with Enter', () => {
      mount(false)
      press('ArrowDown', 'ArrowDown')
      expect(press('ArrowRight', 'ArrowRight').defaultPrevented).toBe(true)
      expect(selectNote).toHaveBeenCalledWith('inbox/C1.md')
      expect(focused()).toBe('editor')
      useStore.setState({ focusedPanel: 'connections' } as never)
      press('Enter', 'Enter')
      expect(selectNote).toHaveBeenCalledTimes(2)
    })

    it('returns to the editor with ArrowLeft and Escape, as h does', () => {
      mount(false)
      press('ArrowLeft', 'ArrowLeft')
      expect(focused()).toBe('editor')
      useStore.setState({ focusedPanel: 'connections' } as never)
      press('Escape', 'Escape')
      expect(focused()).toBe('editor')
    })

    it('has no row menu, so the menu keys pass', () => {
      mount(false)
      expect(press('F10', 'F10', { shiftKey: true }).defaultPrevented).toBe(false)
      expect(press('ContextMenu', 'ContextMenu').defaultPrevented).toBe(false)
      expect(menuOpenedOn).not.toHaveBeenCalled()
    })

    it.each(TYPED_KEYS)('leaves the typed key %s alone', (key, code) => {
      mount(false)
      expect(pressTyped(key, code).defaultPrevented).toBe(false)
      expect(cursor()).toBe(0)
      expect(selectNote).not.toHaveBeenCalled()
      expect(setConnectionPreview).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'inbox/C0.md' }))
      expect(focused()).toBe('connections')
    })

    it('stands down while a dialog or a menu is open', () => {
      mount(false)
      for (const kind of ['dialog', 'menu'] as const) {
        const close = openOverlay(kind)
        expect(press('ArrowDown', 'ArrowDown').defaultPrevented).toBe(false)
        expect(press('ArrowRight', 'ArrowRight').defaultPrevented).toBe(false)
        close()
      }
      expect(cursor()).toBe(0)
      expect(selectNote).not.toHaveBeenCalled()
    })
  })

  describe('with Vim mode on', () => {
    it('keeps j / k, G, gg, l and p', () => {
      mount(true)
      press('j', 'KeyJ')
      press('k', 'KeyK')
      press('j', 'KeyJ')
      expect(cursor()).toBe(1)
      press('G', 'KeyG', { shiftKey: true })
      expect(cursor()).toBe(11)
      press('g', 'KeyG')
      press('g', 'KeyG')
      expect(cursor()).toBe(0)
      press('p', 'KeyP')
      expect(setConnectionPreview).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'inbox/C0.md' }))
      useStore.setState({ focusedPanel: 'connections' } as never)
      press('l', 'KeyL')
      expect(selectNote).toHaveBeenCalledWith('inbox/C0.md')
    })

    it('leaves Home, End and the page keys as they were', () => {
      mount(true)
      for (const key of ['Home', 'End', 'PageDown', 'PageUp']) {
        expect(press(key, key).defaultPrevented).toBe(false)
      }
      expect(cursor()).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

describe('outline keys in VimNav', () => {
  let jumped: number[]

  beforeEach(() => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `<li><button data-outline-idx="${i}" data-outline-line="${i * 4 + 1}">Section ${i}</button></li>`
    ).join('')
    document.body.insertAdjacentHTML(
      'beforeend',
      `<section data-outline-panel><input placeholder="Filter…" /><div data-panel-scroll><ul>${rows}</ul></div></section>`
    )
    layOut('[data-outline-idx]')
    jumped = []
    document.querySelectorAll<HTMLElement>('[data-outline-idx]').forEach((el) => {
      el.addEventListener('click', () => jumped.push(Number(el.dataset.outlineIdx)))
    })
    useStore.setState({ focusedPanel: 'outline', outlineCursorIndex: 0 } as never)
  })

  const cursor = (): number => useStore.getState().outlineCursorIndex

  describe('with Vim mode off', () => {
    it('moves with the arrows, jumps with Home and End, and pages a screenful', () => {
      mount(false)
      press('ArrowDown', 'ArrowDown')
      press('ArrowDown', 'ArrowDown')
      expect(cursor()).toBe(2)
      press('PageDown', 'PageDown')
      expect(cursor()).toBe(6)
      press('End', 'End')
      expect(cursor()).toBe(11)
      press('Home', 'Home')
      expect(cursor()).toBe(0)
    })

    it('jumps to the heading with ArrowRight and with Enter', () => {
      mount(false)
      press('ArrowDown', 'ArrowDown')
      expect(press('ArrowRight', 'ArrowRight').defaultPrevented).toBe(true)
      press('Enter', 'Enter')
      expect(jumped).toEqual([1, 1])
    })

    it('returns to the editor with ArrowLeft and Escape, as h does', () => {
      mount(false)
      press('ArrowLeft', 'ArrowLeft')
      expect(focused()).toBe('editor')
      useStore.setState({ focusedPanel: 'outline' } as never)
      press('Escape', 'Escape')
      expect(focused()).toBe('editor')
    })

    it('leaves the heading filter its keys', () => {
      mount(false)
      const input = document.querySelector('input')!
      expect(press('ArrowDown', 'ArrowDown', {}, input).defaultPrevented).toBe(false)
      expect(press('End', 'End', {}, input).defaultPrevented).toBe(false)
      expect(cursor()).toBe(0)
    })

    it.each(TYPED_KEYS)('leaves the typed key %s alone', (key, code) => {
      mount(false)
      expect(pressTyped(key, code).defaultPrevented).toBe(false)
      expect(cursor()).toBe(0)
      expect(jumped).toEqual([])
      expect(focused()).toBe('outline')
    })

    it('stands down while a dialog or a menu is open', () => {
      mount(false)
      for (const kind of ['dialog', 'menu'] as const) {
        const close = openOverlay(kind)
        expect(press('PageDown', 'PageDown').defaultPrevented).toBe(false)
        expect(press('Enter', 'Enter').defaultPrevented).toBe(false)
        close()
      }
      expect(cursor()).toBe(0)
      expect(jumped).toEqual([])
    })
  })

  describe('with Vim mode on', () => {
    it('keeps j / k, G, gg, l and h', () => {
      mount(true)
      press('j', 'KeyJ')
      press('j', 'KeyJ')
      press('k', 'KeyK')
      expect(cursor()).toBe(1)
      press('l', 'KeyL')
      expect(jumped).toEqual([1])
      press('G', 'KeyG', { shiftKey: true })
      expect(cursor()).toBe(11)
      press('g', 'KeyG')
      press('g', 'KeyG')
      expect(cursor()).toBe(0)
      press('h', 'KeyH')
      expect(focused()).toBe('editor')
    })

    it('leaves Home, End and the page keys as they were', () => {
      mount(true)
      for (const key of ['Home', 'End', 'PageDown', 'PageUp']) {
        expect(press(key, key).defaultPrevented).toBe(false)
      }
      expect(cursor()).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe('comments keys in VimNav', () => {
  let clicks: string[]

  beforeEach(() => {
    const cards = Array.from(
      { length: 8 },
      (_, i) => `<article data-comments-idx="${i}" data-comment-id="c${i}" data-comment-card-id="c${i}">
        <p>Comment ${i}</p>
        <div data-comment-card-control>
          ${['jump', 'reply', 'edit', 'resolve', 'delete']
            .map((action) => `<button data-comment-card-control data-comment-action="${action}">${action}</button>`)
            .join('')}
        </div>
      </article>`
    ).join('')
    document.body.insertAdjacentHTML(
      'beforeend',
      `<aside data-comments-panel tabindex="-1"><button data-comments-new>New</button><div data-panel-scroll>${cards}</div></aside>`
    )
    // Cards are taller than rows: three show at a time (120 px of 40 px cards).
    layOut('[data-comments-idx]', Array(8).fill(40))
    clicks = []
    document.querySelectorAll<HTMLElement>('[data-comments-idx]').forEach((card) => {
      card.addEventListener('click', (event) => {
        const action = (event.target as HTMLElement).dataset.commentAction
        clicks.push(`${card.dataset.commentId}:${action ?? 'card'}`)
      })
    })
    document
      .querySelector('[data-comments-new]')!
      .addEventListener('click', () => clicks.push('new'))
    useStore.setState({ focusedPanel: 'comments', activeCommentId: 'c0' } as never)
  })

  const active = (): string | null => useStore.getState().activeCommentId
  const confirmTitle = (): string | null => getConfirmRequest()?.options.title ?? null
  const answerConfirm = async (yes: boolean): Promise<void> => {
    const request = getConfirmRequest()
    expect(request).not.toBeNull()
    await act(async () => {
      settleConfirmRequest(request!, yes)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  describe('with Vim mode off', () => {
    it('moves with the arrows, jumps with Home and End, and pages a screenful', () => {
      mount(false)
      expect(press('ArrowDown', 'ArrowDown').defaultPrevented).toBe(true)
      expect(active()).toBe('c1')
      // Three 40 px cards show; the page keeps the card left behind on screen.
      press('PageDown', 'PageDown')
      expect(active()).toBe('c3')
      press('End', 'End')
      expect(active()).toBe('c7')
      press('PageUp', 'PageUp')
      expect(active()).toBe('c5')
      press('Home', 'Home')
      expect(active()).toBe('c0')
    })

    it('opens the comment (jumps to its text) with Enter and with ArrowRight', () => {
      mount(false)
      press('ArrowDown', 'ArrowDown')
      expect(press('Enter', 'Enter').defaultPrevented).toBe(true)
      expect(press('ArrowRight', 'ArrowRight').defaultPrevented).toBe(true)
      expect(clicks).toEqual(['c1:card', 'c1:card'])
    })

    it('leaves Enter to a focused card button', () => {
      mount(false)
      const reply = document.querySelector<HTMLElement>('[data-comment-id="c0"] [data-comment-action="reply"]')!
      expect(press('Enter', 'Enter', {}, reply).defaultPrevented).toBe(false)
      expect(clicks).toEqual([])
    })

    it('asks before Backspace or Delete deletes, and deletes only on yes', async () => {
      mount(false)
      press('ArrowDown', 'ArrowDown')
      expect(press('Backspace', 'Backspace').defaultPrevented).toBe(true)
      expect(confirmTitle()).toBe('Delete this comment?')
      expect(clicks).toEqual([])
      await answerConfirm(false)
      expect(clicks).toEqual([])
      expect(active()).toBe('c1')

      press('Delete', 'Delete')
      expect(confirmTitle()).toBe('Delete this comment?')
      await answerConfirm(true)
      expect(clicks).toEqual(['c1:delete'])
      // The cursor takes the next comment, not the first one.
      expect(active()).toBe('c2')
    })

    it('puts the cursor on the previous comment after deleting the last one', async () => {
      mount(false)
      press('End', 'End')
      expect(active()).toBe('c7')
      press('Delete', 'Delete')
      await answerConfirm(true)
      expect(clicks).toEqual(['c7:delete'])
      expect(active()).toBe('c6')
    })

    it('returns to the editor with ArrowLeft and Escape, as h does', () => {
      mount(false)
      press('ArrowLeft', 'ArrowLeft')
      expect(focused()).toBe('editor')
      useStore.setState({ focusedPanel: 'comments' } as never)
      press('Escape', 'Escape')
      expect(focused()).toBe('editor')
    })

    it.each(TYPED_KEYS)('leaves the typed key %s alone', (key, code) => {
      mount(false)
      expect(pressTyped(key, code).defaultPrevented).toBe(false)
      expect(active()).toBe('c0')
      expect(clicks).toEqual([])
      expect(getConfirmRequest()).toBeNull()
      expect(setSearchOpen).not.toHaveBeenCalled()
      expect(focused()).toBe('comments')
    })

    it('leaves a comment draft its keys', () => {
      mount(false)
      const draft = document.createElement('textarea')
      document.querySelector('[data-comments-panel]')!.append(draft)
      expect(press('Backspace', 'Backspace', {}, draft).defaultPrevented).toBe(false)
      expect(press('ArrowDown', 'ArrowDown', {}, draft).defaultPrevented).toBe(false)
      expect(getConfirmRequest()).toBeNull()
      expect(active()).toBe('c0')
    })

    it('stands down while a dialog or a menu is open', () => {
      mount(false)
      for (const kind of ['dialog', 'menu'] as const) {
        const close = openOverlay(kind)
        expect(press('ArrowDown', 'ArrowDown').defaultPrevented).toBe(false)
        expect(press('Backspace', 'Backspace').defaultPrevented).toBe(false)
        expect(press('Enter', 'Enter').defaultPrevented).toBe(false)
        close()
      }
      expect(active()).toBe('c0')
      expect(clicks).toEqual([])
      expect(getConfirmRequest()).toBeNull()
    })
  })

  describe('with Vim mode on', () => {
    it('keeps j / k, G, gg, o, e, r, a and n', () => {
      mount(true)
      press('j', 'KeyJ')
      press('j', 'KeyJ')
      press('k', 'KeyK')
      expect(active()).toBe('c1')
      press('G', 'KeyG', { shiftKey: true })
      expect(active()).toBe('c7')
      press('g', 'KeyG')
      press('g', 'KeyG')
      expect(active()).toBe('c0')
      press('o', 'KeyO')
      press('e', 'KeyE')
      press('r', 'KeyR')
      press('a', 'KeyA')
      press('n', 'KeyN')
      expect(clicks).toEqual(['c0:card', 'c0:edit', 'c0:resolve', 'c0:reply', 'new'])
    })

    it('asks before d, Backspace or Delete deletes', async () => {
      mount(true)
      for (const [key, code] of [
        ['d', 'KeyD'],
        ['Backspace', 'Backspace'],
        ['Delete', 'Delete']
      ]) {
        expect(press(key, code).defaultPrevented).toBe(true)
        expect(confirmTitle()).toBe('Delete this comment?')
        await answerConfirm(false)
      }
      expect(clicks).toEqual([])
      press('d', 'KeyD')
      await answerConfirm(true)
      expect(clicks).toEqual(['c0:delete'])
    })

    it('leaves Home, End and the page keys as they were', () => {
      mount(true)
      for (const key of ['Home', 'End', 'PageDown', 'PageUp']) {
        expect(press(key, key).defaultPrevented).toBe(false)
      }
      expect(active()).toBe('c0')
    })
  })
})
