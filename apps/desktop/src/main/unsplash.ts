/**
 * The cover picker's Unsplash search, sent from main the way the usage count
 * and Cloud are: the renderer's CSP keeps connect-src to the app's own
 * schemes, and this side decides what leaves (a search, a page number, a
 * download location it has checked) and how (no cookies, a bare user agent,
 * no language). The Unsplash key lives on the zennotes.org proxy, never in
 * the app (shared-domain unsplash.ts has the rules).
 *
 * The proxy keeps one hourly budget for every ZenNotes user, so a renderer bug
 * that searched in a loop would spend everyone's. This side caps what one run
 * of the app may ask, well above what a person typing can reach.
 */
import { app, net } from 'electron'
import type { UnsplashSearchResult } from '@zennotes/bridge-contract/unsplash'
import {
  UNSPLASH_PROXY_BASE_URL,
  searchUnsplashThroughProxy,
  trackUnsplashDownloadThroughProxy,
  type UnsplashFetch,
  type UnsplashProxyOptions
} from '@shared/unsplash'

/** Searches and pings one run may send in a minute. */
export const UNSPLASH_REQUESTS_PER_MINUTE = 40

/** The proxy, or the one ZENNOTES_UNSPLASH_PROXY_URL names for a test run. As
 *  with the other overrides, a packaged app honors it only with ZEN_PERF=1. */
export function unsplashProxyBaseUrl(env: NodeJS.ProcessEnv, isPackaged: boolean): string {
  const override = env.ZENNOTES_UNSPLASH_PROXY_URL?.trim()
  if (override && (!isPackaged || env.ZEN_PERF === '1')) return override.replace(/\/+$/, '')
  return UNSPLASH_PROXY_BASE_URL
}

export function createUnsplashClient(deps: {
  fetch: UnsplashFetch
  baseUrl: () => string
  now?: () => number
}): {
  search: (query: unknown, page: unknown) => Promise<UnsplashSearchResult>
  trackDownload: (downloadLocation: unknown) => Promise<void>
} {
  const now = deps.now ?? Date.now
  const sent: number[] = []
  /** Room for one more request, or the time the oldest one leaves the window. */
  const take = (): number | null => {
    const at = now()
    while (sent.length && at - sent[0]! >= 60_000) sent.shift()
    if (sent.length >= UNSPLASH_REQUESTS_PER_MINUTE) return sent[0]! + 60_000
    sent.push(at)
    return null
  }
  const options = (): UnsplashProxyOptions => ({
    baseUrl: deps.baseUrl(),
    headers: { 'user-agent': 'ZenNotes', 'accept-language': '*' },
    now
  })
  return {
    search: async (query, page) => {
      if (typeof query !== 'string') return { ok: false, reason: 'unavailable', retryAt: null }
      const wait = take()
      if (wait !== null) return { ok: false, reason: 'rate-limited', retryAt: wait }
      return await searchUnsplashThroughProxy(
        deps.fetch,
        { query, page: typeof page === 'number' && Number.isFinite(page) ? page : 1 },
        options()
      )
    },
    trackDownload: async (downloadLocation) => {
      if (typeof downloadLocation !== 'string') return
      if (take() !== null) return
      await trackUnsplashDownloadThroughProxy(deps.fetch, downloadLocation, options())
    }
  }
}

const client = createUnsplashClient({
  fetch: (url, init) => net.fetch(url, init),
  baseUrl: () => unsplashProxyBaseUrl(process.env, app.isPackaged)
})

export const searchUnsplash = client.search
export const trackUnsplashDownload = client.trackDownload
