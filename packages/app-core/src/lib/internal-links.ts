/**
 * Standard-Markdown links to other notes — `[text](path/to/Note.md)` — should
 * navigate the same way `[[wikilinks]]` do (#201). Unlike a wikilink (resolved
 * by global note name), a Markdown link's href is a path resolved RELATIVE to
 * the note that contains it, exactly like Markdown / Obsidian's "Markdown
 * links" mode. This module holds the pure resolution so the editor (`gd`,
 * Cmd/Ctrl-click) and the rendered preview can all share it.
 */

export interface InternalNoteLink {
  /** Vault-relative path of the resolved note. */
  path: string
  /** A `#heading` anchor carried by the link, or null. */
  heading: string | null
}

interface NoteRef {
  path: string
  folder?: string
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function posixJoin(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  return a.endsWith('/') ? `${a}${b}` : `${a}/${b}`
}

function posixNormalize(input: string): string {
  const out: string[] = []
  for (const part of input.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0 || out[out.length - 1] === '..') out.push('..')
      else out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

const lc = (s: string): string => s.toLowerCase()

/** External / non-note targets we must leave to their existing handlers. */
function isExternalHref(href: string): boolean {
  return (
    href.startsWith('#') || // same-note anchor
    href.startsWith('//') || // protocol-relative URL
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href) // scheme: http:, mailto:, zen-asset:, …
  )
}

function matchNote(notes: NoteRef[], target: string): string | null {
  const visible = notes.filter((n) => n.folder !== 'trash')
  // Markdown links usually carry the `.md`; tolerate links that omit it.
  const candidates = /\.md$/i.test(target) ? [target] : [`${target}.md`, target]
  for (const cand of candidates) {
    const exact = visible.find((n) => lc(n.path) === lc(cand))
    if (exact) return exact.path
  }
  // Basename fallback for a single unambiguous match — tolerates a link
  // written before the note moved, mirroring wikilink path-suffix resolution.
  const wantBase = lc(candidates[0].split('/').pop() ?? '')
  if (!wantBase) return null
  const baseMatches = visible.filter((n) => lc(n.path.split('/').pop() ?? '') === wantBase)
  return baseMatches.length === 1 ? baseMatches[0].path : null
}

/**
 * Resolve a Markdown link href to an internal note, relative to `notePath`.
 * Returns null for external links, in-page anchors, assets, or no match.
 */
export function resolveInternalNoteHref(
  notePath: string | null | undefined,
  href: string,
  notes: NoteRef[]
): InternalNoteLink | null {
  if (!notePath) return null
  const raw = href.trim()
  if (!raw || isExternalHref(raw)) return null

  const hashIdx = raw.indexOf('#')
  const rawPath = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
  if (!rawPath) return null // pure "#heading" — same note, handled elsewhere
  const heading = hashIdx >= 0 ? decode(raw.slice(hashIdx + 1)).trim() || null : null

  const decoded = decode(rawPath)
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  let target = decoded.startsWith('/')
    ? decoded.replace(/^\/+/, '')
    : noteDir
      ? posixJoin(noteDir, decoded)
      : decoded
  target = posixNormalize(target)
  if (!target || target === '..' || target.startsWith('../')) return null

  const match = matchNote(notes, target)
  return match ? { path: match, heading } : null
}

function unwrapMdUrl(url: string): string {
  // Markdown wraps URLs containing spaces in angle brackets: `[x](<a b.pdf>)`.
  const trimmed = url.trim()
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1)
  return trimmed
}

const LOCAL_FILE_EXT_RE =
  /\.(md|markdown|txt|png|apng|avif|gif|jpe?g|svg|webp|pdf|mp3|m4a|aac|flac|ogg|wav|mp4|m4v|mov|ogv|webm|canvas|excalidraw)$/i

/**
 * A fully-qualified URL to open in the browser, or null. Handles explicit
 * `http(s)://` / `mailto:` / `tel:` links AND bare domains a user typed without
 * a scheme — e.g. `[site](google.com)` or `[docs](example.com/path)` — which
 * Markdown would otherwise treat as a dead relative link. Returns null for note
 * links, relative paths, in-page anchors, and local files. (#201)
 */
export function externalLinkUrl(href: string): string | null {
  const h = href.trim()
  if (!h) return null
  if (/^(https?:|mailto:|tel:)/i.test(h)) return h
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(h)) return null // another scheme — not ours
  if (h.startsWith('#') || h.startsWith('/') || h.startsWith('.') || h.startsWith('//')) return null
  // Bare domain heuristic: `host.tld` (one or more labels) optionally followed
  // by a /path, ?query, or #fragment — but not something that looks like a
  // local note/asset file.
  const host = h.split(/[/?#]/)[0] ?? ''
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return null
  if (LOCAL_FILE_EXT_RE.test(host)) return null
  return `https://${h}`
}

/**
 * The link target at a document offset — a `[[wikilink]]` name, a Markdown
 * link's URL, or a bare URL. Returns null when the offset isn't inside a link.
 */
export function extractLinkAtCursor(doc: string, pos: number): string | null {
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = doc.indexOf('\n', pos)
  const line = doc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
  const col = pos - lineStart
  const wikiRe = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = wikiRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return m[1]
  }
  // Angle-bracketed URLs can contain `)` so match them specifically first.
  const mdAngleRe = /\[([^\]]*)\]\(<([^>]+)>\)/g
  while ((m = mdAngleRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return m[2]
  }
  const mdRe = /\[([^\]]*)\]\(([^)]+)\)/g
  while ((m = mdRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return unwrapMdUrl(m[2])
  }
  const urlRe = /https?:\/\/[^\s)>\]]+/g
  while ((m = urlRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return m[0]
  }
  return null
}

/**
 * The Markdown link `[label](href)` covering a document offset, with its full
 * source range. Used to follow a *rendered* link on a plain click (when the
 * selection is outside the range) while still allowing edits when the cursor is
 * inside it — mirroring how `[[wikilinks]]` behave in the editor. (#201)
 */
export function markdownLinkAt(
  doc: string,
  pos: number
): { href: string; from: number; to: number } | null {
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = doc.indexOf('\n', pos)
  const line = doc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
  const col = pos - lineStart
  const angleRe = /\[[^\]]*\]\(<([^>]+)>\)/g
  let m: RegExpExecArray | null
  while ((m = angleRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) {
      return { href: m[1], from: lineStart + m.index, to: lineStart + m.index + m[0].length }
    }
  }
  const re = /\[[^\]]*\]\(([^)]+)\)/g
  while ((m = re.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) {
      return { href: unwrapMdUrl(m[1]), from: lineStart + m.index, to: lineStart + m.index + m[0].length }
    }
  }
  return null
}
