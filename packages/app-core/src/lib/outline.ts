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
// A fenced code block opens with a run of >=3 backticks or tildes; the second
// group is the rest of the line (the info string).
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})(.*)$/
// A closing fence is a run of fence characters alone on its line, save for
// trailing whitespace (no info string).
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})[ \t]*$/

export function parseOutline(body: string): OutlineItem[] {
  const items: OutlineItem[] = []
  if (!body) return items

  const lines = body.split('\n')
  // The marker run (``` / ~~~) that opened the current fence, or null when not
  // inside one. Tracking the exact marker — instead of toggling a boolean on
  // any fence-looking line — means a `~~~` line can't close a ``` block, a
  // longer closer is required for a longer opener, and an inline `​```…``` `
  // code span isn't mistaken for a block fence (#249).
  let fence: string | null = null
  let offset = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const lineStart = offset
    offset += raw.length + 1 // +1 for the stripped newline

    if (fence) {
      const close = raw.match(FENCE_CLOSE_RE)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null
      }
      continue
    }

    const open = raw.match(FENCE_OPEN_RE)
    if (open) {
      const [, marker, info] = open
      // A backtick fence's info string may not contain backticks; when it does,
      // the line is an inline code span (e.g. ```[[link]]```), not a block
      // fence — so don't enter a fence, and let heading parsing fall through.
      if (marker[0] !== '`' || !info.includes('`')) {
        fence = marker
        continue
      }
    }

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
