// Export a note as a Word document with REAL Word structure.
//
// The one thing this exists to guarantee: the document is built from Word's
// own styles (Heading 1..6, List Paragraph, Quote, Hyperlink), not from text
// that merely looks like headings. Pasting preview HTML into Word produces
// direct formatting on the Normal style, which reads fine and edits terribly;
// a partner who changes "Heading 2" in a document exported here restyles the
// whole thing, which is what "an editable form" means.
//
// The pipeline is markdown → mdast (the same remark parsers the app renders
// with) → a small intermediate representation → docx. The IR exists for two
// reasons: the mdast walk is where every mapping decision lives (and is unit
// tested as plain data), and the docx layer stays a dumb translation that is
// hard to get wrong. Deliberately NO visual styling beyond structure: the
// recipient's Word template owns the look, which is maximal editability.
//
// v1 scope: headings, paragraphs, bold/italic/strikethrough/inline code,
// ==highlights==, links, ordered/unordered/task lists (nested), GFM tables,
// code blocks, blockquotes, thematic breaks, and local images (standard
// markdown image syntax; sized via Electron's nativeImage, re-encoded to PNG
// when Word would not accept the source format). Math renders as its literal
// source in mono; mermaid and other diagram fences render as code blocks;
// `![[chart.png|600]]` image embeds are rewritten to standard image syntax
// before parsing (the shared `rewriteWikilinkImageEmbeds`), so the pictures
// the app itself inserts export like any other (#629); a `|600` hint sizes
// the run. Note embeds still pass through as text. Those upgrades want the
// real renderers and belong to a follow-up, not to a worse approximation here.
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import type { AlignType, ListItem, PhrasingContent, Root, RootContent } from 'mdast'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip
} from 'docx'
import { withExportTitle } from '@shared/export-title'
import { stripBlockAnchorMarkers } from '@shared/block-anchors'
import { rewriteWikilinkImageEmbeds, splitEmbedLabel, type EmbedSize } from '@shared/embed-size'

/* -------------------------------------------------------------------------- */
/*  The intermediate representation                                           */
/* -------------------------------------------------------------------------- */

export interface IRRun {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  highlight?: boolean
  /** Absolute URL for an external hyperlink. Relative links stay plain text:
   *  a .docx on someone else's machine has nothing they could resolve to. */
  link?: string
}

export interface IRListItem {
  /** null for ordinary bullets; a task list item carries its checked state. */
  checked: boolean | null
  blocks: IRBlock[]
}

export type IRBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; runs: IRRun[] }
  | { kind: 'paragraph'; runs: IRRun[] }
  | { kind: 'code'; lines: string[]; lang: string | null }
  | { kind: 'quote'; blocks: IRBlock[] }
  | { kind: 'list'; ordered: boolean; items: IRListItem[] }
  | { kind: 'table'; aligns: (AlignType | null)[]; header: IRRun[][]; rows: IRRun[][][] }
  | { kind: 'rule' }
  | { kind: 'image'; src: string; alt: string; size?: EmbedSize }

interface InlineStyle {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  highlight?: boolean
  link?: string
}

const EXTERNAL_LINK_RE = /^https?:\/\//i

function collectRuns(nodes: readonly PhrasingContent[], style: InlineStyle, out: IRRun[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ text: node.value, ...style })
        break
      case 'strong':
        collectRuns(node.children, { ...style, bold: true }, out)
        break
      case 'emphasis':
        collectRuns(node.children, { ...style, italic: true }, out)
        break
      case 'delete':
        collectRuns(node.children, { ...style, strike: true }, out)
        break
      case 'inlineCode':
        out.push({ text: node.value, ...style, code: true })
        break
      case 'link': {
        const link = EXTERNAL_LINK_RE.test(node.url) ? node.url : undefined
        collectRuns(node.children, link ? { ...style, link } : style, out)
        break
      }
      case 'break':
        out.push({ text: '\n', ...style })
        break
      case 'image':
        // An image INSIDE a sentence cannot become a block without reflowing
        // the sentence, so it degrades to its alt text; standalone images are
        // promoted to image blocks by the paragraph walk.
        out.push({ text: node.alt ? `[${node.alt}]` : `[image]`, ...style, italic: true })
        break
      case 'inlineMath' as never:
        out.push({
          text: `$${(node as unknown as { value: string }).value}$`,
          ...style,
          code: true
        })
        break
      case 'html':
        // Inline HTML in a note is usually a deliberate tag (<br>, <sup>).
        // Word gets the literal text: rendering HTML is the browsers' job.
        if (node.value.trim() === '<br>' || node.value.trim() === '<br/>') {
          out.push({ text: '\n', ...style })
        }
        break
      case 'footnoteReference':
        break
      default: {
        const children = (node as { children?: PhrasingContent[] }).children
        if (children) collectRuns(children, style, out)
      }
    }
  }
}

function runsOf(nodes: readonly PhrasingContent[]): IRRun[] {
  const out: IRRun[] = []
  collectRuns(nodes, {}, out)
  // ==highlight== arrives from the app's markdown as literal text (remark has
  // no mark extension); split it out of text runs so Word shows a highlight.
  return splitHighlights(out)
}

/** Turn `==marked==` spans inside plain text runs into highlighted runs. */
function splitHighlights(runs: IRRun[]): IRRun[] {
  const out: IRRun[] = []
  for (const run of runs) {
    if (run.code || run.link || !run.text.includes('==')) {
      out.push(run)
      continue
    }
    const parts = run.text.split(/==([^=\n]+)==/)
    if (parts.length === 1) {
      out.push(run)
      continue
    }
    parts.forEach((part, index) => {
      if (!part) return
      if (index % 2 === 1) out.push({ ...run, text: part, highlight: true })
      else out.push({ ...run, text: part })
    })
  }
  return out
}

function listItemOf(item: ListItem): IRListItem {
  return {
    checked: typeof item.checked === 'boolean' ? item.checked : null,
    blocks: item.children.flatMap((child) => blockOf(child) ?? [])
  }
}

function blockOf(node: RootContent): IRBlock[] | null {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, node.depth)) as 1 | 2 | 3 | 4 | 5 | 6
      return [{ kind: 'heading', level, runs: runsOf(node.children) }]
    }
    case 'paragraph': {
      // A paragraph that is exactly one image is a figure, not a sentence.
      if (node.children.length === 1 && node.children[0].type === 'image') {
        const image = node.children[0]
        const label = splitEmbedLabel(image.alt, 'markdown')
        return [
          {
            kind: 'image',
            src: image.url,
            alt: label.alt,
            ...(label.size ? { size: label.size } : {})
          }
        ]
      }
      return [{ kind: 'paragraph', runs: runsOf(node.children) }]
    }
    case 'code':
      return [{ kind: 'code', lines: node.value.split('\n'), lang: node.lang ?? null }]
    case 'math' as never:
      return [
        {
          kind: 'code',
          lines: String((node as unknown as { value: string }).value).split('\n'),
          lang: 'math'
        }
      ]
    case 'blockquote':
      return [{ kind: 'quote', blocks: node.children.flatMap((child) => blockOf(child) ?? []) }]
    case 'list':
      return [{ kind: 'list', ordered: node.ordered === true, items: node.children.map(listItemOf) }]
    case 'table': {
      const [head, ...body] = node.children
      return [
        {
          kind: 'table',
          aligns: node.align ?? [],
          header: head ? head.children.map((cell) => runsOf(cell.children)) : [],
          rows: body.map((row) => row.children.map((cell) => runsOf(cell.children)))
        }
      ]
    }
    case 'thematicBreak':
      return [{ kind: 'rule' }]
    case 'html': {
      const text = node.value.trim()
      if (!text || /^<!--[\s\S]*-->$/.test(text)) return null
      return [{ kind: 'code', lines: text.split('\n'), lang: 'html' }]
    }
    case 'yaml':
    case 'toml' as never:
      // Frontmatter: metadata, not content. The title it may carry is already
      // stated by `withExportTitle`.
      return null
    case 'definition':
    case 'footnoteDefinition':
      return null
    default:
      return null
  }
}

/** Parse a note's markdown (title already stated, see `withExportTitle`) into
 *  the IR. Exported for tests: every mapping decision is visible here.
 *  `^block-id` markers are addressing, not prose, and a Word document handed
 *  to non-ZenNotes readers is the last place they should print. (#601) */
export function noteMarkdownToIR(markdown: string): IRBlock[] {
  // `![[chart.png|600]]` becomes `![|600](chart.png)` before remark sees it (#629).
  markdown = rewriteWikilinkImageEmbeds(markdown)
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkMath)
    .parse(stripBlockAnchorMarkers(markdown)) as Root
  return tree.children.flatMap((node) => blockOf(node) ?? [])
}

/* -------------------------------------------------------------------------- */
/*  IR → docx                                                                 */
/* -------------------------------------------------------------------------- */

/** A resolved local image, ready for embedding. */
export interface ResolvedImage {
  data: Buffer
  /** Pixel dimensions at 96dpi, already scaled to fit the page column. */
  width: number
  height: number
  type: 'png' | 'jpg' | 'gif' | 'bmp'
}

/** `size` is the author's `|600` / `|600x400` hint, a request the resolver
 *  honours within the page column. */
export type ImageResolver = (src: string, size?: EmbedSize) => Promise<ResolvedImage | null>

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
] as const

const MONO_FONT = 'Consolas'
const CODE_SHADE = 'F2F2F2'
const NUMBERING_BULLETS = 'zn-bullets'
const NUMBERING_ORDERED = 'zn-ordered'

// C0 control characters (and DEL) are not legal XML 1.0 content, and docx
// writes run text into word/document.xml verbatim. A note holding a stray
// \x01 or \x0B (pasted from a terminal capture, a binary blob, some
// exporters' output) therefore produced a .docx Word refuses to open at all
// ("unreadable content"). Tab, LF, and CR are legal and carry meaning here
// (LF becomes a Word line break below), so they survive.
const XML_ILLEGAL_CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

function stripControlChars(text: string): string {
  return text.replace(XML_ILLEGAL_CONTROL_CHARS_RE, '')
}

function textRunsOf(runs: IRRun[]): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = []
  for (const run of runs) {
    // Line breaks inside a run become real Word line breaks.
    const pieces = stripControlChars(run.text).split('\n')
    const make = (extra: { style?: string } = {}): TextRun[] =>
      pieces.map(
        (piece, index) =>
          new TextRun({
            text: piece,
            break: index > 0 ? 1 : undefined,
            bold: run.bold,
            italics: run.italic,
            strike: run.strike,
            highlight: run.highlight ? 'yellow' : undefined,
            font: run.code ? MONO_FONT : undefined,
            shading: run.code ? { type: ShadingType.CLEAR, fill: CODE_SHADE } : undefined,
            ...extra
          })
      )
    if (run.link) {
      out.push(new ExternalHyperlink({ link: run.link, children: make({ style: 'Hyperlink' }) }))
    } else {
      out.push(...make())
    }
  }
  return out
}

interface BlockContext {
  quoteDepth: number
  listRef?: { reference: string; level: number }
}

async function blockToDocx(
  block: IRBlock,
  ctx: BlockContext,
  resolveImage: ImageResolver
): Promise<(Paragraph | Table)[]> {
  switch (block.kind) {
    case 'heading':
      return [
        new Paragraph({
          heading: HEADINGS[block.level - 1],
          children: textRunsOf(block.runs)
        })
      ]
    case 'paragraph':
      return [
        new Paragraph({
          style: ctx.quoteDepth > 0 ? 'Quote' : undefined,
          numbering: ctx.listRef,
          children: textRunsOf(block.runs)
        })
      ]
    case 'code':
      return block.lines.map((line, index) => {
        // A fenced block is where terminal captures (and their control bytes)
        // most often land, so it needs the same strip as prose runs.
        const text = stripControlChars(line)
        return new Paragraph({
          spacing: { after: index === block.lines.length - 1 ? 200 : 0 },
          shading: { type: ShadingType.CLEAR, fill: CODE_SHADE },
          children: [new TextRun({ text: text === '' ? ' ' : text, font: MONO_FONT, size: 19 })]
        })
      })
    case 'quote': {
      const out: (Paragraph | Table)[] = []
      for (const inner of block.blocks) {
        out.push(...(await blockToDocx(inner, { ...ctx, quoteDepth: ctx.quoteDepth + 1 }, resolveImage)))
      }
      return out
    }
    case 'list': {
      const out: (Paragraph | Table)[] = []
      const reference = block.ordered ? NUMBERING_ORDERED : NUMBERING_BULLETS
      const level = Math.min(ctx.listRef ? ctx.listRef.level + 1 : 0, 2)
      for (const item of block.items) {
        let first = true
        for (const inner of item.blocks) {
          if (inner.kind === 'paragraph' && first) {
            const runs =
              item.checked === null
                ? inner.runs
                : [{ text: item.checked ? '☒ ' : '☐ ' }, ...inner.runs]
            out.push(
              new Paragraph({
                numbering: { reference, level },
                children: textRunsOf(runs)
              })
            )
            first = false
            continue
          }
          if (inner.kind === 'list') {
            out.push(
              ...(await blockToDocx(inner, { ...ctx, listRef: { reference, level } }, resolveImage))
            )
            continue
          }
          out.push(...(await blockToDocx(inner, ctx, resolveImage)))
          first = false
        }
      }
      return out
    }
    case 'table': {
      const makeRow = (cells: IRRun[][], header: boolean): TableRow =>
        new TableRow({
          tableHeader: header,
          children: cells.map(
            (cellRuns, column) =>
              new TableCell({
                margins: {
                  top: 60,
                  bottom: 60,
                  left: 100,
                  right: 100
                },
                children: [
                  new Paragraph({
                    alignment:
                      block.aligns[column] === 'center'
                        ? AlignmentType.CENTER
                        : block.aligns[column] === 'right'
                          ? AlignmentType.RIGHT
                          : undefined,
                    children: textRunsOf(
                      header ? cellRuns.map((run) => ({ ...run, bold: true })) : cellRuns
                    )
                  })
                ]
              })
          )
        })
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            ...(block.header.length > 0 ? [makeRow(block.header, true)] : []),
            ...block.rows.map((row) => makeRow(row, false))
          ]
        })
      ]
    }
    case 'rule':
      return [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'B0B0B0' } },
          spacing: { after: 200 }
        })
      ]
    case 'image': {
      const resolved = await resolveImage(block.src, block.size).catch(() => null)
      if (!resolved) {
        return [
          new Paragraph({
            children: [
              new TextRun({
                text: stripControlChars(block.alt ? `[${block.alt}]` : `[image: ${block.src}]`),
                italics: true
              })
            ]
          })
        ]
      }
      return [
        new Paragraph({
          children: [
            new ImageRun({
              type: resolved.type,
              data: resolved.data,
              transformation: { width: resolved.width, height: resolved.height }
            })
          ]
        })
      ]
    }
  }
}

/**
 * Render a note's markdown into a .docx buffer.
 *
 * `noteTitle` is the fallback title (the filename); the exported document
 * always states its title as a Heading 1 unless the body already does, the
 * same rule the PDF export follows, via the same shared helper.
 */
export async function renderNoteDocx(
  markdown: string,
  noteTitle: string,
  resolveImage: ImageResolver
): Promise<Buffer> {
  const titled = withExportTitle(markdown, noteTitle)
  const blocks = noteMarkdownToIR(titled.markdown)
  const children: (Paragraph | Table)[] = []
  for (const block of blocks) {
    children.push(...(await blockToDocx(block, { quoteDepth: 0 }, resolveImage)))
  }
  const doc = new Document({
    title: titled.title,
    creator: 'ZenNotes',
    numbering: {
      config: [
        {
          reference: NUMBERING_BULLETS,
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: ['•', '◦', '▪'][level],
            style: {
              paragraph: {
                indent: {
                  left: convertInchesToTwip(0.25 + level * 0.25),
                  hanging: convertInchesToTwip(0.18)
                }
              }
            }
          }))
        },
        {
          reference: NUMBERING_ORDERED,
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            style: {
              paragraph: {
                indent: {
                  left: convertInchesToTwip(0.25 + level * 0.25),
                  hanging: convertInchesToTwip(0.18)
                }
              }
            }
          }))
        }
      ]
    },
    sections: [{ children }]
  })
  return await Packer.toBuffer(doc)
}
