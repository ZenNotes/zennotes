/**
 * Remark plugin: restores unhandled leafDirective (::name), textDirective (:name),
 * and containerDirective (:::name) back to plain text, so they're not silently
 * dropped by remark-directive.
 *
 * Must run AFTER remarkDirective, BEFORE any handler that consumes directives.
 */
import { visit, SKIP } from 'unist-util-visit'
import type { Root, Text } from 'mdast'
import type { LeafDirective, TextDirective, ContainerDirective } from 'mdast-util-directive'

type AnyParent = { type: string; children: unknown[] }

function directiveToOpenText(node: LeafDirective | TextDirective | ContainerDirective): Text {
  const name = node.name
  const attrs = node.attributes as Record<string, string> | undefined
  const hasAttributes = attrs && Object.keys(attrs).length > 0

  let prefix: string
  if (node.type === 'containerDirective') {
    prefix = ':::'
  } else if (node.type === 'leafDirective') {
    prefix = '::'
  } else {
    prefix = ':'
  }
  let text = prefix + name

  if (hasAttributes && attrs) {
    const attrStr = Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ')
    text += '{' + attrStr + '}'
  }

  return { type: 'text', value: text } as Text
}

function directiveToCloseText(node: ContainerDirective): Text {
  return { type: 'text', value: ':::' } as Text
}

export default function remarkDirectiveFilter(): (tree: Root) => void {
  return (tree: Root): void => {
    visit(tree, 'containerDirective', (node: ContainerDirective, index: number | undefined, parent: unknown) => {
      if (typeof index !== 'number' || !parent) return
      const p = parent as unknown as AnyParent

      // Only restore if not handled by remarkBoxes (unknown kinds)
      // remarkBoxes will have already transformed known kinds
      const openNode = directiveToOpenText(node)
      const children = node.children || []
      const closeNode = directiveToCloseText(node)
      p.children.splice(index, 1, openNode, ...children, closeNode)
      return [SKIP, index + children.length + 2]
    })

    visit(tree, 'leafDirective', (node: LeafDirective, index: number | undefined, parent: unknown) => {
      if (typeof index !== 'number' || !parent) return
      const p = parent as unknown as AnyParent

      const textNode = directiveToOpenText(node)
      const children = node.children || []
      p.children.splice(index, 1, textNode, ...children)
      return [SKIP, index + children.length + 1]
    })

    visit(tree, 'textDirective', (node: TextDirective, index: number | undefined, parent: unknown) => {
      if (typeof index !== 'number' || !parent) return
      const p = parent as unknown as AnyParent

      // Let remarkScholarly handle :br and :indent
      if (node.name === 'br' || node.name === 'indent') return

      const textNode = directiveToOpenText(node)
      const children = node.children || []
      p.children.splice(index, 1, textNode, ...children)
      return [SKIP, index + children.length + 1]
    })
  }
}
