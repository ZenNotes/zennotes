/**
 * Decode a `data:` URL without `fetch()`. A self-hosted server's CSP limits
 * `connect-src` to its own host (server 2.83.1), and `fetch` on a `data:` URL
 * counts as a connection there, so the web client cannot read one that way.
 */
export function dataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(',')
  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  if (!meta.endsWith(';base64')) return new TextEncoder().encode(decodeURIComponent(payload))
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The MIME type a `data:` URL declares, or `fallback` when it names none. */
export function dataUrlMimeType(dataUrl: string, fallback = 'text/plain'): string {
  const match = /^data:([^;,]+)/i.exec(dataUrl)
  return match ? match[1].toLowerCase() : fallback
}
