/**
 * The cover picker's Unsplash search, sent from main the way the usage count
 * and Cloud are: the renderer's CSP keeps connect-src to the app's own
 * schemes, and this side decides what leaves (a search, a page number, a
 * download location it has checked) and how (no cookies, a bare user agent,
 * no language). Requests go straight to api.unsplash.com with the person's
 * own Access Key, which lives in the system's secure storage (secret-store)
 * and never reaches the renderer: it hears only whether a key is set.
 * shared-domain unsplash.ts has the rules and the client itself.
 */
import { app, net } from 'electron'
import { UNSPLASH_API_BASE_URL, createUnsplashClient, type UnsplashFetch } from '@shared/unsplash'
import {
  canStoreSecretsSecurely,
  deleteUnsplashAccessKeySecret,
  getUnsplashAccessKeySecret,
  setUnsplashAccessKeySecret
} from './secret-store'

/** api.unsplash.com, or the stand-in ZENNOTES_UNSPLASH_API_URL names for a
 *  test run. As with the other overrides, a packaged app honors it only with
 *  ZEN_PERF=1. */
export function unsplashApiBaseUrl(env: NodeJS.ProcessEnv, isPackaged: boolean): string {
  const override = env.ZENNOTES_UNSPLASH_API_URL?.trim()
  if (override && (!isPackaged || env.ZEN_PERF === '1')) return override.replace(/\/+$/, '')
  return UNSPLASH_API_BASE_URL
}

export function createDesktopUnsplashClient(fetch: UnsplashFetch, baseUrl: () => string) {
  return createUnsplashClient({
    fetch,
    store: 'system',
    keys: {
      get: getUnsplashAccessKeySecret,
      set: setUnsplashAccessKeySecret,
      delete: deleteUnsplashAccessKeySecret,
      canStore: canStoreSecretsSecurely
    },
    options: () => ({
      baseUrl: baseUrl(),
      headers: { 'user-agent': 'ZenNotes', 'accept-language': '*' }
    })
  })
}

export const unsplash = createDesktopUnsplashClient(
  (url, init) => net.fetch(url, init),
  () => unsplashApiBaseUrl(process.env, app.isPackaged)
)
