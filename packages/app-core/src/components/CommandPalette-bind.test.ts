// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { useToastStore } from '../lib/toast'
import { CommandPalette } from './CommandPalette'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Alt+Enter on a palette row records a key for that command in place (#971).

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      platformSync: () => 'darwin',
      getAppInfo: vi.fn().mockReturnValue({ runtime: 'desktop' }),
      getCapabilities: vi.fn().mockReturnValue({
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: false,
        supportsCliInstall: false
      })
    }
  })
}

function setQuery(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function press(target: EventTarget, init: KeyboardEventInit & { key: string; code: string }): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

describe('Alt+Enter in the command palette', () => {
  let host: HTMLDivElement
  let root: Root
  let originalState: ReturnType<typeof useStore.getState>
  let originalScrollIntoView: PropertyDescriptor | undefined

  beforeEach(() => {
    installZen()
    originalState = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    useStore.setState({ commandPaletteOpen: true, commandKeymaps: {} })
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
    useStore.setState(originalState, true)
  })

  async function openOn(query: string): Promise<HTMLInputElement> {
    await act(async () => root.render(createElement(CommandPalette)))
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Type a command…"]')!
    await act(async () => setQuery(input, query))
    return input
  }

  it('names the key in the footer', async () => {
    await openOn('')
    expect(document.querySelector('[data-palette-bind-hint]')?.textContent).toBe('⌥↵ set key')
  })

  it('records a key for the highlighted command, saves it on Enter, and shows it on the row', async () => {
    const input = await openOn('New Drawing')
    expect(document.querySelector('[data-cmd-idx="0"]')?.textContent).toContain('New Drawing')

    await act(async () => press(input, { key: 'Enter', code: 'Enter', altKey: true }))
    const recorder = document.querySelector('[data-keymap-recorder="command"]')
    expect(recorder?.textContent).toContain('New Drawing')
    // Alt+Enter did not run the command or close the palette.
    expect(useStore.getState().commandPaletteOpen).toBe(true)

    await act(async () => press(window, { key: 'd', code: 'KeyD', metaKey: true, altKey: true }))
    expect(document.querySelector('[data-keymap-recorder-binding]')?.textContent).toBe('⌥⌘D')

    await act(async () => press(window, { key: 'Enter', code: 'Enter' }))
    expect(useStore.getState().commandKeymaps['drawing.new']).toBe('Alt+Mod+D')
    expect(document.querySelector('[data-keymap-recorder]')).toBeNull()
    expect(useStore.getState().commandPaletteOpen).toBe(true)
    expect(document.querySelector('[data-cmd-idx="0"]')?.textContent).toContain('⌥⌘D')
  })

  it('Escape leaves the recorder without saving and keeps the palette open', async () => {
    const input = await openOn('New Drawing')
    await act(async () => press(input, { key: 'Enter', code: 'Enter', altKey: true }))
    await act(async () => press(window, { key: 'd', code: 'KeyD', metaKey: true, altKey: true }))
    await act(async () => press(window, { key: 'Escape', code: 'Escape' }))
    expect(document.querySelector('[data-keymap-recorder]')).toBeNull()
    expect(useStore.getState().commandKeymaps['drawing.new']).toBeUndefined()
    expect(useStore.getState().commandPaletteOpen).toBe(true)
  })

  it('refuses a key another of your bindings holds', async () => {
    useStore.setState({ commandKeymaps: { 'note.new.quick': 'Alt+Mod+D' } })
    const input = await openOn('New Drawing')
    await act(async () => press(input, { key: 'Enter', code: 'Enter', altKey: true }))
    await act(async () => press(window, { key: 'd', code: 'KeyD', metaKey: true, altKey: true }))
    expect(
      document.querySelector('[data-keymap-recorder-notice="danger"]')?.textContent
    ).toContain('the command New Quick Note')
    expect(document.querySelector<HTMLButtonElement>('[data-keymap-recorder-save]')?.disabled).toBe(true)
    await act(async () => press(window, { key: 'Enter', code: 'Enter' }))
    expect(useStore.getState().commandKeymaps['drawing.new']).toBeUndefined()
    expect(document.querySelector('[data-keymap-recorder]')).not.toBeNull()
  })

  it('plain Enter still runs the highlighted command', async () => {
    const newDrawing = vi.fn()
    useStore.setState({ newDrawing } as never)
    const input = await openOn('New Drawing')
    await act(async () => press(input, { key: 'Enter', code: 'Enter' }))
    expect(newDrawing).toHaveBeenCalled()
    expect(document.querySelector('[data-keymap-recorder]')).toBeNull()
  })
})
