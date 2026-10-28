/**
 * Unsplash photo search for the cover picker, with the person's own Unsplash
 * access key: every host asks api.unsplash.com directly and keeps the key
 * itself (see shared-domain unsplash.ts for the rules this follows). The key
 * never comes back across the bridge; a host says only whether one is set.
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

/** Why a request to Unsplash came back empty-handed:
 *  - `no-key`: no access key is set yet;
 *  - `invalid-key`: Unsplash refused the key (401);
 *  - `rate-limited`: the key's hourly allowance is spent (403 with
 *    X-Ratelimit-Remaining at 0), or the app's own per-minute cap is (until
 *    `retryAt`, epoch ms);
 *  - `offline`: Unsplash could not be reached;
 *  - `unavailable`: any other answer. */
export type UnsplashSearchFailure = 'no-key' | 'invalid-key' | 'rate-limited' | 'offline' | 'unavailable'

export type UnsplashSearchResult =
  | { ok: true; page: UnsplashSearchPage }
  | {
      ok: false
      reason: UnsplashSearchFailure
      retryAt: number | null
      /** The key's hourly allowance, when Unsplash said (X-Ratelimit-Limit). */
      limit: number | null
    }

/** Where a host keeps the key: the system's secure storage (desktop), or
 *  this browser's storage (the web client). */
export type UnsplashKeyStore = 'system' | 'browser'

export interface UnsplashKeyStatus {
  set: boolean
  store: UnsplashKeyStore
  /** False when the host has nowhere safe to keep a key (a Linux desktop
   *  without a keyring, a browser with storage turned off). */
  canStore: boolean
}

/** One real request with a key: it works, with what is left of the hour's
 *  allowance when Unsplash says, or why not. */
export type UnsplashKeyCheck =
  | { ok: true; remaining: number | null; limit: number | null }
  | { ok: false; reason: UnsplashSearchFailure; limit: number | null }

/** Saving a pasted key. It is checked with one request first and kept
 *  unless Unsplash refuses it; a key that could not be checked (offline,
 *  rate-limited) is kept, with the check saying why. */
export type UnsplashKeySaveResult =
  | { saved: true; check: UnsplashKeyCheck }
  | { saved: false; reason: 'malformed' | 'invalid-key' | 'cannot-store' }
