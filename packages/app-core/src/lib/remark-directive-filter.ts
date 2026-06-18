/**
 * Remark plugin: restores unhandled leafDirective (::name) and textDirective (:name)
 * back to plain text, so they're not silently dropped by remark-directive.
 *
 * Must run AFTER remarkDirective, BEFORE any handler that consumes directives.
 */
import { visit, SKIP } from 'unist-util-visit'
import type { Root, Text } from 'mdast'
import type { LeafDirective, TextDirective } from 'mdast-util-directive'

type AnyParent = { type: string; children: unknown[] }

export default function remarkDirectiveFilter(): (tree: Root) => void {
  return (tree: Root): void => {
    visit(tree, 'leafDirective', (node: LeafDirective, index: number | undefined, parent: unknown) => {
      if (typeof index !== 'number' || !parent) return
      const p = parent as unknown as AnyParent

      const name = node.name
      const attrs = node.attributes as Record<string, string> | undefined
      const hasAttributes = attrs && Object.keys(attrs).length > 0
      const hasChildren = node.children && node.children.length > 0

      const prefix = '::'
      let text = prefix + name

      if (hasAttributes && attrs) {
        const attrStr = Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')
        text += '{' + attrStr + '}'
      }

      if (hasChildren) {
        text += prefix
      }

      p.children.splice(index, 1, { type: 'text', value: text } as Text)
      return [SKIP, index + 1]
    })

    visit(tree, 'textDirective', (node: TextDirective, index: number | undefined, parent: unknown) => {
      if (typeof index !== 'number' || !parent) return
      const p = parent as unknown as AnyParent

      const name = node.name
      const attrs = node.attributes as Record<string, string> | undefined
      const hasAttributes = attrs && Object.keys(attrs).length > 0
      const hasChildren = node.children && node.children.length > 0

      const prefix = ':'
      let text = prefix + name

      if (hasAttributes && attrs) {
        const attrStr = Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')
        text += '{' + attrStr + '}'
      }

      if (hasChildren) {
        text += prefix
      }

      p.children.splice(index, 1, { type: 'text', value: text } as Text)
      return [SKIP, index + 1]
    })
  }
}
