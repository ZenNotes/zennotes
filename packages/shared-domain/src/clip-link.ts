// The `zennotes://new` and `zennotes://daily` links: how the web clipper (a
// separate repo, ZenNotes/web-clipper) and any other automation hands a note
// to the app. The extension turns a page into Markdown, puts the note on the
// clipboard and opens one of these links; the app writes the file. The
// contract is normative in docs/web-clipper-link.md, and the cases in
// docs/web-clipper-link.fixtures.json are what every implementation (this
// parser, the extension's builder, the phones) is tested against.
//
// Any web page can fire a zennotes:// link, so everything here is untrusted:
// - there is no overwrite, only create, append and prepend;
// - the clipboard is never read blind. A link names the SHA-256 of the text it
//   put there, and the app files the clipboard only when the hashes match, so
//   a page cannot make the app file whatever was copied last (a password);
// - a location is a folder inside the notes area, never a path that climbs
//   out of it, names a hidden folder, or carries characters Windows refuses
//   (vaults sync between systems);
// - each parameter appears at most once, so two readers can never disagree
//   about which `file` a link meant.
//
// The query is decoded by hand, not with URLSearchParams: that API reads `+`
// as a space, and a clipped note is full of literal plus signs. Encoders
// percent-encode everything but RFC 3986's unreserved characters.
//
// Pure and browser-safe: desktop main and the phone shells import it.

export const CLIP_LINK_SCHEME = 'zennotes'

/** Longest link accepted, in UTF-16 code units. A `content=` body is capped
 *  well below this; the rest is room for the other parameters' encoding. */
export const MAX_CLIP_LINK_CHARS = 131_072

/** Most note text a link may carry inline, in UTF-8 bytes. Longer clips go
 *  through the clipboard: Windows and Linux hand a link to the app on its
 *  command line, which tops out near 32K characters. */
export const MAX_CLIP_CONTENT_BYTES = 32_768

/** Most note text the app files from the clipboard, in UTF-8 bytes. */
export const MAX_CLIP_NOTE_BYTES = 8 * 1024 * 1024

/** Longest `vault` name and `file` value accepted, in UTF-16 code units. */
export const MAX_CLIP_VAULT_CHARS = 256
export const MAX_CLIP_FILE_CHARS = 1024

export type ClipLinkBody = { clipboard: string } | { content: string }

export interface ClipLinkNew {
  action: 'new'
  /** Vault display name or folder name; null means the open vault. */
  vault: string | null
  /** Folder inside the notes area, `/`-separated; '' is its top level. */
  folder: string
  /** Note name without `.md`, unsanitized; null when the link names no file
   *  (the app names the note from its first line, as Quick Capture does). */
  name: string | null
  /** Null for a bare `zennotes://new`: a blank note, or an empty one at
   *  `file`. */
  body: ClipLinkBody | null
  position: 'create' | 'append' | 'prepend'
  silent: boolean
}

export interface ClipLinkDaily {
  action: 'daily'
  vault: string | null
  /** Null opens today's daily note (creating it if missing) and adds nothing. */
  body: ClipLinkBody | null
  position: 'append' | 'prepend'
  silent: boolean
}

export type ClipLinkRequest = ClipLinkNew | ClipLinkDaily

/** Why a link that is ours was refused. Stable codes: the fixtures name them
 *  and the app maps them to one sentence each. */
export type ClipLinkRejection =
  | 'link-too-long'
  | 'bad-encoding'
  | 'duplicate-param'
  | 'bad-vault'
  | 'bad-file'
  | 'bad-hash'
  | 'two-bodies'
  | 'empty-body'
  | 'content-too-long'
  | 'append-and-prepend'
  | 'missing-file'
  | 'nothing-to-insert'

export type ClipLinkParse =
  | { ok: true; request: ClipLinkRequest }
  | { ok: false; reason: ClipLinkRejection }

const KNOWN_PARAMS = new Set(['vault', 'file', 'clipboard', 'content', 'append', 'prepend', 'silent'])

/** Characters no folder segment may hold: Windows refuses them in file
 *  names, and a vault that syncs to Windows would fail there. */
const FORBIDDEN_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/u

/**
 * Parse a `zennotes://new` or `zennotes://daily` link. Returns null for any
 * other link (another action, another scheme, not a URL), so the caller can
 * hand it to the next parser; a link that is ours but malformed comes back
 * with the reason it was refused. A `new` with no file and no body is the
 * blank-note link the phone widgets already fire.
 */
export function parseClipLink(rawUrl: string): ClipLinkParse | null {
  const trimmed = rawUrl.trim()
  const match = /^zennotes:(?:\/\/)?\/*(new|daily)\/?(?:\?([^#]*))?(?:#.*)?$/iu.exec(trimmed)
  if (!match) return null
  const action = match[1].toLowerCase() as 'new' | 'daily'
  if (trimmed.length > MAX_CLIP_LINK_CHARS) return reject('link-too-long')

  const params = new Map<string, string>()
  for (const pair of (match[2] ?? '').split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    let key: string
    let value: string
    try {
      key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq))
      value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1))
    } catch {
      return reject('bad-encoding')
    }
    // Unknown parameters are ignored so a newer clipper can add some without
    // an older app refusing its links.
    if (!KNOWN_PARAMS.has(key)) continue
    if (params.has(key)) return reject('duplicate-param')
    params.set(key, value)
  }

  const vault = parseVault(params.get('vault'))
  if (vault === false) return reject('bad-vault')

  const body = parseBody(params)
  if (typeof body === 'string') return reject(body)

  const append = flag(params, 'append')
  const prepend = flag(params, 'prepend')
  if (append && prepend) return reject('append-and-prepend')
  const silent = flag(params, 'silent')

  if (action === 'daily') {
    return {
      ok: true,
      request: { action, vault, body, position: prepend ? 'prepend' : 'append', silent }
    }
  }

  const file = params.get('file')
  let folder = ''
  let name: string | null = null
  if (file !== undefined && file.trim() !== '') {
    const parsed = parseFile(file)
    if (!parsed) return reject('bad-file')
    folder = parsed.folder
    name = parsed.name
  }

  const position = append ? 'append' : prepend ? 'prepend' : 'create'
  if (position !== 'create') {
    if (name === null) return reject('missing-file')
    if (body === null) return reject('nothing-to-insert')
  }
  return { ok: true, request: { action, vault, folder, name, body, position, silent } }
}

function reject(reason: ClipLinkRejection): ClipLinkParse {
  return { ok: false, reason }
}

/** A bare flag (`&silent`) or `=true`/`=1` turns it on; `=false`/`=0` off. */
function flag(params: Map<string, string>, key: string): boolean {
  if (!params.has(key)) return false
  const value = params.get(key)!.trim().toLowerCase()
  return value !== 'false' && value !== '0'
}

function parseVault(raw: string | undefined): string | null | false {
  if (raw === undefined) return null
  const name = raw.trim()
  if (!name) return null
  if (name.length > MAX_CLIP_VAULT_CHARS || /[\u0000-\u001f\u007f]/u.test(name)) return false
  return name
}

function parseBody(params: Map<string, string>): ClipLinkBody | null | ClipLinkRejection {
  const hasClipboard = params.has('clipboard')
  const hasContent = params.has('content')
  if (hasClipboard && hasContent) return 'two-bodies'
  if (hasClipboard) {
    const hash = params.get('clipboard')!.trim().toLowerCase()
    return /^[0-9a-f]{64}$/u.test(hash) ? { clipboard: hash } : 'bad-hash'
  }
  if (hasContent) {
    const text = params.get('content')!
    if (text === '') return 'empty-body'
    if (utf8Length(text) > MAX_CLIP_CONTENT_BYTES) return 'content-too-long'
    return { content: text }
  }
  return null
}

/** Split `Folder/Sub/Name` into a validated folder and a note name. The name
 *  keeps characters the app's title sanitizer will replace; only what can
 *  never name a note in this place is refused here. */
function parseFile(raw: string): { folder: string; name: string } | null {
  if (raw.length > MAX_CLIP_FILE_CHARS || raw.includes('\0')) return null
  const slashPath = raw.replace(/\\/gu, '/')
  if (slashPath.trimStart().startsWith('/')) return null
  const segments = slashPath.split('/').map((segment) => segment.trim())
  let name = segments.pop() ?? ''
  name = name.replace(/\.md$/iu, '').trim()
  if (!name || name.startsWith('.') || /[\u0000-\u001f\u007f]/u.test(name)) return null
  const folderParts: string[] = []
  for (const [index, segment] of segments.entries()) {
    if (!segment) continue
    if (segment.startsWith('.')) return null
    if (index === 0 && /^[a-z]:$/iu.test(segment)) return null
    if (FORBIDDEN_SEGMENT_CHARS.test(segment)) return null
    folderParts.push(segment)
  }
  return { folder: folderParts.join('/'), name }
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`: what a link's
 *  `clipboard=` names and what the app compares the clipboard against. */
export async function clipTextSha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * The note text to file when the clipboard holds `clipboardText` and the link
 * named `sha256`, or null when they do not match. The bytes the extension
 * hashed are what normally come back. Windows is the exception: a browser
 * there can store the text with CRLF line endings, which the extension never
 * hashed, so the text with CRLF turned back into LF is accepted too, and that
 * is the text filed. Either way the clipboard is only filed when it holds
 * what the link vouched for.
 */
export async function verifiedClipboardText(clipboardText: string, sha256: string): Promise<string | null> {
  if (!clipboardText) return null
  if ((await clipTextSha256Hex(clipboardText)) === sha256) return clipboardText
  if (!clipboardText.includes('\r\n')) return null
  const lf = clipboardText.replace(/\r\n/gu, '\n')
  return (await clipTextSha256Hex(lf)) === sha256 ? lf : null
}

/** Percent-encode everything except RFC 3986's unreserved characters, which
 *  is stricter than encodeURIComponent (that one leaves `!'()*` bare). */
export function encodeClipLinkValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/**
 * The canonical link for a request: parameters in the order `vault`, `file`,
 * body, position, `silent`; flags bare; values encoded by
 * encodeClipLinkValue. The fixtures marked canonical are exactly this output,
 * which is how the extension's builder proves it writes the same links.
 */
export function buildClipLink(request: ClipLinkRequest): string {
  const parts: string[] = []
  if (request.vault) parts.push(`vault=${encodeClipLinkValue(request.vault)}`)
  if (request.action === 'new' && request.name !== null) {
    const file = request.folder ? `${request.folder}/${request.name}` : request.name
    parts.push(`file=${encodeClipLinkValue(file)}`)
  }
  if (request.body) {
    parts.push(
      'clipboard' in request.body
        ? `clipboard=${request.body.clipboard}`
        : `content=${encodeClipLinkValue(request.body.content)}`
    )
  }
  // A daily link with nothing to add only opens the note, so its position
  // would mean nothing; a `new` that creates says nothing either.
  if (request.body || request.action === 'new') {
    if (request.position === 'append') parts.push('append')
    if (request.position === 'prepend') parts.push('prepend')
  }
  if (request.silent) parts.push('silent')
  const query = parts.length ? `?${parts.join('&')}` : ''
  return `${CLIP_LINK_SCHEME}://${request.action}${query}`
}
