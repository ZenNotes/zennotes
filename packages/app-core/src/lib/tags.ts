/**
 * Tag helpers for the vault's tag surfaces. The note-level scan itself,
 * `extractTags`, lives in shared-domain's `tag-scan.ts` (next to the
 * block-level scan that reads by the same rules, #837) and is re-exported here
 * for the renderer's existing callers.
 */
import { extractTags } from '@shared/tag-scan'
import { isTypstPreamblePath } from '@shared/typst-preamble-folder'

export { extractTags }

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
