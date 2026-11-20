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

import { applyRemoteHeaders, type RemoteHeader } from '@shared/remote-headers'
import { trustSystemCertificates } from '../system-trust'

export interface RemoteRequestOptions {
  baseUrl: string
  authToken?: string | null
  /** Extra headers for an access gateway in front of the server (#1091). */
  headers?: readonly RemoteHeader[] | null
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
  response: {
    status: number
    statusText: string
    headers?: { get(name: string): string | null }
  },
  text: string
): string {
  if (response.status === 401) {
    return `The ZenNotes server rejected the connection. Check the auth token for ${baseUrl} and try again.`
  }
  // The ZenNotes server answers in plain text. An HTML 403 came from
  // something in front of it, most often an access gateway turning away a
  // request without its headers (#1091); its page would only be noise here.
  if (
    response.status === 403 &&
    /text\/html/i.test(response.headers?.get('content-type') ?? '')
  ) {
    return gatewayRefusedMessage(baseUrl)
  }
  return `Remote server request failed (${response.status} ${response.statusText}) for ${path}${text ? `: ${text}` : ''}`
}

/** An access gateway in front of the server turned the request away. */
export function gatewayRefusedMessage(baseUrl: string): string {
  return `Something in front of the ZenNotes server at ${baseUrl} refused the request. If it sits behind an access gateway such as Cloudflare Access, check the extra headers for this remote.`
}

/**
 * A gateway such as Cloudflare Access answers a request without its headers by
 * redirecting it to a sign-in page on another host. fetch follows that, lands
 * on HTML, and the caller would report a JSON parse error, so name the gateway
 * instead. A redirect that stays on the server's host (http to https) is fine.
 */
export function gatewayRedirectMessage(
  baseUrl: string,
  response: { redirected: boolean; url: string }
): string | null {
  if (!response.redirected || !response.url) return null
  let from: string
  let to: string
  try {
    from = new URL(baseUrl).hostname.toLowerCase()
    to = new URL(response.url).hostname.toLowerCase()
  } catch {
    return null
  }
  if (from === to) return null
  return `The ZenNotes server at ${baseUrl} sent the request to a sign-in page at ${to}. If the server sits behind an access gateway such as Cloudflare Access, add the gateway's headers to this remote.`
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

/** A request with auth and both error shapes: a server that cannot be reached
 *  and a non-2xx answer. `body` goes as given. */
async function remoteFetch(
  path: string,
  options: RemoteRequestOptions,
  headers: Headers,
  body?: RequestInit['body']
): Promise<Response> {
  if (options.authToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${options.authToken}`)
  }
  applyRemoteHeaders(headers, options.headers)
  trustSystemCertificates()
  let response: Response
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      method: options.method,
      headers,
      body
    })
  } catch (error) {
    throw new Error(connectionErrorMessage(options.baseUrl, error))
  }
  const redirected = gatewayRedirectMessage(options.baseUrl, response)
  if (redirected) throw new RemoteRequestError(redirected, 403)
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).trim()
    throw new RemoteRequestError(
      requestErrorMessage(options.baseUrl, path, response, text),
      response.status
    )
  }
  return response
}

/** One JSON request against a server. */
export async function remoteJsonRequest<T>(
  path: string,
  options: RemoteRequestOptions
): Promise<T> {
  const headers = new Headers()
  const hasBody = options.body !== undefined
  if (hasBody) headers.set('Content-Type', 'application/json')
  const response = await remoteFetch(
    path,
    options,
    headers,
    hasBody ? JSON.stringify(options.body) : undefined
  )
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** A file's bytes from a server. */
export async function remoteBytesRequest(
  path: string,
  options: RemoteRequestOptions
): Promise<Uint8Array> {
  const response = await remoteFetch(path, options, new Headers())
  return new Uint8Array(await response.arrayBuffer())
}

/** A multipart POST, answered in JSON. fetch sets the form's Content-Type. */
export async function remoteFormRequest<T>(
  path: string,
  form: FormData,
  options: RemoteRequestOptions
): Promise<T> {
  const response = await remoteFetch(path, { ...options, method: 'POST' }, new Headers(), form)
  return (await response.json()) as T
}
