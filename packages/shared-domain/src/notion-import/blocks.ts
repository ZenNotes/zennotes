import type { NotionRenderContext } from './render-context'
import {
  escapeLineStart,
  markdownDestination,
  richTextToMarkdown,
  wikilink,
  wikilinkAlias
} from './rich-text'
import { plainText, type NotionBlock, type NotionFile, type NotionRichText } from './types'

type BlockData = {
  rich_text?: NotionRichText[]
  caption?: NotionRichText[]
  children?: NotionBlock[]
  checked?: boolean
  language?: string
  expression?: string
  url?: string
  title?: string
  icon?: { type?: string; emoji?: string } | null
  has_column_header?: boolean
  list_start_index?: number
  cells?: NotionRichText[][]
  type?: string
  page_id?: string
  database_id?: string
  block_id?: string
}

function dataOf(block: NotionBlock): BlockData {
  return (block[block.type] ?? {}) as BlockData
}

/** The key a hosted file is stored under. Media blocks carry theirs here. */
export function blockFileKey(blockId: string): string {
  return `block-${blockId}`
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic)$/i
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|flac|aac)$/i
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv)$/i
export const EMBED_VIDEO_HOST = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com|m\.youtube\.com)\//i

/** The same choice `importFiles` makes: images, PDFs, audio and video embed;
 *  anything else is a link. */
export function assetMarkdown(path: string, name: string): string {
  if (IMAGE_EXT.test(name) || /\.pdf$/i.test(name) || AUDIO_EXT.test(name) || VIDEO_EXT.test(name)) {
    return `![[${path}]]`
  }
  return `[${wikilinkAlias(name)}](${markdownDestination(path)})`
}

function fence(lang: string, body: string): string {
  const longest = Math.max(2, ...(body.match(/`{3,}/g) ?? []).map((run) => run.length))
  const marker = '`'.repeat(longest + 1)
  return `${marker}${lang}\n${body}\n${marker}`
}

const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  'plain text': '',
  'c++': 'cpp',
  'c#': 'csharp',
  'f#': 'fsharp',
  'vb.net': 'vbnet',
  'objective-c': 'objectivec',
  'shell': 'bash',
  'java/c/c++/c#': 'java'
}

function codeLanguage(language: string | undefined): string {
  const name = (language ?? '').trim().toLowerCase()
  if (name in CODE_LANGUAGE_ALIASES) return CODE_LANGUAGE_ALIASES[name]
  return name.replace(/[^a-z0-9+#_-]/g, '')
}

const CALLOUT_TYPE_BY_EMOJI: Record<string, string> = {
  '💡': 'tip',
  '⚠️': 'warning',
  '⚠': 'warning',
  '❗': 'danger',
  '‼️': 'danger',
  '🚨': 'danger',
  '🔥': 'danger',
  '✅': 'success',
  '❓': 'question',
  'ℹ️': 'info',
  '📝': 'note',
  '🐛': 'bug'
}

function prefixLines(text: string, prefix: string): string {
  const bare = prefix.trimEnd()
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : bare))
    .join('\n')
}

function indentContinuation(text: string, width: number): string {
  const pad = ' '.repeat(width)
  return text
    .split('\n')
    .map((line, index) => (index === 0 || line.length === 0 ? line : `${pad}${line}`))
    .join('\n')
}

function paragraphLines(markdown: string): string {
  return markdown.split('\n').map(escapeLineStart).join('\n')
}

function captionLine(caption: NotionRichText[] | undefined, ctx: NotionRenderContext): string {
  const text = richTextToMarkdown(caption, ctx, { singleLine: true }).trim()
  return text ? `\n\n*${text}*` : ''
}

function placeholder(label: string): string {
  return `> [!warning] Not imported from Notion\n> ${label}`
}

function renderMedia(block: NotionBlock, ctx: NotionRenderContext): string {
  const media = dataOf(block) as unknown as NotionFile
  const caption = captionLine(media.caption, ctx)
  const stored = ctx.assetFor(blockFileKey(block.id))
  if (stored) return `${assetMarkdown(stored.path, stored.name)}${caption}`
  if (media.type === 'external' && media.external?.url) {
    const url = media.external.url
    const shown = plainText(media.caption).trim()
    if (block.type === 'image') {
      return `![${wikilinkAlias(shown)}](${markdownDestination(url)})`
    }
    if (block.type === 'video' && EMBED_VIDEO_HOST.test(url)) {
      return `${fence('embed', url)}${caption}`
    }
    return `[${wikilinkAlias(shown || media.name || url)}](${markdownDestination(url)})`
  }
  const name = media.name || plainText(media.caption) || block.type
  ctx.issue('file-missing', `${block.type} "${name}"`)
  return placeholder(`The ${block.type} "${wikilinkAlias(name)}" could not be downloaded.`)
}

function renderTable(block: NotionBlock, ctx: NotionRenderContext): string {
  const rows = (block.children ?? []).filter((child) => child.type === 'table_row')
  if (rows.length === 0) return ''
  const cells = rows.map((row) =>
    (dataOf(row).cells ?? []).map((cell) => {
      const text = richTextToMarkdown(cell, ctx, { table: true }).trim()
      return text || ' '
    })
  )
  const width = Math.max(...cells.map((row) => row.length))
  const line = (row: string[]): string => {
    const filled = [...row, ...Array<string>(width - row.length).fill(' ')]
    return `| ${filled.join(' | ')} |`
  }
  // GFM has no headerless table, so a Notion table without a header row leads
  // with its first row.
  return [line(cells[0]), line(Array<string>(width).fill('---')), ...cells.slice(1).map(line)].join('\n')
}

function renderLinkToPage(block: NotionBlock, ctx: NotionRenderContext): string {
  const data = dataOf(block)
  if (data.page_id) {
    const target = ctx.resolvePage(data.page_id)
    if (target) return wikilink(target.target, target.title)
  } else if (data.database_id) {
    const [target] = ctx.resolveDatabase(data.database_id)
    if (target) return wikilink(target.target, target.title)
  }
  ctx.issue('unresolved-link', `Link to a ${data.type ?? 'page'} this import can't read`)
  return ''
}

function isListItem(block: NotionBlock): boolean {
  return (
    block.type === 'bulleted_list_item' ||
    block.type === 'numbered_list_item' ||
    block.type === 'to_do'
  )
}

/** Bullets and to-dos are one Markdown list; numbers are another. */
function sameList(a: NotionBlock, b: NotionBlock): boolean {
  return (a.type === 'numbered_list_item') === (b.type === 'numbered_list_item')
}

function renderListItem(block: NotionBlock, number: number, ctx: NotionRenderContext): string {
  const data = dataOf(block)
  let marker: string
  if (block.type === 'numbered_list_item') marker = `${number}.`
  else if (block.type === 'to_do') marker = data.checked ? '- [x]' : '- [ ]'
  else marker = '-'
  // Task markers still continue at the bullet's own indent.
  const width = block.type === 'numbered_list_item' ? marker.length + 1 : 2
  const text = indentContinuation(paragraphLines(richTextToMarkdown(data.rich_text, ctx)), width)

  const children = block.children ?? []
  if (children.length === 0) return `${marker} ${text}`
  const nested = renderBlocks(children, ctx)
    .split('\n')
    .map((line) => (line.length > 0 ? `${' '.repeat(width)}${line}` : line))
    .join('\n')
  // Only a list can follow its parent's text directly; anything else would
  // read as more of the same paragraph.
  return `${marker} ${text}${isListItem(children[0]) ? '\n' : '\n\n'}${nested}`
}

function renderContainer(
  head: string,
  children: NotionBlock[] | undefined,
  ctx: NotionRenderContext
): string {
  const body = renderBlocks(children ?? [], ctx)
  if (head && body) return `${head}\n\n${body}`
  return head || body
}

function renderBlock(block: NotionBlock, ctx: NotionRenderContext): string {
  const data = dataOf(block)
  switch (block.type) {
    case 'paragraph':
      return renderContainer(paragraphLines(richTextToMarkdown(data.rich_text, ctx)), block.children, ctx)
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'heading_4': {
      // A heading is already heavy: bold on top of it just adds asterisks.
      const unbolded = (data.rich_text ?? []).map((part) => ({
        ...part,
        annotations: { ...part.annotations, bold: false }
      }))
      const text = richTextToMarkdown(unbolded, ctx, { singleLine: true }).trim()
      const hashes = '#'.repeat(Number(block.type.slice(-1)))
      // A toggle heading's content follows it: headings fold in ZenNotes.
      return renderContainer(text ? `${hashes} ${text}` : '', block.children, ctx)
    }
    case 'quote': {
      const body = renderContainer(paragraphLines(richTextToMarkdown(data.rich_text, ctx)), block.children, ctx)
      return body ? prefixLines(body, '> ') : ''
    }
    case 'callout': {
      const emoji = data.icon?.type === 'emoji' ? (data.icon.emoji ?? '') : ''
      const known = CALLOUT_TYPE_BY_EMOJI[emoji]
      const text = paragraphLines(richTextToMarkdown(data.rich_text, ctx))
      const lead = !known && emoji ? `${emoji} ${text}`.trim() : text
      const body = renderContainer(lead, block.children, ctx)
      const head = `> [!${known ?? 'note'}]`
      return body ? `${head}\n${prefixLines(body, '> ')}` : head
    }
    case 'toggle': {
      const title = richTextToMarkdown(data.rich_text, ctx, { singleLine: true }).trim()
      const body = renderBlocks(block.children ?? [], ctx)
      const head = `> [!note]- ${title}`.trimEnd()
      return body ? `${head}\n${prefixLines(body, '> ')}` : head
    }
    case 'code':
      return `${fence(codeLanguage(data.language), plainText(data.rich_text))}${captionLine(data.caption, ctx)}`
    case 'equation':
      return `$$\n${data.expression ?? ''}\n$$`
    case 'divider':
      return '---'
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf':
      return renderMedia(block, ctx)
    case 'bookmark':
      return data.url ? `${fence('bookmark', data.url)}${captionLine(data.caption, ctx)}` : ''
    case 'embed':
      if (!data.url) return ''
      return fence(EMBED_VIDEO_HOST.test(data.url) ? 'embed' : 'bookmark', data.url)
    case 'link_preview':
      return data.url ? fence('bookmark', data.url) : ''
    case 'link_to_page':
      return renderLinkToPage(block, ctx)
    case 'child_page': {
      if (ctx.isExcluded?.(block.id)) return ''
      const target = ctx.resolvePage(block.id)
      if (target) return wikilink(target.target, data.title || target.title)
      ctx.issue('unresolved-link', `Subpage "${data.title ?? ''}"`)
      return ''
    }
    case 'child_database': {
      if (ctx.isExcluded?.(block.id)) return ''
      const targets = ctx.resolveDatabase(block.id)
      if (targets.length > 0) {
        return targets.map((target) => wikilink(target.target, target.title)).join('\n\n')
      }
      const title = data.title?.trim() || 'Untitled'
      ctx.issue('linked-database', `"${title}"`)
      return placeholder(`Linked database "${wikilinkAlias(title)}": Notion's API can't read these.`)
    }
    case 'table':
      return renderTable(block, ctx)
    case 'column_list':
    case 'column':
    case 'synced_block':
      return renderBlocks(block.children ?? [], ctx)
    case 'table_of_contents':
    case 'breadcrumb':
      // Notion draws these from the page; the Outline does that job here.
      return ''
    case 'unsupported': {
      const kind = String((block.unsupported as { block_type?: string } | undefined)?.block_type ?? 'unknown')
      ctx.issue('unsupported-block', kind)
      return placeholder(`A ${kind} block: Notion's API doesn't return its contents.`)
    }
    default: {
      // A type newer than this importer: keep whatever nested in it.
      ctx.issue('unknown-block', block.type)
      const nested = renderBlocks(block.children ?? [], ctx)
      const note = placeholder(`A ${block.type} block.`)
      return nested ? `${note}\n\n${nested}` : note
    }
  }
}

export function renderBlocks(blocks: NotionBlock[], ctx: NotionRenderContext): string {
  let out = ''
  let previous: NotionBlock | null = null
  let number = 1
  for (const block of blocks) {
    if (block.type === 'numbered_list_item') {
      const continues = previous?.type === 'numbered_list_item'
      number = continues ? number + 1 : (dataOf(block).list_start_index ?? 1)
    }
    const rendered = isListItem(block)
      ? renderListItem(block, number, ctx)
      : renderBlock(block, ctx)
    if (rendered) {
      if (out) {
        const tight = previous && isListItem(previous) && isListItem(block) && sameList(previous, block)
        out += tight ? '\n' : '\n\n'
      }
      out += rendered
      previous = block
    } else if (!isListItem(block)) {
      // An empty paragraph between two lists still separates them in Notion.
      previous = block
    }
  }
  return out
}

/** Whether a page holds to-dos, which ZenNotes would otherwise list in Tasks. */
export function blocksHaveTodos(blocks: NotionBlock[]): boolean {
  return blocks.some((block) => block.type === 'to_do' || blocksHaveTodos(block.children ?? []))
}
