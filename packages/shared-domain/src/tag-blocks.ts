/**
 * Block-level tag occurrences (#837). A note's tags stay a flat list on
 * `NoteMeta.tags`; this finds where each inline `#tag` sits and which block
 * carries it (a list item, a paragraph, a heading's section, a quote, a table
 * row), so the Tags view can list the idea itself under its note and jump to
 * its line.
 *
 * Tags are read exactly as `extractTags` reads them (the same frontmatter cut,
 * the same `stripCodeContent` mask, the same pattern), so a block is listed
 * for a tag only when the note-level scan counted that tag from that line.
 * Frontmatter tags tag the whole note and produce no block.
 *
 * Block structure is read from the lines markdown owns (`scanMarkdownLines`:
 * outside frontmatter and fenced code), so a fence inside a list item stays
 * part of the item and a `#` line inside a fence is never a heading.
 */
import { trailingBlockIdRange } from './block-anchors'
import { FRONTMATTER_BLOCK_RE } from './frontmatter'
import { FENCE_OPEN_RE, frontmatterEndIndex, scanMarkdownLines } from './markdown-lines'
import { INLINE_TAG_RE, stripCodeContent } from './tag-scan'

export type TagBlockKind = 'heading' | 'list-item' | 'paragraph' | 'quote' | 'table-row'

export interface TagBlock {
  kind: TagBlockKind
  /** 0-based first line of the block in the whole body, frontmatter counted.
   *  This is the line a jump lands on. */
  startLine: number
  /** 0-based last line of the block, inclusive. A heading's block runs to the
   *  next heading at the same or a higher level. */
  endLine: number
  /** The inline tags on the block's own lines, as written, first seen first.
   *  A nested list item or a paragraph inside a heading's section is a block
   *  of its own and keeps its own tags. */
  tags: string[]
  /** The block as readable text: markers stripped, blank lines and code
   *  dropped, capped at a few lines. */
  text: string
}

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]|$)/
const LIST_MARKER_RE = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE_RE = /^[ \t]{0,3}>/
const TABLE_ROW_RE = /^[ \t]*\|/

const MAX_TEXT_LINES = 6
const MAX_TEXT_CHARS = 400

/** Every block in `body` that carries an inline tag, in document order. */
export function extractTagBlocks(body: string): TagBlock[] {
  if (!body.includes('#')) return []
  // CRLF bodies: drop the CR so every line rule below sees the same text an LF
  // body would. Only a CR before LF goes, so line numbers do not move.
  const text = body.includes('\r') ? body.replace(/\r(?=\n)/g, '') : body

  const tagLines = inlineTagLines(text)
  if (tagLines.size === 0) return []

  const lines = text.split('\n')
  const owned = new Array<boolean>(lines.length).fill(false)
  for (const { line } of scanMarkdownLines(text)) owned[line - 1] = true
  const ctx: LineContext = { lines, owned, frontmatterEnd: frontmatterEndIndex(lines) }

  const byStart = new Map<number, { kind: TagBlockKind; end: number; tags: string[] }>()
  for (const [lineIndex, tags] of tagLines) {
    const { kind, start, end } = blockAt(ctx, lineIndex)
    const existing = byStart.get(start)
    if (existing) {
      for (const tag of tags) if (!existing.tags.includes(tag)) existing.tags.push(tag)
    } else {
      byStart.set(start, { kind, end, tags: [...tags] })
    }
  }

  return [...byStart.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, block]) => ({
      kind: block.kind,
      startLine: start,
      endLine: block.end,
      tags: block.tags,
      text: blockText(ctx, block.kind, start, block.end)
    }))
}

/**
 * The 0-based char offset a jump to a block should land on: the start of the
 * line plus its indentation, quote and list markers, task box and heading
 * hashes, so the caret sits on the block's first word. Clamped to the body.
 */
export function tagBlockJumpOffset(body: string, line: number): number {
  const lines = body.split('\n')
  const target = Math.max(0, Math.min(line, lines.length - 1))
  let offset = 0
  for (let i = 0; i < target; i++) offset += (lines[i] as string).length + 1
  const lineText = lines[target] ?? ''
  const marker = /^[ \t]*(?:>[ \t]?)*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX>/-]\][ \t]*)?|#{1,6}[ \t]+)?/.exec(lineText)
  return offset + (marker ? marker[0].length : 0)
}

interface LineContext {
  lines: string[]
  owned: boolean[]
  /** Index of the frontmatter's closing fence, or -1. */
  frontmatterEnd: number
}

/** Line index (whole body) → the inline tags on that line, scanned the way
 *  `extractTags` scans them. */
function inlineTagLines(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>()
  const frontmatter = FRONTMATTER_BLOCK_RE.exec(text)
  const markdownBody = frontmatter ? text.slice(frontmatter[0].length) : text
  // The frontmatter cut removes whole lines, so lines below it shift by the
  // number of newlines it swallowed.
  const shift = frontmatter ? countNewlines(frontmatter[0]) : 0
  if (!markdownBody.includes('#')) return out
  const masked = stripCodeContent(markdownBody).split('\n')
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i] as string
    if (!line.includes('#')) continue
    const tags: string[] = []
    for (const m of line.matchAll(INLINE_TAG_RE)) {
      const tag = m[1] as string
      if (!tags.includes(tag)) tags.push(tag)
    }
    if (tags.length > 0) out.set(i + shift, tags)
  }
  return out
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

function blockAt(
  ctx: LineContext,
  index: number
): { kind: TagBlockKind; start: number; end: number } {
  const { lines, owned } = ctx
  // A line the structure walk does not own (a fence variant only the tag mask
  // disagrees about) is still a counted tag: list it as its own line.
  if (!owned[index]) return { kind: 'paragraph', start: index, end: index }
  const line = lines[index] as string

  const level = headingLevel(ctx, index)
  if (level > 0) return { kind: 'heading', start: index, end: sectionEnd(ctx, index, level) }

  if (QUOTE_RE.test(line)) {
    let start = index
    while (start - 1 > ctx.frontmatterEnd && owned[start - 1] && QUOTE_RE.test(lines[start - 1] as string)) start--
    let end = index
    while (end + 1 < lines.length && owned[end + 1] && QUOTE_RE.test(lines[end + 1] as string)) end++
    return { kind: 'quote', start, end }
  }

  const item = owningListItem(ctx, index)
  if (item >= 0) return { kind: 'list-item', start: item, end: listItemEnd(ctx, item) }

  if (TABLE_ROW_RE.test(line)) return { kind: 'table-row', start: index, end: index }

  let start = index
  while (start - 1 > ctx.frontmatterEnd && isParagraphLine(ctx, start - 1)) start--
  let end = index
  while (end + 1 < lines.length && isParagraphLine(ctx, end + 1)) end++
  return { kind: 'paragraph', start, end }
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function indentOf(line: string): number {
  let width = 0
  for (const ch of line) {
    if (ch === ' ') width++
    else if (ch === '\t') width += 4 - (width % 4)
    else break
  }
  return width
}

function headingLevel(ctx: LineContext, index: number): number {
  if (!ctx.owned[index]) return 0
  const m = HEADING_RE.exec(ctx.lines[index] as string)
  return m ? (m[1] as string).length : 0
}

function isThematicBreak(line: string): boolean {
  return THEMATIC_BREAK_RE.test(line)
}

function isListMarker(ctx: LineContext, index: number): boolean {
  const line = ctx.lines[index] as string
  return ctx.owned[index] === true && LIST_MARKER_RE.test(line) && !isThematicBreak(line)
}

function isParagraphLine(ctx: LineContext, index: number): boolean {
  const line = ctx.lines[index] as string
  return (
    ctx.owned[index] === true &&
    !isBlank(line) &&
    headingLevel(ctx, index) === 0 &&
    !isThematicBreak(line) &&
    !isListMarker(ctx, index) &&
    !QUOTE_RE.test(line) &&
    !TABLE_ROW_RE.test(line)
  )
}

/** A heading's section: down to the line before the next heading at the same
 *  or a higher level, trailing blank lines left out. */
function sectionEnd(ctx: LineContext, start: number, level: number): number {
  let end = start
  for (let i = start + 1; i < ctx.lines.length; i++) {
    const next = headingLevel(ctx, i)
    if (next > 0 && next <= level) break
    end = i
  }
  while (end > start && isBlank(ctx.lines[end] as string)) end--
  return end
}

/**
 * The list item whose content includes line `index`, as the index of the
 * item's marker line, or -1 when the line is not inside a list. A line belongs
 * to the nearest marker above it that is less indented than every non-blank
 * line in between, or to the marker it continues without a blank line (a lazy
 * continuation). A column-0 line of other text after a blank line, a heading,
 * or a thematic break closes the search.
 */
function owningListItem(ctx: LineContext, index: number): number {
  if (isListMarker(ctx, index)) return index
  const { lines, owned } = ctx
  let minIndent = indentOf(lines[index] as string)
  let sawBlank = false
  for (let j = index - 1; j > ctx.frontmatterEnd; j--) {
    const line = lines[j] as string
    if (isBlank(line)) {
      sawBlank = true
      continue
    }
    if (owned[j]) {
      if (headingLevel(ctx, j) > 0 || isThematicBreak(line)) return -1
      if (isListMarker(ctx, j)) {
        const markerIndent = indentOf(line)
        if (minIndent > markerIndent || !sawBlank) return j
        // A sibling item at this depth: only a shallower item can still hold
        // the line.
        if (markerIndent === 0) return -1
        minIndent = Math.min(minIndent, markerIndent)
        continue
      }
    }
    minIndent = Math.min(minIndent, indentOf(line))
    if (minIndent === 0 && sawBlank) return -1
  }
  return -1
}

/** Where a list item ends: the last line indented under it (children, wrapped
 *  text, loose paragraphs, fenced code), or a lazy continuation of its text. */
function listItemEnd(ctx: LineContext, start: number): number {
  const { lines, owned } = ctx
  const indent = indentOf(lines[start] as string)
  let end = start
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string
    if (isBlank(line)) continue
    if (indentOf(line) > indent) {
      end = i
      continue
    }
    const lazy =
      i === end + 1 &&
      owned[i] === true &&
      owned[end] === true &&
      isParagraphLine(ctx, i) &&
      !isBlank(lines[end] as string)
    if (lazy) {
      end = i
      continue
    }
    break
  }
  return end
}

/** The readable text of a block, for listing it. Code lines are dropped: the
 *  idea is the prose around them. */
function blockText(ctx: LineContext, kind: TagBlockKind, start: number, end: number): string {
  const out: string[] = []
  let chars = 0
  let truncated = false
  for (let i = start; i <= end; i++) {
    if (!ctx.owned[i]) continue
    const raw = ctx.lines[i] as string
    if (FENCE_OPEN_RE.test(raw)) continue
    const clean = displayLine(raw, kind === 'heading' && i === start)
    if (!clean) continue
    if (out.length === MAX_TEXT_LINES || chars + clean.length > MAX_TEXT_CHARS) {
      const room = MAX_TEXT_CHARS - chars
      if (out.length < MAX_TEXT_LINES && room > 20) out.push(clean.slice(0, room).trimEnd())
      truncated = true
      break
    }
    out.push(clean)
    chars += clean.length
  }
  if (truncated && out.length > 0) out[out.length - 1] = `${out[out.length - 1]}…`
  return out.join('\n')
}

function displayLine(raw: string, isHeadingLine: boolean): string {
  let line = raw
  const anchor = trailingBlockIdRange(line)
  if (anchor) line = line.slice(0, anchor.from)
  if (isHeadingLine) {
    line = line.replace(/^ {0,3}#{1,6}[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '')
  } else if (TABLE_ROW_RE.test(line)) {
    line = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(' · ')
  } else {
    line = line
      .replace(/^[ \t]*(?:>[ \t]?)+/, '')
      .replace(/^\[![^\]]+\][+-]?[ \t]*/, '')
      .replace(/^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/, '')
      .replace(/^\[[ xX>/-]\][ \t]+/, '')
      .replace(/^ {0,3}#{1,6}[ \t]+/, '')
  }
  return line.trim()
}
