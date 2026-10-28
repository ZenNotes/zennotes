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
 * - The key. Each person registers an Unsplash app of their own and pastes
 *   its Access Key. Requests go from their machine straight to
 *   api.unsplash.com with `Authorization: Client-ID <key>`; zennotes.org takes
 *   no part. The terms keep a key confidential, so the host keeps it to
 *   itself (desktop main in the system's secure storage, the web client in
 *   its browser) and tells the renderer only whether one is set.
 *
 * Whatever Unsplash hands back is checked here before the app shows it:
 * images only from images.unsplash.com, links only to unsplash.com, a ping
 * only to an api.unsplash.com download endpoint.
 */
import type {
  UnsplashKeyCheck,
  UnsplashKeySaveResult,
  UnsplashKeyStatus,
  UnsplashKeyStore,
  UnsplashPhoto,
  UnsplashSearchFailure,
  UnsplashSearchPage,
  UnsplashSearchResult
} from '@zennotes/bridge-contract/unsplash'
import type { NoteCover, NoteCoverCredit } from './note-cover'

export const UNSPLASH_API_BASE_URL = 'https://api.unsplash.com'
export const UNSPLASH_HOME_URL = 'https://unsplash.com/'
/** Where a person registers the app whose Access Key they paste. */
export const UNSPLASH_DEVELOPERS_URL = 'https://unsplash.com/developers'
/** A person's Unsplash apps, where a key is found again or revoked. */
export const UNSPLASH_APPS_URL = 'https://unsplash.com/oauth/applications'
/** The app name Unsplash's referral links carry. */
export const UNSPLASH_UTM_SOURCE = 'zennotes'
export const UNSPLASH_MIN_QUERY_LENGTH = 2
export const UNSPLASH_MAX_QUERY_LENGTH = 100
export const UNSPLASH_MAX_PAGE = 50
/** Photos per page: six rows of the picker's four tiles. */
export const UNSPLASH_PER_PAGE = 24
/** What a new Unsplash app may ask in an hour, until Unsplash approves it
 *  for production. */
export const UNSPLASH_DEMO_HOURLY_LIMIT = 50
/** Requests one client sends in a minute at most, well above what a person
 *  typing reaches: a renderer bug that searched in a loop would otherwise
 *  spend the key's hour in seconds. */
export const UNSPLASH_REQUESTS_PER_MINUTE = 40

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

/** A pasted Access Key, trimmed, or null when it cannot be one. Unsplash's
 *  keys are 43 URL-safe characters today; this is looser on purpose. It
 *  keeps a pasted line break or label out of a request header, and leaves
 *  the real verdict to Unsplash, which saving asks. */
export function normalizeUnsplashAccessKey(key: unknown): string | null {
  if (typeof key !== 'string') return null
  const trimmed = key.trim()
  return /^[A-Za-z0-9_-]{16,128}$/.test(trimmed) ? trimmed : null
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed.slice(0, max) : null
}

function size(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function photoFrom(entry: unknown): UnsplashPhoto | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  // An Unsplash+ photo can be listed to a free key, but nobody may use it
  // without a plan.
  if (e.premium === true || e.plus === true) return null
  const urls = record(e.urls)
  const user = record(e.user)
  const id = typeof e.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(e.id) ? e.id : null
  const name = text(user.name, 120)
  const profile = httpsUrl(record(user.links).html)
  const downloadLocation = record(e.links).download_location
  if (!id || !name) return null
  if (!isUnsplashImageUrl(urls.raw) || !isUnsplashImageUrl(urls.small)) return null
  if (profile?.hostname !== 'unsplash.com' || !isUnsplashDownloadLocation(downloadLocation)) return null
  return {
    id,
    width: size(e.width),
    height: size(e.height),
    color: typeof e.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : null,
    alt: text(e.alt_description, 300) ?? text(e.description, 300),
    rawUrl: urls.raw as string,
    thumbUrl: urls.small as string,
    // The note keeps the profile itself; the referral tags are added when drawn.
    photographer: { name, profileUrl: `${profile.origin}${profile.pathname}` },
    downloadLocation: downloadLocation as string
  }
}

/** Unsplash's search answer, `{ total_pages, results: [...] }`, as a page of
 *  photos; a photo the app could not use is left out, an answer that is not
 *  one is null. */
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

export interface UnsplashApiOptions {
  /** api.unsplash.com, or a stand-in for a test run. */
  baseUrl?: string
  /** Extra request headers (the desktop sends a bare user agent). */
  headers?: Record<string, string>
}

function apiBase(options: UnsplashApiOptions): string {
  return (options.baseUrl ?? UNSPLASH_API_BASE_URL).replace(/\/+$/, '')
}

function apiRequest(key: string, headers: Record<string, string> | undefined): RequestInit {
  return {
    method: 'GET',
    // No cookies: a search has nothing to do with an account, and the
    // desktop's session may hold zennotes.org ones from a Cloud page.
    credentials: 'omit',
    cache: 'no-store',
    // Unsplash needs no Referer naming the page (a self-hoster's address).
    referrerPolicy: 'no-referrer',
    headers: {
      accept: 'application/json',
      'accept-version': 'v1',
      authorization: `Client-ID ${key}`,
      ...headers
    },
    signal: AbortSignal.timeout(10_000)
  }
}

function headerCount(response: UnsplashFetchResponse, name: string): number | null {
  const value = response.headers.get(name)?.trim()
  if (!value) return null
  const count = Number(value)
  return Number.isInteger(count) && count >= 0 ? count : null
}

/** What an answer that is not a success means. Unsplash refuses a key with
 *  401, and says the hour's allowance is spent with 403 "Rate Limit
 *  Exceeded" and X-Ratelimit-Remaining at 0. */
export function unsplashFailureOf(response: UnsplashFetchResponse): UnsplashSearchFailure {
  if (response.status === 401) return 'invalid-key'
  if (response.status === 429) return 'rate-limited'
  if (response.status === 403 && headerCount(response, 'x-ratelimit-remaining') === 0) return 'rate-limited'
  return 'unavailable'
}

function failed(reason: UnsplashSearchFailure, limit: number | null, retryAt: number | null = null): UnsplashSearchResult {
  return { ok: false, reason, retryAt, limit }
}

function clampPage(page: number | undefined): number {
  return Math.min(UNSPLASH_MAX_PAGE, Math.max(1, Math.floor(page ?? 1)))
}

/** One page of landscape, safe-search results. Never throws: a failure comes
 *  back as the reason the picker shows. */
export async function searchUnsplashPhotos(
  fetchFn: UnsplashFetch,
  input: { key: string; query: string; page?: number },
  options: UnsplashApiOptions = {}
): Promise<UnsplashSearchResult> {
  const query = normalizeUnsplashQuery(input.query)
  const page = clampPage(input.page)
  if (query.length < UNSPLASH_MIN_QUERY_LENGTH) {
    return { ok: true, page: { query, page, totalPages: 0, photos: [] } }
  }
  const params = new URLSearchParams({
    query,
    page: String(page),
    per_page: String(UNSPLASH_PER_PAGE),
    orientation: 'landscape',
    content_filter: 'high'
  })
  let response: UnsplashFetchResponse
  try {
    response = await fetchFn(`${apiBase(options)}/search/photos?${params}`, apiRequest(input.key, options.headers))
  } catch {
    return failed('offline', null)
  }
  if (!response.ok) return failed(unsplashFailureOf(response), headerCount(response, 'x-ratelimit-limit'))
  let parsed: UnsplashSearchPage | null = null
  try {
    parsed = parseUnsplashSearchResponse(await response.json(), query, page)
  } catch {
    parsed = null
  }
  return parsed ? { ok: true, page: parsed } : failed('unavailable', null)
}

/** Tell Unsplash a photo became a cover: a GET of its download location,
 *  with the key. The location's path and query go to the API base, which is
 *  api.unsplash.com outside a test run. Fire and forget: a ping that does
 *  not arrive must never undo or delay the pick. */
export async function trackUnsplashPhotoDownload(
  fetchFn: UnsplashFetch,
  input: { key: string; downloadLocation: string },
  options: UnsplashApiOptions = {}
): Promise<void> {
  if (!isUnsplashDownloadLocation(input.downloadLocation)) return
  const location = new URL(input.downloadLocation)
  try {
    await fetchFn(`${apiBase(options)}${location.pathname}${location.search}`, apiRequest(input.key, options.headers))
  } catch {
    // Dropped, as above.
  }
}

/** One request with a key: the first photo of Unsplash's editorial feed,
 *  the cheapest thing it answers. It costs one of the hour's requests, and
 *  the answer's headers say how many are left. */
export async function checkUnsplashAccessKey(
  fetchFn: UnsplashFetch,
  key: string,
  options: UnsplashApiOptions = {}
): Promise<UnsplashKeyCheck> {
  let response: UnsplashFetchResponse
  try {
    response = await fetchFn(`${apiBase(options)}/photos?per_page=1`, apiRequest(key, options.headers))
  } catch {
    return { ok: false, reason: 'offline', limit: null }
  }
  const limit = headerCount(response, 'x-ratelimit-limit')
  if (!response.ok) return { ok: false, reason: unsplashFailureOf(response), limit }
  return { ok: true, remaining: headerCount(response, 'x-ratelimit-remaining'), limit }
}

/** Where a host keeps the key. `set` answers false when it could not keep
 *  it safely. */
export interface UnsplashKeyVault {
  get(): Promise<string | null>
  set(key: string): Promise<boolean>
  delete(): Promise<void>
  canStore(): boolean
}

export interface UnsplashClient {
  status(): Promise<UnsplashKeyStatus>
  save(key: unknown): Promise<UnsplashKeySaveResult>
  test(): Promise<UnsplashKeyCheck>
  clear(): Promise<void>
  search(query: unknown, page: unknown): Promise<UnsplashSearchResult>
  trackDownload(downloadLocation: unknown): Promise<void>
}

/**
 * Everything a host does for the Unsplash tab, given a fetch and a place for
 * the key: desktop main (net.fetch and the system's secure storage) and the
 * web client (the browser's fetch and storage) are both built from this. The
 * arguments are checked here, since desktop main takes them from the
 * renderer, and nothing the client answers carries the key.
 */
export function createUnsplashClient(deps: {
  fetch: UnsplashFetch
  keys: UnsplashKeyVault
  store: UnsplashKeyStore
  options?: () => UnsplashApiOptions
  now?: () => number
}): UnsplashClient {
  const now = deps.now ?? Date.now
  const options = deps.options ?? (() => ({}))
  const sent: number[] = []
  /** Room for one more request, or the time the oldest one leaves the window. */
  const take = (): number | null => {
    const at = now()
    while (sent.length && at - sent[0]! >= 60_000) sent.shift()
    if (sent.length >= UNSPLASH_REQUESTS_PER_MINUTE) return sent[0]! + 60_000
    sent.push(at)
    return null
  }
  // Read once and kept for the run; saving or clearing replaces it.
  let current: Promise<string | null> | null = null
  const key = (): Promise<string | null> =>
    (current ??= deps.keys.get().then(normalizeUnsplashAccessKey, () => null))

  return {
    async status() {
      return { set: (await key()) !== null, store: deps.store, canStore: deps.keys.canStore() }
    },
    async save(raw) {
      const next = normalizeUnsplashAccessKey(raw)
      if (!next) return { saved: false, reason: 'malformed' }
      if (!deps.keys.canStore()) return { saved: false, reason: 'cannot-store' }
      const check: UnsplashKeyCheck =
        take() === null
          ? await checkUnsplashAccessKey(deps.fetch, next, options())
          : { ok: false, reason: 'rate-limited', limit: null }
      if (!check.ok && check.reason === 'invalid-key') return { saved: false, reason: 'invalid-key' }
      if (!(await deps.keys.set(next).catch(() => false))) return { saved: false, reason: 'cannot-store' }
      current = Promise.resolve(next)
      return { saved: true, check }
    },
    async test() {
      const saved = await key()
      if (!saved) return { ok: false, reason: 'no-key', limit: null }
      if (take() !== null) return { ok: false, reason: 'rate-limited', limit: null }
      return await checkUnsplashAccessKey(deps.fetch, saved, options())
    },
    async clear() {
      await deps.keys.delete()
      current = Promise.resolve(null)
    },
    async search(query, page) {
      if (typeof query !== 'string') return failed('unavailable', null)
      const at = typeof page === 'number' && Number.isFinite(page) ? clampPage(page) : 1
      if (!isUnsplashSearchableQuery(query)) {
        return { ok: true, page: { query: normalizeUnsplashQuery(query), page: at, totalPages: 0, photos: [] } }
      }
      const saved = await key()
      if (!saved) return failed('no-key', null)
      const wait = take()
      if (wait !== null) return failed('rate-limited', null, wait)
      return await searchUnsplashPhotos(deps.fetch, { key: saved, query, page: at }, options())
    },
    async trackDownload(downloadLocation) {
      if (!isUnsplashDownloadLocation(downloadLocation)) return
      const saved = await key()
      if (!saved || take() !== null) return
      await trackUnsplashPhotoDownload(deps.fetch, { key: saved, downloadLocation: downloadLocation as string }, options())
    }
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
