// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The reading view's PDF embed is an iframe. Android's WebView has no PDF
// viewer, so there it was an empty white box (Dave, Discord, 2026-10-27); the
// card that opens the file in another app stands in for it instead.

const openAssetExternally = vi.fn(async () => ({ ok: true }))

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      resolveLocalAssetUrl: vi.fn((_r: string, _n: string, href: string) => `zen-asset://v/${href}`),
      resolveVaultAssetUrl: vi.fn((_r: string, rel: string) => `zen-asset://v/${rel}`),
      openAssetExternally
    }
  })
}

function setPdfViewer(enabled: boolean | undefined): void {
  Object.defineProperty(window.navigator, 'pdfViewerEnabled', {
    configurable: true,
    get: () => enabled
  })
}

async function load() {
  vi.resetModules()
  localStorage.clear()
  installZen()
  const { useStore } = await import('../store')
  const { enhanceLocalAssetNodes } = await import('./local-assets')
  useStore.setState({ assetFiles: [{ path: 'assets/Tourtickets.pdf' }] as never })
  return { useStore, enhanceLocalAssetNodes }
}

function render(
  enhance: Awaited<ReturnType<typeof load>>['enhanceLocalAssetNodes'],
  href: string,
  extra: { pinnedAssetPath?: string } = {}
): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `<p><a href="${href}">Tourtickets.pdf</a></p>`
  enhance(root, { vaultRoot: '/v', notePath: 'inbox/The trip.md', ...extra })
  return root
}

beforeEach(() => {
  openAssetExternally.mockClear()
})

afterEach(() => {
  delete (window.navigator as unknown as { pdfViewerEnabled?: boolean }).pdfViewerEnabled
})

describe('reading view: a PDF where the engine cannot draw one', () => {
  it.each([
    '/home/dave/pCloudrive/zennotes/assets/Tourtickets.pdf',
    'assets/Tourtickets.pdf'
  ])('shows a card for %s that opens the file in another app, with no frame', async (href) => {
    setPdfViewer(false)
    const { enhanceLocalAssetNodes } = await load()
    const root = render(enhanceLocalAssetNodes, href)

    expect(root.querySelector('iframe')).toBeNull()
    const card = root.querySelector<HTMLElement>('figure.local-asset-pinned-ref')!
    expect(card.dataset.localAssetKind).toBe('pdf')
    expect(card.querySelector('.local-asset-pinned-ref-text')?.textContent).toBe('Tourtickets.pdf')
    expect(card.querySelector('.local-asset-pinned-ref-badge')?.textContent).toBe('open')

    card.querySelector<HTMLButtonElement>('button')!.click()
    // No "Open attachment?" question first: a PDF viewer runs nothing.
    await vi.waitFor(() => expect(openAssetExternally).toHaveBeenCalledWith('assets/Tourtickets.pdf'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens the pinned reference elsewhere too, since the pane would be empty', async () => {
    setPdfViewer(false)
    const { enhanceLocalAssetNodes } = await load()
    const root = render(enhanceLocalAssetNodes, 'assets/Tourtickets.pdf', {
      pinnedAssetPath: 'assets/Tourtickets.pdf'
    })

    expect(root.querySelector('.local-asset-pinned-ref-badge')?.textContent).toBe('open')
  })
})

describe('reading view: a PDF where the engine draws it', () => {
  it.each([true, undefined])('keeps the framed embed (pdfViewerEnabled %s)', async (enabled) => {
    setPdfViewer(enabled)
    const { enhanceLocalAssetNodes } = await load()
    const root = render(enhanceLocalAssetNodes, 'assets/Tourtickets.pdf')

    expect(root.querySelector('figure.local-asset-embed iframe')?.getAttribute('src')).toBe(
      'zen-asset://v/assets/Tourtickets.pdf'
    )
    expect(root.querySelector('.local-asset-pinned-ref')).toBeNull()
  })
})
