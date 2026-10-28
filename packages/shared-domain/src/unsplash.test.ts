import { describe, expect, it, vi } from 'vitest'
import {
  isUnsplashDownloadLocation,
  isUnsplashImageUrl,
  noteCoverCreditLine,
  normalizeUnsplashQuery,
  parseUnsplashSearchResponse,
  searchUnsplashThroughProxy,
  trackUnsplashDownloadThroughProxy,
  unsplashCoverUrl,
  unsplashReferralUrl,
  unsplashRetryAt,
  type UnsplashFetch,
  type UnsplashFetchResponse
} from './unsplash'

const RAW = 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?ixid=M3w1fDB8MXxzZWFyY2h8MXx8Zm9n&ixlib=rb-4.0.3'

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'Bkci_8qcdvQ',
    width: 6000,
    height: 4000,
    color: '#c0d9d9',
    alt: 'fog over a valley',
    urls: { raw: RAW, small: `${RAW}&w=400` },
    user: { name: 'Jane Doe', profile: 'https://unsplash.com/@janedoe' },
    download_location: 'https://api.unsplash.com/photos/Bkci_8qcdvQ/download?ixid=M3w1fDB8',
    ...overrides
  }
}

function response(status: number, json: unknown, headers: Record<string, string> = {}): UnsplashFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => json
  }
}

describe('Unsplash URLs', () => {
  it('builds a cover-sized image from the raw URL, keeping its own parameters as they were', () => {
    expect(unsplashCoverUrl(RAW)).toBe(`${RAW}&w=2400&q=80&auto=format`)
    expect(unsplashCoverUrl('https://images.unsplash.com/photo-1')).toBe(
      'https://images.unsplash.com/photo-1?w=2400&q=80&auto=format'
    )
  })

  it('takes images only from images.unsplash.com over https', () => {
    expect(isUnsplashImageUrl(RAW)).toBe(true)
    expect(isUnsplashImageUrl('http://images.unsplash.com/photo-1')).toBe(false)
    expect(isUnsplashImageUrl('https://images.unsplash.com.evil.test/photo-1')).toBe(false)
    expect(isUnsplashImageUrl('https://plus.unsplash.com/premium_photo-1')).toBe(false)
    expect(unsplashCoverUrl('https://example.com/a.jpg')).toBeNull()
  })

  it('accepts a ping only to an api.unsplash.com download endpoint', () => {
    expect(isUnsplashDownloadLocation('https://api.unsplash.com/photos/abc_-1/download?ixid=x')).toBe(true)
    expect(isUnsplashDownloadLocation('https://api.unsplash.com/photos/abc/download/../../me')).toBe(false)
    expect(isUnsplashDownloadLocation('https://api.unsplash.com/me')).toBe(false)
    expect(isUnsplashDownloadLocation('https://api.unsplash.com:8443/photos/abc/download')).toBe(false)
    expect(isUnsplashDownloadLocation('https://user@api.unsplash.com/photos/abc/download')).toBe(false)
    expect(isUnsplashDownloadLocation('https://example.com/photos/abc/download')).toBe(false)
  })

  it('adds the referral parameters to unsplash.com links only', () => {
    expect(unsplashReferralUrl('https://unsplash.com/@janedoe')).toBe(
      'https://unsplash.com/@janedoe?utm_source=zennotes&utm_medium=referral'
    )
    expect(unsplashReferralUrl('https://unsplash.com/')).toBe(
      'https://unsplash.com/?utm_source=zennotes&utm_medium=referral'
    )
    expect(unsplashReferralUrl('https://example.com/me')).toBe('https://example.com/me')
  })

  it('sends search text trimmed, single-spaced and capped', () => {
    expect(normalizeUnsplashQuery('  misty   forest \n')).toBe('misty forest')
    expect(normalizeUnsplashQuery('x'.repeat(300))).toHaveLength(100)
  })
})

describe('parseUnsplashSearchResponse', () => {
  it('reads the proxy answer into photos', () => {
    const page = parseUnsplashSearchResponse({ total_pages: 7, results: [result()] }, 'fog', 1)
    expect(page).toEqual({
      query: 'fog',
      page: 1,
      totalPages: 7,
      photos: [
        {
          id: 'Bkci_8qcdvQ',
          width: 6000,
          height: 4000,
          color: '#c0d9d9',
          alt: 'fog over a valley',
          rawUrl: RAW,
          thumbUrl: `${RAW}&w=400`,
          photographer: { name: 'Jane Doe', profileUrl: 'https://unsplash.com/@janedoe' },
          downloadLocation: 'https://api.unsplash.com/photos/Bkci_8qcdvQ/download?ixid=M3w1fDB8'
        }
      ]
    })
  })

  it('leaves out a photo with an image, link or ping it should not follow', () => {
    const bad = [
      result({ urls: { raw: 'https://example.com/a.jpg', small: RAW } }),
      result({ urls: { raw: RAW, small: 'javascript:alert(1)' } }),
      result({ user: { name: 'X', profile: 'https://example.com/@x' } }),
      result({ user: { name: '  ', profile: 'https://unsplash.com/@x' } }),
      result({ download_location: 'https://example.com/photos/a/download' }),
      result({ id: '../../me' }),
      null,
      'photo'
    ]
    expect(parseUnsplashSearchResponse({ total_pages: 1, results: [...bad, result()] }, 'fog', 1)?.photos).toHaveLength(1)
  })

  it('drops a colour or caption it cannot use, and is null for an answer that is not one', () => {
    const photo = parseUnsplashSearchResponse({ results: [result({ color: 'red;', alt: 42 })] }, 'q', 1)?.photos[0]
    expect(photo?.color).toBeNull()
    expect(photo?.alt).toBeNull()
    expect(parseUnsplashSearchResponse({ results: 'none' }, 'q', 1)).toBeNull()
    expect(parseUnsplashSearchResponse(null, 'q', 1)).toBeNull()
  })
})

describe('searchUnsplashThroughProxy', () => {
  it('posts the query, with no cookies, and returns the page', async () => {
    const fetchFn = vi.fn<UnsplashFetch>(async () => response(200, { total_pages: 2, results: [result()] }))
    const out = await searchUnsplashThroughProxy(fetchFn, { query: ' fog ', page: 2 }, { baseUrl: 'http://127.0.0.1:9/u' })
    expect(out.ok && out.page.photos).toHaveLength(1)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:9/u/search')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
    expect(JSON.parse(String(init.body))).toEqual({ query: 'fog', page: 2 })
  })

  it('asks nothing for a query too short to search', async () => {
    const fetchFn = vi.fn<UnsplashFetch>()
    const out = await searchUnsplashThroughProxy(fetchFn, { query: 'a' })
    expect(out).toEqual({ ok: true, page: { query: 'a', page: 1, totalPages: 0, photos: [] } })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('says why when it fails: unreachable, over the hourly budget, or anything else', async () => {
    const throwing = vi.fn<UnsplashFetch>(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await searchUnsplashThroughProxy(throwing, { query: 'fog' })).toEqual({
      ok: false,
      reason: 'offline',
      retryAt: null
    })
    const limited = vi.fn<UnsplashFetch>(async () => response(429, {}, { 'retry-after': '120' }))
    expect(await searchUnsplashThroughProxy(limited, { query: 'fog' }, { now: () => 1_000 })).toEqual({
      ok: false,
      reason: 'rate-limited',
      retryAt: 121_000
    })
    const down = vi.fn<UnsplashFetch>(async () => response(503, { error: 'unavailable' }))
    expect(await searchUnsplashThroughProxy(down, { query: 'fog' })).toMatchObject({ ok: false, reason: 'unavailable' })
    const garbage = vi.fn<UnsplashFetch>(async () => response(200, '<html>'))
    expect(await searchUnsplashThroughProxy(garbage, { query: 'fog' })).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('reads Retry-After as seconds or a date', () => {
    expect(unsplashRetryAt('60', 0)).toBe(60_000)
    expect(unsplashRetryAt('Wed, 28 Oct 2026 15:00:00 GMT', 0)).toBe(Date.UTC(2026, 9, 28, 15))
    expect(unsplashRetryAt('soon', 0)).toBeNull()
    expect(unsplashRetryAt(null, 0)).toBeNull()
  })
})

describe('trackUnsplashDownloadThroughProxy', () => {
  it('posts a valid download location and swallows a failure', async () => {
    const fetchFn = vi.fn<UnsplashFetch>(async () => {
      throw new Error('offline')
    })
    const location = 'https://api.unsplash.com/photos/abc/download?ixid=x'
    await expect(trackUnsplashDownloadThroughProxy(fetchFn, location, { baseUrl: 'https://p.test' })).resolves.toBeUndefined()
    expect(fetchFn.mock.calls[0]![0]).toBe('https://p.test/downloads')
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1].body))).toEqual({ download_location: location })
  })

  it('sends nothing for any other URL', async () => {
    const fetchFn = vi.fn<UnsplashFetch>()
    await trackUnsplashDownloadThroughProxy(fetchFn, 'https://example.com/photos/abc/download')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('noteCoverCreditLine', () => {
  it('names Unsplash, with referral links, for an Unsplash photo', () => {
    const line = noteCoverCreditLine({
      key: 'banner',
      target: { kind: 'url', url: unsplashCoverUrl(RAW)! },
      y: 0.5,
      credit: { name: 'Jane Doe', url: 'https://unsplash.com/@janedoe' }
    })
    expect(line).toEqual({
      name: 'Jane Doe',
      nameUrl: 'https://unsplash.com/@janedoe?utm_source=zennotes&utm_medium=referral',
      source: { name: 'Unsplash', url: 'https://unsplash.com/?utm_source=zennotes&utm_medium=referral' }
    })
  })

  it('draws any other credit as written, and nothing without one', () => {
    expect(
      noteCoverCreditLine({ key: 'banner', target: { kind: 'vault', href: 'a.png' }, y: 0.5, credit: { name: 'Me', url: null } })
    ).toEqual({ name: 'Me', nameUrl: null, source: null })
    expect(noteCoverCreditLine({ key: 'banner', target: { kind: 'vault', href: 'a.png' }, y: 0.5 })).toBeNull()
  })
})
