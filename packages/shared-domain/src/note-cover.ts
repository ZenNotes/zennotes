// A note's cover image: the wide banner across the top of the note, kept in
// its own frontmatter so the file stays the whole truth.
//
// The keys are the ones Obsidian's banner plugins already read (Banners,
// Pixel Banner, Banners Reloaded, Banner Images), so a vault shared with one
// of them shows the same banner there:
//
//   banner: "![[assets/lisbon.jpg]]"
//   banner_y: 0.35
//
// `banner` holds an embed of a vault image or an https URL. `banner_y` is
// the vertical focal point from 0 (top edge) to 1 (bottom edge), the Banners
// plugin's scale; the percentages Banners Reloaded writes ("75%") and Pixel
// Banner's 0..100 read the same. A note whose author used `cover:` (Hugo,
// Hashnode, Obsidian card views) shows that image too, and edits keep writing
// to the key the note already uses.
//
// The image is written as an embed, `![[...]]`, on purpose. Every host's note
// index (desktop main, the Go server, the phone shells) already lists a
// note's `![[...]]` targets as the assets it uses, frontmatter included: that
// list is what keeps the Assets view from calling a cover image unused (and
// offering to delete it), what a published note uploads, and what picks the
// notes the asset-rename rewriter (asset-link-rename.ts and its Go port)
// rewrites, so a cover follows its file through a rename or a move. A plain
// `[[...]]` link would get none of that. Reading accepts both.
import { FRONTMATTER_BLOCK_RE, unquote, updateFrontmatterFields } from './frontmatter'

export type NoteCoverKey = 'banner' | 'cover'

/** Read in this order: the first key that holds a usable image wins. */
export const NOTE_COVER_KEYS: readonly NoteCoverKey[] = ['banner', 'cover']

/** Where the focal point sits when a note does not say. */
export const NOTE_COVER_DEFAULT_Y = 0.5

export type NoteCoverTarget = { kind: 'vault'; href: string } | { kind: 'url'; url: string }

export interface NoteCover {
  /** The frontmatter key holding the image. */
  key: NoteCoverKey
  target: NoteCoverTarget
  /** Vertical focal point, 0 (top) to 1 (bottom). */
  y: number
}

/** Top-level `key: value` lines of the leading frontmatter block, keys
 *  lower-cased. Indented lines (list items, nested maps) are not keys. */
function topLevelFields(body: string): Map<string, string> {
  const fields = new Map<string, string>()
  const block = FRONTMATTER_BLOCK_RE.exec(body)?.[1]
  if (block == null) return fields
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_][\w-]*)\s*:\s*(.*)$/)
    if (kv && !fields.has(kv[1].toLowerCase())) fields.set(kv[1].toLowerCase(), kv[2])
  }
  return fields
}

/** A YAML scalar's text. A double-quoted one is JSON-compatible the way
 *  `yamlValue` writes it, a single-quoted one doubles its quotes, and only an
 *  unquoted one can carry a trailing `# comment`. */
function scalarText(raw: string): string {
  const trimmed = raw.trim()
  const double = trimmed.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/)
  if (double) {
    try {
      const parsed: unknown = JSON.parse(double[1])
      if (typeof parsed === 'string') return parsed.trim()
    } catch {
      return double[1].slice(1, -1).trim()
    }
  }
  const single = trimmed.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/)
  if (single) return single[1].replace(/''/g, "'").trim()
  return unquote(trimmed.replace(/\s+#.*$/, ''))
}

/**
 * What a cover value points at, in any of the shapes the banner plugins
 * accept: `[[file]]` or `![[file]]` (an alias or size after `|` is dropped),
 * a markdown image or link, `<path>`, a bare path, or an http(s) URL.
 */
export function parseNoteCoverTarget(value: string): NoteCoverTarget | null {
  let text = value.trim()
  if (!text) return null
  const wikilink = text.match(/^!?\[\[([^\]]+)\]\]$/)
  if (wikilink) {
    text = wikilink[1].split('|')[0].trim()
  } else {
    const markdown = text.match(/^!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'(][^)]*)?\s*\)$/)
    if (markdown) text = markdown[1]
  }
  if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1).trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) return { kind: 'url', url: text }
  // Any other scheme (file:, data:, app links) is not an image the vault or
  // the web can hand over.
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(text)) return null
  return { kind: 'vault', href: text }
}

/** A focal point as written: 0..1, a percentage, or Pixel Banner's 0..100. */
export function parseNoteCoverY(value: string | undefined): number {
  if (value == null) return NOTE_COVER_DEFAULT_Y
  const text = scalarText(value)
  const percent = text.endsWith('%')
  const n = Number(percent ? text.slice(0, -1) : text)
  if (!Number.isFinite(n) || text === '') return NOTE_COVER_DEFAULT_Y
  const ratio = percent || n > 1 ? n / 100 : n
  return clampNoteCoverY(ratio)
}

export function clampNoteCoverY(y: number): number {
  if (!Number.isFinite(y)) return NOTE_COVER_DEFAULT_Y
  return Math.min(1, Math.max(0, y))
}

/** The note's cover, or null when its frontmatter names none. */
export function readNoteCover(body: string): NoteCover | null {
  const fields = topLevelFields(body)
  for (const key of NOTE_COVER_KEYS) {
    const raw = fields.get(key)
    if (raw == null) continue
    const target = parseNoteCoverTarget(scalarText(raw))
    if (!target) continue
    return { key, target, y: parseNoteCoverY(fields.get(`${key}_y`) ?? fields.get(`${key}-y`)) }
  }
  return null
}

/** The frontmatter value for a cover: an embed for a vault file (see the
 *  header for why not a plain link), the URL itself otherwise. */
export function noteCoverValue(target: NoteCoverTarget): string {
  return target.kind === 'url' ? target.url : `![[${target.href}]]`
}

/** Two decimals is a 1% step, finer than a drag or an arrow key moves it. */
export function formatNoteCoverY(y: number): string {
  return String(Math.round(clampNoteCoverY(y) * 100) / 100)
}

function coverKeyFor(body: string): NoteCoverKey {
  return readNoteCover(body)?.key ?? 'banner'
}

/** Drop a frontmatter block that the edit left with nothing in it, so a cover
 *  added to a note without frontmatter and then removed leaves the note as it
 *  was. */
function dropEmptyFrontmatter(body: string): string {
  const m = FRONTMATTER_BLOCK_RE.exec(body)
  if (!m || (m[1] ?? '').trim() !== '') return body
  return body.slice(m[0].length)
}

/**
 * Set the note's cover image, keeping every other frontmatter line as it was.
 * A new image starts at the default focal point: the old one's position was
 * chosen for a different picture.
 */
export function setNoteCover(body: string, target: NoteCoverTarget): string {
  const key = coverKeyFor(body)
  return updateFrontmatterFields(body, {
    [key]: noteCoverValue(target),
    [`${key}_y`]: null,
    [`${key}-y`]: null
  })
}

/** Move the focal point of the note's existing cover; no cover, no change. */
export function setNoteCoverPosition(body: string, y: number): string {
  const cover = readNoteCover(body)
  if (!cover) return body
  return updateFrontmatterFields(body, {
    [`${cover.key}-y`]: null,
    [`${cover.key}_y`]: formatNoteCoverY(y)
  })
}

/** Remove the cover and its position. */
export function removeNoteCover(body: string): string {
  const cover = readNoteCover(body)
  if (!cover) return body
  return dropEmptyFrontmatter(
    updateFrontmatterFields(body, {
      [cover.key]: null,
      [`${cover.key}_y`]: null,
      [`${cover.key}-y`]: null
    })
  )
}
