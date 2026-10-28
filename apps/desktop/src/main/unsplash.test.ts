import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true }, net: { fetch: vi.fn() } }))

import type { UnsplashFetch } from '@shared/unsplash'
import { createUnsplashClient, unsplashProxyBaseUrl, UNSPLASH_REQUESTS_PER_MINUTE } from './unsplash'

const ok = (json: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => json })

describe('unsplashProxyBaseUrl', () => {
  it('is zennotes.org unless a test run names another', () => {
    expect(unsplashProxyBaseUrl({}, true)).toBe('https://zennotes.org/api/v1/unsplash')
    expect(unsplashProxyBaseUrl({ ZENNOTES_UNSPLASH_PROXY_URL: 'http://127.0.0.1:7/u/' }, false)).toBe(
      'http://127.0.0.1:7/u'
    )
    // A packaged copy honors the override only for a test run.
    expect(unsplashProxyBaseUrl({ ZENNOTES_UNSPLASH_PROXY_URL: 'http://127.0.0.1:7/u' }, true)).toBe(
      'https://zennotes.org/api/v1/unsplash'
    )
    expect(unsplashProxyBaseUrl({ ZENNOTES_UNSPLASH_PROXY_URL: 'http://127.0.0.1:7/u', ZEN_PERF: '1' }, true)).toBe(
      'http://127.0.0.1:7/u'
    )
  })
})

describe('createUnsplashClient', () => {
  it('sends a search with no cookies, a bare user agent and no language', async () => {
    const fetch = vi.fn<UnsplashFetch>(async () => ok({ total_pages: 0, results: [] }))
    const client = createUnsplashClient({ fetch, baseUrl: () => 'https://p.test' })
    expect(await client.search('fog', 1)).toMatchObject({ ok: true })
    const init = fetch.mock.calls[0]![1]
    expect(init.credentials).toBe('omit')
    expect(init.headers).toMatchObject({ 'user-agent': 'ZenNotes', 'accept-language': '*' })
  })

  it('refuses arguments that are not a search', async () => {
    const fetch = vi.fn<UnsplashFetch>()
    const client = createUnsplashClient({ fetch, baseUrl: () => 'https://p.test' })
    expect(await client.search({ query: 'fog' }, 1)).toEqual({ ok: false, reason: 'unavailable', retryAt: null })
    await client.trackDownload(42)
    await client.trackDownload('https://example.com/photos/a/download')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('caps one run at a minute’s worth of requests, whatever the renderer asks', async () => {
    let now = 0
    const fetch = vi.fn<UnsplashFetch>(async () => ok({ total_pages: 1, results: [] }))
    const client = createUnsplashClient({ fetch, baseUrl: () => 'https://p.test', now: () => now })
    for (let i = 0; i < UNSPLASH_REQUESTS_PER_MINUTE; i++) await client.search(`fog ${i}`, 1)
    expect(await client.search('one more', 1)).toEqual({ ok: false, reason: 'rate-limited', retryAt: 60_000 })
    expect(fetch).toHaveBeenCalledTimes(UNSPLASH_REQUESTS_PER_MINUTE)
    now = 60_000
    expect(await client.search('later', 1)).toMatchObject({ ok: true })
  })
})
