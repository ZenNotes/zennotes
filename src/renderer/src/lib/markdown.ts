import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import rehypeStringify from 'rehype-stringify'
import { visit, SKIP } from 'unist-util-visit'
import type { Root as MdRoot } from 'mdast'
import type { Root as HastRoot, Element as HastElement } from 'hast'

/**
 * Remark plugin: `[[target]]` and `[[target|label]]` → link nodes
 * tagged with class `wikilink` so the renderer can post-process them.
 */
type AnyNode = { type: string; [k: string]: unknown }
type AnyParent = { type: string; children: AnyNode[] }

function remarkWikilinks() {
  return (tree: MdRoot): void => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return
      const p = parent as unknown as AnyParent
      if (p.type === 'link' || p.type === 'linkReference') return
      const value = (node as { value: string }).value
      if (!value.includes('[[')) return
      const regex = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g
      const next: AnyNode[] = []
      let last = 0
      let m: RegExpExecArray | null
      let changed = false
      while ((m = regex.exec(value)) !== null) {
        changed = true
        if (m.index > last) {
          next.push({ type: 'text', value: value.slice(last, m.index) })
        }
        const target = m[1].trim()
        const label = (m[2] ?? m[1]).trim()
        next.push({
          type: 'link',
          url: `zen://note/${encodeURIComponent(target)}`,
          title: null,
          data: {
            hProperties: {
              className: ['wikilink'],
              'data-wikilink': target
            }
          },
          children: [{ type: 'text', value: label }]
        })
        last = regex.lastIndex
      }
      if (!changed) return
      if (last < value.length) {
        next.push({ type: 'text', value: value.slice(last) })
      }
      p.children.splice(index, 1, ...next)
      return [SKIP, index + next.length]
    })
  }
}

/**
 * Remark plugin: inline `#tag` tokens become styled links.
 * Matches only when preceded by start-of-line or whitespace to avoid
 * catching fragments inside URLs and emoji codes.
 */
function remarkHashtags() {
  return (tree: MdRoot): void => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return
      const p = parent as unknown as AnyParent
      if (p.type === 'link' || p.type === 'linkReference' || p.type === 'heading') return
      const value = (node as { value: string }).value
      if (!value.includes('#')) return
      const regex = /(^|\s)#([a-zA-Z][\w\-/]*)/g
      const next: AnyNode[] = []
      let last = 0
      let m: RegExpExecArray | null
      let changed = false
      while ((m = regex.exec(value)) !== null) {
        const start = m.index + m[1].length
        if (start > last) {
          next.push({ type: 'text', value: value.slice(last, start) })
        }
        next.push({
          type: 'link',
          url: `zen://tag/${encodeURIComponent(m[2])}`,
          title: null,
          data: {
            hProperties: {
              className: ['hashtag'],
              'data-tag': m[2]
            }
          },
          children: [{ type: 'text', value: `#${m[2]}` }]
        })
        last = regex.lastIndex
        changed = true
      }
      if (!changed) return
      if (last < value.length) {
        next.push({ type: 'text', value: value.slice(last) })
      }
      p.children.splice(index, 1, ...next)
      return [SKIP, index + next.length]
    })
  }
}

/**
 * Remark plugin: rewrites Obsidian-style callouts.
 *
 *     > [!note] Optional title
 *     > body
 *
 * → `<div class="callout" data-callout="note">` with a `.callout-title` header.
 */
function remarkCallouts() {
  return (tree: MdRoot): void => {
    visit(tree, 'blockquote', (node) => {
      const first = node.children?.[0]
      if (!first || first.type !== 'paragraph') return
      const firstText = first.children?.[0]
      if (!firstText || firstText.type !== 'text') return

      const raw = firstText.value
      const headerEnd = raw.indexOf('\n')
      const header = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw
      const match = header.match(/^\[!(\w+)\](?:\s+(.*))?$/)
      if (!match) return

      const type = match[1].toLowerCase()
      const title = (match[2] ?? '').trim() || type.charAt(0).toUpperCase() + type.slice(1)
      const rest = headerEnd >= 0 ? raw.slice(headerEnd + 1) : ''

      firstText.value = rest
      if (rest === '') {
        first.children.shift()
      }
      if (first.children.length === 0) {
        node.children.shift()
      }

      // Turn the blockquote into a styled div.
      node.data = {
        ...(node.data || {}),
        hName: 'div',
        hProperties: {
          className: ['callout'],
          'data-callout': type
        }
      }

      // Prepend a title paragraph that renders as `<div class="callout-title">`.
      node.children.unshift({
        type: 'paragraph',
        data: {
          hName: 'div',
          hProperties: { className: ['callout-title'] }
        },
        children: [{ type: 'text', value: title }]
      } as never)
    })
  }
}

/**
 * Rehype plugin: convert fenced mermaid blocks to a div the runtime can
 * pick up after mount. Runs *before* rehype-highlight so the diagram body
 * isn't mangled by syntax coloring.
 */
function rehypeMermaid() {
  return (tree: HastRoot): void => {
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'pre' || !parent || index === undefined) return
      const first = node.children?.[0] as HastElement | undefined
      if (!first || first.type !== 'element' || first.tagName !== 'code') return
      const classNames = (first.properties?.className as string[] | undefined) ?? []
      if (!classNames.includes('language-mermaid')) return
      const textNode = first.children?.[0] as { type: string; value: string } | undefined
      const source = textNode && textNode.type === 'text' ? textNode.value : ''
      const replacement: HastElement = {
        type: 'element',
        tagName: 'div',
        // Source is mirrored into `data-mermaid-source` so the runtime can
        // re-render the SVG (e.g. on theme change) after its first render
        // has replaced the div's text with the rendered output.
        properties: {
          className: ['mermaid'],
          'data-mermaid-source': source
        },
        children: [{ type: 'text', value: source }]
      }
      ;(parent as unknown as AnyParent).children[index] = replacement as unknown as AnyNode
      return [SKIP, index]
    })
  }
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkMath)
  .use(remarkWikilinks)
  .use(remarkHashtags)
  .use(remarkCallouts)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeMermaid)
  .use(rehypeHighlight, { detect: true, ignoreMissing: true })
  .use(rehypeKatex)
  .use(rehypeStringify)

export function renderMarkdown(src: string): string {
  try {
    return String(processor.processSync(src))
  } catch (err) {
    console.error('markdown render failed', err)
    return `<pre class="text-sm text-red-600">Markdown error: ${(err as Error).message}</pre>`
  }
}
