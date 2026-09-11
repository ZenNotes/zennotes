import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadAsset } from './download-asset'

// The helper talks to the DOM (`window.zen`, `document`, `URL.createObjectURL`)
// and to `fetch`. Vitest here runs in a node environment, so each test stubs
// exactly the surface the helper touches: resolve the embed URL, fetch it,
// and click a hidden anchor carrying the asset's basename.
describe('downloadAsset', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (URL as unknown as Record<string, unknown>).createObjectURL
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL
  })

  function stubDom(options: {
    resolve?: string | null
    fetchOk?: boolean
    fetchedUrl?: (url: string) => void
  }): { anchors: Array<{ download: string; click: ReturnType<typeof vi.fn> }> } {
    const anchors: Array<{ download: string; click: ReturnType<typeof vi.fn> }> = []
    const resolve = 'resolve' in options ? options.resolve : 'https://vault.test/api/assets/raw?path=x'
    vi.stubGlobal('window', {
      zen: { resolveVaultAssetUrl: vi.fn(() => resolve) }
    })
    vi.stubGlobal('document', {
      body: { appendChild: vi.fn() },
      createElement: () => {
        const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
        anchors.push(anchor)
        return anchor
      }
    })
    ;(URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:mock')
    ;(URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        options.fetchedUrl?.(String(url))
        return Promise.resolve({ ok: options.fetchOk ?? true, blob: () => Promise.resolve(new Blob(['PNG'])) })
      })
    )
    return { anchors }
  }

  it('fetches the resolved asset URL and clicks an anchor named after the asset', async () => {
    let fetched = ''
    const { anchors } = stubDom({ fetchedUrl: (url) => (fetched = url) })

    await downloadAsset('/vault', 'assets/holiday pic.png')

    expect(fetched).toBe('https://vault.test/api/assets/raw?path=x')
    expect(anchors).toHaveLength(1)
    expect(anchors[0]?.download).toBe('holiday pic.png')
    expect(anchors[0]?.click).toHaveBeenCalledOnce()
  })

  it('throws when the bridge cannot resolve the path', async () => {
    stubDom({ resolve: null })
    await expect(downloadAsset('/vault', '../escape.png')).rejects.toThrow('Asset path is invalid.')
  })

  it('throws when the asset cannot be read', async () => {
    stubDom({ fetchOk: false })
    await expect(downloadAsset('/vault', 'assets/missing.png')).rejects.toThrow('Asset could not be read.')
  })
})
