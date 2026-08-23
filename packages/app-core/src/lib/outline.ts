/**
 * Extract the heading outline from a markdown note body.
 *
 * Covers ATX headings (`# Title` through `###### Title`) with three
 * practical rules:
 *   - Skip a leading YAML frontmatter block (`---` … `---`), so the
 *     closing `---` isn't read as a setext underline that turns the
 *     last frontmatter line into a phantom H2 (#442).
 *   - Skip headings inside fenced code blocks (``` or ~~~), so code
 *     snippets that start lines with `#` don't pollute the outline.
 *   - Accept setext-style underline headings (`Title\n====`) and
 *     normalize them to level 1 (=) or 2 (-).
 *
 * The `line` field is the 1-based line number so callers can feed it
 * straight to CodeMirror's `doc.line(n)` API. `from` is the 0-based
 * character offset where the heading line starts — useful when the
 * caller already has the full body in hand.
 */
import { scanMarkdownLines } from '@shared/markdown-lines'

// The line walker (frontmatter and fence rules) lives in shared-domain now so
// the block-anchor grammar and the DOCX export share it; this re-export keeps
// the historical app-core import path working.
export { scanMarkdownLines, type MarkdownLine } from '@shared/markdown-lines'

export interface OutlineItem {
  level: number // 1..6
  text: string
  line: number // 1-based
  from: number // 0-based char offset of the heading line
}

/** Find the last heading at or before a 1-based editor cursor line. */
export function activeOutlineLineForCursor(
  items: readonly OutlineItem[],
  cursorLine: number
): number | null {
  let activeLine: number | null = null
  for (const item of items) {
    if (item.line > cursorLine) break
    activeLine = item.line
  }
  return activeLine
}

const ATX_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const SETEXT_UNDERLINE_RE = /^(=+|-+)\s*$/

export function parseOutline(body: string): OutlineItem[] {
  const items: OutlineItem[] = []

  for (const { text: raw, next, line, from: lineStart } of scanMarkdownLines(body)) {
    const atx = raw.match(ATX_RE)
    if (atx) {
      items.push({
        level: atx[1].length,
        text: atx[2].trim(),
        line,
        from: lineStart
      })
      continue
    }

    // Setext: current line is the title, next line is `===` or `---`.
    // Only treat it as a heading when the title line has content and
    // the next line is purely underline characters.
    if (next !== undefined && raw.trim().length > 0) {
      const under = next.match(SETEXT_UNDERLINE_RE)
      if (under) {
        items.push({
          level: under[1].startsWith('=') ? 1 : 2,
          text: raw.trim(),
          line,
          from: lineStart
        })
      }
    }
  }

  return items
}
