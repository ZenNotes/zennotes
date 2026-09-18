// @vitest-environment jsdom
//
// Guards two things about ExcalidrawView.
//
// Theme: the view derives its theme from document.documentElement.dataset.themeMode
// rather than looking up the theme id in THEMES. The THEMES array only contains
// built-in themes, so a custom theme id (e.g. "custom-mine") would always resolve
// to "light" under the old approach (THEMES.find returns undefined and
// undefined?.mode === 'dark' is false). Those tests would catch a regression back
// to THEMES.find().
//
// Saving: a scene the canvas reports is written to the path that canvas was
// opened for, never to the path the view happens to show when the debounce
// fires (#755). The stand-in canvas below reproduces the two Excalidraw
// behaviours the view has to survive: initialData is read once at mount (a
// keyed remount gets a fresh scene, a prop change does not), and onChange
// fires from componentDidUpdate on every render with the scene the canvas
// holds.

import { act, createElement, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Spy on the Excalidraw component so we can inspect its props. vi.hoisted is
// needed so the variables are in scope for both the mock module factory and
// the test body.
const { mockExcalidraw, mockSerializeAsJSON } = vi.hoisted(() => {
  const mockExcalidraw = vi.fn((_props: Record<string, unknown>): null => null)
  const mockSerializeAsJSON = vi.fn((elements: unknown): string => JSON.stringify(elements))
  return { mockExcalidraw, mockSerializeAsJSON }
})

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: mockExcalidraw,
  serializeAsJSON: mockSerializeAsJSON
}))

// Mock store: expose a custom theme id that does NOT exist in the built-in THEMES array.
const { storeState } = vi.hoisted(() => {
  const storeState: Record<string, unknown> = {
    themeId: 'custom-test-theme',
    themeMode: 'dark',
    setFocusedPanel: () => undefined
  }
  return { storeState }
})

vi.mock('../store', () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState)
}))

import { ExcalidrawView } from './ExcalidrawView'

type SceneElement = { id: string; type: string }
type CanvasProps = {
  initialData?: { elements?: SceneElement[] }
  onChange?: (elements: SceneElement[], appState: unknown, files: unknown) => void
  theme?: string
}

const CANVAS_APP_STATE = { scrollX: 0, scrollY: 0, zoom: { value: 1 } }

function FakeCanvas(props: CanvasProps): null {
  const [scene] = useState(() => props.initialData?.elements ?? [])
  useLayoutEffect(() => {
    props.onChange?.(scene, CANVAS_APP_STATE, {})
  })
  return null
}
mockExcalidraw.mockImplementation(FakeCanvas as (props: Record<string, unknown>) => null)

const FIRST = 'inbox/First.excalidraw'
const SECOND = 'inbox/Second.excalidraw'
const ELLIPSE: SceneElement[] = [{ id: 'first-ellipse', type: 'ellipse' }]
const RECTANGLE: SceneElement[] = [{ id: 'second-rect', type: 'rectangle' }]
const SAVE_DEBOUNCE_MS = 700

function drawingBody(elements: SceneElement[]): string {
  return JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: {}, files: {} })
}

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
        writeNote: vi.fn()
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
    // Flush the readNote effect so the drawing loads and Excalidraw renders.
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

  it('tracks a live theme-mode switch while the drawing stays open', async () => {
    document.documentElement.dataset.themeMode = 'light'

    await act(async () => {
      root.render(createElement(ExcalidrawView, { path: 'inbox/drawing.excalidraw' }))
    })
    await act(async () => {})
    expect(mockExcalidraw.mock.lastCall?.[0].theme).toBe('light')

    // App.tsx flips data-theme-mode when the theme changes; the view observes it
    // and must re-render dark without a remount (guards against reading the
    // attribute only once during render).
    await act(async () => {
      document.documentElement.dataset.themeMode = 'dark'
    })
    await act(async () => {})
    expect(mockExcalidraw.mock.lastCall?.[0].theme).toBe('dark')
  })
})

describe('ExcalidrawView saves each drawing to its own path (#755)', () => {
  let root: Root
  let host: HTMLDivElement
  let readNote: ReturnType<typeof vi.fn>
  let writeNote: ReturnType<typeof vi.fn>

  const bodies: Record<string, string> = {
    [FIRST]: drawingBody(ELLIPSE),
    [SECOND]: drawingBody(RECTANGLE)
  }

  /** Every (path, elements) pair handed to writeNote, decoded. */
  const writes = (): Array<[string, SceneElement[]]> =>
    writeNote.mock.calls.map(([path, json]) => [path as string, JSON.parse(json as string)])

  const render = (path: string): Promise<void> =>
    act(async () => {
      root.render(createElement(ExcalidrawView, { path }))
    })

  const settle = (): Promise<void> => act(async () => {})

  const passDebounce = (): Promise<void> =>
    act(async () => {
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS + 1)
    })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    readNote = vi.fn((path: string) => Promise.resolve({ body: bodies[path] ?? '' }))
    writeNote = vi.fn(() => Promise.resolve())
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: { readNote, writeNote }
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('writes the drawing being left to its own path and never over the next one', async () => {
    await render(FIRST)
    await settle()
    await passDebounce()
    expect(writes()).toEqual([[FIRST, ELLIPSE]])

    await render(SECOND)
    await settle()
    await passDebounce()

    for (const [path, elements] of writes()) {
      expect(elements, `${path} received the wrong scene`).toEqual(
        path === FIRST ? ELLIPSE : RECTANGLE
      )
    }
    expect(writes().some(([path]) => path === SECOND)).toBe(true)
  })

  it('keeps the previous scene off the new path when the next read lands in the same render batch', async () => {
    await render(FIRST)
    await settle()
    await passDebounce()

    // A local vault answers the read for the next drawing before React gets to
    // render the "Loading drawing" placeholder, so both state updates land in
    // one batch and the canvas is never torn down between the two drawings.
    // A thenable that settles synchronously reproduces that batch exactly.
    readNote.mockImplementation((path: string) => {
      const settled = {
        then(onFulfilled: (value: { body: string }) => void) {
          onFulfilled({ body: bodies[path] ?? '' })
          return settled
        },
        catch() {
          return settled
        }
      }
      return settled
    })
    await render(SECOND)
    await settle()
    await passDebounce()

    const toSecond = writes().filter(([path]) => path === SECOND)
    expect(toSecond.map(([, elements]) => elements)).not.toContainEqual(ELLIPSE)
    expect(mockExcalidraw.mock.lastCall?.[0].initialData).toMatchObject({ elements: RECTANGLE })
    expect(bodies[FIRST]).toBe(drawingBody(ELLIPSE))
  })

  it('ignores a change the torn-down canvas reports after the view moved on', async () => {
    await render(FIRST)
    await settle()
    await passDebounce()
    const firstCanvasOnChange = mockExcalidraw.mock.lastCall?.[0].onChange as CanvasProps['onChange']
    expect(firstCanvasOnChange).toBeTypeOf('function')

    await render(SECOND)
    await settle()
    const writesBefore = writes().length

    // Excalidraw calls onChange from componentDidUpdate, so a canvas that is
    // being replaced can still report its scene once React has already moved
    // the view to the next path.
    await act(async () => {
      firstCanvasOnChange?.(ELLIPSE, CANVAS_APP_STATE, {})
    })
    await passDebounce()

    // The late report produced nothing; the only write since is Second's own
    // debounce carrying Second's scene.
    expect(writes().slice(writesBefore)).toEqual([[SECOND, RECTANGLE]])
  })
})
