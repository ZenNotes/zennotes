/**
 * Unsplash photo search for the cover picker. The app never holds an
 * Unsplash key: every host asks the proxy on zennotes.org, which signs the
 * request, trims the answer to these fields and keeps the shared hourly
 * budget (see shared-domain unsplash.ts for the rules this follows).
 */

/** One photo, as the picker needs it. */
export interface UnsplashPhoto {
  id: string
  width: number
  height: number
  /** The photo's average colour, drawn while its thumbnail loads. */
  color: string | null
  alt: string | null
  /** `urls.raw`: every size is built from it, and it carries the `ixid`
   *  Unsplash counts views by. */
  rawUrl: string
  /** `urls.small`, about 400 px wide, for the picker's tiles. */
  thumbUrl: string
  photographer: { name: string; profileUrl: string }
  /** `links.download_location`, pinged when the photo becomes a cover. */
  downloadLocation: string
}

export interface UnsplashSearchPage {
  query: string
  page: number
  totalPages: number
  photos: UnsplashPhoto[]
}

/** Why a search came back empty-handed: no connection, the shared hourly
 *  budget is spent (until `retryAt`, epoch ms, when the proxy says), or the
 *  service could not answer. */
export type UnsplashSearchFailure = 'offline' | 'rate-limited' | 'unavailable'

export type UnsplashSearchResult =
  | { ok: true; page: UnsplashSearchPage }
  | { ok: false; reason: UnsplashSearchFailure; retryAt: number | null }
