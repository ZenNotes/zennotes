/**
 * Extract a note's tags from a markdown body: its frontmatter `tags` field
 * plus every inline `#tag`. Mirrors the extraction the main process runs in
 * `vault.ts` so the sidebar can update tag counts *live* as the user types,
 * instead of waiting for the save + chokidar round-trip.
 *
 * Rules:
 *  - The hash must be preceded by start-of-line or whitespace (so
 *    `me#tag` and `url.com/#x` don't match).
 *  - The first tag character must be a letter in any script (Cyrillic,
 *    CJK, … — #205), the rest can be letters, digits, `_`, `-`, or `/`.
 *  - Fenced code blocks and inline code spans are stripped first.
 *  - Heading markers (`#`, `##`, …) are not a hashtag because the
 *    character after the hash is a space, not a letter.
 *  - The frontmatter block is read for `tags` and then excluded from the
 *    inline scan, so a `#` in some other field is never a tag (#444).
 */
import { FRONTMATTER_BLOCK_RE, frontmatterTags } from '@shared/frontmatter'
import { isTypstPreamblePath } from '@shared/typst-preamble-folder'

export function extractTags(body: string): string[] {
  const seen = new Set<string>()
  for (const tag of frontmatterTags(body)) seen.add(tag)

  const markdownBody = body.replace(FRONTMATTER_BLOCK_RE, '')
  const stripped = stripCodeContent(markdownBody)
  const regex = /(?:^|\s)#(\p{L}[\p{L}\d_/-]*)/gu
  let m: RegExpExecArray | null
  while ((m = regex.exec(stripped)) !== null) {
    seen.add(m[1])
  }
  return [...seen]
}

/**
 * Blank out fenced and inline code so the tag scanner never reads code as a
 * tag. Fence detection is line-based and indentation-tolerant: a fence nested
 * under a list item is still a code block, so e.g. a C `#include` line inside
 * it is not a tag (#293). Mirrors `stripCodeContent` in
 * apps/desktop/src/main/vault.ts and internal/vault/parse.go in ZenNotes/znserver —
 * keep the three in sync.
 */
function stripCodeContent(body: string): string {
  if (!body.includes('`') && !body.includes('~')) return body
  const lines = body.split('\n')
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
    if (m) {
      const marker = m[1] as string
      const char = marker[0] as string
      const rest = m[2] as string
      if (!inFence) {
        // A backtick fence's info string may not contain a backtick (CommonMark).
        if (char === '~' || !rest.includes('`')) {
          inFence = true
          fenceChar = char
          fenceLen = marker.length
          lines[i] = ' '
          continue
        }
      } else if (char === fenceChar && marker.length >= fenceLen && rest.trim() === '') {
        inFence = false
        lines[i] = ' '
        continue
      }
    }
    if (inFence) lines[i] = ' '
  }
  return lines.join('\n').replace(/`[^`\n]*`/g, ' ')
}

/**
 * Does a note's tags satisfy the Tags-view selection? `all` = the note carries
 * every selected tag (AND, the narrowing default, #221); `any` = it carries at
 * least one (OR). Case-insensitive. No selection → no match.
 */
export function matchesSelectedTags(
  noteTags: readonly string[],
  selectedTags: readonly string[],
  mode: 'all' | 'any'
): boolean {
  if (selectedTags.length === 0) return false
  const have = new Set(noteTags.map((t) => t.toLowerCase()))
  const want = selectedTags.map((t) => t.toLowerCase())
  return mode === 'any' ? want.some((t) => have.has(t)) : want.every((t) => have.has(t))
}

/**
 * The tags a note contributes to the vault's tag surfaces: the live buffer for
 * the note being edited (so a freshly typed `#tag` counts before the index
 * catches up), the indexed list for everything else.
 *
 * Typst preamble notes contribute nothing. Their bodies are Typst source, so
 * `#let vec(x) = …` and the `#var` references in formulas are variables rather
 * than tags (#562). The indexers already drop them, and this keeps the live
 * path from putting them back the moment the user opens one.
 */
export function noteTagsForCount(
  note: { path: string; tags: readonly string[] },
  active: { path: string; body: string } | null | undefined,
  preambleFolder: string
): readonly string[] {
  if (isTypstPreamblePath(note.path, preambleFolder)) return EMPTY_TAGS
  return active && active.path === note.path ? extractTags(active.body) : note.tags
}

const EMPTY_TAGS: readonly string[] = []

/**
 * Unique tags across the vault (trash excluded), counted by how many notes use
 * them. The active note is read live from its buffer so a tag just typed in the
 * same note is offered too. One aggregation for the editor's `#` completion,
 * the frontmatter `tags:` completion and the New note form in search.
 */
export function countVaultTags(
  notes: readonly { path: string; folder: string; tags: readonly string[] }[],
  active: { path: string; body: string } | null | undefined,
  preambleFolder: string
): Map<string, number> {
  const counter = new Map<string, number>()
  for (const note of notes) {
    if (note.folder === 'trash') continue
    for (const t of noteTagsForCount(note, active, preambleFolder)) {
      counter.set(t, (counter.get(t) ?? 0) + 1)
    }
  }
  return counter
}

export interface RankedTag {
  tag: string
  count: number
}

const MAX_TAG_COMPLETIONS = 20

/** Rank vault tags for `query` so prefix matches beat substring matches, and
 *  more-used tags beat less-used ones. Excludes the exact tag already typed. */
export function rankTagCompletions(
  query: string,
  counts: ReadonlyMap<string, number>
): RankedTag[] {
  const q = query.toLowerCase()
  return [...counts.entries()]
    .map(([tag, count]) => {
      const lower = tag.toLowerCase()
      const rank = lower.startsWith(q) ? 0 : lower.includes(q) ? 1 : 2
      return { tag, lower, count, rank }
    })
    .filter((t) => t.rank < 2 && t.lower !== q)
    .sort((a, b) => a.rank - b.rank || b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, MAX_TAG_COMPLETIONS)
    .map(({ tag, count }) => ({ tag, count }))
}

/** A node in the hierarchical (`/`-separated) tag tree. (#439) */
export interface TagTreeNode {
  /** The last path segment shown as the row label, e.g. `compiler`. */
  name: string
  /** The full tag path, e.g. `project/compiler` — the value used for selection. */
  path: string
  /** Depth from a root node (0 = top level). */
  depth: number
  /** Notes carrying this exact tag; 0 for an inferred parent that is not itself a tag. */
  count: number
  /** True when `path` is a real tag in the vault, false when it exists only as an ancestor. */
  isTag: boolean
  /** Sum of `count` over this node and every descendant — a browse hint, not a
   *  de-duplicated note count (a note tagged with two tags in the subtree counts twice). */
  subtreeCount: number
  children: TagTreeNode[]
}

/**
 * Group a flat `[tag, count]` list into a hierarchical tree, splitting each tag
 * on `/`. Ancestors that are not themselves tags (e.g. `project` when only
 * `project/compiler` exists) become grouping nodes with `isTag: false`. Each
 * level is sorted case-insensitively by label. A tag with no `/` is a single
 * root leaf, so a flat vault yields a flat tree. Empty path segments (from a
 * stray `//` or a trailing `/`) are dropped. (#439)
 */
export function buildTagTree(
  tags: readonly (readonly [string, number])[]
): TagTreeNode[] {
  const roots: TagTreeNode[] = []
  const byPath = new Map<string, TagTreeNode>()

  const ensure = (segments: string[]): TagTreeNode => {
    const path = segments.join('/')
    const existing = byPath.get(path)
    if (existing) return existing
    const node: TagTreeNode = {
      name: segments[segments.length - 1] as string,
      path,
      depth: segments.length - 1,
      count: 0,
      isTag: false,
      subtreeCount: 0,
      children: []
    }
    byPath.set(path, node)
    if (segments.length === 1) {
      roots.push(node)
    } else {
      ensure(segments.slice(0, -1)).children.push(node)
    }
    return node
  }

  for (const [rawPath, count] of tags) {
    const segments = rawPath.split('/').filter(Boolean)
    if (segments.length === 0) continue
    const node = ensure(segments)
    node.isTag = true
    node.count += count
  }

  const finalize = (nodes: TagTreeNode[]): number => {
    nodes.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    let total = 0
    for (const node of nodes) {
      node.subtreeCount = node.count + finalize(node.children)
      total += node.subtreeCount
    }
    return total
  }
  finalize(roots)
  return roots
}

/** Flatten a tag tree into visible rows in display order, hiding the subtrees of
 *  any node whose path is in `collapsed`. Used by both the sidebar and the Tags
 *  view so their tree renders (and keyboard nav) stay in sync. (#439) */
export function flattenTagTree(
  roots: readonly TagTreeNode[],
  collapsed: ReadonlySet<string>
): TagTreeNode[] {
  const out: TagTreeNode[] = []
  const walk = (nodes: readonly TagTreeNode[]): void => {
    for (const node of nodes) {
      out.push(node)
      if (node.children.length > 0 && !collapsed.has(node.path)) walk(node.children)
    }
  }
  walk(roots)
  return out
}
