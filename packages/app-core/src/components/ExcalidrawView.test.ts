// @vitest-environment jsdom
//
// Guards: ExcalidrawView derives its theme from document.documentElement.dataset.themeMode
// rather than looking up the theme id in THEMES. The THEMES array only contains built-in
// themes, so a custom theme id (e.g. "custom-mine") would always resolve to "light" under
// the old approach — THEMES.find returns undefined and undefined?.mode === 'dark' is false.
// This test verifies that dark custom themes correctly produce a dark Excalidraw theme,
// and would catch a regression back to THEMES.find().

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Spy on the Excalidraw component so we can inspect its theme prop.
// vi.hoisted is needed so the variable is in scope for both the mock module factory
// and the test body.
const { mockExcalidraw } = vi.hoisted(() => {
  const mockExcalidraw = vi.fn((_props: Record<string, unknown>) => null)
  return { mockExcalidraw }
})

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: mockExcalidraw,
  serializeAsJSON: vi.fn(() => '{}')
}))

// Mock store: expose a custom theme id that does NOT exist in the built-in THEMES array.
const { storeState } = vi.hoisted(() => {
  const storeState: Record<string, unknown> = {
    themeId: 'custom-test-theme',
    themeMode: 'dark',
  }
  return { storeState }
})

vi.mock('../store', () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState)
}))

import { ExcalidrawView } from './ExcalidrawView'

describe('ExcalidrawView theme mode with custom themes', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: {
        readNote: vi.fn().mockResolvedValue({ body: '{}' }),
        writeNote: vi.fn(),
      }
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('renders dark Excalidraw theme when custom theme id + data-theme-mode=dark', async () => {
    document.documentElement.dataset.themeMode = 'dark'

    await act(async () => {
      root.render(createElement(ExcalidrawView, { path: 'inbox/drawing.excalidraw' }))
    })
    // Flush the readNote effect so setInitialData runs and Excalidraw renders.
    await act(async () => {})

    expect(mockExcalidraw).toHaveBeenCalled()
    const lastCall = mockExcalidraw.mock.lastCall
    expect(lastCall?.[0].theme).toBe('dark')
  })

  it('renders light Excalidraw theme when custom theme id + data-theme-mode=light', async () => {
    document.documentElement.dataset.themeMode = 'light'

    await act(async () => {
      root.render(createElement(ExcalidrawView, { path: 'inbox/drawing.excalidraw' }))
    })
    await act(async () => {})

    expect(mockExcalidraw).toHaveBeenCalled()
    const lastCall = mockExcalidraw.mock.lastCall
    expect(lastCall?.[0].theme).toBe('light')
  })

})
