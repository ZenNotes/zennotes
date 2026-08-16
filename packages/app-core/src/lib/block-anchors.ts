import { scanMarkdownLines } from './outline'

/**
 * Obsidian-style block ids: a `^id` marker at the very end of a line, naming
 * the block on that line so `[[Note^id]]` can point at it. (#601)
 *
 * The marker must end the line and sit at a word boundary, which is what keeps
 * it apart from a caret used as an operator: `2^3` and `x ^ y` are not ids,
 * while `- Second note ^note-two` and a bare `^note-two` on its own line are.
 * Ids are alphanumeric with hyphens, matching what Obsidian generates and
 * accepts, so a stray `^` in prose cannot silently become an anchor.
 */
const BLOCK_ID_RE = /(?:^|\s)\^([A-Za-z0-9][A-Za-z0-9-]*)\s*$/

/**
 * The `^id` marker ending a single line, as offsets within that line, or null
 * when the line carries none. Rendering uses this to hide the marker; the
 * parser below uses it so both agree on what an id is.
 */
export function trailingBlockIdRange(
  lineText: string
): { id: string; from: number; to: number } | null {
  const match = lineText.match(BLOCK_ID_RE)
  if (!match) return null

  // `index` points at the boundary character (the space before `^`) unless the
  // marker starts the line, so find the caret itself.
  const from = lineText.indexOf('^', match.index ?? 0)
  return { id: match[1], from, to: from + 1 + match[1].length }
}

export interface BlockAnchor {
  id: string
  /** 1-based line number of the block the id marks. */
  line: number
  /** 0-based char offset where that line starts, for jumping to the block. */
  from: number
  /** 0-based char offsets of the `^id` marker itself, for hiding it. */
  markerFrom: number
  markerTo: number
}

/**
 * Every block id in a note body, in document order. Frontmatter and fenced
 * code are skipped, so a `^id` inside a code sample is not an anchor.
 *
 * A repeated id keeps every occurrence: the note is the user's file and we do
 * not get to reject it. Lookup resolves to the first, which is the same rule
 * headings already follow.
 */
export function parseBlockAnchors(body: string): BlockAnchor[] {
  const anchors: BlockAnchor[] = []

  for (const { text, line, from } of scanMarkdownLines(body)) {
    const marker = trailingBlockIdRange(text)
    if (!marker) continue

    anchors.push({
      id: marker.id,
      line,
      from,
      markerFrom: from + marker.from,
      markerTo: from + marker.to
    })
  }

  return anchors
}

/**
 * The block a `^id` anchor points at, or null when the note has no such id.
 * Ids are matched case-insensitively, the way heading anchors are.
 */
export function findBlockAnchor(body: string, id: string): BlockAnchor | null {
  const needle = id.trim().replace(/^\^/, '').toLowerCase()
  if (!needle) return null

  return parseBlockAnchors(body).find((anchor) => anchor.id.toLowerCase() === needle) ?? null
}

const LIST_ITEM_RE = /^(\s*)(?:[-+*]|\d+[.)])\s/

/**
 * The text of the block a `^id` marks, with the marker removed, for embedding
 * it elsewhere with `![[Note^id]]`. Null when the note has no such id.
 *
 * What counts as "the block" follows how the marker was written:
 *   - on a list item, the item and any lines indented under it, so a bullet
 *     brings its children along;
 *   - on any other line, the paragraph that line belongs to;
 *   - alone on its own line, the paragraph directly above it, which is how
 *     Obsidian lets you tag a block without touching its text.
 */
export function extractBlock(body: string, id: string): string | null {
  const anchor = findBlockAnchor(body, id)
  if (!anchor) return null

  const lines = body.split('\n')
  const index = anchor.line - 1
  const marked = lines[index] ?? ''
  const withoutMarker = marked.slice(0, anchor.markerFrom - anchor.from).replace(/[ \t]+$/, '')

  // A marker on its own line describes the paragraph above it.
  if (withoutMarker.trim() === '') {
    let start = index - 1
    while (start >= 0 && lines[start].trim() === '') start--
    if (start < 0) return null
    let first = start
    while (first > 0 && lines[first - 1].trim() !== '') first--
    return lines.slice(first, start + 1).join('\n').trim() || null
  }

  const list = withoutMarker.match(LIST_ITEM_RE)
  if (list) {
    // Keep the lines indented under the item: its wrapped text and children.
    const indent = list[1].length
    const collected = [withoutMarker]
    for (let i = index + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '') break
      const lineIndent = line.length - line.trimStart().length
      if (lineIndent <= indent) break
      collected.push(line)
    }
    return collected.join('\n').trim() || null
  }

  // An ordinary line: take the paragraph it sits in.
  let first = index
  while (first > 0 && lines[first - 1].trim() !== '') first--
  let last = index
  while (last + 1 < lines.length && lines[last + 1].trim() !== '') last++
  const paragraph = lines.slice(first, last + 1)
  paragraph[index - first] = withoutMarker
  return paragraph.join('\n').trim() || null
}
