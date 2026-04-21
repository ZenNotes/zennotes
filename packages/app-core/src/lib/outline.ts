/**
 * Extract the heading outline from a markdown note body.
 *
 * Covers ATX headings (`# Title` through `###### Title`) with two
 * practical rules:
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
export interface OutlineItem {
  level: number // 1..6
  text: string
  line: number // 1-based
  from: number // 0-based char offset of the heading line
}

const ATX_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const SETEXT_UNDERLINE_RE = /^(=+|-+)\s*$/
const FENCE_RE = /^(?:```|~~~)/

export function parseOutline(body: string): OutlineItem[] {
  const items: OutlineItem[] = []
  if (!body) return items

  const lines = body.split('\n')
  let inFence = false
  let offset = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const lineStart = offset
    offset += raw.length + 1 // +1 for the stripped newline

    const stripped = raw.trimStart()

    if (FENCE_RE.test(stripped)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const atx = raw.match(ATX_RE)
    if (atx) {
      items.push({
        level: atx[1].length,
        text: atx[2].trim(),
        line: i + 1,
        from: lineStart
      })
      continue
    }

    // Setext: current line is the title, next line is `===` or `---`.
    // Only treat it as a heading when the title line has content and
    // the next line is purely underline characters.
    const next = lines[i + 1]
    if (next !== undefined && raw.trim().length > 0) {
      const under = next.match(SETEXT_UNDERLINE_RE)
      if (under) {
        items.push({
          level: under[1].startsWith('=') ? 1 : 2,
          text: raw.trim(),
          line: i + 1,
          from: lineStart
        })
      }
    }
  }

  return items
}
