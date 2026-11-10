/**
 * Signing in to ZenNotes Cloud from the browser (docs/ideas/cloud-in-browser.md,
 * "Signing in as a device"). The package's CloudAuthFlow does the PKCE work;
 * this file holds what the browser decides:
 *
 * - The website returns to this origin's `/auth/callback` with the code and
 *   state in the URL fragment. The page reads them, clears them with
 *   `history.replaceState`, then completes the sign-in.
 * - The pending sign-in lives in IndexedDB keyed by its state and is used
 *   once (portable-vault mobile-cloud-auth.ts), so the callback can finish in
 *   another tab, as it does when a new user's verification link opens one.
 *   It lasts 45 minutes: a sign-up with email verification fits, and the
 *   verifier is useless without a code, which still expires five minutes
 *   after Authorize.
 * - The finishing tab tells the others over a BroadcastChannel.
 * - The device is named for the browser and the OS ("Chrome on macOS").
 */

export const AUTH_CALLBACK_PATH = '/auth/callback'
export const BROWSER_SIGN_IN_LIFETIME_MS = 45 * 60 * 1000

export function cloudCallbackUrl(origin = location.origin): string {
  return `${origin}${AUTH_CALLBACK_PATH}`
}

/** "Chrome on macOS", "Safari on iPhone", "Firefox on Windows". */
export function browserDeviceName(userAgent: string): string {
  const ua = userAgent
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\/|FxiOS\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\/|Chromium\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'A browser'
  const system = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /CrOS/.test(ua)
          ? 'ChromeOS'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Windows/.test(ua)
              ? 'Windows'
              : /Linux/.test(ua)
                ? 'Linux'
                : null
  return system ? `${browser} on ${system}` : browser
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const ACCOUNT_CHANNEL = 'zennotes:cloud-account'

export type AccountAnnouncement =
  | { type: 'signed-in'; email: string }
  | { type: 'signed-out' }
  /** This browser's copy of the account was removed (revoked, or another
   *  account signed in): every tab stops and shows why. */
  | { type: 'wiped'; reason: 'revoked' | 'account-switch' }

export function announceAccount(message: AccountAnnouncement): void {
  if (typeof BroadcastChannel === 'undefined') return
  try {
    const channel = new BroadcastChannel(ACCOUNT_CHANNEL)
    channel.postMessage(message)
    channel.close()
  } catch {
    // A closed or blocked channel: the other tabs learn on their next request.
  }
}

export function onAccountAnnouncement(listener: (message: AccountAnnouncement) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(ACCOUNT_CHANNEL)
  channel.onmessage = (event: MessageEvent<AccountAnnouncement>) => {
    const type = (event.data as { type?: unknown } | null)?.type
    if (type === 'signed-in' || type === 'signed-out' || type === 'wiped') listener(event.data)
  }
  return () => channel.close()
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

export interface CallbackCapture {
  url: string
  hasCode: boolean
}

/**
 * Reads this page's callback URL and clears the code from the address bar
 * and history before anything else runs, so a reload, the history list or a
 * shared screenshot never carries it.
 */
export function captureAuthCallback(): CallbackCapture | null {
  if (location.pathname !== AUTH_CALLBACK_PATH) return null
  const url = location.href
  const hasCode = new URLSearchParams(location.hash.replace(/^#/, '')).has('code')
  history.replaceState(null, '', '/')
  return { url, hasCode }
}

/** The sign-in this tab did not start, or one too old to finish. */
export const SIGN_IN_ELSEWHERE_MESSAGE =
  'This sign-in was started in another browser, or more than 45 minutes ago. Open the sign-in link in the browser you started in, or sign in again here.'

export const CLOUD_WEB_NOT_ENABLED_MESSAGE =
  'ZenNotes in the browser is not available for your account yet. Your notes are safe in ZenNotes Cloud and in the apps.'
