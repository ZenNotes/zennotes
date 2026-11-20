/**
 * Extra HTTP headers sent with every request to a self-hosted ZenNotes server
 * (#1091). They exist for an access gateway in front of the server, such as a
 * Cloudflare Access service token (`CF-Access-Client-Id` and
 * `CF-Access-Client-Secret`), which turns away any request without them before
 * the server ever sees it.
 *
 * One format everywhere: one `Name: value` per line, the way curl and every
 * proxy's documentation write a header. The desktop app's connect dialog and
 * saved remote profiles take it, and so does `ZENNOTES_REMOTE_HEADERS` for the
 * MCP server and `zn` bundled with the app (a JSON env block writes the line
 * break as `\n`). The standalone Go `zn` does not read it yet. Values are secrets: the app keeps them in the OS secret store with
 * the auth token, never in config.toml.
 */

export interface RemoteHeader {
  name: string
  value: string
}

/** The variable the MCP server and the bundled `zn` read the headers from. */
export const REMOTE_HEADERS_ENV = 'ZENNOTES_REMOTE_HEADERS'

/** More than any gateway needs; a pasted file or log is the likelier cause. */
export const MAX_REMOTE_HEADERS = 20

// RFC 9110 field-name token characters.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// No control characters in a value: a CR or LF would split the request.
const HEADER_VALUE_FORBIDDEN = /[\u0000-\u0008\u000a-\u001f\u007f]/

/**
 * Names the connection itself owns. Fetch and the WebSocket handshake set
 * these, and a second copy breaks the request (or the upgrade) instead of
 * reaching the gateway. Authorization has its own field, the auth token, and
 * the server reads it as that token.
 */
const RESERVED_NAMES = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

function reservedReason(name: string): string | null {
  const lower = name.toLowerCase()
  if (lower === 'authorization') return 'use the Auth token field for Authorization'
  if (RESERVED_NAMES.has(lower) || lower.startsWith('sec-websocket-')) {
    return `${name} is set by the connection itself`
  }
  return null
}

export type ParsedRemoteHeaders =
  | { ok: true; headers: RemoteHeader[] }
  | { ok: false; error: string }

/**
 * Read `Name: value` lines. Blank lines and lines starting with `#` are
 * skipped, so a pasted block with a comment still reads. The first error wins
 * and names its line; nothing is half-accepted.
 */
export function parseRemoteHeaders(text: string): ParsedRemoteHeaders {
  const headers: RemoteHeader[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r\n|\r|\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (!line || line.startsWith('#')) continue
    const where = `Line ${index + 1}`
    const colon = line.indexOf(':')
    if (colon <= 0) {
      return { ok: false, error: `${where}: write each header as Name: value.` }
    }
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (!HEADER_NAME.test(name)) {
      return { ok: false, error: `${where}: "${name}" is not a valid header name.` }
    }
    const reserved = reservedReason(name)
    if (reserved) return { ok: false, error: `${where}: ${reserved}.` }
    if (!value) return { ok: false, error: `${where}: ${name} has no value.` }
    if (HEADER_VALUE_FORBIDDEN.test(value)) {
      return { ok: false, error: `${where}: ${name} has a control character in its value.` }
    }
    const key = name.toLowerCase()
    if (seen.has(key)) return { ok: false, error: `${where}: ${name} is listed twice.` }
    seen.add(key)
    headers.push({ name, value })
    if (headers.length > MAX_REMOTE_HEADERS) {
      return { ok: false, error: `At most ${MAX_REMOTE_HEADERS} headers are allowed.` }
    }
  }
  return { ok: true, headers }
}

/** The lines `parseRemoteHeaders` reads back. */
export function formatRemoteHeaders(headers: readonly RemoteHeader[]): string {
  return headers.map((header) => `${header.name}: ${header.value}`).join('\n')
}

/**
 * The headers to send, re-checked: a stored list only reaches the network if
 * it would still parse. Anything else (a hand-edited secrets file, a list from
 * an older build) is dropped whole rather than sent in part.
 */
export function sanitizeRemoteHeaders(value: unknown): RemoteHeader[] {
  if (!Array.isArray(value)) return []
  const lines: string[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return []
    const { name, value: headerValue } = entry as Record<string, unknown>
    if (typeof name !== 'string' || typeof headerValue !== 'string') return []
    lines.push(`${name}: ${headerValue}`)
  }
  const parsed = parseRemoteHeaders(lines.join('\n'))
  return parsed.ok ? parsed.headers : []
}

/**
 * `ZENNOTES_REMOTE_HEADERS` for the MCP server and `zn`. Unset or blank means
 * no headers. A value that does not parse throws: running on without the
 * headers would only trade this message for the gateway's bare 403.
 */
export function remoteHeadersFromEnv(env: Record<string, string | undefined>): RemoteHeader[] {
  const raw = env[REMOTE_HEADERS_ENV]
  if (!raw || !raw.trim()) return []
  // A JSON env block can only carry a line break as the two characters `\n`
  // when the client passes the string through unescaped.
  const parsed = parseRemoteHeaders(raw.replace(/\\n/g, '\n'))
  if (!parsed.ok) throw new Error(`${REMOTE_HEADERS_ENV}: ${parsed.error}`)
  return parsed.headers
}

/** Add the headers to a request's set. They never replace one already there. */
export function applyRemoteHeaders(
  target: Headers,
  headers: readonly RemoteHeader[] | null | undefined
): void {
  for (const header of headers ?? []) {
    if (!target.has(header.name)) target.set(header.name, header.value)
  }
}
