/**
 * Remark plugin: `:::` container blocks for Payer-style containers.
 *
 * Uses `remark-directive` (installed) to parse `:::` fences,
 * then transforms directive nodes into styled container elements
 * via hName/hProperties (the remark-rehype bridge).
 *
 * Supported container types (from Payer's qa_viewer.html):
 *   grammar-box, grammar-box2, media, center, metrik-schema,
 *   important, deleteme-box, note-box, laut-table,
 *   indent, compact, no-header
 *
 * Syntax:
 *   ::: grammar-box[Optional title]
 *   content
 *   :::
 *
 * The optional title in `[brackets]` is extracted from the first line
 * of the container body and rendered as `.md-box__title`.
 */
import { visit, SKIP } from 'unist-util-visit'
import type { Content } from 'mdast'

type AnyParent = { type: string; children: Content[] }

const CONTAINER_KINDS: Record<string, string> = {
  'grammarbox':     'grammarbox',
  'grammarbox2':    'grammarbox2',
  'grammar-box':    'grammarbox',
  'grammar-box2':   'grammarbox2',
  'media':          'media',
  'center':         'center',
  'metrik-schema':  'metrik-schema',
  'important':      'important',
  'deleteme-box':   'deleteme-box',
  'note-box':       'note-box',
  'laut-table':     'laut-table',
  'indent':         'indent',
  'compact':        'compact',
  'no-header':      'no-header',
  'hidden':         'hidden',
}

/** Extract title from `[brackets]` at the start of a text node. */
function extractTitle(text: string): [string | null, string] {
  const m = text.match(/^\[([^\]]*)\]\s*(.*)/s)
  if (m) {
    const title = m[1].trim()
    return [title.length > 0 ? title : null, m[2]]
  }
  return [null, text]
}


/**
 * Remark plugin that converts `containerDirective` nodes (from
 * `remark-directive`) into our styled container `<div>` elements.
 *
 * Uses the hName/hProperties bridge so remark-rehype generates the
 * correct HTML structure, preserving sandboxed rendering.
 *
 * Must be placed **after** `remarkDirective` in the processor pipeline.
 */
import type { ContainerDirective } from 'mdast-util-directive'

export default function remarkBoxes(this: unknown): (tree: import('mdast').Root) => void {
  return (tree: import('mdast').Root): void => {
    visit(tree, 'containerDirective', (node: ContainerDirective, index: number | undefined, parent: import('mdast').Parent | undefined) => {
      if (!parent || index === undefined) return
      const kind = (node.name != null ? CONTAINER_KINDS[node.name] : undefined)
      if (!kind) return // Unknown directive — skip

      const p = parent as unknown as AnyParent

      // ── Extract optional title from directive attributes or first child ──
      // remark-directive parses `:::grammar-box{title="My Title"}` into
      // node.attributes.title. Also supports legacy `[title]` in content.
      let title: string | null = null
      if (node.attributes?.title && typeof node.attributes.title === 'string') {
        title = node.attributes.title.trim() || null
      } else {
        // Legacy: parse [title] from first text node content
        const firstChild = node.children?.[0]
        if (firstChild?.type === 'paragraph') {
          const firstText = (firstChild as AnyParent).children?.[0]
          if (firstText?.type === 'text') {
            const [t, rest] = extractTitle((firstText as { value: string }).value)
            title = t
            if (rest) {
              (firstText as { value: string }).value = rest
            } else {
              // Title consumed entire first paragraph — remove it
              (firstChild as AnyParent).children.shift()
              if ((firstChild as AnyParent).children.length === 0) {
                node.children.shift()
              }
            }
          }
        }
      }

      // ── Map kind to semantic tag ──
      const tagName = (kind === 'important') ? 'aside' : 'div'

      // ── Build children with title as first element ──
      const containerChildren: Content[] = [...(node.children ?? [])]

      if (title) {
        // Prepend a title paragraph that renders as <div class="md-box__title">
        containerChildren.unshift({
          type: 'paragraph',
          data: {
            hName: 'div',
            hProperties: { className: ['md-box__title'] },
          },
          children: [{ type: 'text', value: title }],
        } as Content)
      }

      // ── Wrap body in a div.md-box__body container ──
      // We replace the directive with a container div that has an inner
      // structure matching customBoxes.css:
      //   <div class="md-box md-box--kind" data-box-kind="kind">
      //     <div class="md-box__inner">
      //       [title]  <-- already injected above
      //       <div class="md-box__body">[children]</div>
      //     </div>
      //   </div>
      //
      // We achieve this by using a paragraph with hName for the container
      // and wrapping children in an intermediate HTML wrapper.

      const containerNode: Content = {
        type: 'paragraph',
        data: {
          hName: tagName,
          hProperties: {
            className: ['md-box', `md-box--${kind}`],
            'data-box-kind': kind,
          },
        },
        children: [
          // Inner wrapper
          {
            type: 'paragraph',
            data: {
              hName: 'div',
              hProperties: { className: ['md-box__inner'] },
            },
            children: [
              // Body wrapper (title is already in containerChildren)
              {
                type: 'paragraph',
                data: {
                  hName: 'div',
                  hProperties: { className: ['md-box__body'] },
                },
                // This will contain the actual content children
                children: containerChildren,
              } as Content,
            ],
          } as Content,
        ],
      } as Content

      p.children.splice(index, 1, containerNode)
      return index
    })
  }
}