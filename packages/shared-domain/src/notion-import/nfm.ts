import type { NotionBlock, NotionRichText } from './types'
import { notionIdFromHref, plainText } from './types'

/**
 * Notion-flavored Markdown, the format Notion's hosted sign-in service answers
 * with, turned into the same block objects the REST API returns. Everything
 * downstream (rendering, paths, databases, the report) then has one input.
 *
 * It's CommonMark plus XML-style tags, and a tag's body is block content:
 * `<toggle>\nTitle\n\n- child\n</toggle>`. Code fences are literal, so every
 * scan for a closing tag has to step over them.
 */

export interface NfmContext {
  nextId(): string
  /** Stable `notion-file-block://` reference to its signed download link. */
  references?: Record<string, string>
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of source.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) {
    attrs[match[1]] = decodeEntities(match[2])
  }
  return attrs
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

interface Marks {
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  underline?: boolean
  code?: boolean
  href?: string | null
}

const INLINE_TAG = /^<(b|i|s|u|span)((?:\s+[\w-]+="[^"]*")*)\s*>/

function closingIndex(text: string, from: number, tag: string): number {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?(?<!/)>`, 'g')
  const close = `</${tag}>`
  let depth = 1
  let at = from
  for (;;) {
    const end = text.indexOf(close, at)
    if (end < 0) return -1
    open.lastIndex = at
    let nested = open.exec(text)
    while (nested && nested.index < end) {
      depth += 1
      nested = open.exec(text)
    }
    depth -= 1
    if (depth === 0) return end
    at = end + close.length
    // Opens before this close are counted; count from past it next time.
  }
}

function mentionFor(attrs: Record<string, string>, label: string): NotionRichText {
  const url = attrs.url ?? ''
  const base = { type: 'mention', plain_text: label || url, annotations: {} }
  if (url.startsWith('user://')) {
    return { ...base, plain_text: label ? `@${label}` : '', mention: { type: 'user', user: { id: url.slice(7) } } }
  }
  if (url.startsWith('collection://') || attrs.type === 'database') {
    const id = url.startsWith('collection://') ? url.slice(13) : (notionIdFromHref(url) ?? '')
    return { ...base, mention: { type: 'database', database: { id } } }
  }
  const pageId = notionIdFromHref(url)
  if (pageId) return { ...base, href: url, mention: { type: 'page', page: { id: pageId } } }
  return { ...base, mention: { type: 'link_preview', link_preview: { url } } }
}

function parseInlineInto(text: string, marks: Marks, out: NotionRichText[]): void {
  let buffer = ''
  const flush = (): void => {
    if (!buffer) return
    const content = buffer
    buffer = ''
    out.push({
      type: 'text',
      plain_text: content,
      href: marks.href ?? null,
      annotations: {
        bold: marks.bold,
        italic: marks.italic,
        strikethrough: marks.strikethrough,
        underline: marks.underline,
        code: marks.code
      },
      text: { content, link: marks.href ? { url: marks.href } : null }
    })
  }
  const nested = (inner: string, extra: Marks): void => {
    flush()
    parseInlineInto(inner, { ...marks, ...extra }, out)
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const rest = (): string => text.slice(i)

    if (ch === '\\' && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) {
      buffer += text[i + 1]
      i += 2
      continue
    }

    if (ch === '<') {
      const r = rest()
      const br = /^<br\s*\/?>/.exec(r)
      if (br) {
        buffer += '\n'
        i += br[0].length
        continue
      }
      // Notion writes inline code this way too, though its spec doesn't list
      // it. The body is literal: `<code>2>&1 <file></code>`.
      const code = /^<code>([\s\S]*?)<\/code>/.exec(r)
      if (code) {
        flush()
        const literal = decodeEntities(code[1])
        out.push({
          type: 'text',
          plain_text: literal,
          href: marks.href ?? null,
          annotations: { ...marks, code: true },
          text: { content: literal, link: marks.href ? { url: marks.href } : null }
        })
        i += code[0].length
        continue
      }
      const tag = INLINE_TAG.exec(r)
      if (tag) {
        const start = i + tag[0].length
        const end = closingIndex(text, start, tag[1])
        if (end >= 0) {
          const extra: Marks =
            tag[1] === 'b'
              ? { bold: true }
              : tag[1] === 'i'
                ? { italic: true }
                : tag[1] === 's'
                  ? { strikethrough: true }
                  : tag[1] === 'u'
                    ? { underline: true }
                    : {}
          nested(text.slice(start, end), extra)
          i = end + tag[1].length + 3
          continue
        }
      }
      const self = /^<(mention|date|link-preview)((?:\s+[\w-]+="[^"]*")*)\s*\/>/.exec(r)
      const paired = /^<mention((?:\s+[\w-]+="[^"]*")*)\s*>([\s\S]*?)<\/mention>/.exec(r)
      if (paired) {
        flush()
        out.push(mentionFor(parseAttrs(paired[1]), decodeEntities(paired[2])))
        i += paired[0].length
        continue
      }
      if (self) {
        flush()
        const attrs = parseAttrs(self[2])
        if (self[1] === 'mention') {
          out.push(mentionFor(attrs, ''))
        } else if (self[1] === 'date') {
          const join = (day?: string, time?: string): string =>
            day ? (time ? `${day}T${time}` : day) : ''
          const start = join(attrs.start, attrs['start-time'])
          const end = join(attrs.end, attrs['end-time'])
          out.push({
            type: 'mention',
            plain_text: end ? `${start} to ${end}` : start,
            annotations: {},
            mention: { type: 'date', date: { start, end: end || null } }
          })
        } else {
          out.push({
            type: 'mention',
            plain_text: attrs.url ?? '',
            annotations: {},
            mention: { type: 'link_preview', link_preview: { url: attrs.url ?? '' } }
          })
        }
        i += self[0].length
        continue
      }
    }

    if (ch === '`') {
      const run = /^`+/.exec(rest())?.[0] ?? '`'
      const end = text.indexOf(run, i + run.length)
      if (end > 0) {
        flush()
        let code = text.slice(i + run.length, end)
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1)
        out.push({
          type: 'text',
          plain_text: code,
          href: marks.href ?? null,
          annotations: { ...marks, code: true },
          text: { content: code, link: marks.href ? { url: marks.href } : null }
        })
        i = end + run.length
        continue
      }
    }

    if (ch === '$' && text[i + 1] !== ' ' && text[i + 1] !== '$') {
      const match = /^\$((?:\\.|[^$\\\n])*?\S)\$(?!\d)/.exec(rest())
      if (match) {
        flush()
        out.push({
          type: 'equation',
          plain_text: match[1],
          annotations: {},
          equation: { expression: match[1] }
        })
        i += match[0].length
        continue
      }
    }

    if (ch === '[') {
      const match = /^\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|(?:[^()\s]|\([^()]*\))*)\s*\)/.exec(rest())
      if (match) {
        const href = decodeEntities(match[2].replace(/^<|>$/g, ''))
        nested(match[1], { href })
        i += match[0].length
        continue
      }
    }

    const emphasis = (
      [
        ['**', { bold: true }],
        ['~~', { strikethrough: true }],
        ['*', { italic: true }]
      ] as Array<[string, Marks]>
    ).find(([marker]) => text.startsWith(marker, i))
    if (emphasis) {
      const [marker, extra] = emphasis
      const start = i + marker.length
      const end = text.indexOf(marker, start)
      if (end > start && !/\s/.test(text[start]) && !/\s/.test(text[end - 1])) {
        nested(text.slice(start, end), extra)
        i = end + marker.length
        continue
      }
    }

    if (ch === '&') {
      const entity = /^&(?:amp|lt|gt|quot|#39|apos|nbsp);/.exec(rest())
      if (entity) {
        buffer += HTML_ENTITIES[entity[0]] ?? entity[0]
        i += entity[0].length
        continue
      }
    }

    buffer += ch
    i += 1
  }
  flush()
}

export function parseInline(text: string): NotionRichText[] {
  const out: NotionRichText[] = []
  parseInlineInto(text, {}, out)
  return out
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'quote', 'toggle', 'callout', 'ul', 'ol', 'li', 'todo',
  'columns', 'column', 'tabs', 'tab', 'synced-block', 'synced-block-reference', 'page',
  'folder', 'database', 'image', 'pdf', 'file', 'audio', 'video', 'bookmark', 'embed',
  'table', 'equation', 'table-of-contents', 'meeting-notes', 'meeting-notes-section-notes',
  'meeting-notes-section-summary', 'meeting-notes-section-transcript', 'mail', 'custom-block',
  'external_object_instance', 'unknown'
])
const MEDIA_TAGS = new Set(['image', 'pdf', 'file', 'audio', 'video'])

const SINGLE_TAG = /^<([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>\s*$/
const ONE_LINE_TAG = /^<([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*>(.*)<\/\1>\s*$/
const FENCE = /^(\s*)(`{3,})(.*)$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s*)?(.*)$/
const HEADING = /^(#{1,4})\s+(.*)$/
const IMAGE_LINE = /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)\s*\)\s*$/

function indentOf(line: string): number {
  let width = 0
  for (const ch of line) {
    if (ch === ' ') width += 1
    else if (ch === '\t') width += 4
    else break
  }
  return width
}

function dedent(lines: string[]): string[] {
  const min = Math.min(...lines.filter((line) => line.trim()).map(indentOf))
  if (!Number.isFinite(min) || min === 0) return lines
  return lines.map((line) => {
    let removed = 0
    let at = 0
    while (at < line.length && removed < min) {
      removed += line[at] === '\t' ? 4 : 1
      at += 1
    }
    return line.slice(at)
  })
}

/** The line closing the tag opened at `start`, stepping over code fences. */
function findClose(lines: string[], start: number, tag: string): number {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g')
  const close = `</${tag}>`
  let depth = 1
  let fence: string | null = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[2]
      else if (fenceMatch[2].length >= fence.length && !fenceMatch[3].trim()) fence = null
      continue
    }
    if (fence !== null) continue
    for (const match of line.matchAll(open)) {
      if (!match[0].endsWith('/>')) depth += 1
    }
    depth -= line.split(close).length - 1
    if (depth <= 0) return i
  }
  return -1
}

function trimBlank(lines: string[]): string[] {
  let from = 0
  let to = lines.length
  while (from < to && !lines[from].trim()) from++
  while (to > from && !lines[to - 1].trim()) to--
  return lines.slice(from, to)
}

/** A container's body: its title runs to the first blank line, and what
 *  follows is its children. */
function splitBody(body: string[]): { title: string; rest: string[] } {
  const lines = trimBlank(body)
  const blank = lines.findIndex((line) => !line.trim())
  const titleLines = blank < 0 ? lines : lines.slice(0, blank)
  const rest = blank < 0 ? [] : lines.slice(blank + 1)
  const title = titleLines.join('\n').replace(/\\\n/g, '\n').trim()
  return { title: title === '<p />' ? '' : title, rest }
}

function splitTableRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cell += '|'
      i += 1
    } else if (body[i] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += body[i]
    }
  }
  cells.push(cell.trim())
  return cells
}

class Parser {
  constructor(private readonly ctx: NfmContext) {}

  private make(type: string, data: Record<string, unknown>, children?: NotionBlock[], id?: string): NotionBlock {
    const kids = children && children.length > 0 ? children : undefined
    return { id: id ?? this.ctx.nextId(), type, [type]: data, has_children: !!kids, children: kids }
  }

  private media(tag: string, source: string, caption: string): NotionBlock {
    const captionText = parseInline(caption)
    if (source.startsWith('notion-file-block://')) {
      const blockId = /^notion-file-block:\/\/([0-9a-f-]+)\//i.exec(source)?.[1] ?? this.ctx.nextId()
      const name = /[?&]name=([^&]+)/.exec(source)?.[1]
      let decoded = name
      try {
        decoded = name ? decodeURIComponent(name) : undefined
      } catch {
        // Keep the raw name.
      }
      return this.make(
        tag,
        {
          type: 'file',
          file: { url: this.ctx.references?.[source] ?? '' },
          name: decoded,
          caption: captionText,
          // Notion's stable reference: how a fresh link is asked for.
          source
        },
        undefined,
        blockId
      )
    }
    return this.make(tag, { type: 'external', external: { url: source }, caption: captionText })
  }

  private tagBlock(tag: string, attrs: Record<string, string>, body: string[]): NotionBlock[] {
    const { title, rest } = splitBody(body)
    const richTitle = (): NotionRichText[] => parseInline(title)
    const children = (): NotionBlock[] => this.blocks(rest)

    if (MEDIA_TAGS.has(tag)) return [this.media(tag, attrs.source ?? '', title)]
    switch (tag) {
      case 'p': {
        const paragraph = title ? [this.make('paragraph', { rich_text: richTitle() })] : []
        return [...paragraph, ...children()]
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4': {
        const heading = `heading_${tag[1]}`
        return [this.make(heading, { rich_text: richTitle() }), ...children()]
      }
      case 'quote':
        return [this.make('quote', { rich_text: richTitle() }, children())]
      case 'toggle': {
        if (attrs.heading) {
          const heading = `heading_${attrs.heading.slice(1)}`
          return [this.make(heading, { rich_text: richTitle(), is_toggleable: true }, children())]
        }
        return [this.make('toggle', { rich_text: richTitle() }, children())]
      }
      case 'callout': {
        const icon = attrs.icon ? { type: 'emoji', emoji: attrs.icon } : null
        return [this.make('callout', { rich_text: richTitle(), icon }, children())]
      }
      case 'ul':
      case 'ol':
        return this.listTags(tag, body)
      case 'li':
        return [this.make('bulleted_list_item', { rich_text: richTitle() }, children())]
      case 'todo':
        return [this.make('to_do', { rich_text: richTitle(), checked: attrs.checked === 'true' }, children())]
      case 'columns':
        return [this.make('column_list', {}, this.blocks(body))]
      case 'column':
        return [this.make('column', {}, this.blocks(body))]
      case 'tabs':
      case 'synced-block':
      case 'synced-block-reference':
      case 'meeting-notes-section-notes':
      case 'meeting-notes-section-summary':
        return this.blocks(body)
      case 'tab':
      case 'meeting-notes':
      case 'mail': {
        const paragraph = title ? [this.make('paragraph', { rich_text: richTitle() })] : []
        return [...paragraph, ...children()]
      }
      case 'meeting-notes-section-transcript':
        return []
      case 'page':
      case 'folder': {
        const id = attrs.url ? notionIdFromHref(attrs.url) : null
        if (!id) return []
        return [this.make('child_page', { title: plainText(richTitle()) }, undefined, id)]
      }
      case 'database': {
        const id = attrs.url ? notionIdFromHref(attrs.url) : null
        if (!id) return []
        const block = this.make('child_database', { title: plainText(richTitle()) }, undefined, id)
        block.has_children = false
        return [block]
      }
      case 'bookmark':
        return [this.make('bookmark', { url: attrs.source ?? attrs.url ?? '', caption: parseInline(title) })]
      case 'embed':
        return [this.make('embed', { url: attrs.source ?? attrs.url ?? '' })]
      case 'equation':
        return [this.make('equation', { expression: decodeEntities(title) })]
      case 'table-of-contents':
        return [this.make('table_of_contents', {})]
      case 'table':
        return [this.htmlTable(body)]
      case 'unknown':
        return [this.make('unsupported', { block_type: 'truncated', url: attrs.url ?? '', alt: attrs.alt ?? '' })]
      default:
        return [this.make('unsupported', { block_type: tag })]
    }
  }

  private listTags(tag: 'ul' | 'ol' | string, body: string[]): NotionBlock[] {
    const type = tag === 'ol' ? 'numbered_list_item' : 'bulleted_list_item'
    return this.blocks(body).map((block) => {
      if (block.type !== 'bulleted_list_item') return block
      const data = block.bulleted_list_item as Record<string, unknown>
      const { bulleted_list_item: _dropped, ...others } = block
      return { ...others, type, [type]: data } as NotionBlock
    })
  }

  private htmlTable(body: string[]): NotionBlock {
    const rows: NotionBlock[] = []
    for (const row of body.join('\n').matchAll(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1].matchAll(/<t[dh](?:\s[^>]*)?>([\s\S]*?)<\/t[dh]>/g)].map((cell) =>
        parseInline(cell[1].trim())
      )
      rows.push(this.make('table_row', { cells }))
    }
    return this.make('table', { table_width: 0, has_column_header: true }, rows)
  }

  blocks(lines: string[]): NotionBlock[] {
    const out: NotionBlock[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim()) {
        i += 1
        continue
      }
      const trimmed = line.trim()

      const fence = FENCE.exec(line)
      if (fence) {
        const body: string[] = []
        let j = i + 1
        for (; j < lines.length; j++) {
          const close = FENCE.exec(lines[j])
          if (close && close[2].length >= fence[2].length && !close[3].trim()) break
          body.push(lines[j])
        }
        const code = dedentBy(body, indentOf(line)).join('\n')
        out.push(
          this.make('code', {
            language: fence[3].trim() || 'plain text',
            rich_text: [{ type: 'text', plain_text: code, text: { content: code } }],
            caption: []
          })
        )
        i = j + 1
        continue
      }

      if (trimmed === '<p />' || trimmed === '<p/>') {
        i += 1
        continue
      }

      const oneLine = ONE_LINE_TAG.exec(trimmed)
      if (oneLine && BLOCK_TAGS.has(oneLine[1])) {
        out.push(...this.tagBlock(oneLine[1], parseAttrs(oneLine[2]), [oneLine[3]]))
        i += 1
        continue
      }
      const single = SINGLE_TAG.exec(trimmed)
      if (single && BLOCK_TAGS.has(single[1])) {
        const attrs = parseAttrs(single[2])
        if (single[3]) {
          out.push(...this.tagBlock(single[1], attrs, []))
          i += 1
          continue
        }
        const close = findClose(lines, i, single[1])
        const end = close < 0 ? lines.length : close
        out.push(...this.tagBlock(single[1], attrs, dedent(lines.slice(i + 1, end))))
        i = end + 1
        continue
      }
      // Opens on this line and closes on a later one: `<columns><column>`.
      const glued = /^<([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*>(.+)$/.exec(trimmed)
      if (glued && BLOCK_TAGS.has(glued[1]) && !trimmed.includes(`</${glued[1]}>`)) {
        const close = findClose(lines, i, glued[1])
        if (close >= 0) {
          const body = [glued[3], ...lines.slice(i + 1, close)]
          out.push(...this.tagBlock(glued[1], parseAttrs(glued[2]), body))
          i = close + 1
          continue
        }
      }

      if (trimmed === '$$') {
        let j = i + 1
        const body: string[] = []
        while (j < lines.length && lines[j].trim() !== '$$') body.push(lines[j++])
        out.push(this.make('equation', { expression: body.join('\n') }))
        i = j + 1
        continue
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        out.push(this.make('divider', {}))
        i += 1
        continue
      }
      const heading = HEADING.exec(trimmed)
      if (heading) {
        out.push(this.make(`heading_${heading[1].length}`, { rich_text: parseInline(heading[2]) }))
        i += 1
        continue
      }
      const image = IMAGE_LINE.exec(trimmed)
      if (image) {
        out.push(this.media('image', decodeEntities(image[2].replace(/^<|>$/g, '')), image[1]))
        i += 1
        continue
      }
      if (trimmed.startsWith('|')) {
        const rows: string[][] = []
        let j = i
        while (j < lines.length && lines[j].trim().startsWith('|')) {
          const cells = splitTableRow(lines[j])
          if (!cells.every((cell) => /^:?-{1,}:?$/.test(cell))) rows.push(cells)
          j += 1
        }
        const rowBlocks = rows.map((cells) =>
          this.make('table_row', { cells: cells.map((cell) => parseInline(cell)) })
        )
        out.push(this.make('table', { table_width: rows[0]?.length ?? 0, has_column_header: true }, rowBlocks))
        i = j
        continue
      }
      if (trimmed.startsWith('>')) {
        const body: string[] = []
        let j = i
        while (j < lines.length && lines[j].trim().startsWith('>')) {
          body.push(lines[j].trim().replace(/^>\s?/, ''))
          j += 1
        }
        const { title, rest } = splitBody(body)
        out.push(this.make('quote', { rich_text: parseInline(title) }, this.blocks(rest)))
        i = j
        continue
      }
      const item = LIST_ITEM.exec(line)
      if (item) {
        const base = indentOf(line)
        const nested: string[] = []
        let j = i + 1
        while (j < lines.length) {
          const next = lines[j]
          if (next.trim()) {
            if (indentOf(next) <= base) break
            nested.push(next)
            j += 1
            continue
          }
          // A blank line stays in the item only when more of it follows.
          let k = j + 1
          while (k < lines.length && !lines[k].trim()) k += 1
          if (k < lines.length && indentOf(lines[k]) > base) {
            nested.push(next)
            j += 1
            continue
          }
          break
        }
        const children = this.blocks(dedent(nested))
        const text = parseInline(item[4].replace(/\\$/, ''))
        if (item[3] !== undefined) {
          out.push(this.make('to_do', { rich_text: text, checked: item[3].toLowerCase() === 'x' }, children))
        } else if (/\d/.test(item[2])) {
          const previous = out[out.length - 1]
          const data: Record<string, unknown> = { rich_text: text }
          if (previous?.type !== 'numbered_list_item') data.list_start_index = parseInt(item[2], 10)
          out.push(this.make('numbered_list_item', data, children))
        } else {
          out.push(this.make('bulleted_list_item', { rich_text: text }, children))
        }
        i = j
        continue
      }

      // A paragraph runs until a blank line or anything that opens a block.
      const para: string[] = [line.trim()]
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j]
        const nextTrim = next.trim()
        if (
          !nextTrim ||
          FENCE.test(next) ||
          LIST_ITEM.test(next) ||
          HEADING.test(nextTrim) ||
          nextTrim.startsWith('>') ||
          nextTrim.startsWith('|') ||
          nextTrim === '$$' ||
          (SINGLE_TAG.test(nextTrim) && BLOCK_TAGS.has(SINGLE_TAG.exec(nextTrim)?.[1] ?? ''))
        ) {
          break
        }
        para.push(nextTrim)
        j += 1
      }
      const joined = para.map((part) => part.replace(/\\$/, '<br />')).join(' ').replace(/<br \/> /g, '<br />')
      out.push(this.make('paragraph', { rich_text: parseInline(joined) }))
      i = j
    }
    return out
  }
}

function dedentBy(lines: string[], width: number): string[] {
  if (width === 0) return lines
  return lines.map((line) => {
    let removed = 0
    let at = 0
    while (at < line.length && removed < width && (line[at] === ' ' || line[at] === '\t')) {
      removed += line[at] === '\t' ? 4 : 1
      at += 1
    }
    return line.slice(at)
  })
}

export function parseNotionMarkdown(markdown: string, ctx: NfmContext): NotionBlock[] {
  return new Parser(ctx).blocks(markdown.replace(/\r\n/g, '\n').split('\n'))
}

/** A database cell's text, which arrives as Notion Markdown too: a title can
 *  be `<p>\nName \n</p>`. */
export function parseCellText(value: string): NotionRichText[] {
  const body = value.trim()
  const wrapped = /^<p>\s*([\s\S]*?)\s*<\/p>$/.exec(body)
  return parseInline(wrapped ? wrapped[1] : body)
}
