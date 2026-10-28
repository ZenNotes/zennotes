import { describe, expect, it } from 'vitest'
import {
  describeUpdateError,
  ReleaseFeedHttpError,
  stillPublishingMessage,
  UPDATE_SIGNATURE_MESSAGE,
  updateErrorStatus
} from './update-error-copy'

/** The response headers GitHub sends with a missing release asset (HTTP/2,
 *  so the status line has no reason phrase). `max-age=31536000` holds the
 *  digit run `536`, which the old `5\d\d` test read as a server error. */
const GITHUB_404_HEADERS = `{
  "date": "Tue, 27 Oct 2026 21:14:03 GMT",
  "content-type": "text/plain; charset=utf-8",
  "vary": "X-PJAX, X-PJAX-Container, Turbo-Visit, Turbo-Frame, X-Requested-With, X-GitHub-Client-Version, Sec-Fetch-Site,Accept-Encoding, Accept, X-Requested-With",
  "cache-control": "no-cache",
  "strict-transport-security": "max-age=31536000; includeSubdomains; preload",
  "x-frame-options": "deny",
  "x-content-type-options": "nosniff",
  "x-xss-protection": "0",
  "referrer-policy": "no-referrer-when-downgrade",
  "server": "github.com",
  "content-length": "9",
  "x-github-request-id": "D35F:97851:C4D42C:115D4E7:6AE20ED5"
}`

const STACK = `    at createHttpError (C:\\Users\\me\\AppData\\Local\\Programs\\ZenNotes\\resources\\app.asar\\node_modules\\builder-util-runtime\\out\\httpExecutor.js:53:12)
    at ElectronHttpExecutor.handleResponse (C:\\Users\\me\\AppData\\Local\\Programs\\ZenNotes\\resources\\app.asar\\node_modules\\builder-util-runtime\\out\\httpExecutor.js:155:20)
    at ClientRequest.<anonymous> (C:\\Users\\me\\AppData\\Local\\Programs\\ZenNotes\\resources\\app.asar\\node_modules\\builder-util-runtime\\out\\httpExecutor.js:525:33)`

const feedUrl = (version: string, file: string) =>
  `https://github.com/ZenNotes/zennotes/releases/download/v${version}/${file}`

/**
 * What electron-updater 6's GitHubProvider throws when the newest release
 * has no `<channel>.yml`: its own error, with the HTTP error's stack pasted
 * into the message and only a code to tell it apart (#1003's dialog).
 */
function channelFileNotFound(version: string, file: string): Error {
  const url = feedUrl(version, file)
  const httpError =
    `HttpError: 404 \n` +
    JSON.stringify(
      `method: GET url: ${url}\n\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\n`
    ) +
    `\nHeaders: ${GITHUB_404_HEADERS}\n${STACK}`
  return Object.assign(
    new Error(`Cannot find ${file} in the latest release artifacts (${url}): ${httpError}`),
    { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }
  )
}

/** builder-util-runtime's HttpError, as electron-updater rejects with it. */
function httpError(status: number, reason = ''): Error {
  return Object.assign(new Error(`${status} ${reason}\nHeaders: ${GITHUB_404_HEADERS}`), {
    name: 'HttpError',
    statusCode: status,
    code: `HTTP_ERROR_${status}`
  })
}

describe('describeUpdateError: a release still being published (#1003)', () => {
  it('turns the reported Windows dialog into one sentence and keeps the dump for Details', () => {
    const copy = describeUpdateError(channelFileNotFound('2.78.0', 'latest.yml'), 'check', 'win32')
    expect(copy.kind).toBe('still-publishing')
    expect(copy.message).toBe('ZenNotes 2.78.0 is still being published. Try again in a few minutes.')
    expect(copy.retryable).toBe(false)
    expect(copy.detail).toContain('[ERR_UPDATER_CHANNEL_FILE_NOT_FOUND]')
    expect(copy.detail).toContain('max-age=31536000')
    expect(copy.detail).toContain('at createHttpError')
  })

  it('reads every platform feed the release publishes the same way', () => {
    const feeds: Array<[string, NodeJS.Platform]> = [
      ['latest.yml', 'win32'],
      ['latest-arm64.yml', 'win32'],
      ['latest-mac.yml', 'darwin'],
      ['latest-linux.yml', 'linux'],
      ['latest-linux-arm64.yml', 'linux']
    ]
    for (const [file, platform] of feeds) {
      const copy = describeUpdateError(channelFileNotFound('2.79.0', file), 'check', platform)
      expect(copy.kind, file).toBe('still-publishing')
      expect(copy.message, file).toBe(stillPublishingMessage('2.79.0'))
    }
  })

  it('recognizes the wording when a code was lost on the way', () => {
    const { message } = channelFileNotFound('2.78.0', 'latest-mac.yml')
    expect(describeUpdateError(new Error(message), 'check', 'darwin').message).toBe(
      stillPublishingMessage('2.78.0')
    )
  })

  it('names the release from the notify-only check, which lands there by redirect', () => {
    const missing = new ReleaseFeedHttpError(404, feedUrl('2.79.0', 'latest-linux.yml'))
    const copy = describeUpdateError(missing, 'check', 'linux')
    expect(copy.kind).toBe('still-publishing')
    expect(copy.message).toBe('ZenNotes 2.79.0 is still being published. Try again in a few minutes.')
    expect(copy.detail).toContain('GitHub answered 404 for the release feed')
  })

  it('still says so when no URL names the version', () => {
    expect(describeUpdateError(new ReleaseFeedHttpError(404, null), 'check', 'linux').message).toBe(
      'A new version of ZenNotes is still being published. Try again in a few minutes.'
    )
  })
})

describe('describeUpdateError: everything else', () => {
  it('never reads a 404 dump as a server error because of digits in its headers', () => {
    const copy = describeUpdateError(httpError(404), 'check', 'win32')
    expect(copy.kind).toBe('other')
    expect(copy.retryable).toBe(false)
    expect(copy.message).not.toMatch(/temporary/)
  })

  it('keeps the temporary-error sentence for real 5xx answers, and retries them', () => {
    const copy = describeUpdateError(httpError(503, 'Service Unavailable'), 'check', 'win32')
    expect(copy.kind).toBe('unavailable')
    expect(copy.retryable).toBe(true)
    expect(copy.message).toBe(
      'GitHub returned a temporary network or server error while checking for updates. Try again in a moment, or open the latest release directly.'
    )
    // The notify-only check's own status, and a 5xx wrapped by electron-updater.
    expect(describeUpdateError(new ReleaseFeedHttpError(502, null), 'check').retryable).toBe(true)
    const wrapped = Object.assign(
      new Error(
        `Unable to find latest version on GitHub (https://github.com/ZenNotes/zennotes/releases/latest), please ensure a production release exists: HttpError: 502 \nHeaders: ${GITHUB_404_HEADERS}\n${STACK}`
      ),
      { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' }
    )
    expect(describeUpdateError(wrapped, 'check').kind).toBe('unavailable')
  })

  it('treats a timeout as temporary, and a rate limit as temporary but not worth an instant retry', () => {
    expect(describeUpdateError(new Error('Request timed out'), 'check')).toMatchObject({
      kind: 'unavailable',
      retryable: true
    })
    expect(describeUpdateError(httpError(429, 'Too Many Requests'), 'check')).toMatchObject({
      kind: 'unavailable',
      retryable: false
    })
  })

  it('words a failed download as a download', () => {
    expect(describeUpdateError(httpError(503), 'download').message).toBe(
      'GitHub returned a temporary network or server error while downloading the update. Try again in a moment, or open the latest release directly.'
    )
    // A missing installer is not a release in progress: the feeds go up last.
    expect(describeUpdateError(httpError(404), 'download').message).toBe(
      "ZenNotes couldn't download the update. Try again later, or open the latest release directly."
    )
  })

  it('names a refused code signature only on macOS', () => {
    const signature = new Error(
      'Code signature at URL file:///Users/me/Library/Caches/zennotes-updater/pending/ZenNotes.app/ did not pass validation: code object is not signed at all'
    )
    expect(describeUpdateError(signature, 'download', 'darwin')).toMatchObject({
      kind: 'signature',
      message: UPDATE_SIGNATURE_MESSAGE
    })
    expect(describeUpdateError(signature, 'download', 'win32').kind).toBe('other')
  })

  it('falls back to a plain sentence, with the original text kept for Details', () => {
    const copy = describeUpdateError(new Error('The release feed carried no version.'), 'check', 'linux')
    expect(copy.message).toBe(
      "ZenNotes couldn't check for updates. Try again later, or open the latest release directly."
    )
    expect(copy.detail).toBe('The release feed carried no version.')
    expect(describeUpdateError('boom', 'check').detail).toBe('boom')
  })

  it('never puts headers, stack lines or URLs in the sentence', () => {
    const errors = [
      channelFileNotFound('2.78.0', 'latest.yml'),
      httpError(404),
      httpError(503),
      new ReleaseFeedHttpError(404, feedUrl('2.79.0', 'latest-linux.yml'))
    ]
    for (const error of errors) {
      for (const action of ['check', 'download'] as const) {
        const { message } = describeUpdateError(error, action, 'win32')
        expect(message).not.toMatch(/Headers|\bat \w|https?:|HttpError|\n/)
      }
    }
  })
})

describe('updateErrorStatus', () => {
  it('reads the status only where errors keep it', () => {
    expect(updateErrorStatus(httpError(503))).toBe(503)
    expect(updateErrorStatus(Object.assign(new Error('x'), { code: 'HTTP_ERROR_403' }))).toBe(403)
    expect(updateErrorStatus(new ReleaseFeedHttpError(404, null))).toBe(404)
    expect(updateErrorStatus(channelFileNotFound('2.78.0', 'latest.yml'))).toBe(404)
    // Digits in headers and stack lines are not a status.
    expect(updateErrorStatus(new Error(`failed\nHeaders: ${GITHUB_404_HEADERS}\n${STACK}`))).toBeNull()
    expect(updateErrorStatus(undefined)).toBeNull()
  })
})
