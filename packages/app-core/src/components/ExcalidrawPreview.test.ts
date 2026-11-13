// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const preview = vi.hoisted(() => ({
  get: vi.fn<(path: string) => Promise<string | null>>(),
  peek: vi.fn<(path: string) => string | null>(() => null)
}))

vi.mock('../lib/excalidraw-preview', () => ({
  getExcalidrawPreview: preview.get,
  peekExcalidrawPreview: preview.peek
}))

import { ExcalidrawPreview } from './ExcalidrawPreview'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// #1078: a PDF export waits for each drawing embed to say it is done, so the
// rendered element carries its state: loading, ready (the image) or error.
describe('ExcalidrawPreview state', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    preview.get.mockReset()
  })

  it('reads loading until the drawing renders, then ready on its image', async () => {
    let finish: (url: string | null) => void = () => {}
    preview.get.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    act(() => root.render(createElement(ExcalidrawPreview, { path: 'diagram.excalidraw' })))
    expect(host.querySelector('[data-excalidraw-state]')?.getAttribute('data-excalidraw-state')).toBe(
      'loading'
    )

    await act(async () => finish('data:image/png;base64,AAAA'))
    const img = host.querySelector('img')
    expect(img?.getAttribute('data-excalidraw-state')).toBe('ready')
  })

  it('reads error when the drawing cannot be rendered', async () => {
    preview.get.mockResolvedValue(null)
    await act(async () => root.render(createElement(ExcalidrawPreview, { path: 'missing.excalidraw' })))
    expect(host.querySelector('[data-excalidraw-state]')?.getAttribute('data-excalidraw-state')).toBe(
      'error'
    )
  })
})
