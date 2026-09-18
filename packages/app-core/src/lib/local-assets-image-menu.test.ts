// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

// The reading view's right-click asset menu (Open, Rename…, Move…, Reveal,
// Delete…) finds its host through `[data-local-asset-kind][data-local-asset-url]`.
// PDF / audio / video embeds and attachment chips carried both since day one;
// image figures only stamped the URL on the `<img>`, so an image was the one
// embed with no menu.

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      resolveLocalAssetUrl: vi.fn((_r: string, _n: string, href: string) => `zen-asset://v/${href}`),
      resolveVaultAssetUrl: vi.fn((_r: string, rel: string) => `zen-asset://v/${rel}`)
    }
  })
}

async function load() {
  vi.resetModules()
  localStorage.clear()
  installZen()
  const { useStore } = await import('../store')
  const { enhanceLocalAssetNodes } = await import('./local-assets')
  return { useStore, enhanceLocalAssetNodes }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('image embeds carry the asset-menu host attributes', () => {
  it('tags the image figure with kind, url and href like the other embeds', async () => {
    const { useStore, enhanceLocalAssetNodes } = await load()
    useStore.setState({ assetFiles: [{ path: 'assets/shot.png' }] } as never)
    const root = document.createElement('div')
    root.innerHTML = '<p><img src="assets/shot.png" alt="shot"></p>'
    enhanceLocalAssetNodes(root, { vaultRoot: '/v', notePath: 'inbox/Gallery.md' })

    const figure = root.querySelector<HTMLElement>('figure.local-image-embed')
    expect(figure).not.toBeNull()
    expect(figure!.dataset.localAssetKind).toBe('image')
    expect(figure!.dataset.localAssetUrl).toBe('zen-asset://v/assets/shot.png')
    expect(figure!.dataset.localAssetHref).toBe('assets/shot.png')
    // The selector the Preview's context-menu handler walks up to.
    const img = figure!.querySelector('img')!
    expect(img.closest('[data-local-asset-kind][data-local-asset-url]')).toBe(figure)
  })
})
