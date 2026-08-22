import {
  FENCE_CLOSE_RE,
  FENCE_OPEN_RE,
  frontmatterEndIndex,
  scanMarkdownLines
} from './markdown-lines'

/**
 * Obsidian-style block ids: a `^id` marker at the very end of a line, naming
 * the block on that line so `[[Note^id]]` can point at it. (#601)
 *
 * The marker must end the line and sit at a word boundary, which is what keeps
 * it apart from a caret used as an operator: `2^3` and `x ^ y` are not ids,
 * while `- Second note ^note-two` and a bare `^note-two` on its own line are.
 * Ids are alphanumeric with hyphens, matching what Obsidian generates and
 * accepts, so a stray `^` in prose cannot silently become an anchor.
 *
 * Lives in shared-domain so every markdown pipeline (reading view, DOCX
 * export, share viewer) strips and resolves the same grammar the parser
 * defines, instead of each renderer approximating it.
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
  /** 1-based line number carrying the literal `^id` marker. */
  markerLine: number
  /** 0-based char offset where the marker's line starts. */
  markerLineFrom: number
  /** 0-based char offsets of the `^id` marker itself, for hiding it. */
  markerFrom: number
  markerTo: number
}

/** Everything the block walks need to know about a body's lines: the raw
 *  lines, their offsets, which lines markdown owns (outside frontmatter and
 *  fences), and where the frontmatter ends. */
interface BodyMap {
  lines: string[]
  lineStarts: number[]
  owned: boolean[]
  frontmatterEnd: number
}

function mapBody(body: string): BodyMap {
  const lines = body.split('\n')
  const lineStarts: number[] = []
  let offset = 0
  for (const line of lines) {
    lineStarts.push(offset)
    offset += line.length + 1
  }
  const owned = new Array<boolean>(lines.length).fill(false)
  for (const { line } of scanMarkdownLines(body)) owned[line - 1] = true
  return { lines, lineStarts, owned, frontmatterEnd: frontmatterEndIndex(lines) }
}

/**
 * The 0-based [start, end] line range of the block a standalone marker at
 * `markerIndex` names: the block directly above it. Null when nothing usable
 * sits above (top of note, or only frontmatter: frontmatter is metadata, never
 * a block, and anchoring it embedded raw YAML). A fenced code block above IS a
 * block, fence markers included, matching how a bare `^id` tags whatever it
 * follows.
 */
function standaloneBlockRange(
  map: BodyMap,
  markerIndex: number
): { start: number; end: number } | null {
  const { lines, owned, frontmatterEnd } = map
  let previous = markerIndex - 1
  while (previous >= 0 && owned[previous] && lines[previous].trim() === '') previous--
  if (previous < 0 || previous <= frontmatterEnd) return null
  if (lines[previous].trim() === '') return null
  if (!owned[previous]) {
    // Fence territory: the whole contiguous unowned run is the block.
    let start = previous
    while (start - 1 > frontmatterEnd && !owned[start - 1]) start--
    let end = previous
    while (end + 1 < markerIndex && !owned[end + 1]) end++
    return { start, end }
  }
  let start = previous
  while (start - 1 > frontmatterEnd && owned[start - 1] && lines[start - 1].trim() !== '') start--
  return { start, end: previous }
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
  const map = mapBody(body)

  for (const { text, line, from } of scanMarkdownLines(body)) {
    const marker = trailingBlockIdRange(text)
    if (!marker) continue

    let targetLine = line
    let targetFrom = from
    const markerIsStandalone = text.slice(0, marker.from).trim() === ''
    if (markerIsStandalone) {
      const range = standaloneBlockRange(map, line - 1)
      if (range) {
        targetLine = range.start + 1
        targetFrom = map.lineStarts[range.start]
      }
    }

    anchors.push({
      id: marker.id,
      line: targetLine,
      from: targetFrom,
      markerLine: line,
      markerLineFrom: from,
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
 *   - on a list item, the item and everything indented under it. Loose
 *     children (separated by blank lines) belong to the item, and a fenced
 *     code block inside a child is carried whole: cutting one open mid-fence
 *     leaked an unclosed ``` into the embedding note and swallowed the rest
 *     of its rendering;
 *   - on any other line, the paragraph that line belongs to, bounded by
 *     markdown-owned lines so it can never climb into a fence or frontmatter;
 *   - alone on its own line, the block directly above it, which is how
 *     Obsidian lets you tag a block without touching its text.
 */
export function extractBlock(body: string, id: string): string | null {
  const anchor = findBlockAnchor(body, id)
  if (!anchor) return null

  const map = mapBody(body)
  const { lines } = map
  const index = anchor.markerLine - 1
  const marked = lines[index] ?? ''
  const withoutMarker = marked
    .slice(0, anchor.markerFrom - anchor.markerLineFrom)
    .replace(/[ \t]+$/, '')

  // A marker on its own line describes the block above it.
  if (withoutMarker.trim() === '') {
    const range = standaloneBlockRange(map, index)
    if (!range) return null
    return lines.slice(range.start, range.end + 1).join('\n').trim() || null
  }

  const list = withoutMarker.match(LIST_ITEM_RE)
  if (list) {
    // Keep everything indented under the item: wrapped text, children, loose
    // sub-paragraphs, and any fenced block in full. Only a dedent to the
    // item's level (outside a fence) or the end of the note closes it.
    const indent = list[1].length
    const collected = [withoutMarker]
    let lastContent = 0
    let childFence: string | null = null
    for (let i = index + 1; i < lines.length; i++) {
      const line = lines[i]
      if (childFence) {
        collected.push(line)
        lastContent = collected.length - 1
        const close = line.match(FENCE_CLOSE_RE)
        if (close && close[1][0] === childFence[0] && close[1].length >= childFence.length) {
          childFence = null
        }
        continue
      }
      if (line.trim() === '') {
        let j = i + 1
        while (j < lines.length && lines[j].trim() === '') j++
        const next = lines[j]
        if (next === undefined) break
        const nextIndent = next.length - next.trimStart().length
        if (nextIndent <= indent) break
        collected.push(line)
        continue
      }
      const lineIndent = line.length - line.trimStart().length
      if (lineIndent <= indent) break
      collected.push(line)
      lastContent = collected.length - 1
      const open = line.match(FENCE_OPEN_RE)
      if (open && (open[1][0] !== '`' || !open[2].includes('`'))) childFence = open[1]
    }
    return collected.slice(0, lastContent + 1).join('\n').trim() || null
  }

  // An ordinary line: take the paragraph it sits in, never crossing out of
  // markdown-owned territory.
  let first = index
  while (first > 0 && map.owned[first - 1] && lines[first - 1].trim() !== '') first--
  let last = index
  while (last + 1 < lines.length && map.owned[last + 1] && lines[last + 1].trim() !== '') last++
  const paragraph = lines.slice(first, last + 1)
  paragraph[index - first] = withoutMarker
  return paragraph.join('\n').trim() || null
}

/**
 * The note body with every `^id` anchor marker removed, for rendering. The
 * marker is addressing, not prose, so reading surfaces hide it; stripping at
 * the source, with the parser's own grammar, is what keeps "what navigates"
 * and "what disappears" the same set of markers. A per-text-node strip here
 * once deleted real prose (`See note ^ref *below*` lost its `^ref` AND the
 * joining space) while leaving a genuine mid-paragraph anchor visible.
 *
 * Line-preserving: markers are cut from their line, marker-only lines become
 * blank lines, and no line is added or removed, so source-line mappings
 * (scroll sync, task indexes) stay valid.
 */
export function stripBlockAnchorMarkers(body: string): string {
  const anchors = parseBlockAnchors(body)
  if (anchors.length === 0) return body
  const lines = body.split('\n')
  for (const anchor of anchors) {
    const index = anchor.markerLine - 1
    const local = anchor.markerFrom - anchor.markerLineFrom
    lines[index] = (lines[index] ?? '').slice(0, local).replace(/[ \t]+$/, '')
  }
  return lines.join('\n')
}
