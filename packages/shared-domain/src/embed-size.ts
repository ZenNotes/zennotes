/**
 * Obsidian-style embed size hints and image embeds, shared by every surface
 * that has to understand `![[chart.png|600]]`: the editor and preview in
 * app-core, and the desktop main process for the Word export. One copy, so
 * an export can never disagree with the editor about what `|600x400` means.
 */

export interface EmbedSize {
  width: number
  height?: number
}

/** `600` or `600x400`. A zero dimension is not a resize: an invalid hint stays
 *  a caption instead of distorting the image. */
const SIZE_HINT_RE = /^(\d+)(?:x(\d+))?$/

export function parseEmbedSizeHint(hint: string | null | undefined): EmbedSize | null {
  if (!hint) return null
  const m = hint.trim().match(SIZE_HINT_RE)
  if (!m) return null
  const width = Number(m[1])
  const height = m[2] ? Number(m[2]) : undefined
  if (width < 1 || (height !== undefined && height < 1)) return null
  return { width, height }
}

/** Split an embed label into its caption and a trailing size hint, covering
 *  every Obsidian spelling: `caption|600` (from `![caption|600](img)` alt
 *  text or `![[img|caption|600]]`), and plain captions with no hint. Pipes
 *  inside the caption survive; only a LAST segment that parses as a size is
 *  consumed. The whole-label form (`600x400` from `![[img|600x400]]`) is a
 *  hint only for `source: 'wikilink'`: in standard markdown the alt is the
 *  author's caption, so `![2024](chart.png)` keeps its numeric alt instead
 *  of being resized to 2024px (write `![|2024](chart.png)` to size). (#570) */
export function splitEmbedLabel(
  label: string | null | undefined,
  source: 'wikilink' | 'markdown'
): { alt: string; size: EmbedSize | null } {
  const raw = (label ?? '').trim()
  if (!raw) return { alt: '', size: null }
  if (source === 'wikilink') {
    const wholeSize = parseEmbedSizeHint(raw)
    if (wholeSize) return { alt: '', size: wholeSize }
  }
  const pipeAt = raw.lastIndexOf('|')
  if (pipeAt < 0) return { alt: raw, size: null }
  const size = parseEmbedSizeHint(raw.slice(pipeAt + 1))
  if (!size) return { alt: raw, size: null }
  return { alt: raw.slice(0, pipeAt).trim(), size }
}

const STANDALONE_WIKILINK_EMBED_LINE_RE = /^(\s*)!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\](\s*)$/
const STANDALONE_MARKDOWN_IMAGE_LINE_RE = /^(\s*)!\[([^\]]*)\](\(.*\))(\s*)$/

/**
 * Rewrite the size hint of a standalone image line (`![[pic.png|300]]`,
 * `![alt|300](pic.png "title")`, or either form without a hint) to `width`,
 * or strip it when `width` is null. The caption survives, the target and any
 * markdown title are copied verbatim, and a `WxH` hint is replaced by the
 * bare width so a resized picture keeps its aspect ratio instead of being
 * distorted into the old height. An empty markdown alt keeps the leading pipe
 * (`![|320](pic.png)`) because a lone number there is a caption (#570).
 * Returns null when the line is not a standalone image embed. This is how the
 * editor's drag handle and the Resize Image command write a size back into
 * the note (#684): as the hint every surface already reads, never as private
 * state.
 */
export function withEmbedWidth(lineText: string, width: number | null): string | null {
  if (width !== null && (!Number.isInteger(width) || width < 1)) return null
  const wiki = lineText.match(STANDALONE_WIKILINK_EMBED_LINE_RE)
  if (wiki) {
    const [, lead, target, label, trail] = wiki
    if (!isImageEmbedTarget(target)) return null
    const { alt } = splitEmbedLabel(label, 'wikilink')
    const parts = [alt, width === null ? '' : String(width)].filter(Boolean)
    const suffix = parts.length ? `|${parts.join('|')}` : ''
    return `${lead}![[${target}${suffix}]]${trail}`
  }
  const md = lineText.match(STANDALONE_MARKDOWN_IMAGE_LINE_RE)
  if (md) {
    const [, lead, rawAlt, rest, trail] = md
    const { alt } = splitEmbedLabel(rawAlt, 'markdown')
    const altText = width === null ? alt : `${alt}|${width}`
    return `${lead}![${altText}]${rest}${trail}`
  }
  return null
}

/** The width of the size hint on a standalone image line, or null when the
 *  line is not one or carries no hint. Seeds the Resize Image prompt. */
export function readEmbedWidth(lineText: string): number | null {
  const wiki = lineText.match(STANDALONE_WIKILINK_EMBED_LINE_RE)
  if (wiki) {
    if (!isImageEmbedTarget(wiki[2])) return null
    return splitEmbedLabel(wiki[3], 'wikilink').size?.width ?? null
  }
  const md = lineText.match(STANDALONE_MARKDOWN_IMAGE_LINE_RE)
  if (md) return splitEmbedLabel(md[2], 'markdown').size?.width ?? null
  return null
}

/** Extensions an `![[…]]` embed may point at and still mean "a picture". */
export const IMAGE_EMBED_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'avif',
  'apng'
])

export function isImageEmbedTarget(target: string): boolean {
  const clean = target.trim().split('#')[0]
  const dot = clean.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EMBED_EXTENSIONS.has(clean.slice(dot + 1).toLowerCase())
}

const WIKILINK_IMAGE_RE = /!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/

/**
 * Rewrite `![[chart.png|caption|600]]` embeds into the standard markdown the
 * remark pipelines understand: `![caption|600](chart.png)`. The label keeps
 * its size hint, so a consumer reads it back with `splitEmbedLabel(alt,
 * 'markdown')`. Note embeds (`![[Some note]]`) and anything inside a fenced
 * code block are left alone.
 */
export function rewriteWikilinkImageEmbeds(markdown: string): string {
  const lines = markdown.split('\n')
  let fence: string | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const fenceMatch = line.match(FENCE_RE)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (fence || !line.includes('![[')) continue
    lines[i] = line.replace(WIKILINK_IMAGE_RE, (whole, target: string, label?: string) => {
      if (!isImageEmbedTarget(target)) return whole
      const { alt, size } = splitEmbedLabel(label, 'wikilink')
      const sizeText = size ? (size.height ? `${size.width}x${size.height}` : String(size.width)) : ''
      // A bare size keeps its leading pipe (`![|320](x)`): in markdown alt
      // text a lone number is a caption, not a size (#570).
      const altText = sizeText ? `${alt}|${sizeText}` : alt
      const href = target.trim()
      const safeHref = /[\s()]/.test(href) ? `<${href}>` : href
      return `![${altText}](${safeHref})`
    })
  }
  return lines.join('\n')
}
