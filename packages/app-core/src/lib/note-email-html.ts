// Render a note as an inline-styled HTML fragment made for pasting into an
// email body.
//
// Email clients strip <style> blocks, classes and most of the document
// around a pasted fragment, so the only styling that survives is inline
// `style=` attributes on semantic tags. That is exactly what this produces:
// the note's markdown through the same remark parsers the app renders with,
// then one pass that stamps a small, self-contained style on each element.
// No app CSS, no theme variables, no scripts: the fragment must look right
// inside someone else's mail client on someone else's machine.
//
// Images travel as `data:` URIs: a pasted email body cannot reference a file
// on this disk, but mail clients turn an inline data image into an attached
// inline picture, which is what the recipient expects to see (#628). The
// caller reads the bytes (it has the vault and the bridge) and hands them in;
// an image it could not read degrades to its alt text in italics. Math and
// diagram fences stay as code. The title is stated in the fragment via the
// shared export-title rule, so an email never starts mid-thought.
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { visit } from 'unist-util-visit'
import type { Element, Root as HastRoot } from 'hast'
import { withExportTitle } from '@shared/export-title'
import { isImageEmbedTarget, rewriteWikilinkImageEmbeds, splitEmbedLabel } from '@shared/embed-size'

const MONO = "ui-monospace, 'SF Mono', Consolas, Menlo, monospace"

const TAG_STYLES: Record<string, string> = {
  h1: 'font-size:1.7em;font-weight:700;line-height:1.25;margin:0.8em 0 0.4em',
  h2: 'font-size:1.4em;font-weight:700;line-height:1.25;margin:0.9em 0 0.35em',
  h3: 'font-size:1.2em;font-weight:600;margin:0.9em 0 0.3em',
  h4: 'font-size:1.05em;font-weight:600;margin:0.9em 0 0.3em',
  h5: 'font-size:1em;font-weight:600;margin:0.9em 0 0.3em',
  h6: 'font-size:0.95em;font-weight:600;margin:0.9em 0 0.3em',
  p: 'margin:0.5em 0;line-height:1.55',
  ul: 'margin:0.5em 0;padding-left:1.5em',
  ol: 'margin:0.5em 0;padding-left:1.5em',
  li: 'margin:0.2em 0',
  blockquote: 'margin:0.6em 0;padding:0.05em 1em;border-left:3px solid #d0d0d0;color:#555555',
  pre: `background:#f5f5f5;border:1px solid #e2e2e2;border-radius:4px;padding:10px 12px;margin:0.6em 0;font-family:${MONO};font-size:0.9em;line-height:1.5;white-space:pre-wrap`,
  table: 'border-collapse:collapse;margin:0.6em 0',
  th: 'border:1px solid #cfcfcf;padding:5px 9px;text-align:left;background:#f4f4f4;font-weight:600',
  td: 'border:1px solid #cfcfcf;padding:5px 9px',
  a: 'color:#0b62c4;text-decoration:underline',
  hr: 'border:none;border-top:1px solid #d5d5d5;margin:1em 0'
}

const INLINE_CODE_STYLE = `font-family:${MONO};font-size:0.92em;background:#f5f5f5;padding:1px 4px;border-radius:3px`

const IMAGE_STYLE = 'max-width:100%;height:auto;display:block;margin:0.6em 0'

function styleTree(tree: HastRoot, images: ReadonlyMap<string, string>): void {
  visit(tree, 'element', (node: Element, _index, parent) => {
    if (node.tagName === 'img') {
      const src = typeof node.properties?.src === 'string' ? node.properties.src : ''
      const rawAlt = typeof node.properties?.alt === 'string' ? node.properties.alt : ''
      const { alt, size } = splitEmbedLabel(rawAlt, 'markdown')
      const embedded = images.get(src)
      const remote = /^(?:https?:|data:)/i.test(src)
      if (embedded || remote) {
        const sizing = size ? `;width:${size.width}px${size.height ? `;height:${size.height}px` : ''}` : ''
        node.properties = { src: embedded ?? src, alt, style: `${IMAGE_STYLE}${sizing}` }
        return
      }
      // No bytes for this one (outside the vault, too large, unreadable): the
      // alt text beats a broken picture icon on the recipient's end.
      node.tagName = 'em'
      node.properties = {}
      node.children = [{ type: 'text', value: alt ? `[${alt}]` : '[image]' }]
      return
    }
    // GFM task list checkboxes are form controls, which mail clients mangle;
    // a glyph says the same thing everywhere.
    if (node.tagName === 'input' && node.properties?.type === 'checkbox') {
      const checked = node.properties.checked === true
      node.tagName = 'span'
      node.properties = {}
      node.children = [{ type: 'text', value: checked ? '☒ ' : '☐ ' }]
      return
    }
    if (node.tagName === 'code') {
      const inPre = parent?.type === 'element' && (parent as Element).tagName === 'pre'
      if (!inPre) node.properties = { ...node.properties, style: INLINE_CODE_STYLE }
      return
    }
    const style = TAG_STYLES[node.tagName]
    if (style) node.properties = { ...node.properties, style }
  })
}

export interface EmailHtml {
  html: string
  title: string
}

export interface EmailHtmlOptions {
  /** Image `src` as written in the note (after `![[…]]` rewriting, so the
   *  wikilink target) mapped to a `data:` URI with the file's bytes. */
  images?: ReadonlyMap<string, string>
}

const IMAGE_REF_RE = /!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
const WIKILINK_REF_RE = /!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g

/** Every local image the note refers to, in the form `styleTree` will see as
 *  `src`: markdown destinations as written (title dropped) and wikilink
 *  targets. Remote URLs are left out; the mail client fetches those itself. */
export function collectEmailImageRefs(markdown: string): string[] {
  const refs = new Set<string>()
  for (const m of markdown.matchAll(IMAGE_REF_RE)) {
    const href = (m[1] ?? m[2] ?? '').trim()
    if (href && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) refs.add(href)
  }
  for (const m of markdown.matchAll(WIKILINK_REF_RE)) {
    const target = (m[1] ?? '').trim()
    if (target && isImageEmbedTarget(target)) refs.add(target)
  }
  return [...refs]
}

/** The note as an email-ready fragment: title stated, styles inline, images
 *  embedded when their bytes were supplied. */
export function renderNoteEmailHtml(
  body: string,
  noteTitle: string,
  options: EmailHtmlOptions = {}
): EmailHtml {
  const images = options.images ?? new Map<string, string>()
  const titled = withExportTitle(rewriteWikilinkImageEmbeds(body), noteTitle)
  const rendered = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkRehype)
    .use(() => (tree: HastRoot) => styleTree(tree, images))
    .use(rehypeStringify)
    .processSync(titled.markdown)
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:15px;color:#1c1c1c">${String(rendered)}</div>`
  return { html, title: titled.title }
}
