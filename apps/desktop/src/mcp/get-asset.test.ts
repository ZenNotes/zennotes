import { describe, expect, it } from 'vitest'
import type { VaultBackend } from '../cli/backend'
import { callTool, listToolNames } from './server'

// Only the members a given test reaches are implemented; the cast keeps the
// stubs honest about being partial.
function backend(partial: Partial<VaultBackend>): VaultBackend {
  return partial as VaultBackend
}

describe('get_asset (#716)', () => {
  it('is registered next to list_assets', () => {
    const names = listToolNames()
    expect(names).toContain('list_assets')
    expect(names).toContain('get_asset')
  })

  it('returns base64, size, and a guessed MIME type', async () => {
    const bytes = new TextEncoder().encode('PNGDATA')
    const result = (await callTool(
      'get_asset',
      { path: 'assets/pic.png' },
      backend({ readAsset: async () => bytes })
    )) as Record<string, unknown>
    expect(result).toEqual({
      path: 'assets/pic.png',
      size: 7,
      mimeType: 'image/png',
      base64: Buffer.from(bytes).toString('base64')
    })
  })

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const result = (await callTool(
      'get_asset',
      { path: 'assets/blob.bin' },
      backend({ readAsset: async () => new Uint8Array([1]) })
    )) as Record<string, unknown>
    expect(result.mimeType).toBe('application/octet-stream')
  })

  it('rejects assets over the 10 MB tool limit and points at the CLI', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    await expect(
      callTool(
        'get_asset',
        { path: 'assets/huge.mp4' },
        backend({ readAsset: async () => big })
      )
    ).rejects.toThrow(/zn asset get/)
  })

  it('surfaces backend errors (missing asset, escaping path)', async () => {
    await expect(
      callTool(
        'get_asset',
        { path: 'assets/nope.png' },
        backend({ readAsset: async () => { throw new Error('Asset not found: assets/nope.png') } })
      )
    ).rejects.toThrow(/not found/i)
  })
})
