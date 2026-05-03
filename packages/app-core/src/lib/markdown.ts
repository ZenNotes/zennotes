import { unified } from 'unified'
import DOMPurify from 'dompurify'
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
import { recordRendererPerf } from './perf'
import { classifyLocalAssetHref } from './local-assets'

/**
 * Remark plugin: `[[target]]` and `[[target|label]]` → link nodes
 * tagged with class `wikilink` so the renderer can post-process them.
 */
type AnyNode = { type: string; [k: string]: unknown }
type AnyParent = { type: string; children: AnyNode[] }

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/
const ALLOWED_RENDERED_URI_SCHEME_RE = /^(?:https?|mailto|zen|zen-asset|blob|data):/i
const ALLOWED_RENDERED_URI_RE =
  /^(?:(?:https?|mailto|zen|zen-asset|blob|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
const ALLOWED_RENDERED_DATA_ATTRS = [
  'data-callout',
  'data-function-plot-source',
  'data-jsxgraph-source',
  'data-local-asset-href',
  'data-local-asset-kind',
  'data-local-asset-url',
  'data-mermaid-source',
  'data-resolved-path',
  'data-tag',
  'data-tikz-source',
  'data-wikilink',
  'data-zen-diagram-expanded',
  'data-zen-diagram-kind',
  'data-zen-diagram-source'
]
let sanitizerHooksInstalled = false

function ensureSanitizerHooks(): void {
  if (sanitizerHooksInstalled) return
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== 'href' && data.attrName !== 'src' && data.attrName !== 'xlink:href') {
      return
    }
    const value = data.attrValue?.trim()
    if (value && URI_SCHEME_RE.test(value) && !ALLOWED_RENDERED_URI_SCHEME_RE.test(value)) {
      data.keepAttr = false
    }
  })
  sanitizerHooksInstalled = true
}

function sanitizeRenderedHtml(html: string): string {
  ensureSanitizerHooks()
  return DOMPurify.sanitize(html, {
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: true,
    ALLOWED_URI_REGEXP: ALLOWED_RENDERED_URI_RE,
    ADD_ATTR: ALLOWED_RENDERED_DATA_ATTRS
  })
}

function remarkWikilinks() {
  function buildWikilinkNode(bang: string, target: string, label: string): AnyNode {
    const assetKind = classifyLocalAssetHref(target)
    if (bang === '!' && assetKind === 'image') {
      return {
        type: 'image',
        url: target,
        title: null,
        alt: label
      }
    }
    if (bang === '!' && assetKind) {
      return {
        type: 'link',
        url: target,
        title: null,
        children: [{ type: 'text', value: label }]
      }
    }
    return {
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
    }
  }

  function inlineText(node: AnyNode): string | null {
    if (node.type === 'text') return String(node.value ?? '')
    const children = (node as Partial<AnyParent>).children
    if (Array.isArray(children)) {
      const parts = children.map((child) => inlineText(child))
      return parts.every((part): part is string => part != null) ? parts.join('') : null
    }
    return null
  }

  function replaceSplitWikilinks(parent: AnyParent): void {
    for (let index = 0; index < parent.children.length; index += 1) {
      const first = inlineText(parent.children[index]!)
      if (!first || !first.includes('[[')) continue

      const open = first.indexOf('[[')
      const hasBang = open > 0 && first[open - 1] === '!'
      const prefixEnd = hasBang ? open - 1 : open
      let combined = first.slice(open + 2)
      let endIndex = combined.indexOf(']]')
      let endNodeIndex = index

      while (endIndex === -1 && endNodeIndex + 1 < parent.children.length) {
        endNodeIndex += 1
        const next = inlineText(parent.children[endNodeIndex]!)
        if (next == null) return
        combined += next
        endIndex = combined.indexOf(']]')
      }

      if (endIndex === -1 || endNodeIndex === index) continue

      const raw = combined.slice(0, endIndex)
      const [rawTarget, rawLabel] = raw.split('|', 2)
      const target = rawTarget?.trim() ?? ''
      if (!target) continue

      const label = (rawLabel ?? rawTarget ?? '').trim()
      const replacement: AnyNode[] = []
      const prefix = first.slice(0, prefixEnd)
      const suffix = combined.slice(endIndex + 2)
      if (prefix) replacement.push({ type: 'text', value: prefix })
      replacement.push(buildWikilinkNode(hasBang ? '!' : '', target, label))
      if (suffix) replacement.push({ type: 'text', value: suffix })

      parent.children.splice(index, endNodeIndex - index + 1, ...replacement)
      index += replacement.length - 1
    }
  }

  return (tree: MdRoot): void => {
    visit(tree, 'paragraph', (node) => {
      replaceSplitWikilinks(node as unknown as AnyParent)
    })

    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return
      const p = parent as unknown as AnyParent
      if (p.type === 'link' || p.type === 'linkReference') return
      const value = (node as { value: string }).value
      if (!value.includes('[[')) return
      const regex = /(!?)\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g
      const next: AnyNode[] = []
      let last = 0
      let m: RegExpExecArray | null
      let changed = false
      while ((m = regex.exec(value)) !== null) {
        changed = true
        if (m.index > last) {
          next.push({ type: 'text', value: value.slice(last, m.index) })
        }
        const bang = m[1] ?? ''
        const target = m[2].trim()
        const label = (m[3] ?? m[2]).trim()
        next.push(buildWikilinkNode(bang, target, label))
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

/**
 * Rehype plugin: replace fenced blocks tagged `tikz`, `jsxgraph`, and
 * `function-plot` with placeholder divs. Each placeholder keeps the raw
 * source in a `data-*-source` attribute so the runtime side (Preview.tsx)
 * can render and re-render on demand — the same pattern as
 * `rehypeMermaid`.
 */
function rehypeMathDiagrams() {
  const map: Record<string, { className: string; sourceAttr: string }> = {
    'language-tikz': { className: 'zen-tikz', sourceAttr: 'data-tikz-source' },
    'language-jsxgraph': {
      className: 'zen-jsxgraph',
      sourceAttr: 'data-jsxgraph-source'
    },
    'language-function-plot': {
      className: 'zen-function-plot',
      sourceAttr: 'data-function-plot-source'
    },
    'language-functionplot': {
      className: 'zen-function-plot',
      sourceAttr: 'data-function-plot-source'
    }
  }
  return (tree: HastRoot): void => {
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'pre' || !parent || index === undefined) return
      const first = node.children?.[0] as HastElement | undefined
      if (!first || first.type !== 'element' || first.tagName !== 'code') return
      const classNames = (first.properties?.className as string[] | undefined) ?? []
      const matchKey = classNames.find((c) => map[c])
      if (!matchKey) return
      const entry = map[matchKey]
      const textNode = first.children?.[0] as
        | { type: string; value: string }
        | undefined
      const source = textNode && textNode.type === 'text' ? textNode.value : ''
      const replacement: HastElement = {
        type: 'element',
        tagName: 'div',
        properties: {
          className: [entry.className],
          [entry.sourceAttr]: source
        },
        children: [{ type: 'text', value: source }]
      }
      ;(parent as unknown as AnyParent).children[index] =
        replacement as unknown as AnyNode
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
  .use(rehypeMathDiagrams)
  .use(rehypeHighlight, { detect: true, ignoreMissing: true })
  .use(rehypeKatex)
  .use(rehypeStringify)

const MARKDOWN_RENDER_CACHE_LIMIT = 24
const markdownRenderCache = new Map<string, string>()

function getCachedMarkdown(src: string): string | null {
  const cached = markdownRenderCache.get(src)
  if (cached == null) return null
  markdownRenderCache.delete(src)
  markdownRenderCache.set(src, cached)
  return cached
}

function cacheRenderedMarkdown(src: string, html: string): void {
  markdownRenderCache.set(src, html)
  while (markdownRenderCache.size > MARKDOWN_RENDER_CACHE_LIMIT) {
    const oldest = markdownRenderCache.keys().next().value
    if (!oldest) break
    markdownRenderCache.delete(oldest)
  }
}

export function renderMarkdown(src: string): string {
  const cached = getCachedMarkdown(src)
  if (cached != null) {
    recordRendererPerf('markdown.render.cache-hit', 0, { chars: src.length })
    return cached
  }

  const startedAt = performance.now()
  try {
    const html = sanitizeRenderedHtml(String(processor.processSync(src)))
    cacheRenderedMarkdown(src, html)
    recordRendererPerf('markdown.render', performance.now() - startedAt, {
      chars: src.length
    })
    return html
  } catch (err) {
    recordRendererPerf('markdown.render.error', performance.now() - startedAt, {
      chars: src.length
    })
    console.error('markdown render failed', err)
    return `<pre class="text-sm text-red-600">Markdown error: ${(err as Error).message}</pre>`
  }
}
