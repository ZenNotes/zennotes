/**
 * Remark plugin: scholarly extensions for Sanskrit courseware.
 *
 * Handles:
 *   1. `:br` — text directive → hard line break inside table cells
 *   2. `:indent` — text directive → inline indent span
 *   3. `⟪Devanagari⟫` — explicit Sanskrit markup (always red)
 *
 * Ported from Payer's qa_viewer.html `scholarly_fixes` core.ruler.
 * Operates on inline text nodes in the remark AST.
 */
import { visit, SKIP } from 'unist-util-visit'
import type { Root, Content } from 'mdast'
import type { TextDirective } from 'mdast-util-directive'

type AnyParent = { type: string; children: Content[] }

/**
 * Regex to split text on scholarly markers.
 * Captures: ⟪Devanagari⟫
 */
const SCHOLARLY_RE = /(⟪[^⟫]+⟫|(?<!:):br|(?<!:):indent)/g

function processInlineText(value: string): Content[] | null {
  if (!value.includes('⟪') && !value.includes(':br') && !value.includes(':indent')) {
    return null // Fast path: nothing to transform
  }

  const parts = value.split(SCHOLARLY_RE)
  const result: Content[] = []

  for (const part of parts) {
    if (!part) continue

    if (part.startsWith('⟪') && part.endsWith('⟫')) {
      // Explicitly marked Devanagari
      const text = part.slice(1, -1)
      result.push({
        type: 'html',
        value: `<span class="sanskrit-dev">${text}</span>`,
      } as Content)
    } else if (part === ':br') {
      result.push({ type: 'break' as Content['type'] } as Content)
    } else if (part === ':indent') {
      result.push({
        type: 'html',
        value: '<span class="indent-inline"></span>',
      } as Content)
    } else {
      // Plain text
      result.push({ type: 'text', value: part } as Content)
    }
  }

  return result
}

/**
 * Remark plugin that processes inline text nodes for scholarly extensions.
 * Must run AFTER remarkParse but BEFORE remarkRehype.
 */
export default function remarkScholarlyExtensions(this: unknown): (tree: Root) => void {
  return (tree: Root): void => {
    // 1. Process text nodes for ⟪...⟫
    visit(tree, 'text', (node: Content, index, parent) => {
      if (!parent || index === undefined) return
      const p = parent as unknown as AnyParent

      // Don't transform text inside headings (they should stay clean)
      if (p.type === 'heading') return

      const value = (node as { value: string }).value
      const replacement = processInlineText(value)
      if (!replacement) return

      p.children.splice(index, 1, ...replacement)
      return [SKIP, index + replacement.length]
    })

    // 2. Process textDirectives for :br and :indent
    visit(tree, 'textDirective', (node: Content, index, parent) => {
      if (!parent || index === undefined) return
      const p = parent as unknown as AnyParent
      const dir = node as unknown as TextDirective
      
      if (dir.name === 'br') {
        p.children.splice(index, 1, { type: 'break' as Content['type'] } as Content)
        return [SKIP, index + 1]
      } else if (dir.name === 'indent') {
        p.children.splice(index, 1, {
          type: 'html',
          value: '<span class="indent-inline"></span>',
        } as Content)
        return [SKIP, index + 1]
      }
    })
  }
}
