/**
 * A failed update check or download in a sentence a person can act on
 * (#1003).
 *
 * electron-updater's errors carry everything it knows in the message: the
 * request, every response header, and the stack of the HTTP error it wrapped.
 * Shown as is, a Windows user who pressed Check for updates got a dialog of
 * headers that ended in "GitHub returned a temporary network or server
 * error", because a bare `5\d\d` matched a digit run somewhere in those
 * headers. The answer had been a 404: the release workflow publishes the
 * GitHub release before its update feeds, so for about fifty minutes the
 * newest release has no `latest.yml` (or `latest-mac.yml`, or
 * `latest-linux.yml`) for some platforms.
 *
 * So the HTTP status is read only from where it is structured (an error's
 * `statusCode`, the `HTTP_ERROR_NNN` code, `HttpError: NNN` at the head of a
 * wrapped error, the release feed's own status), never from the text at
 * large, and the original text goes to `detail` for the Details disclosure
 * and the log, never into the message.
 */

/** What the updater was doing when it failed. */
export type UpdateAction = 'check' | 'download'

export type UpdateErrorKind =
  /** The newest release has no update feed for this platform yet. */
  | 'still-publishing'
  /** GitHub answered with a server error, a rate limit, or not in time. */
  | 'unavailable'
  /** macOS refused the downloaded update's code signature. */
  | 'signature'
  | 'other'

export interface UpdateErrorCopy {
  /** What happened and what to do, in one or two sentences. */
  message: string
  /** The original error text, for Details, Copy details and the log. */
  detail: string | null
  kind: UpdateErrorKind
  /** True when trying again in a moment may succeed (a 5xx, a timeout). */
  retryable: boolean
}

/**
 * The release feed answered with something other than a feed. Thrown by the
 * notify-only check (update-feed.ts), which reads the feed with fetch rather
 * than electron-updater. `url` is where the request ended up after GitHub's
 * redirect from `releases/latest`, which names the release's tag.
 */
export class ReleaseFeedHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string | null
  ) {
    super(`GitHub answered ${status} for the release feed${url ? ` (${url})` : ''}.`)
    this.name = 'ReleaseFeedHttpError'
  }
}

/** electron-updater's code for a 404 on `<channel>.yml` of the newest release. */
const CHANNEL_FILE_NOT_FOUND = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'

/** A release download path naming an update feed: the tag is the version. */
const FEED_URL_VERSION = /\/releases\/download\/v?(\d+\.\d+\.\d+[^/\s)]*)\/latest[^/\s)]*\.ya?ml\b/i

const TRANSIENT_TEXT = /gateway time-?out|timed out|econnreset|eai_again|socket hang up/i

export function stillPublishingMessage(version: string | null): string {
  return version
    ? `ZenNotes ${version} is still being published. Try again in a few minutes.`
    : 'A new version of ZenNotes is still being published. Try again in a few minutes.'
}

const UNAVAILABLE: Record<UpdateAction, string> = {
  check:
    'GitHub returned a temporary network or server error while checking for updates. Try again in a moment, or open the latest release directly.',
  download:
    'GitHub returned a temporary network or server error while downloading the update. Try again in a moment, or open the latest release directly.'
}

const OTHER: Record<UpdateAction, string> = {
  check: "ZenNotes couldn't check for updates. Try again later, or open the latest release directly.",
  download:
    "ZenNotes couldn't download the update. Try again later, or open the latest release directly."
}

/** A download that lost the network. A check that cannot reach GitHub never
 *  shows an error: it waits for the connection (updater.ts, #812). */
export const UPDATE_OFFLINE_MESSAGE =
  "ZenNotes couldn't reach GitHub. Check the connection and try again."

export const UPDATE_SIGNATURE_MESSAGE =
  "macOS couldn't verify the update's code signature, so ZenNotes can't install it. Open the latest release directly and install it from there."

interface ChainLink {
  message: string
  code: string | null
  statusCode: number | null
  /** Set for the notify-only check's own feed request. */
  feedUrl: string | null
  isReleaseFeed: boolean
}

/** Each error along the `cause` chain, outermost first. */
function errorChain(error: unknown): ChainLink[] {
  const links: ChainLink[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (current instanceof Error) {
      const fields = current as { code?: unknown; statusCode?: unknown; cause?: unknown }
      const feed = current instanceof ReleaseFeedHttpError ? current : null
      links.push({
        message: current.message,
        code: typeof fields.code === 'string' ? fields.code : null,
        statusCode: feed ? feed.status : typeof fields.statusCode === 'number' ? fields.statusCode : null,
        feedUrl: feed?.url ?? null,
        isReleaseFeed: feed !== null
      })
      current = fields.cause
    } else {
      links.push({
        message: String(current),
        code: null,
        statusCode: null,
        feedUrl: null,
        isReleaseFeed: false
      })
      break
    }
  }
  return links
}

/**
 * The part of a message before the response headers and the stack, where
 * the error says what it is. Digits after that point are header values,
 * request ids and line numbers.
 */
function headline(message: string): string {
  const cut = [message.indexOf('\nHeaders:'), message.search(/\n\s+at /)]
    .filter((index) => index >= 0)
    .reduce((first, index) => Math.min(first, index), message.length)
  return message.slice(0, cut)
}

/** The HTTP status an error stands for, or null when it carries none. */
export function updateErrorStatus(error: unknown): number | null {
  for (const link of errorChain(error)) {
    if (link.statusCode !== null) return link.statusCode
    const fromCode = /^HTTP_ERROR_(\d{3})$/.exec(link.code ?? '')
    if (fromCode) return Number(fromCode[1])
    // A wrapped HttpError is pasted in as its stack: "HttpError: 404 ...".
    const wrapped = /\bHttpError: (\d{3})\b/.exec(headline(link.message))
    if (wrapped) return Number(wrapped[1])
  }
  return null
}

/** The version a missing feed belongs to, read from the feed's URL. */
function versionFromFeedUrl(links: ChainLink[]): string | null {
  for (const link of links) {
    for (const text of [link.feedUrl, headline(link.message)]) {
      const match = text ? FEED_URL_VERSION.exec(text) : null
      if (match) return match[1]
    }
  }
  return null
}

function isMissingFeed(links: ChainLink[]): boolean {
  return links.some(
    (link) =>
      link.code === CHANNEL_FILE_NOT_FOUND ||
      /^Cannot find \S+\.ya?ml in the latest release artifacts\b/.test(link.message) ||
      // The notify-only check reads `releases/latest/download/latest-linux.yml`.
      (link.isReleaseFeed && link.statusCode === 404)
  )
}

/** The whole original text, every link of the chain, for Details. */
function detailOf(links: ChainLink[]): string | null {
  const parts = links
    .map((link) => [link.code && !link.message.includes(link.code) ? `[${link.code}]` : '', link.message.trim()])
    .map((pair) => pair.filter(Boolean).join(' '))
    .filter(Boolean)
  const unique = parts.filter((part, index) => parts.indexOf(part) === index)
  return unique.length > 0 ? unique.join('\n\ncaused by: ') : null
}

export function describeUpdateError(
  error: unknown,
  action: UpdateAction,
  platform: NodeJS.Platform = process.platform
): UpdateErrorCopy {
  const links = errorChain(error)
  const detail = detailOf(links)
  const status = updateErrorStatus(error)

  if (action === 'check' && isMissingFeed(links)) {
    return {
      message: stillPublishingMessage(versionFromFeedUrl(links)),
      detail,
      kind: 'still-publishing',
      retryable: false
    }
  }

  const transient = links.some((link) => TRANSIENT_TEXT.test(headline(link.message)))
  if ((status !== null && status >= 500 && status <= 599) || status === 429 || transient) {
    return {
      message: UNAVAILABLE[action],
      detail,
      kind: 'unavailable',
      // A rate limit does not lift in a second and a half.
      retryable: status !== 429
    }
  }

  if (
    platform === 'darwin' &&
    links.some((link) => /code signature|signature .*(?:valid|verif)|not signed/i.test(headline(link.message)))
  ) {
    return { message: UPDATE_SIGNATURE_MESSAGE, detail, kind: 'signature', retryable: false }
  }

  return { message: OTHER[action], detail, kind: 'other', retryable: false }
}
