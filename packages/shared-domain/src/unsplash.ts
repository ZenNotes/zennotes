/**
 * Unsplash as a source of note covers, and the rules that come with it (the
 * Unsplash API Terms and Guidelines, as read on 2026-10-28):
 *
 * - Hotlinking. The photo stays on images.unsplash.com: the terms say "you
 *   must directly use or embed the related image URLs returned by the API",
 *   and their own example is a picked background. So an Unsplash cover is an
 *   https cover, never a copy in assets/ the way the built-in gallery is.
 *   Sizes are `urls.raw` plus imgix parameters, keeping its `ixid`.
 * - Download tracking. Making a photo a cover pings its `download_location`.
 * - Attribution. "Photo by <name> on Unsplash", the name linking to the
 *   photographer's profile and Unsplash to unsplash.com, every link with
 *   utm_source and utm_medium=referral. The note keeps the name and the
 *   profile (note-cover.ts); the referral parameters are added when drawn.
 * - The key stays secret, so search and the ping go through the proxy on
 *   zennotes.org, which also keeps one hourly budget for every ZenNotes user.
 *
 * Whatever the proxy hands back is checked here before the app shows it:
 * images only from images.unsplash.com, links only to unsplash.com, a ping
 * only to an api.unsplash.com download endpoint.
 */
import type {
  UnsplashPhoto,
  UnsplashSearchPage,
  UnsplashSearchResult
} from '@zennotes/bridge-contract/unsplash'
import type { NoteCover, NoteCoverCredit } from './note-cover'

export const UNSPLASH_PROXY_BASE_URL = 'https://zennotes.org/api/v1/unsplash'
export const UNSPLASH_HOME_URL = 'https://unsplash.com/'
/** The app name Unsplash's referral links carry. */
export const UNSPLASH_UTM_SOURCE = 'zennotes'
export const UNSPLASH_MIN_QUERY_LENGTH = 2
export const UNSPLASH_MAX_QUERY_LENGTH = 100
export const UNSPLASH_MAX_PAGE = 50

/** A cover spans the whole pane: 2400 px fills a wide window at 2x without
 *  pulling the original, which is often 6000 px and more. */
const COVER_IMAGE_PARAMS = 'w=2400&q=80&auto=format'

function httpsUrl(text: unknown): URL | null {
  if (typeof text !== 'string') return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

export function isUnsplashImageUrl(url: unknown): boolean {
  return httpsUrl(url)?.hostname === 'images.unsplash.com'
}

function isUnsplashPageUrl(url: unknown): boolean {
  return httpsUrl(url)?.hostname === 'unsplash.com'
}

/** An api.unsplash.com download endpoint, the only place the ping may go. */
export function isUnsplashDownloadLocation(url: unknown): boolean {
  const parsed = httpsUrl(url)
  return (
    !!parsed &&
    parsed.hostname === 'api.unsplash.com' &&
    !parsed.port &&
    /^\/photos\/[A-Za-z0-9_-]{1,64}\/download$/.test(parsed.pathname)
  )
}

/** The cover's image: the raw URL with a cover-sized width. The parameters
 *  are appended as text so the raw URL's own (`ixid` among them) stay byte
 *  for byte what Unsplash gave. */
export function unsplashCoverUrl(rawUrl: string): string | null {
  if (!isUnsplashImageUrl(rawUrl)) return null
  const base = rawUrl.replace(/#.*$/, '')
  return `${base}${base.includes('?') ? '&' : '?'}${COVER_IMAGE_PARAMS}`
}

/** An unsplash.com link with the referral parameters Unsplash asks for. Any
 *  other link comes back as it was. */
export function unsplashReferralUrl(url: string): string {
  const parsed = httpsUrl(url)
  if (!parsed || parsed.hostname !== 'unsplash.com') return url
  parsed.searchParams.set('utm_source', UNSPLASH_UTM_SOURCE)
  parsed.searchParams.set('utm_medium', 'referral')
  return parsed.toString()
}

/** Search text as it is sent: trimmed, one space between words, capped. */
export function normalizeUnsplashQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').slice(0, UNSPLASH_MAX_QUERY_LENGTH)
}

export function isUnsplashSearchableQuery(query: string): boolean {
  return normalizeUnsplashQuery(query).length >= UNSPLASH_MIN_QUERY_LENGTH
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed.slice(0, max) : null
}

function size(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function photoFrom(entry: unknown): UnsplashPhoto | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  const urls = (e.urls ?? {}) as Record<string, unknown>
  const user = (e.user ?? {}) as Record<string, unknown>
  const id = typeof e.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(e.id) ? e.id : null
  const name = text(user.name, 120)
  if (!id || !name) return null
  if (!isUnsplashImageUrl(urls.raw) || !isUnsplashImageUrl(urls.small)) return null
  if (!isUnsplashPageUrl(user.profile) || !isUnsplashDownloadLocation(e.download_location)) return null
  return {
    id,
    width: size(e.width),
    height: size(e.height),
    color: typeof e.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : null,
    alt: text(e.alt, 300),
    rawUrl: urls.raw as string,
    thumbUrl: urls.small as string,
    photographer: { name, profileUrl: user.profile as string },
    downloadLocation: e.download_location as string
  }
}

/** The proxy's answer, `{ total_pages, results: [...] }`, as a page of
 *  photos; a malformed photo is left out, a malformed answer is null. */
export function parseUnsplashSearchResponse(
  json: unknown,
  query: string,
  page: number
): UnsplashSearchPage | null {
  if (!json || typeof json !== 'object') return null
  const body = json as Record<string, unknown>
  if (!Array.isArray(body.results)) return null
  const photos = body.results.map(photoFrom).filter((p): p is UnsplashPhoto => p !== null)
  const totalPages = Math.min(UNSPLASH_MAX_PAGE, size(body.total_pages))
  return { query, page, totalPages, photos }
}

/** What a host's fetch returns: Electron's net.fetch and the browser's fetch
 *  both fit. */
export interface UnsplashFetchResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}
export type UnsplashFetch = (url: string, init: RequestInit) => Promise<UnsplashFetchResponse>

export interface UnsplashProxyOptions {
  baseUrl?: string
  /** Extra request headers (the desktop sends a bare user agent). */
  headers?: Record<string, string>
  now?: () => number
}

function proxyRequest(body: unknown, headers: Record<string, string> | undefined): RequestInit {
  return {
    method: 'POST',
    // No cookies: the app's session may hold zennotes.org ones from a Cloud
    // page, and a search has nothing to do with the account.
    credentials: 'omit',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  }
}

/** When to try again after a 429: Retry-After in seconds, or an HTTP date. */
export function unsplashRetryAt(retryAfter: string | null, now: number): number | null {
  if (!retryAfter) return null
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
  const date = Date.parse(retryAfter)
  return Number.isFinite(date) ? date : null
}

/** One page of results through the proxy. Never throws: a failure comes back
 *  as the reason the picker shows. */
export async function searchUnsplashThroughProxy(
  fetchFn: UnsplashFetch,
  input: { query: string; page?: number },
  options: UnsplashProxyOptions = {}
): Promise<UnsplashSearchResult> {
  const query = normalizeUnsplashQuery(input.query)
  const page = Math.min(UNSPLASH_MAX_PAGE, Math.max(1, Math.floor(input.page ?? 1)))
  const now = options.now ?? Date.now
  if (query.length < UNSPLASH_MIN_QUERY_LENGTH) {
    return { ok: true, page: { query, page, totalPages: 0, photos: [] } }
  }
  let response: UnsplashFetchResponse
  try {
    response = await fetchFn(
      `${options.baseUrl ?? UNSPLASH_PROXY_BASE_URL}/search`,
      proxyRequest({ query, page }, options.headers)
    )
  } catch {
    return { ok: false, reason: 'offline', retryAt: null }
  }
  if (response.status === 429) {
    return { ok: false, reason: 'rate-limited', retryAt: unsplashRetryAt(response.headers.get('retry-after'), now()) }
  }
  if (!response.ok) return { ok: false, reason: 'unavailable', retryAt: null }
  let parsed: UnsplashSearchPage | null = null
  try {
    parsed = parseUnsplashSearchResponse(await response.json(), query, page)
  } catch {
    parsed = null
  }
  return parsed ? { ok: true, page: parsed } : { ok: false, reason: 'unavailable', retryAt: null }
}

/** Tell Unsplash a photo became a cover. Fire and forget: a ping that does
 *  not arrive must never undo or delay the pick. */
export async function trackUnsplashDownloadThroughProxy(
  fetchFn: UnsplashFetch,
  downloadLocation: string,
  options: UnsplashProxyOptions = {}
): Promise<void> {
  if (!isUnsplashDownloadLocation(downloadLocation)) return
  try {
    await fetchFn(
      `${options.baseUrl ?? UNSPLASH_PROXY_BASE_URL}/downloads`,
      proxyRequest({ download_location: downloadLocation }, options.headers)
    )
  } catch {
    // Dropped, as above.
  }
}

/** The credit a picked photo leaves in the note. */
export function unsplashPhotoCredit(photo: UnsplashPhoto): NoteCoverCredit {
  return { name: photo.photographer.name, url: photo.photographer.profileUrl }
}

/** The credit line drawn on a cover: "Photo by <name> on Unsplash" for a
 *  photo on images.unsplash.com, the name as written otherwise. */
export interface NoteCoverCreditLine {
  name: string
  nameUrl: string | null
  /** "Unsplash" and its link, for an Unsplash photo. */
  source: { name: string; url: string } | null
}

export function noteCoverCreditLine(cover: NoteCover): NoteCoverCreditLine | null {
  if (!cover.credit) return null
  const unsplash = cover.target.kind === 'url' && isUnsplashImageUrl(cover.target.url)
  const url = cover.credit.url
  return {
    name: cover.credit.name,
    nameUrl: url ? (unsplash ? unsplashReferralUrl(url) : url) : null,
    source: unsplash ? { name: 'Unsplash', url: unsplashReferralUrl(UNSPLASH_HOME_URL) } : null
  }
}
