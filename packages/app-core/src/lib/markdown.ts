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
import { trailingBlockIdRange } from './block-anchors'
import { wikilinkDisplayLabel } from './wikilinks'
import { classifyLocalAssetHref } from './local-assets'
import { parseEmbedSizeHint, splitEmbedLabel } from './excalidraw-preview'
import { parseColWidthsComment } from './markdown-table'
import { scanTaskMetadata, type TaskMetaToken } from './task-metadata-tokens'
import { rollupChildDone, rollupCountsChild, rollupLabel, type ChildTaskState } from './task-rollup'
import {
  customCodeLanguageRegistry,
  PREVIEW_TOKEN_CLASS
} from './custom-code-languages'
import {
  markdownLooseMathDelimiters,
  markdownMathRenderer,
  markdownSettingsRevision
} from './markdown-settings'
import { numberLatexEquationEnvironments } from './latex-equation-numbering'

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
  'data-bookmark-url',
  'data-callout',
  'data-embed-src',
  'data-embed-url',
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
  'data-typst-display',
  'data-typst-source',
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

/**
 * Drop the trailing `^block-id` marker from rendered prose. It names the block
 * so `[[Note^id]]` can point at it, which is addressing rather than something
 * to read, and the editor's live preview hides it for the same reason. Code
 * spans and fences are untouched: those are `inlineCode` / `code` nodes, which
 * this never visits. (#601)
 */
function remarkBlockIds() {
  return (tree: MdRoot): void => {
    visit(tree, 'text', (node) => {
      const text = node as AnyNode & { value?: string }
      if (typeof text.value !== 'string') return
      const marker = trailingBlockIdRange(text.value)
      // A marker alone on its line has nothing left to attach to, so leave it
      // rather than rendering an empty paragraph.
      if (!marker || marker.from === 0) return
      text.value = text.value.slice(0, marker.from).replace(/[ \t]+$/, '')
    })
  }
}

function remarkWikilinks() {
  function buildWikilinkNode(bang: string, target: string, label: string): AnyNode {
    const assetKind = classifyLocalAssetHref(target)
    if (bang === '!' && assetKind === 'image') {
      return {
        type: 'image',
        url: target,
        title: null,
        alt: label,
        // Marks the label as wikilink-sourced for remarkImageSizeHints: a
        // bare `600x400` is a size hint there, but ordinary markdown alt
        // text keeps it as the caption.
        data: { zenWikilinkEmbed: true }
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
    // A generic non-previewable file embedded as `![[file.tldraw]]` becomes an
    // image node so it flows through the same attachment-chip path as
    // `![](file.tldraw)`. PDF/audio/video keep their rich embeds (link node
    // below → media embed). (#463)
    if (bang === '!' && assetKind === 'file') {
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
      // An un-aliased anchored link would otherwise read `Daily Note^note-two`
      // mid-sentence; the label is `target` exactly when no alias was
      // given. (#601)
      children: [
        { type: 'text', value: label === target ? wikilinkDisplayLabel(target) : label }
      ]
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
 * The task states markdown itself does not know. GFM understands `[ ]` and
 * `[x]` only, so ZenNotes' other three states arrive here as a plain list item
 * whose text happens to start with `[/]`, `[-]` or `[>]` — which is exactly how
 * they used to render: as literal characters, in the preview, in HTML and PDF
 * export, and in a note shared with someone through the public viewer, while
 * the editor drew a proper marker for the same line. (#316, #450, #512)
 */
const NON_GFM_TASK_STATES: Record<string, { state: string; label: string }> = {
  '/': { state: 'in-progress', label: 'In progress' },
  '-': { state: 'cancelled', label: 'Cancelled' },
  '>': { state: 'forwarded', label: 'Forwarded to another note' }
}
// The marker must be followed by a space (or end the item), so `[-]this` and a
// stray `[>]` mid-sentence are left alone.
const NON_GFM_TASK_RE = /^\[([/>-])\](?:[ \t]+|$)/

/**
 * Remark plugin: give `- [/]`, `- [-]` and `- [>]` items the same shape as a
 * GFM task item — the `task-list-item` class (so they line up in the list
 * gutter with real checkboxes) plus a state marker span the CSS draws, in
 * place of the literal `[/]` text.
 *
 * The state is also recorded on the node as `zenTaskState`, which is what
 * `remarkTaskMetadata` keys off to chip `due:`/`!high` on these lines too, and
 * what makes them countable as tasks when the preview maps a clicked checkbox
 * back to its line.
 */
function remarkTaskStates() {
  return (tree: MdRoot): void => {
    visit(tree, 'listItem', (node) => {
      const item = node as unknown as AnyParent & {
        checked?: boolean | null
        data?: Record<string, unknown>
      }
      // A real GFM task already renders a checkbox; leave it alone.
      if (item.checked !== null && item.checked !== undefined) return
      const para = item.children[0] as (AnyNode & { children?: AnyNode[] }) | undefined
      if (!para || para.type !== 'paragraph' || !Array.isArray(para.children)) return
      const first = para.children[0] as (AnyNode & { value?: string }) | undefined
      if (!first || first.type !== 'text' || typeof first.value !== 'string') return
      const match = first.value.match(NON_GFM_TASK_RE)
      if (!match) return
      const { state, label } = NON_GFM_TASK_STATES[match[1]]

      first.value = first.value.slice(match[0].length)
      para.children.unshift({
        type: 'emphasis',
        data: {
          hName: 'span',
          hProperties: {
            className: ['zen-task-state', `zen-task-state-${state}`],
            title: label
          }
        },
        children: []
      } as AnyNode)

      const data = (item.data ??= {})
      data.zenTaskState = state
      const hProperties = ((data.hProperties ??= {}) as Record<string, unknown>)
      const existing = hProperties.className
      hProperties.className = [
        ...(Array.isArray(existing) ? (existing as string[]) : []),
        'task-list-item',
        `zen-task-${state}`
      ]
    })
  }
}

/**
 * Remark plugin: a parent task with subtasks shows its children's progress as
 * a `2/5` chip, derived at render time and never written into the markdown
 * (#512: the vault stays the single source of truth no matter who edits it).
 * Counts direct children only, one nesting level down; the state semantics
 * (cancelled and forwarded children out of the denominator, in-progress not
 * yet done) are shared with the editor widget via `task-rollup.ts`, so both
 * renderers always show the same number. Runs after `remarkTaskStates` so the
 * non-GFM child states are already on the nodes.
 */
function remarkTaskRollup() {
  return (tree: MdRoot): void => {
    visit(tree, 'listItem', (node) => {
      const item = node as unknown as AnyParent & {
        checked?: boolean | null
        data?: { zenTaskState?: string }
      }
      const isTask = item.checked != null || item.data?.zenTaskState != null
      if (!isTask) return

      let done = 0
      let total = 0
      for (const child of item.children) {
        if ((child as AnyNode).type !== 'list') continue
        for (const li of (child as unknown as AnyParent).children) {
          const sub = li as unknown as {
            type: string
            checked?: boolean | null
            data?: { zenTaskState?: string }
          }
          if (sub.type !== 'listItem') continue
          const state =
            sub.checked === true
              ? 'done'
              : sub.checked === false
                ? 'open'
                : (sub.data?.zenTaskState as ChildTaskState | undefined)
          if (!state || !rollupCountsChild(state)) continue
          total += 1
          if (rollupChildDone(state)) done += 1
        }
      }
      if (total === 0) return

      const para = item.children[0] as (AnyNode & { children?: AnyNode[] }) | undefined
      if (!para || para.type !== 'paragraph' || !Array.isArray(para.children)) return
      const label = rollupLabel({ done, total })
      para.children.push({
        type: 'emphasis',
        data: {
          hName: 'span',
          hProperties: {
            className:
              done === total
                ? ['zen-task-meta', 'zen-task-rollup', 'zen-task-rollup-complete']
                : ['zen-task-meta', 'zen-task-rollup'],
            title: label,
            'aria-label': label
          }
        },
        children: [{ type: 'text', value: `${done}/${total}` }]
      } as AnyNode)
    })
  }
}

/**
 * Remark plugin: task metadata (`!high`, `due:2026-01-31`, `@waiting`) inside a
 * task list item becomes chips, matching what the editor shows for the same
 * line (#454, #479). Every task item is scanned: the GFM ones (`listItem.checked`
 * is non-null exactly for those) plus the states `remarkTaskStates` marked. Only
 * their own content, though — nested lists are skipped here because each nested
 * item is visited in its own right.
 *
 * Inline code is a separate mdast node, so `` `!high` `` is never touched.
 * The due chip carries `data-due` rather than an overdue class: whether a date
 * is overdue depends on today, which the rendered HTML outlives (it is cached),
 * so the Preview component decides that when it attaches the DOM.
 */
function remarkTaskMetadata() {
  const SKIP_TYPES = new Set(['list', 'link', 'linkReference', 'inlineCode', 'code', 'html'])

  const chipFor = (token: TaskMetaToken): AnyNode => {
    const className =
      token.kind === 'priority'
        ? ['zen-task-prio', `zen-task-prio-${token.level}`]
        : token.kind === 'due'
          ? ['zen-task-meta', 'zen-task-due']
          : ['zen-task-meta', 'zen-task-field']
    const hProperties: Record<string, unknown> = { className }
    if (token.kind === 'due' && token.date) hProperties['data-due'] = token.date
    return {
      type: 'emphasis',
      data: { hName: 'span', hProperties },
      children: [{ type: 'text', value: token.text }]
    } as AnyNode
  }

  const splitText = (parent: AnyParent, index: number): number => {
    const value = (parent.children[index] as unknown as { value: string }).value
    const tokens = scanTaskMetadata(value)
    if (tokens.length === 0) return 1
    const next: AnyNode[] = []
    let last = 0
    for (const token of tokens) {
      if (token.start > last) {
        next.push({ type: 'text', value: value.slice(last, token.start) } as AnyNode)
      }
      next.push(chipFor(token))
      last = token.end
    }
    if (last < value.length) {
      next.push({ type: 'text', value: value.slice(last) } as AnyNode)
    }
    parent.children.splice(index, 1, ...next)
    return next.length
  }

  const walk = (parent: AnyParent): void => {
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i] as AnyNode & { children?: AnyNode[] }
      if (SKIP_TYPES.has(child.type)) continue
      if (child.type === 'text') {
        i += splitText(parent, i) - 1
        continue
      }
      if (Array.isArray(child.children)) walk(child as unknown as AnyParent)
    }
  }

  return (tree: MdRoot): void => {
    visit(tree, 'listItem', (node) => {
      const item = node as unknown as AnyParent & {
        checked?: boolean | null
        data?: { zenTaskState?: string }
      }
      const isTask = item.checked != null || item.data?.zenTaskState != null
      if (!isTask) return
      walk(item)
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
/** Honor Obsidian-style size hints on image embeds (#570). Both spellings
 *  arrive here as image nodes with the hint in their alt: `![[img|600x400]]`
 *  via remarkWikilinks (the whole label is the hint) and `![alt|600](img)`
 *  straight from the markdown alt text. The hint is stripped from the alt and
 *  applied through hProperties so remarkRehype writes real width/height
 *  attributes. Attachment chips (non-image files riding the image node type)
 *  keep their labels untouched: only image-classified and remote urls
 *  participate. */
function remarkImageSizeHints() {
  return (tree: MdRoot): void => {
    visit(tree, 'image', (node) => {
      const image = node as unknown as AnyNode
      const url = String(image.url ?? '')
      const isRemote = /^(https?:|data:)/i.test(url)
      if (!isRemote && classifyLocalAssetHref(url) !== 'image') return
      const fromWikilink =
        (image.data as { zenWikilinkEmbed?: boolean } | undefined)?.zenWikilinkEmbed === true
      const { alt, size } = splitEmbedLabel(
        typeof image.alt === 'string' ? image.alt : '',
        fromWikilink ? 'wikilink' : 'markdown'
      )
      if (!size) return
      image.alt = alt
      const data = (image.data ??= {}) as { hProperties?: Record<string, unknown> }
      const hProperties = (data.hProperties ??= {})
      if (size.width) hProperties.width = size.width
      if (size.height) hProperties.height = size.height
    })
  }
}

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

      // The marker must open the paragraph and be followed by whitespace (or
      // nothing). The title is EVERYTHING else on the first line, inline
      // nodes included — a [link](x) or $math$ in the title used to be
      // orphaned into an uncolored body paragraph, because only this leading
      // text fragment was consulted for the title. (#549)
      const marker = firstText.value.match(/^\[!(\w+)\](?:[ \t]+|(?=\n)|$)/)
      if (!marker) return
      const type = marker[1].toLowerCase()

      // Split the paragraph's inline children into the title line and the
      // body. remark-breaks runs earlier, so soft breaks arrive as `break`
      // nodes and the first one ends the title; the delimiter itself is
      // dropped, or the body paragraph opens with a stray <br> that reads as
      // a phantom empty line. Raw newlines are handled too, in case the
      // plugin ever runs without remark-breaks.
      type Inline = (typeof first.children)[number]
      const titleChildren: Inline[] = []
      const bodyChildren: Inline[] = []
      let inBody = false
      const pushText = (value: string, into: Inline[]): void => {
        if (value !== '') into.push({ type: 'text', value } as Inline)
      }
      first.children.forEach((child, i) => {
        if (inBody) {
          bodyChildren.push(child)
          return
        }
        if (child.type === 'break') {
          inBody = true
          return
        }
        if (i === 0 || child.type === 'text') {
          const value =
            i === 0 ? firstText.value.slice(marker[0].length) : (child as { value: string }).value
          const nl = value.indexOf('\n')
          if (nl >= 0) {
            pushText(value.slice(0, nl), titleChildren)
            pushText(value.slice(nl + 1), bodyChildren)
            inBody = true
          } else {
            pushText(value, titleChildren)
          }
          return
        }
        titleChildren.push(child)
      })

      const hasTitle = titleChildren.some(
        (child) => child.type !== 'text' || (child as { value: string }).value.trim() !== ''
      )
      const fallbackTitle = type.charAt(0).toUpperCase() + type.slice(1)

      if (bodyChildren.length > 0) {
        first.children = bodyChildren
      } else {
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
        children: hasTitle ? titleChildren : [{ type: 'text', value: fallbackTitle }]
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
    },
    // A ```embed fence holds a URL (YouTube, etc.) rendered as an iframe by
    // `renderEmbeds`. The runtime replaces the placeholder with the player.
    'language-embed': { className: 'zen-embed', sourceAttr: 'data-embed-url' },
    // A ```bookmark fence holds a URL rendered as a rich link card (favicon /
    // title / description / preview) by `renderBookmarks`.
    'language-bookmark': { className: 'zen-bookmark', sourceAttr: 'data-bookmark-url' }
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

/** Highlight unknown fenced tags through the user-installed TextMate registry. */
function rehypeCustomCodeLanguages() {
  return (tree: HastRoot): void => {
    // Skip the tree walk when no grammar is installed — the usual case.
    if (customCodeLanguageRegistry.isEmpty) return
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'code') return
      const classNames = (node.properties?.className as string[] | undefined) ?? []
      const languageClass = classNames.find((name) => name.startsWith('language-'))
      if (!languageClass) return
      const tag = languageClass.slice('language-'.length)
      if (!customCodeLanguageRegistry.resolve(tag)) return
      const textContent = (child: HastElement['children'][number]): string => {
        if (child.type === 'text') return child.value
        if (child.type === 'element') return child.children.map(textContent).join('')
        return ''
      }
      const source = node.children.map(textContent).join('')
      const tokens = customCodeLanguageRegistry.tokenize(tag, source)
      if (tokens.length === 0) return
      const children: HastElement['children'] = []
      let offset = 0
      for (const token of tokens) {
        if (token.from > offset) children.push({ type: 'text', value: source.slice(offset, token.from) })
        children.push({
          type: 'element',
          tagName: 'span',
          properties: { className: PREVIEW_TOKEN_CLASS[token.kind].split(' ') },
          children: [{ type: 'text', value: source.slice(token.from, token.to) }]
        })
        offset = token.to
      }
      if (offset < source.length) children.push({ type: 'text', value: source.slice(offset) })
      node.children = children
      node.properties = {
        ...node.properties,
        className: Array.from(new Set([...classNames, 'hljs']))
      }
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
 * Mid-line `$$…$$` with non-empty content, the shape remark-math parses as an
 * inline-math node when display math lives inside other markdown (a table
 * cell, in practice). Two dollars on each side can never be currency, so the
 * guard lets these through where the single-`$` rule would demote them.
 */
const CELL_DISPLAY_MATH_RE = /^\$\$[\s\S]+\$\$$/

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
      // `$$…$$` in a table cell: genuine display math, not currency. The
      // editor's table widget renders it in display mode, so swap the node's
      // math-inline class for math-display (rehype-katex keys displayMode off
      // it) and flag it for the Typst placeholder plugin, which overwrites
      // hProperties wholesale and cannot see the class. Cell-scoped on
      // purpose: in prose the editor leaves mid-line `$$…$$` literal (#399),
      // so the reading view must keep demoting it there.
      const mathNode = node as typeof node & { value?: string; data?: Record<string, unknown> }
      if (
        (parent as { type?: string }).type === 'tableCell' &&
        CELL_DISPLAY_MATH_RE.test(token) &&
        String(mathNode.value ?? '').trim() !== ''
      ) {
        const data = (mathNode.data ??= {})
        data.zenDisplayMath = true
        const hProperties = ((data.hProperties ??= {}) as Record<string, unknown>)
        const classes = Array.isArray(hProperties.className)
          ? (hProperties.className as string[]).filter((c) => c !== 'math-inline')
          : []
        hProperties.className = [...classes, 'math-display']
        return
      }
      ;(parent as unknown as AnyParent).children.splice(index, 1, { type: 'text', value: token })
      return [SKIP, index + 1]
    })
  }
}

function remarkNumberLatexEquations() {
  return (tree: MdRoot): void => {
    let equationNumber = 0
    visit(tree, 'math', (node) => {
      const mathNode = node as AnyNode & { value?: string }
      const numbered = numberLatexEquationEnvironments(
        String(mathNode.value ?? ''),
        equationNumber
      )
      mathNode.value = numbered.latex
      const hChildren = (
        mathNode.data as
          | { hChildren?: Array<{ children?: Array<{ value?: string }> }> }
          | undefined
      )?.hChildren
      const hastText = hChildren?.[0]?.children?.[0]
      if (hastText) hastText.value = numbered.latex
      equationNumber = numbered.nextNumber
    })
  }
}

/**
 * Remark plugin (Typst renderer only): rewrite `$…$` / `$$…$$` math nodes into
 * `.zen-typst-math` placeholders carrying the raw Typst source, instead of
 * letting rehype-katex bake KaTeX HTML. The runtime (`renderTypstMath` in
 * `typst-math-render.ts`, invoked from Preview.tsx) fills each placeholder with
 * a compiled SVG (the same placeholder-then-render pattern the diagram blocks
 * use). Runs after remark-math so the math nodes already exist.
 */
function remarkTypstMathPlaceholders() {
  return (tree: MdRoot): void => {
    visit(tree, ['math', 'inlineMath'], (node) => {
      const mathNode = node as AnyNode & { value?: string; data?: Record<string, unknown> }
      // zenDisplayMath: a `$$…$$` living inside a table cell, flagged by the
      // currency guard; inline position, display rendering.
      const display = mathNode.type === 'math' || mathNode.data?.zenDisplayMath === true
      const value = String(mathNode.value ?? '')
      const data = (mathNode.data ??= {})
      data.hName = display ? 'div' : 'span'
      data.hProperties = {
        className: display
          ? ['zen-typst-math', 'zen-typst-display']
          : ['zen-typst-math'],
        'data-typst-source': value,
        'data-typst-display': display ? 'true' : 'false'
      }
      data.hChildren = [{ type: 'text', value }]
    })
  }
}

/**
 * Build the markdown → HTML processor for a given math renderer. Everything is
 * shared except the math step: KaTeX bakes formulas into HTML via rehype-katex;
 * Typst emits placeholders (rehype-katex is omitted) for the runtime to render.
 */
function createProcessor(mathRenderer: 'katex' | 'typst') {
  const base = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkGfm)
    .use(remarkBreaks)
    .use(remarkMath)
    .use(remarkCurrencyGuard)

  const withTypst =
    mathRenderer === 'typst'
      ? base.use(remarkTypstMathPlaceholders)
      : base.use(remarkNumberLatexEquations)

  const rehyped = withTypst
    // Before the wikilink/hashtag splitters, so the state marker is still the
    // head of one unsplit text node when it is matched.
    .use(remarkTaskStates)
    .use(remarkTaskRollup)
    .use(remarkBlockIds)
    .use(remarkWikilinks)
    .use(remarkImageSizeHints)
    .use(remarkHashtags)
    .use(remarkTaskMetadata)
    .use(remarkHighlight)
    .use(remarkCallouts)
    .use(remarkSourceLines)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeTableColWidths)
    .use(rehypeMermaid)
    .use(rehypeMathDiagrams)
    .use(rehypeHighlight, { detect: true, ignoreMissing: true })
    // After rehype-highlight so a user-installed TextMate grammar wins over
    // highlight.js' guess for a fence tag it does not actually know.
    .use(rehypeCustomCodeLanguages)

  const withKatex =
    mathRenderer === 'katex' ? rehyped.use(rehypeKatex) : rehyped

  return withKatex.use(rehypeStringify)
}

const katexProcessor = createProcessor('katex')
let typstProcessor: ReturnType<typeof createProcessor> | null = null

// Which typesetter `renderMarkdown` uses, and whether `$$` delimiters are
// relaxed, both live in `./markdown-settings` so that pushing a setting down
// (App.tsx does, on every pref change) does not make this whole module — and
// with it remark/rehype/highlight — a static dependency of the app entry.
// A switch invalidates cached HTML through the revision in the cache key rather
// than by clearing the cache from the setter.
function activeProcessor() {
  if (markdownMathRenderer() === 'typst') {
    return (typstProcessor ??= createProcessor('typst'))
  }
  return katexProcessor
}

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
function normalizeBlockMathFences(src: string, loose = false): string {
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
    // Opening fence: strict is `$$` at line start; loose also accepts prose
    // before a `$$` that ends the line (`Note: $$`), splitting the prose off.
    let indent: string | null = null
    let rest = ''
    let proseBefore = ''
    const strictOpen = raw.match(/^( {0,3})\$\$(?!\$)(.*)$/)
    if (strictOpen) {
      indent = strictOpen[1]
      rest = strictOpen[2]
    } else if (loose) {
      const looseOpen = raw.match(/^( {0,3})(.+?)\s*\$\$(?!\$)\s*$/)
      if (looseOpen && !looseOpen[2].includes('$$')) {
        indent = looseOpen[1]
        proseBefore = looseOpen[2]
      }
    }
    if (indent === null) {
      out.push(raw)
      i++
      continue
    }
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
    // the editor's whole-line rule would reject. In loose mode, prose after
    // the close fence (`$$ done`) is also accepted and split off.
    let close = -1
    let closeHasContent = false
    let closeTrailing = ''
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k].trim()
      if (!t.includes('$$')) continue
      if (t === '$$') {
        close = k
      } else if (t.endsWith('$$') && t.indexOf('$$') === t.length - 2) {
        close = k
        closeHasContent = true
      } else if (loose) {
        // `$$ done` (prose after the close) or `x^2$$ done` (content + prose).
        const trailing = t.match(/^(.*?)\$\$(?!\$)\s+(\S.*)$/)
        if (trailing && !trailing[1].includes('$$')) {
          close = k
          if (trailing[1].trim() !== '') closeHasContent = true
          closeTrailing = trailing[2]
        }
      }
      break
    }
    const alreadyCanonical =
      restTrimmed === '' && !closeHasContent && proseBefore === '' && closeTrailing === ''
    if (close === -1 || alreadyCanonical) {
      // Unclosed, editor-rejected, or already canonical: leave untouched.
      out.push(raw)
      i++
      continue
    }
    if (proseBefore !== '') {
      // Prose leading the open fence becomes its own paragraph.
      out.push(`${indent}${proseBefore}`, '')
      changed = true
    }
    out.push(`${indent}$$`)
    if (restTrimmed !== '') {
      out.push(rest)
      changed = true
    }
    for (let k = i + 1; k < close; k++) out.push(lines[k])
    if (closeTrailing !== '') {
      // Loose close: `[content]$$ trailing` -> content, `$$`, blank, trailing.
      const rawClose = lines[close]
      const idx = rawClose.lastIndexOf('$$')
      const beforeDollar = rawClose.slice(0, idx)
      if (beforeDollar.trim() !== '') out.push(beforeDollar)
      out.push(`${indent}$$`, '', `${indent}${closeTrailing}`)
      changed = true
    } else if (closeHasContent) {
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
  const cacheKey = `${customCodeLanguageRegistry.revision}\0${markdownSettingsRevision()}\0${src}`
  const cached = getCachedMarkdown(cacheKey)
  if (cached != null) {
    recordRendererPerf('markdown.render.cache-hit', 0, { chars: src.length })
    return cached
  }

  const startedAt = performance.now()
  try {
    const html = sanitizeRenderedHtml(
      String(
        activeProcessor().processSync(
          escapeTableMathPipes(normalizeBlockMathFences(src, markdownLooseMathDelimiters()))
        )
      )
    )
    cacheRenderedMarkdown(cacheKey, html)
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
