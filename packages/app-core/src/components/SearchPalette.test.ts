// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import { useToastStore } from '../lib/toast'
import { SearchPalette } from './SearchPalette'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const confirmApp = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../lib/confirm-requests', () => ({ confirmApp }))

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

describe('SearchPalette: Ctrl+D moves the highlighted note to Trash', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let originalScrollIntoView: PropertyDescriptor | undefined
  let moveToTrash: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    confirmApp.mockClear()
    confirmApp.mockResolvedValue(true)

    const notes = [note('Alpha'), note('Beta'), note('Gamma')]
    moveToTrash = vi.fn(async (path: string) => ({
      ...notes.find((n) => n.path === path)!,
      path: path.replace('inbox/', 'trash/'),
      folder: 'trash' as const
    }))
    ;(window as unknown as { zen: unknown }).zen = { moveToTrash }
    useStore.setState({
      notes,
      selectedPath: null,
      noteContents: {},
      noteDirty: {},
      searchOpen: true,
      // The real refresh re-lists the vault through the bridge; here the
      // listing just forgets whatever was trashed.
      refreshNotes: async () => {
        const trashed = new Set(moveToTrash.mock.calls.map((call) => call[0] as string))
        useStore.setState({ notes: notes.filter((n) => !trashed.has(n.path)) })
      }
    })
    useToastStore.setState({ toasts: [] })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
    delete (window as unknown as { zen?: unknown }).zen
    vi.restoreAllMocks()
    useStore.setState(originalState, true)
  })

  const input = (): HTMLInputElement => {
    const el = document.querySelector<HTMLInputElement>('input[placeholder^="Search notes"]')
    if (!el) throw new Error('search input not rendered')
    return el
  }
  const rows = (): string[] =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-search-idx]')].map(
      (row) => row.textContent?.replace(/inbox$/i, '').trim() ?? ''
    )
  const ctrlD = async (): Promise<void> => {
    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true })
      )
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('trashes the highlighted note, keeps the palette open, and drops the row', async () => {
    act(() => root.render(createElement(SearchPalette)))
    expect(rows()).toEqual(['Alpha', 'Beta', 'Gamma'])

    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })
    await ctrlD()

    expect(confirmApp).toHaveBeenCalledTimes(1)
    expect(moveToTrash).toHaveBeenCalledWith('inbox/Beta.md')
    expect(useStore.getState().searchOpen).toBe(true)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(rows()).toEqual(['Alpha', 'Gamma'])
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'Moved "Beta" to Trash'
    )
    // The highlight stays on the row that took Beta's place.
    expect(document.querySelector('[data-search-idx="1"]')?.className).toContain('bg-paper-200')
  })

  it('does nothing when the confirmation is declined', async () => {
    confirmApp.mockResolvedValue(false)
    act(() => root.render(createElement(SearchPalette)))
    await ctrlD()
    expect(moveToTrash).not.toHaveBeenCalled()
    expect(rows()).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('clamps the highlight when the last row is trashed', async () => {
    act(() => root.render(createElement(SearchPalette)))
    for (let i = 0; i < 2; i++) {
      act(() => {
        input().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        )
      })
    }
    await ctrlD()
    expect(moveToTrash).toHaveBeenCalledWith('inbox/Gamma.md')
    expect(rows()).toEqual(['Alpha', 'Beta'])
    expect(document.querySelector('[data-search-idx="1"]')?.className).toContain('bg-paper-200')
  })
})
