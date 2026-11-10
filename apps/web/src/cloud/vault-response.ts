/**
 * How the service worker answers `/_vault/<vaultKey>/<path>` (sw.ts), kept
 * apart from the worker's globals so vitest checks the headers and ranges.
 */

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  md: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8'
}

/** Media a browser renders without running anything from the file. */
const PASSIVE_PREFIXES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'audio/', 'video/']

export function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf('.')
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  // Anything not listed (an .html attachment included) is served as bytes to
  // download, never as a document on this origin.
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * Headers every vault answer carries. A vault file opened as a page (an SVG
 * or a PDF in its own tab, a PDF frame) must never run script with this
 * origin's access to the vault, so everything but passive media and PDFs is
 * sandboxed into an opaque origin. PDFs are left to the browser's viewer,
 * which a sandbox would refuse to load and which does not run a document's
 * script as the page's origin.
 */
export function vaultHeaders(type: string, size: number): Headers {
  const headers = new Headers({
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(size),
    'Cross-Origin-Resource-Policy': 'same-origin'
  })
  if (!PASSIVE_PREFIXES.some((prefix) => type.startsWith(prefix)) && type !== 'application/pdf') {
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:")
  }
  return headers
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` against `size`; null when unusable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, startText, endText] = match
  if (startText === '' && endText === '') return null
  let start: number
  let end: number
  if (startText === '') {
    const suffix = Number(endText)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(size - suffix, 0)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/** The answer for a vault file read from OPFS, or null when it is not there. */
export function vaultFileResponse(file: Blob | null, name: string, request: Pick<Request, 'method' | 'headers'>): Response {
  if (!file) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const type = contentTypeOf(name)
  const range = parseRange(request.headers.get('Range'), file.size)
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${file.size}`, 'Cache-Control': 'no-store' }
    })
  }
  if (range) {
    const headers = vaultHeaders(type, range.end - range.start + 1)
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
    const body = request.method === 'HEAD' ? null : file.slice(range.start, range.end + 1, type)
    return new Response(body, { status: 206, headers })
  }
  const body = request.method === 'HEAD' ? null : file
  return new Response(body, { status: 200, headers: vaultHeaders(type, file.size) })
}
