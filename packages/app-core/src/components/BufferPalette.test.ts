// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findLeaf, type PaneLeaf } from '../lib/pane-layout'
import { useStore } from '../store'
import { BufferPalette } from './BufferPalette'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('BufferPalette (#641)', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let originalScrollIntoView: PropertyDescriptor | undefined

  beforeEach(() => {
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })

    const pane: PaneLeaf = {
      kind: 'leaf',
      id: 'pane-a',
      tabs: ['inbox/A.md', 'inbox/B.md', 'inbox/C.md'],
      pinnedTabs: [],
      activeTab: 'inbox/A.md'
    }
    useStore.setState({
      paneLayout: pane,
      activePaneId: pane.id,
      selectedPath: pane.activeTab,
      noteContents: {},
      noteDirty: {},
      notes: [],
      bufferPaletteOpen: true
    })
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
    vi.restoreAllMocks()
    useStore.setState(originalState, true)
  })

  it('closes the highlighted buffer with Ctrl+D while keeping the palette open', async () => {
    act(() => root.render(createElement(BufferPalette)))
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Switch buffer…"]')
    expect(input).not.toBeNull()

    // Natural order is B, C, then the current buffer A. Select C.
    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })

    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'd',
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      )
      await Promise.resolve()
    })

    expect(findLeaf(useStore.getState().paneLayout, 'pane-a')?.tabs).toEqual([
      'inbox/A.md',
      'inbox/B.md'
    ])
    expect(useStore.getState().bufferPaletteOpen).toBe(true)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    // The row after C stays highlighted. Closing it again exercises the
    // end-of-list clamp: A disappears and selection moves back to B.
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'd',
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      )
      await Promise.resolve()
    })

    expect(findLeaf(useStore.getState().paneLayout, 'pane-a')?.tabs).toEqual(['inbox/B.md'])
    expect(useStore.getState().bufferPaletteOpen).toBe(true)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-buf-idx="0"]')?.textContent).toContain(
      'B'
    )
  })
})
