// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PdfOpenElsewhere } from './PdfOpenElsewhere'

// The reference pane and an asset tab show this instead of a frame where the
// engine has no PDF viewer: on Android both were blank sheets (Dave, Discord,
// 2026-10-27), and a pin made before the fix still opens the pane.

describe('PdfOpenElsewhere', () => {
  let root: Root
  let host: HTMLDivElement
  const openAssetExternally = vi.fn(async () => ({ ok: true }))

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(window, 'zen', { configurable: true, value: { openAssetExternally } })
    openAssetExternally.mockClear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() =>
      root.render(
        createElement(PdfOpenElsewhere, { assetPath: 'assets/Tourtickets.pdf', title: 'Tourtickets.pdf' })
      )
    )
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('names the file, says why, and hands it to another app without asking first', async () => {
    expect(host.textContent).toContain('Tourtickets.pdf')
    expect(host.textContent).toContain("This device can't show PDFs inside ZenNotes.")
    expect(host.querySelector('iframe')).toBeNull()

    const open = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Open in another app')!
    await act(async () => open.click())
    expect(openAssetExternally).toHaveBeenCalledWith('assets/Tourtickets.pdf')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
