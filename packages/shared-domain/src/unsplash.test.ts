import { describe, expect, it, vi } from 'vitest'
import {
  UNSPLASH_REQUESTS_PER_MINUTE,
  checkUnsplashAccessKey,
  createUnsplashClient,
  isUnsplashDownloadLocation,
  isUnsplashImageUrl,
  noteCoverCreditLine,
  normalizeUnsplashAccessKey,
  normalizeUnsplashQuery,
  parseUnsplashSearchResponse,
  searchUnsplashPhotos,
  trackUnsplashPhotoDownload,
  unsplashCoverUrl,
  unsplashReferralUrl,
  type UnsplashFetch,
  type UnsplashFetchResponse,
  type UnsplashKeyVault
} from './unsplash'

const RAW = 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?ixid=M3w1fDB8MXxzZWFyY2h8MXx8Zm9n&ixlib=rb-4.0.3'
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'

/** A photo the way api.unsplash.com sends it, cut to the fields read. */
function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'Bkci_8qcdvQ',
    width: 6000,
    height: 4000,
    color: '#c0d9d9',
    description: null,
    alt_description: 'fog over a valley',
    urls: { raw: RAW, small: `${RAW}&w=400` },
    links: { download_location: 'https://api.unsplash.com/photos/Bkci_8qcdvQ/download?ixid=M3w1fDB8' },
    user: { name: 'Jane Doe', links: { html: 'https://unsplash.com/@janedoe?utm_source=x' } },
    premium: false,
    plus: false,
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

describe('normalizeUnsplashAccessKey', () => {
  it('takes a pasted key, trimmed, and nothing that could break a header', () => {
    expect(normalizeUnsplashAccessKey(`  ${KEY}\n`)).toBe(KEY)
    expect(normalizeUnsplashAccessKey(`${KEY}\r\nX-Other: 1`)).toBeNull()
    expect(normalizeUnsplashAccessKey('Access Key: abc')).toBeNull()
    expect(normalizeUnsplashAccessKey('short')).toBeNull()
    expect(normalizeUnsplashAccessKey(42)).toBeNull()
  })
})

describe('parseUnsplashSearchResponse', () => {
  it('reads Unsplash’s answer into photos, keeping the profile without its query', () => {
    const page = parseUnsplashSearchResponse({ total: 140, total_pages: 7, results: [result()] }, 'fog', 1)
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

  it('leaves out an Unsplash+ photo, and one with an image, link or ping it should not follow', () => {
    const bad = [
      result({ premium: true }),
      result({ plus: true }),
      result({ urls: { raw: 'https://example.com/a.jpg', small: RAW } }),
      result({ urls: { raw: RAW, small: 'javascript:alert(1)' } }),
      result({ user: { name: 'X', links: { html: 'https://example.com/@x' } } }),
      result({ user: { name: '  ', links: { html: 'https://unsplash.com/@x' } } }),
      result({ links: { download_location: 'https://example.com/photos/a/download' } }),
      result({ id: '../../me' }),
      null,
      'photo'
    ]
    expect(parseUnsplashSearchResponse({ total_pages: 1, results: [...bad, result()] }, 'fog', 1)?.photos).toHaveLength(1)
  })

  it('falls back to the description for a caption, drops what it cannot use, and is null for an answer that is not one', () => {
    expect(
      parseUnsplashSearchResponse({ results: [result({ alt_description: null, description: 'Morning fog' })] }, 'q', 1)
        ?.photos[0]?.alt
    ).toBe('Morning fog')
    const photo = parseUnsplashSearchResponse({ results: [result({ color: 'red;', alt_description: 42 })] }, 'q', 1)?.photos[0]
    expect(photo?.color).toBeNull()
    expect(photo?.alt).toBeNull()
    expect(parseUnsplashSearchResponse({ results: 'none' }, 'q', 1)).toBeNull()
    expect(parseUnsplashSearchResponse(null, 'q', 1)).toBeNull()
  })
})

describe('searchUnsplashPhotos', () => {
  it('asks api.unsplash.com with the key, no cookies and no referrer, and returns the page', async () => {
    const fetchFn = vi.fn<UnsplashFetch>(async () => response(200, { total_pages: 3, results: [result()] }))
    const answer = await searchUnsplashPhotos(fetchFn, { key: KEY, query: '  misty  fog ', page: 2 })
    expect(answer).toMatchObject({ ok: true, page: { query: 'misty fog', page: 2, totalPages: 3 } })
    const [url, init] = fetchFn.mock.calls[0]!
    const sent = new URL(url)
    expect(`${sent.origin}${sent.pathname}`).toBe('https://api.unsplash.com/search/photos')
    expect(Object.fromEntries(sent.searchParams)).toEqual({
      query: 'misty fog',
      page: '2',
      per_page: '24',
      orientation: 'landscape',
      content_filter: 'high'
    })
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('omit')
    expect(init.referrerPolicy).toBe('no-referrer')
    expect(init.headers).toMatchObject({ authorization: `Client-ID ${KEY}`, 'accept-version': 'v1' })
  })

  it('asks nothing for a query too short to search', async () => {
    const fetchFn = vi.fn<UnsplashFetch>()
    expect(await searchUnsplashPhotos(fetchFn, { key: KEY, query: ' a ' })).toMatchObject({ ok: true, page: { photos: [] } })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('says why when it fails: a refused key, a spent hour, no connection, or anything else', async () => {
    const answer = (r: UnsplashFetchResponse) => searchUnsplashPhotos(async () => r, { key: KEY, query: 'fog' })
    expect(await answer(response(401, { errors: ['OAuth error: The access token is invalid'] }))).toEqual({
      ok: false,
      reason: 'invalid-key',
      retryAt: null,
      limit: null
    })
    expect(
      await answer(response(403, null, { 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0' }))
    ).toEqual({ ok: false, reason: 'rate-limited', retryAt: null, limit: 50 })
    // A 403 with allowance left is not the rate limit.
    expect(await answer(response(403, null, { 'x-ratelimit-remaining': '12' }))).toMatchObject({ reason: 'unavailable' })
    expect(await answer(response(500, null))).toMatchObject({ reason: 'unavailable' })
    expect(await answer(response(200, { nothing: true }))).toMatchObject({ reason: 'unavailable' })
    const offline = await searchUnsplashPhotos(
      async () => {
        throw new TypeError('fetch failed')
      },
      { key: KEY, query: 'fog' }
    )
    expect(offline).toEqual({ ok: false, reason: 'offline', retryAt: null, limit: null })
  })
})

describe('trackUnsplashPhotoDownload', () => {
  it('GETs a valid download location with the key, at the API base, and swallows a failure', async () => {
    const fetchFn = vi.fn<UnsplashFetch>(async () => {
      throw new Error('offline')
    })
    const downloadLocation = 'https://api.unsplash.com/photos/abc/download?ixid=xyz'
    await expect(trackUnsplashPhotoDownload(fetchFn, { key: KEY, downloadLocation })).resolves.toBeUndefined()
    expect(fetchFn.mock.calls[0]![0]).toBe(downloadLocation)
    expect(fetchFn.mock.calls[0]![1].headers).toMatchObject({ authorization: `Client-ID ${KEY}` })
    // A test run's stand-in gets the same path and query.
    await trackUnsplashPhotoDownload(fetchFn, { key: KEY, downloadLocation }, { baseUrl: 'http://127.0.0.1:7/' })
    expect(fetchFn.mock.calls[1]![0]).toBe('http://127.0.0.1:7/photos/abc/download?ixid=xyz')
  })

  it('sends nothing for any other URL', async () => {
    const fetchFn = vi.fn<UnsplashFetch>()
    await trackUnsplashPhotoDownload(fetchFn, { key: KEY, downloadLocation: 'https://example.com/photos/abc/download' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('checkUnsplashAccessKey', () => {
  it('asks for one photo and reports what is left of the hour', async () => {
    const fetchFn = vi.fn<UnsplashFetch>(async () =>
      response(200, [], { 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '49' })
    )
    expect(await checkUnsplashAccessKey(fetchFn, KEY)).toEqual({ ok: true, remaining: 49, limit: 50 })
    expect(fetchFn.mock.calls[0]![0]).toBe('https://api.unsplash.com/photos?per_page=1')
  })

  it('says a refused key, a spent hour or no connection apart', async () => {
    expect(await checkUnsplashAccessKey(async () => response(401, {}), KEY)).toEqual({
      ok: false,
      reason: 'invalid-key',
      limit: null
    })
    expect(
      await checkUnsplashAccessKey(async () => response(403, null, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '50' }), KEY)
    ).toEqual({ ok: false, reason: 'rate-limited', limit: 50 })
    expect(
      await checkUnsplashAccessKey(async () => {
        throw new TypeError('fetch failed')
      }, KEY)
    ).toEqual({ ok: false, reason: 'offline', limit: null })
  })
})

describe('createUnsplashClient', () => {
  function memoryVault(initial: string | null = null, canStore = true): UnsplashKeyVault & { value: string | null } {
    const vault = {
      value: initial,
      get: async () => vault.value,
      set: async (key: string) => {
        if (!canStore) return false
        vault.value = key
        return true
      },
      delete: async () => {
        vault.value = null
      },
      canStore: () => canStore
    }
    return vault
  }
  const ok = (json: unknown = { total_pages: 1, results: [result()] }) =>
    response(200, json, { 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '48' })

  it('without a key, says so and sends nothing', async () => {
    const fetchFn = vi.fn<UnsplashFetch>()
    const client = createUnsplashClient({ fetch: fetchFn, keys: memoryVault(), store: 'system' })
    expect(await client.status()).toEqual({ set: false, store: 'system', canStore: true })
    expect(await client.search('fog', 1)).toEqual({ ok: false, reason: 'no-key', retryAt: null, limit: null })
    expect(await client.test()).toEqual({ ok: false, reason: 'no-key', limit: null })
    await client.trackDownload('https://api.unsplash.com/photos/abc/download')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('checks a pasted key before keeping it, and never answers with the key', async () => {
    const vault = memoryVault()
    const fetchFn = vi.fn<UnsplashFetch>(async () => ok([]))
    const client = createUnsplashClient({ fetch: fetchFn, keys: vault, store: 'system' })
    const saved = await client.save(`  ${KEY} `)
    expect(saved).toEqual({ saved: true, check: { ok: true, remaining: 48, limit: 50 } })
    expect(vault.value).toBe(KEY)
    const status = await client.status()
    expect(status).toEqual({ set: true, store: 'system', canStore: true })
    for (const answer of [saved, status, await client.test()]) expect(JSON.stringify(answer)).not.toContain(KEY)
    expect(fetchFn.mock.calls[0]![1].headers).toMatchObject({ authorization: `Client-ID ${KEY}` })
  })

  it('does not keep a key Unsplash refuses, a malformed one, or one with nowhere safe to go', async () => {
    const refused = memoryVault()
    expect(
      await createUnsplashClient({ fetch: async () => response(401, {}), keys: refused, store: 'system' }).save(KEY)
    ).toEqual({ saved: false, reason: 'invalid-key' })
    expect(refused.value).toBeNull()

    const fetchFn = vi.fn<UnsplashFetch>()
    expect(await createUnsplashClient({ fetch: fetchFn, keys: memoryVault(), store: 'system' }).save('my key')).toEqual({
      saved: false,
      reason: 'malformed'
    })
    const nowhere = createUnsplashClient({ fetch: fetchFn, keys: memoryVault(null, false), store: 'system' })
    expect(await nowhere.status()).toEqual({ set: false, store: 'system', canStore: false })
    expect(await nowhere.save(KEY)).toEqual({ saved: false, reason: 'cannot-store' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('keeps a key it could not check, saying why', async () => {
    const vault = memoryVault()
    const client = createUnsplashClient({
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
      keys: vault,
      store: 'browser'
    })
    expect(await client.save(KEY)).toEqual({ saved: true, check: { ok: false, reason: 'offline', limit: null } })
    expect(vault.value).toBe(KEY)
  })

  it('searches and pings with the saved key, and clearing it stops both', async () => {
    const vault = memoryVault(KEY)
    const fetchFn = vi.fn<UnsplashFetch>(async () => ok())
    const client = createUnsplashClient({ fetch: fetchFn, keys: vault, store: 'system' })
    expect(await client.search('fog', 1)).toMatchObject({ ok: true, page: { photos: [{ id: 'Bkci_8qcdvQ' }] } })
    await client.trackDownload('https://api.unsplash.com/photos/Bkci_8qcdvQ/download?ixid=M3w1fDB8')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    await client.clear()
    expect(vault.value).toBeNull()
    expect(await client.status()).toMatchObject({ set: false })
    expect(await client.search('fog', 1)).toMatchObject({ ok: false, reason: 'no-key' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('refuses arguments that are not a search or a download endpoint', async () => {
    const fetchFn = vi.fn<UnsplashFetch>()
    const client = createUnsplashClient({ fetch: fetchFn, keys: memoryVault(KEY), store: 'system' })
    expect(await client.search({ query: 'fog' }, 1)).toMatchObject({ ok: false, reason: 'unavailable' })
    await client.trackDownload(42)
    await client.trackDownload('https://example.com/photos/a/download')
    expect(await client.search('a', 1)).toMatchObject({ ok: true, page: { photos: [] } })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('caps one run at a minute’s worth of requests, whatever the renderer asks', async () => {
    let now = 0
    const fetchFn = vi.fn<UnsplashFetch>(async () => ok({ total_pages: 1, results: [] }))
    const client = createUnsplashClient({ fetch: fetchFn, keys: memoryVault(KEY), store: 'system', now: () => now })
    for (let i = 0; i < UNSPLASH_REQUESTS_PER_MINUTE; i++) await client.search(`fog ${i}`, 1)
    expect(await client.search('one more', 1)).toEqual({ ok: false, reason: 'rate-limited', retryAt: 60_000, limit: null })
    expect(fetchFn).toHaveBeenCalledTimes(UNSPLASH_REQUESTS_PER_MINUTE)
    now = 60_000
    expect(await client.search('later', 1)).toMatchObject({ ok: true })
  })

  it('sends the host’s base URL and headers', async () => {
    const fetchFn = vi.fn<UnsplashFetch>(async () => ok())
    const client = createUnsplashClient({
      fetch: fetchFn,
      keys: memoryVault(KEY),
      store: 'system',
      options: () => ({ baseUrl: 'http://127.0.0.1:9/', headers: { 'user-agent': 'ZenNotes' } })
    })
    await client.search('fog', 1)
    expect(fetchFn.mock.calls[0]![0]).toMatch(/^http:\/\/127\.0\.0\.1:9\/search\/photos\?/)
    expect(fetchFn.mock.calls[0]![1].headers).toMatchObject({ 'user-agent': 'ZenNotes', authorization: `Client-ID ${KEY}` })
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
