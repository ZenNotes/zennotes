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

/**
 * 0-based index of the closing `---` of a leading YAML frontmatter block,
 * or -1 when the body has none. Matches the editor's frontmatter detection
 * (cm-wysiwyg-blocks): the very first line must be `---`, and the block runs
 * to the next `---` line.
 */
function frontmatterEndIndex(lines: string[]): number {
  if (lines.length < 2 || lines[0].trim() !== '---') return -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return i
  }
  return -1
}

/** One body line that markdown owns: outside frontmatter, outside a code fence. */
export interface MarkdownLine {
  /** Raw line text. */
  text: string
  /** The line after it, or undefined at the end of the body (setext lookahead). */
  next: string | undefined
  /** 1-based line number. */
  line: number
  /** 0-based char offset where the line starts. */
  from: number
}

/**
 * Walk the lines of a note body that markdown owns, skipping leading YAML
 * frontmatter and the inside of fenced code blocks.
 *
 * Headings and block anchors are both line-level markers and have to agree on
 * what counts as markdown, so they share this walker instead of keeping two
 * copies of the frontmatter and fence rules in step.
 */
export function scanMarkdownLines(body: string): MarkdownLine[] {
  const scanned: MarkdownLine[] = []
  if (!body) return scanned

  const lines = body.split('\n')
  // Everything up to and including this line is frontmatter and is skipped.
  const frontmatterEnd = frontmatterEndIndex(lines)
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

    // Skip the leading frontmatter block wholesale — its fences and `key: value`
    // lines are YAML, not markdown, and must never surface as outline entries.
    if (i <= frontmatterEnd) continue

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
      // fence — so don't enter a fence, and let parsing fall through.
      if (marker[0] !== '`' || !info.includes('`')) {
        fence = marker
        continue
      }
    }

    scanned.push({ text: raw, next: lines[i + 1], line: i + 1, from: lineStart })
  }

  return scanned
}

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
