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
import type { VFile } from 'vfile'
import { recordRendererPerf } from './perf'
import { classifyLocalAssetHref } from './local-assets'
import { parseEmbedSizeHint } from './excalidraw-preview'
import { parseColWidthsComment } from './markdown-table'

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
  'data-embed-src',
  'data-embed-height',
  'data-embed-width',
  'data-excalidraw-embed',
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
    if (bang === '!' && assetKind === 'excalidraw') {
      const size = parseEmbedSizeHint(label)
      const w = size?.width ? ` data-embed-width="${size.width}"` : ''
      const h = size?.height ? ` data-embed-height="${size.height}"` : ''
      const safeTarget = target.replace(/"/g, '&quot;')
      return {
        type: 'html',
        value: `<div class="excalidraw-embed-host" data-excalidraw-embed="${safeTarget}"${w}${h}></div>`
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
      const regex = /(^|\s)#(\p{L}[\p{L}\d_/-]*)/gu
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
 * Remark plugin: `==text==` → `<mark>` (Obsidian-style highlight). Colored
 * highlights are authored as raw `<mark class="hl-green">…</mark>` HTML and ride
 * through `rehypeRaw`; this plugin only handles the bare `==…==` shorthand,
 * which maps to the default highlight color. Inline code is a separate mdast
 * node (not a `text` child), so code spans are skipped automatically.
 */
function remarkHighlight() {
  return (tree: MdRoot): void => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return
      const p = parent as unknown as AnyParent
      if (p.type === 'link' || p.type === 'linkReference') return
      const value = (node as { value: string }).value
      if (!value.includes('==')) return
      // `==text==`: non-space just inside each `==`, shortest content, so
      // `==a== ==b==` is two marks and `x == y` (spaced) never matches.
      const regex = /==(?=\S)([\s\S]*?\S)==/g
      const next: AnyNode[] = []
      let last = 0
      let m: RegExpExecArray | null
      let changed = false
      while ((m = regex.exec(value)) !== null) {
        if (m.index > last) next.push({ type: 'text', value: value.slice(last, m.index) })
        next.push({
          type: 'emphasis',
          data: { hName: 'mark' },
          children: [{ type: 'text', value: m[1] }]
        })
        last = regex.lastIndex
        changed = true
      }
      if (!changed) return
      if (last < value.length) next.push({ type: 'text', value: value.slice(last) })
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

/**
 * Honor a `<!-- zen:cols=120,auto,90 -->` width hint that follows a table (#294):
 * turn it into a <colgroup> so the preview and PDF export render the columns at
 * the widths set by the live-table resize handles. The comment node itself is
 * dropped by the sanitizer. Runs after rehypeRaw so the comment is a hast node.
 */
function rehypeTableColWidths() {
  return (tree: HastRoot): void => {
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'table' || !parent || index === undefined) return
      const siblings = (parent as unknown as AnyParent).children
      let j = index + 1
      while (
        j < siblings.length &&
        siblings[j]?.type === 'text' &&
        String((siblings[j] as { value?: string }).value ?? '').trim() === ''
      ) {
        j++
      }
      const sib = siblings[j] as (AnyNode & { value?: string }) | undefined
      if (!sib || sib.type !== 'comment' || typeof sib.value !== 'string') return
      const widths = parseColWidthsComment(`<!--${sib.value}-->`)
      if (!widths || !widths.some((w) => w != null)) return
      const colgroup = {
        type: 'element',
        tagName: 'colgroup',
        properties: {},
        children: widths.map((w) => ({
          type: 'element',
          tagName: 'col',
          properties: w != null ? { style: `width:${w}px` } : {},
          children: []
        }))
      } as unknown as HastElement
      node.children = [colgroup, ...(node.children ?? [])] as HastElement['children']
      const cls = (node.properties?.className as string[] | undefined) ?? []
      node.properties = { ...(node.properties ?? {}), className: [...cls, 'zen-has-col-widths'] }
    })
  }
}

/**
 * Stamp each top-level block with `data-source-line` (its 1-based start line in
 * the markdown source), so the split-view preview can be scroll-synced to the
 * editor by mapping the editor's top line to the matching rendered element
 * instead of by a raw scroll ratio (which drifts when the two heights differ).
 * Applied via `data.hProperties` so `remarkRehype` carries it onto the element.
 */
function remarkSourceLines() {
  return (tree: MdRoot): void => {
    for (const node of tree.children) {
      const line = node.position?.start?.line
      if (line == null) continue
      const data = (node.data ??= {})
      const hProperties = ((data.hProperties ??= {}) as Record<string, unknown>)
      hProperties['data-source-line'] = line
    }
  }
}

/**
 * Genuine inline math (mirrors the live editor's `INLINE_MATH_RE`): a single `$`
 * on each side with no whitespace immediately inside either delimiter. The
 * anchored form is tested against the raw `$…$` source token.
 */
const STRICT_INLINE_MATH_RE = /^\$(?!\s)(?:\\.|[^$\\])*(?<!\s)\$$/

/**
 * remark-math is more permissive than the editor: it renders `$5 and got $10` as
 * a formula (the content only has to avoid *both-sided* padding), so a currency
 * line shows up as math in the reading view while the editor keeps it literal.
 * Re-check every inline-math node against the editor's stricter rule using the
 * original source, and turn currency-like matches back into plain text so the two
 * views agree. Runs right after remark-math, before the node becomes a KaTeX span.
 */
function remarkCurrencyGuard() {
  return (tree: MdRoot, file: VFile): void => {
    const raw = file?.value
    const source = typeof raw === 'string' ? raw : raw != null ? String(raw) : ''
    if (!source.includes('$')) return
    visit(tree, 'inlineMath', (node, index, parent) => {
      if (!parent || index === undefined) return
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (start == null || end == null) return
      const token = source.slice(start, end)
      if (STRICT_INLINE_MATH_RE.test(token)) return
      ;(parent as unknown as AnyParent).children.splice(index, 1, { type: 'text', value: token })
      return [SKIP, index + 1]
    })
  }
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkMath)
  .use(remarkCurrencyGuard)
  .use(remarkWikilinks)
  .use(remarkHashtags)
  .use(remarkHighlight)
  .use(remarkCallouts)
  .use(remarkSourceLines)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeTableColWidths)
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

/**
 * GFM splits table cells on every `|`, including pipes inside inline math, so
 * `| $P(A|B)$ |` is torn apart before remark-math ever sees it (#319). Escape a
 * raw `|` when it falls inside an inline `$...$` span on a table row: GFM then
 * treats it as a literal pipe and unescapes it back to `|` for the cell, so the
 * math renders. Currency like `| $5 | $10 |` is left alone, because the span
 * rule (no whitespace just inside the `$` delimiters) never matches it.
 */
function escapeTableMathPipes(src: string): string {
  if (!src.includes('|') || !src.includes('$')) return src
  const lines = src.split('\n')
  // A GFM delimiter row: only spaces, pipes, colons, dashes, with a pipe and a
  // dash. The line above it (the header) must also look like a table row.
  const delimiter = /^[\s|:-]*-[\s|:-]*$/
  const isTableRow = new Array<boolean>(lines.length).fill(false)
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes('|') && delimiter.test(lines[i]) && lines[i - 1].includes('|')) {
      isTableRow[i - 1] = true
      isTableRow[i] = true
      for (
        let j = i + 1;
        j < lines.length && lines[j].trim() !== '' && lines[j].includes('|');
        j++
      ) {
        isTableRow[j] = true
      }
    }
  }
  // Inline math: opening `$` not escaped and not followed by space; closing `$`
  // not preceded by space. Mirrors remark-math so currency is not matched.
  const mathSpan = /(?<!\\)\$(?!\s)((?:\\.|[^$\\])+?)(?<!\s)\$/g
  let changed = false
  const out = lines.map((line, i) => {
    if (!isTableRow[i] || !line.includes('$') || !line.includes('|')) return line
    return line.replace(mathSpan, (whole, inner: string) => {
      if (!inner.includes('|')) return whole
      changed = true
      return `$${inner.replace(/(?<!\\)\|/g, '\\|')}$`
    })
  })
  return changed ? out.join('\n') : src
}

/**
 * remark-math only closes a `$$` block on a line containing nothing but the
 * closing fence, while the editor's live preview (cm-math-render) also accepts
 * content hugging a fence: a closing `$$` at the end of the last content line,
 * or a whole `$$x^2$$` block on one line (#399). Rewrite those editor-legal
 * shapes into the canonical fence-on-its-own-line form so the reading view
 * parses exactly what the editor renders. Fenced code is left untouched, and
 * anything the editor itself rejects (mid-line `$$`, empty or unclosed blocks)
 * passes through unchanged — canonical notes come back byte-identical.
 */
function normalizeBlockMathFences(src: string): string {
  if (!src.includes('$$')) return src
  const lines = src.split('\n')
  const out: string[] = []
  let changed = false
  let codeFence: string | null = null
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (codeFence) {
      out.push(raw)
      if (trimmed.startsWith(codeFence)) codeFence = null
      i++
      continue
    }
    const fence = trimmed.match(/^(`{3,}|~{3,})/)
    if (fence) {
      out.push(raw)
      codeFence = fence[1]
      i++
      continue
    }
    const open = raw.match(/^( {0,3})\$\$(?!\$)(.*)$/)
    if (!open) {
      out.push(raw)
      i++
      continue
    }
    const indent = open[1]
    const rest = open[2]
    const restTrimmed = rest.trim()
    if (restTrimmed.includes('$$')) {
      // `$$x^2$$` on one line: expand it. Anything else with a `$$` mid-line
      // (`$$a$$b`, `$$ $$`) is rejected by the editor too — pass through.
      if (restTrimmed.endsWith('$$') && restTrimmed.indexOf('$$') === restTrimmed.length - 2) {
        const inner = restTrimmed.slice(0, -2)
        if (inner.trim() !== '') {
          out.push(`${indent}$$`, inner, `${indent}$$`)
          changed = true
          i++
          continue
        }
      }
      out.push(raw)
      i++
      continue
    }
    // Multi-line block: find the closing fence, giving up at the first `$$`
    // the editor's whole-line rule would reject.
    let close = -1
    let closeHasContent = false
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k].trim()
      if (!t.includes('$$')) continue
      if (t === '$$') {
        close = k
      } else if (t.endsWith('$$') && t.indexOf('$$') === t.length - 2) {
        close = k
        closeHasContent = true
      }
      break
    }
    if (close === -1 || (restTrimmed === '' && !closeHasContent)) {
      // Unclosed, editor-rejected, or already canonical: leave untouched.
      out.push(raw)
      i++
      continue
    }
    out.push(`${indent}$$`)
    if (restTrimmed !== '') {
      out.push(rest)
      changed = true
    }
    for (let k = i + 1; k < close; k++) out.push(lines[k])
    if (closeHasContent) {
      const rawClose = lines[close]
      const idx = rawClose.lastIndexOf('$$')
      out.push(rawClose.slice(0, idx), `${indent}$$`)
      changed = true
    } else {
      out.push(lines[close])
    }
    i = close + 1
  }
  return changed ? out.join('\n') : src
}

export function renderMarkdown(src: string): string {
  const cached = getCachedMarkdown(src)
  if (cached != null) {
    recordRendererPerf('markdown.render.cache-hit', 0, { chars: src.length })
    return cached
  }

  const startedAt = performance.now()
  try {
    const html = sanitizeRenderedHtml(
      String(processor.processSync(escapeTableMathPipes(normalizeBlockMathFences(src))))
    )
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
