// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

// The reading view stamps every top-level block with its source line so the
// split scroll sync and the reading position carried into Edit (#822) can
// find the source. A standalone image paragraph is replaced by a figure, which
// used to drop that stamp: the image was the one block Edit could not find,
// and its "Edit this block" button opened the editor wherever the caret was.

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

describe('image embed keeps its block source line', () => {
  it('moves the paragraph stamp onto the figure and hands it to "Edit this block"', async () => {
    const { useStore, enhanceLocalAssetNodes } = await load()
    useStore.setState({ assetFiles: [{ path: 'assets/shot.png' }] } as never)
    const root = document.createElement('div')
    root.innerHTML = '<p data-source-line="17"><img src="assets/shot.png" alt="shot"></p>'
    const onRequestEdit = vi.fn()
    enhanceLocalAssetNodes(root, { vaultRoot: '/v', notePath: 'inbox/Gallery.md', onRequestEdit })

    const figure = root.querySelector<HTMLElement>('figure.local-image-embed')!
    expect(figure.dataset.sourceLine).toBe('17')
    figure.getBoundingClientRect = () => ({ top: 240 } as DOMRect)

    figure.querySelector<HTMLButtonElement>('button[aria-label="Edit this block"]')!.click()
    expect(onRequestEdit).toHaveBeenCalledWith({ sourceLine: 17, blockClientTop: 240 })
  })

  it('reports no line for an image paragraph that was never stamped', async () => {
    const { useStore, enhanceLocalAssetNodes } = await load()
    useStore.setState({ assetFiles: [{ path: 'assets/shot.png' }] } as never)
    const root = document.createElement('div')
    root.innerHTML = '<p><img src="assets/shot.png" alt="shot"></p>'
    const onRequestEdit = vi.fn()
    enhanceLocalAssetNodes(root, { vaultRoot: '/v', notePath: 'inbox/Gallery.md', onRequestEdit })

    const figure = root.querySelector<HTMLElement>('figure.local-image-embed')!
    expect(figure.dataset.sourceLine).toBeUndefined()
    figure.querySelector<HTMLButtonElement>('button[aria-label="Edit this block"]')!.click()
    expect(onRequestEdit).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLine: null })
    )
  })
})
