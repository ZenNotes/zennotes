import { describe, expect, it, vi } from 'vitest'
import { openExternalUrl } from './external-urls'

describe('external URL opening', () => {
  it('only opens a custom scheme when enabled in host config', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    const url = 'zotero://open-pdf/library/items/W78FUE98?page=3#annotation=ABC'
    expect(await openExternalUrl(url, [], open)).toEqual({
      ok: false,
      error: 'scheme-disabled',
      scheme: 'zotero'
    })
    expect(open).not.toHaveBeenCalled()
    expect(await openExternalUrl(url, ['Zotero://'], open)).toEqual({ ok: true })
    expect(open).toHaveBeenCalledWith(url)
  })
  it.each(['https://example.com', 'http://example.com', 'mailto:me@example.com', 'tel:+123'])(
    'keeps %s available',
    async (url) => {
      const open = vi.fn().mockResolvedValue(undefined)
      expect(await openExternalUrl(url, [], open)).toEqual({ ok: true })
      expect(open).toHaveBeenCalledWith(url)
    }
  )
  it.each([
    'javascript:alert(1)',
    'file:///tmp/script',
    'data:text/html,test',
    'zen-asset://secret',
    'C:/script.exe',
    '../Note.md',
    'zotero://bad\nvalue',
    'https://',
    { url: 'zotero://item' }
  ])('rejects invalid or reserved URLs even if configured: %s', async (url) => {
    const open = vi.fn()
    expect(
      (await openExternalUrl(url, ['javascript', 'file', 'data', 'zen-asset', 'c', 'zotero'], open))
        .ok
    ).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
  it('reports a missing or failing OS handler without throwing', async () => {
    const open = vi.fn().mockRejectedValue(new Error('No registered app'))
    expect(await openExternalUrl('zotero://item', ['zotero'], open)).toEqual({
      ok: false,
      error: 'open-failed',
      scheme: 'zotero'
    })
  })
})
