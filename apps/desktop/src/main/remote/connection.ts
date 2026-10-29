/**
 * The parts of talking to a ZenNotes server that don't need a WebSocket.
 *
 * Split out of server-client.ts so the `zn` CLI can reuse them (#493). The
 * CLI is bundled as a standalone `cli.js` that ships *outside* the asar, where
 * no `node_modules` is resolvable — every import has to end up in the bundle.
 * server-client.ts imports `ws` for its vault watcher, so importing it from
 * the CLI would drag a package the CLI can never use into a bundle that can't
 * resolve it. A one-shot command has nothing to watch, so the CLI takes this
 * module instead and stays fetch-only.
 */

import { trustSystemCertificates } from '../system-trust'

export interface RemoteRequestOptions {
  baseUrl: string
  authToken?: string | null
  method?: string
  /** Serialised as JSON; sets Content-Type when present. */
  body?: unknown
}

/** `localhost:7878` → `http://localhost:7878`, and no trailing slash. */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return normalized.replace(/\/+$/, '')
}

/**
 * Message for a transport-level failure — the request never got a response.
 *
 * On macOS 15+ a connection to anything on the local network needs the Local
 * Network privacy permission. Without it the OS drops the attempt before a
 * single packet leaves the machine, which surfaces here as a bare "fetch
 * failed" and looks exactly like a server that is down. The app now declares
 * `NSLocalNetworkUsageDescription` so macOS prompts on first use, but a user
 * who dismissed that prompt lands back here — so say where to turn it on. (#481)
 */
export function connectionErrorMessage(
  baseUrl: string,
  error: unknown,
  platform: NodeJS.Platform = process.platform
): string {
  const detail =
    error instanceof Error && error.message ? ` Could not reach the server: ${error.message}.` : ''
  const localNetworkHint =
    platform === 'darwin'
      ? ' If the server is on your local network, check that ZenNotes is allowed under System Settings → Privacy & Security → Local Network.'
      : ''
  return (
    `Could not connect to the ZenNotes server at ${baseUrl}. ` +
    `Make sure the server is running and the URL is correct.${detail}${localNetworkHint}`
  )
}

/** What the server said went wrong, phrased for whoever is reading. */
export function requestErrorMessage(
  baseUrl: string,
  path: string,
  response: { status: number; statusText: string },
  text: string
): string {
  if (response.status === 401) {
    return `The ZenNotes server rejected the connection. Check the auth token for ${baseUrl} and try again.`
  }
  return `Remote server request failed (${response.status} ${response.statusText}) for ${path}${text ? `: ${text}` : ''}`
}

/** A non-2xx server answer, with the HTTP status attached so callers can
 *  tell a 404 (absent file) from a real failure (#556 absence handling). */
export class RemoteRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'RemoteRequestError'
  }
}

/** One JSON request against a server, with auth and both error shapes. */
export async function remoteJsonRequest<T>(
  path: string,
  options: RemoteRequestOptions
): Promise<T> {
  const headers = new Headers()
  if (options.authToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${options.authToken}`)
  }
  const hasBody = options.body !== undefined
  if (hasBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  trustSystemCertificates()
  let response: Response
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      method: options.method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined
    })
  } catch (error) {
    throw new Error(connectionErrorMessage(options.baseUrl, error))
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new RemoteRequestError(
      requestErrorMessage(options.baseUrl, path, response, text),
      response.status
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}
