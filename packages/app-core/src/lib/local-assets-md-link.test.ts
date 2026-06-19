// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Regression guard for #201: a standard-Markdown link to another note —
// `[text](Note.md)` — must NOT be rewritten into a `zen-asset://` URL by the
// asset enhancer (which made the preview open note links as broken asset tabs).
// Real asset links (images/PDFs) still get tagged.

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getCapabilities: vi.fn().mockReturnValue({
        supportsUpdater: false,
        supportsNativeMenus: false,
        supportsFloatingWindows: false,
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: false,
        supportsCliInstall: false,
        supportsCustomTemplates: false
      }),
      resolveLocalAssetUrl: vi.fn((_root: string, _note: string, href: string) => `zen-asset://v/${href}`),
      resolveVaultAssetUrl: vi.fn((_root: string, rel: string) => `zen-asset://v/${rel}`)
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

describe('#201 — enhanceLocalAssetNodes leaves note links alone', () => {
  it('tags a real asset link but not a `.md` note link', async () => {
    const { useStore, enhanceLocalAssetNodes } = await load()
    useStore.setState({ assetFiles: [{ path: 'Folder/pic.png' }] as never })

    const root = document.createElement('div')
    root.innerHTML = [
      '<a id="note" href="Another Note.md">a note</a>',
      '<a id="noteh" href="Another%20Note.md#Heading">with heading</a>',
      '<a id="asset" href="pic.png">an image</a>'
    ].join('')

    enhanceLocalAssetNodes(root, { vaultRoot: '/v', notePath: 'Folder/b.md' })

    const note = root.querySelector<HTMLAnchorElement>('#note')!
    const noteh = root.querySelector<HTMLAnchorElement>('#noteh')!
    const asset = root.querySelector<HTMLAnchorElement>('#asset')!

    // Note links keep their original href and are NOT tagged as assets.
    expect(note.dataset.localAssetUrl).toBeUndefined()
    expect(note.getAttribute('href')).toBe('Another Note.md')
    expect(noteh.dataset.localAssetUrl).toBeUndefined()

    // The real image link still gets resolved + tagged.
    expect(asset.dataset.localAssetUrl).toBe('zen-asset://v/Folder/pic.png')
  })
})
