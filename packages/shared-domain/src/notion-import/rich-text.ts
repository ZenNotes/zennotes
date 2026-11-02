import type { NotionRenderContext } from './render-context'
import { notionIdFromHref, type NotionAnnotations, type NotionRichText } from './types'

export interface RichTextOptions {
  /** A GFM table cell: pipes escape and a line break becomes a space. */
  table?: boolean
  /** Headings, list-free one-liners: a line break becomes a space. */
  singleLine?: boolean
}

/**
 * Notion text is literal, Markdown text is not. Without this two prices become
 * math, `#word` becomes a tag in the Tags view, and `[x](y)` becomes a link.
 *
 * The editor shows a backslash as a backslash, so each character escapes only
 * where it would actually mean something: one `$` or one backtick has no pair
 * to open, `2 * 3` is no emphasis, and `[1]` is no link. `snake_case` and
 * `C:\\Users` stay as they were typed.
 */
export function escapeMarkdownText(text: string): string {
  const paired = (out: string, mark: RegExp): string =>
    (out.match(mark) ?? []).length >= 2 ? out.replace(mark, '\\$&') : out
  return paired(paired(text.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\'), /`/g), /\$/g)
    .replace(/\*(?=\S)|(?<=\S)\*/g, '\\*')
    .replace(/\[\[/g, '\\[\\[')
    .replace(/\[(?=[!^])/g, '\\[')
    .replace(/\](?=[([:])/g, '\\]')
    .replace(/(^|[^\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, (match) => match.replace('_', '\\_'))
    .replace(/~~/g, '\\~\\~')
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=#?\w+;)/g, '\\&')
    .replace(/(^|\s)#(?=[\p{L}\p{N}])/gu, '$1\\#')
}

/** Characters that would open a block if they started a paragraph's line. */
export function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\[[ xX>/-]\])/, '$1\\$2')
    .replace(/^(\s*\d{1,9})([.)]\s)/, '$1\\$2')
    .replace(/^(\s*)(-{3,}\s*$|={3,}\s*$|~~~)/, '$1\\$2')
}

export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

export function markdownDestination(url: string): string {
  if (!/[\s()<>]/.test(url)) return url
  return `<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>`
}

/** Text a `[[target|alias]]` can carry: no brackets, pipes or line breaks. */
export function wikilinkAlias(text: string): string {
  return text
    .replace(/[[\]|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function wikilink(target: string, alias?: string): string {
  const shown = alias ? wikilinkAlias(alias) : ''
  return shown && shown !== target ? `[[${target}|${shown}]]` : `[[${target}]]`
}

interface Run {
  text: string
  /** Already Markdown: a mention or an equation. */
  raw: boolean
  annotations: NotionAnnotations
  href: string | null
}

function formatDateMention(start: string, end?: string | null): string {
  const one = (value: string): string =>
    value.includes('T') ? value.slice(0, 16).replace('T', ' ') : value
  return end ? `${one(start)} to ${one(end)}` : one(start)
}

function mentionToMarkdown(item: NotionRichText, ctx: NotionRenderContext): string {
  const mention = item.mention
  if (!mention) return escapeMarkdownText(item.plain_text ?? '')
  switch (mention.type) {
    case 'page': {
      const target = mention.page ? ctx.resolvePage(mention.page.id) : null
      if (target) return wikilink(target.target, item.plain_text || target.title)
      ctx.issue('unresolved-link', `Page mention "${item.plain_text}"`)
      return item.href
        ? `[${escapeMarkdownText(item.plain_text)}](${markdownDestination(item.href)})`
        : escapeMarkdownText(item.plain_text)
    }
    case 'database': {
      const [target] = mention.database ? ctx.resolveDatabase(mention.database.id) : []
      if (target) return wikilink(target.target, item.plain_text || target.title)
      ctx.issue('linked-database', `Database mention "${item.plain_text}"`)
      return escapeMarkdownText(item.plain_text)
    }
    case 'date':
      return mention.date
        ? escapeMarkdownText(formatDateMention(mention.date.start, mention.date.end))
        : escapeMarkdownText(item.plain_text)
    case 'link_preview':
      return mention.link_preview
        ? `[${escapeMarkdownText(item.plain_text || mention.link_preview.url)}](${markdownDestination(mention.link_preview.url)})`
        : escapeMarkdownText(item.plain_text)
    case 'link_mention': {
      const href = mention.link_mention?.href
      if (!href) return escapeMarkdownText(item.plain_text)
      const title = mention.link_mention?.title || item.plain_text || href
      return `[${escapeMarkdownText(title)}](${markdownDestination(href)})`
    }
    default:
      // A user, a custom emoji or a template: its printed form is the content.
      return escapeMarkdownText(item.plain_text ?? '')
  }
}

function toRuns(rich: NotionRichText[], ctx: NotionRenderContext): Run[] {
  const runs: Run[] = []
  for (const item of rich) {
    const annotations = item.annotations ?? {}
    let run: Run
    if (item.type === 'mention') {
      run = { text: mentionToMarkdown(item, ctx), raw: true, annotations, href: null }
    } else if (item.type === 'equation' && item.equation) {
      run = { text: `$${item.equation.expression}$`, raw: true, annotations, href: null }
    } else {
      const href = item.text?.link?.url ?? item.href ?? null
      run = { text: item.text?.content ?? item.plain_text ?? '', raw: false, annotations, href }
    }
    const last = runs[runs.length - 1]
    // Notion splits text wherever an edit landed, so `**a****b**` is common
    // input. Runs that look the same are one run.
    if (last && !last.raw && !run.raw && sameLook(last, run)) last.text += run.text
    else runs.push(run)
  }
  return runs
}

function sameLook(a: Run, b: Run): boolean {
  return (
    a.href === b.href &&
    !!a.annotations.bold === !!b.annotations.bold &&
    !!a.annotations.italic === !!b.annotations.italic &&
    !!a.annotations.strikethrough === !!b.annotations.strikethrough &&
    !!a.annotations.code === !!b.annotations.code
  )
}

function renderRunLine(run: Run, line: string, ctx: NotionRenderContext): string {
  const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(line) as RegExpExecArray
  if (!body) return line

  let inner: string
  if (run.raw) inner = body
  else if (run.annotations.code) inner = codeSpan(body)
  else inner = escapeMarkdownText(body)

  if (run.href) {
    const pageId = notionIdFromHref(run.href)
    const target = pageId ? ctx.resolvePage(pageId) : null
    if (target) {
      inner = wikilink(target.target, body)
    } else {
      if (pageId) ctx.issue('unresolved-link', `Link "${body}"`)
      inner = `[${inner}](${markdownDestination(run.href)})`
    }
  }
  if (run.annotations.strikethrough) inner = `~~${inner}~~`
  if (run.annotations.italic) inner = `*${inner}*`
  if (run.annotations.bold) inner = `**${inner}**`
  return `${lead}${inner}${trail}`
}

/**
 * Inline Markdown for Notion rich text. Whitespace stays outside the markers,
 * since `**bold **next` is not bold in Markdown, and each line carries its own
 * markers, since emphasis cannot span a hard break. Text color and underline
 * have no Markdown form and are dropped; the report says so once.
 */
export function richTextToMarkdown(
  rich: NotionRichText[] | undefined | null,
  ctx: NotionRenderContext,
  options: RichTextOptions = {}
): string {
  const oneLine = options.table || options.singleLine
  const parts: string[] = []
  for (const run of toRuns(rich ?? [], ctx)) {
    const lines = run.text.split('\n').map((line) => renderRunLine(run, line, ctx))
    let rendered = lines.join(oneLine ? ' ' : '  \n')
    if (options.table) rendered = rendered.replace(/\|/g, '\\|')
    parts.push(rendered)
  }
  return parts.join('')
}
