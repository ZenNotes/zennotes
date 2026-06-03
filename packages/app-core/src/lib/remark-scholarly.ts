/**
 * Remark plugin: scholarly extensions for Sanskrit courseware.
 *
 * Handles:
 *   1. `[[br]]` —  → hard line break inside table cells
 *   2. `[[indent]]` → inline indent span
 *   3. `⟪Devanagari⟫` — explicit Sanskrit markup (always red)
 *   4. Bare Devanagari runs (U+0900–U+097F) — auto-wrap in sanskrit-dev
 *
 * Ported from Payer's qa_viewer.html `scholarly_fixes` core.ruler.
 * Operates on inline text nodes in the remark AST.
 */
import { visit, SKIP } from 'unist-util-visit'
import type { Root, Content } from 'mdast'

type AnyParent = { type: string; children: Content[] }

/**
 * Regex to split text on scholarly markers.
 * Captures: ⟪Devanagari⟫, bare Devanagari runs, [[br]], [[indent]]
 */
const SCHOLARLY_RE = /(⟪[ऀ-ॿ]+⟫|[ऀ-ॿ]+|\[\[br\]\]|\[\[indent\]\])/g

/** True if s contains any Devanagari character. */
const DEVANAGARI_RE = /[ऀ-ॿ]/

function processInlineText(value: string): Content[] | null {
  if (
    !value.includes('[[br]]') &&
    !value.includes('[[indent]]') &&
    !value.includes('⟪') &&
    !DEVANAGARI_RE.test(value)
  ) {
    return null // Fast path: nothing to transform
  }

  const parts = value.split(SCHOLARLY_RE)
  const result: Content[] = []

  for (const part of parts) {
    if (!part) continue

    if (part === '[[br]]') {
      // Hard break
      result.push({ type: 'break' as Content['type'] } as Content)
    } else if (part === '[[indent]]') {
      // Inline indent span
      result.push({
        type: 'html',
        value: '<span class="indent-inline"></span>',
      } as Content)
    } else if (part.startsWith('⟪') && part.endsWith('⟫')) {
      // Explicitly marked Devanagari
      const text = part.slice(1, -1)
      result.push({
        type: 'html',
        value: `<span class="sanskrit-dev">${text}</span>`,
      } as Content)
    } else if (DEVANAGARI_RE.test(part)) {
      // Bare Devanagari — auto-wrap
      result.push({
        type: 'html',
        value: `<span class="sanskrit-dev">${part}</span>`,
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
  }
}
