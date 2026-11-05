// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { Sidebar } from './Sidebar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function note(title: string): NoteMeta {
  return {
    path: `inbox/${title}.md`,
    title,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    size: 0,
    tags: [],
    wikilinks: [],
    hasAttachments: false,
    assetEmbeds: [],
    excerpt: ''
  }
}

let coarse = false
let host: HTMLDivElement
let root: Root
let originalState: ReturnType<typeof useStore.getState>

beforeEach(() => {
  originalState = useStore.getState()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: coarse && query === '(pointer: coarse)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {}
    })
  })
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  const known: Record<string, unknown> = {
    platformSync: () => 'darwin',
    getAppInfo: () => ({ runtime: 'web', hostKind: 'ios' }),
    getCapabilities: () => ({}),
    duplicateNote: vi.fn(async () => note('One copy'))
  }
  ;(window as unknown as { zen: unknown }).zen = new Proxy(known, {
    get: (target, name: string) =>
      target[name] ??
      (name.startsWith('on') ? () => () => {} : async () => null)
  })
  useStore.setState({
    vault: { root: '/v', name: 'v' },
    notes: [note('One'), note('Two')],
    collapsedFolders: [],
    sidebarOpen: true,
    selectedPath: null,
    focusedPanel: 'sidebar',
    sidebarCursorIndex: 3,
    refreshNotes: vi.fn(async () => {}),
    selectNote: vi.fn(async () => {})
  } as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useStore.setState(originalState, true)
  vi.unstubAllGlobals()
  coarse = false
})

const cursorRows = (): Element[] => [
  ...host.querySelectorAll('.vim-cursor, .vim-cursor-on-active, .vim-cursor-on-selected')
]

const noteRow = (title: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-sidebar-path="inbox/${title}.md"]`)!

async function openMenuOn(row: HTMLElement): Promise<void> {
  await act(async () => {
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
  })
}

const menuItem = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-ctx-menu] button')].find((button) =>
    button.textContent?.trim().startsWith(label)
  )!

describe('Sidebar highlights', () => {
  it('draws the keyboard cursor where a pointer is fine', async () => {
    await act(async () => root.render(createElement(Sidebar)))
    expect(cursorRows()).toHaveLength(1)
  })

  it('draws no keyboard cursor on a touch device, whatever the index says', async () => {
    coarse = true
    await act(async () => root.render(createElement(Sidebar)))
    expect(cursorRows()).toHaveLength(0)
  })

  it('draws the cursor on a touch device once a key is pressed', async () => {
    coarse = true
    await act(async () => root.render(createElement(Sidebar)))
    expect(cursorRows()).toHaveLength(0)
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    })
    expect(cursorRows()).toHaveLength(1)
  })

  it('keeps one row selected with Cmd when a menu on it closes', async () => {
    await act(async () => root.render(createElement(Sidebar)))
    await act(async () => {
      noteRow('Two').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })
      )
    })
    expect(noteRow('Two').getAttribute('class')).toContain('bg-accent/[0.09]')
    await openMenuOn(noteRow('Two'))
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(noteRow('Two').getAttribute('class')).toContain('bg-accent/[0.09]')
  })

  it('takes the highlight off a row when its menu closes', async () => {
    await act(async () => root.render(createElement(Sidebar)))
    const row = noteRow('Two')
    await openMenuOn(row)
    const selected = row.getAttribute('class')
    expect(selected).toContain('bg-accent/[0.09]')
    await act(async () => menuItem('Duplicate').click())
    expect(noteRow('Two').getAttribute('class')).not.toContain('bg-accent/[0.09]')
  })

  it('keeps a selection the person made when a menu closes', async () => {
    await act(async () => root.render(createElement(Sidebar)))
    const click = (row: HTMLElement, init: MouseEventInit): Promise<void> =>
      act(async () => {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
      })
    await click(noteRow('One'), { metaKey: true })
    await click(noteRow('Two'), { metaKey: true })
    await openMenuOn(noteRow('Two'))
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(noteRow('One').getAttribute('class')).toContain('bg-accent/[0.09]')
    expect(noteRow('Two').getAttribute('class')).toContain('bg-accent/[0.09]')
  })
})
