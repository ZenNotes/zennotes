/**
 * Immutable tree helpers for the multi-pane editor layout.
 *
 * A `PaneLayout` is either a `leaf` (holds an ordered list of tab paths
 * and a single active tab) or a `split` (ordered children with a flex
 * direction and a `sizes` array of ratios summing to 1).
 *
 * All mutation helpers return fresh trees — callers feed them into
 * zustand via `set`.
 */

export type PaneDirection = 'row' | 'column'

export interface PaneLeaf {
  kind: 'leaf'
  id: string
  tabs: string[]
  activeTab: string | null
}

export interface PaneSplit {
  kind: 'split'
  id: string
  direction: PaneDirection
  children: PaneLayout[]
  sizes: number[]
}

export type PaneLayout = PaneLeaf | PaneSplit

export type PaneEdge = 'left' | 'right' | 'top' | 'bottom' | 'center'

let paneCounter = 0

export function nextPaneId(): string {
  paneCounter += 1
  return `pane-${paneCounter}-${Math.random().toString(36).slice(2, 7)}`
}

export function makeLeaf(tabs: string[] = [], activeTab: string | null = null): PaneLeaf {
  return {
    kind: 'leaf',
    id: nextPaneId(),
    tabs: [...tabs],
    activeTab: activeTab ?? tabs[0] ?? null
  }
}

export function allLeaves(root: PaneLayout): PaneLeaf[] {
  if (root.kind === 'leaf') return [root]
  return root.children.flatMap(allLeaves)
}

export function findLeaf(root: PaneLayout, id: string): PaneLeaf | null {
  if (root.kind === 'leaf') return root.id === id ? root : null
  for (const child of root.children) {
    const found = findLeaf(child, id)
    if (found) return found
  }
  return null
}

/** Return the first leaf that currently has `path` as its activeTab. */
export function findLeafWithActiveTab(root: PaneLayout, path: string): PaneLeaf | null {
  for (const leaf of allLeaves(root)) {
    if (leaf.activeTab === path) return leaf
  }
  return null
}

/** Return every leaf whose tab list includes `path`. */
export function findLeavesContaining(root: PaneLayout, path: string): PaneLeaf[] {
  return allLeaves(root).filter((leaf) => leaf.tabs.includes(path))
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0)
  if (total <= 0 || sizes.length === 0) {
    return sizes.length === 0 ? [] : sizes.map(() => 1 / sizes.length)
  }
  return sizes.map((s) => s / total)
}

function collapseSingleChild(split: PaneSplit): PaneLayout {
  if (split.children.length === 1) return split.children[0]
  return split
}

/**
 * Recursively update or remove leaves via a visitor. If `visit` returns
 * `null` the leaf is removed (and single-child splits collapse).
 */
export function mapLeaves(
  root: PaneLayout,
  visit: (leaf: PaneLeaf) => PaneLeaf | null
): PaneLayout | null {
  if (root.kind === 'leaf') return visit(root)
  const nextChildren: PaneLayout[] = []
  const nextSizes: number[] = []
  for (let i = 0; i < root.children.length; i++) {
    const mapped = mapLeaves(root.children[i], visit)
    if (mapped !== null) {
      nextChildren.push(mapped)
      nextSizes.push(root.sizes[i] ?? 1 / root.children.length)
    }
  }
  if (nextChildren.length === 0) return null
  if (nextChildren.length === 1) return nextChildren[0]
  return {
    ...root,
    children: nextChildren,
    sizes: normalizeSizes(nextSizes)
  }
}

/** Apply `fn` to the leaf with id `targetId`. Removes it if `fn` returns null. */
export function updateLeaf(
  root: PaneLayout,
  targetId: string,
  fn: (leaf: PaneLeaf) => PaneLeaf | null
): PaneLayout | null {
  return mapLeaves(root, (leaf) => (leaf.id === targetId ? fn(leaf) : leaf))
}

/** Replace the leaf with id `targetId` by the subtree returned by `replacer`. */
export function replaceLeaf(
  root: PaneLayout,
  targetId: string,
  replacer: (leaf: PaneLeaf) => PaneLayout
): PaneLayout {
  if (root.kind === 'leaf') return root.id === targetId ? replacer(root) : root
  const nextChildren = root.children.map((child) => replaceLeaf(child, targetId, replacer))
  return { ...root, children: nextChildren }
}

/**
 * Split a target leaf. `edge` tells us which side of the original leaf
 * the new leaf should occupy. Returns a new tree.
 *
 * - `'right'` / `'left'` create a `row` split (side-by-side)
 * - `'top'` / `'bottom'` create a `column` split (stacked)
 */
export function splitLeaf(
  root: PaneLayout,
  targetId: string,
  edge: Exclude<PaneEdge, 'center'>,
  newLeaf: PaneLeaf
): PaneLayout {
  const direction: PaneDirection = edge === 'left' || edge === 'right' ? 'row' : 'column'
  const newFirst = edge === 'left' || edge === 'top'
  return replaceLeaf(root, targetId, (leaf) => {
    const children: PaneLayout[] = newFirst ? [newLeaf, leaf] : [leaf, newLeaf]
    const split: PaneSplit = {
      kind: 'split',
      id: nextPaneId(),
      direction,
      children,
      sizes: [0.5, 0.5]
    }
    return split
  })
}

/** Remove the leaf with id `targetId`. Returns null if the tree becomes empty. */
export function removeLeaf(root: PaneLayout, targetId: string): PaneLayout | null {
  return updateLeaf(root, targetId, () => null)
}

export function updateSplitSizes(
  root: PaneLayout,
  splitId: string,
  sizes: number[]
): PaneLayout {
  if (root.kind === 'leaf') return root
  if (root.id === splitId && sizes.length === root.children.length) {
    return { ...root, sizes: normalizeSizes(sizes) }
  }
  let changed = false
  const next = root.children.map((child) => {
    const mapped = updateSplitSizes(child, splitId, sizes)
    if (mapped !== child) changed = true
    return mapped
  })
  if (!changed) return root
  return { ...root, children: next }
}

/**
 * Rewrite or drop paths in every leaf's `tabs` array.
 *
 * - Returning `null` from `fn` drops that tab.
 * - Returning the same string keeps it unchanged.
 * - Returning a different string renames it.
 *
 * Leaves whose tab list becomes empty are removed; single-child splits
 * collapse; if the whole tree becomes empty we return a fresh empty
 * leaf (so the UI always has a pane to render).
 */
export function rewritePathsInTree(
  root: PaneLayout,
  fn: (path: string) => string | null
): PaneLayout {
  const result = mapLeaves(root, (leaf) => {
    const nextTabs: string[] = []
    const seen = new Set<string>()
    for (const tab of leaf.tabs) {
      const mapped = fn(tab)
      if (mapped == null) continue
      if (seen.has(mapped)) continue
      seen.add(mapped)
      nextTabs.push(mapped)
    }
    if (nextTabs.length === 0) return null
    let nextActive: string | null = null
    if (leaf.activeTab) {
      const mappedActive = fn(leaf.activeTab)
      if (mappedActive && nextTabs.includes(mappedActive)) {
        nextActive = mappedActive
      }
    }
    if (!nextActive) nextActive = nextTabs[0]
    return { ...leaf, tabs: nextTabs, activeTab: nextActive }
  })
  return result ?? makeLeaf()
}

/**
 * Classify where within a pane's bounding rect the cursor falls when
 * dragging a tab over it. Edge bands (outer 25% on each side) trigger
 * splits; the interior triggers an in-pane drop (append tab / move).
 */
export function inferPaneDropEdge(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  band = 0.22
): PaneEdge {
  const rx = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)))
  const ry = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(rect.height, 1)))
  const distLeft = rx
  const distRight = 1 - rx
  const distTop = ry
  const distBottom = 1 - ry
  const minDist = Math.min(distLeft, distRight, distTop, distBottom)
  if (minDist >= band) return 'center'
  if (minDist === distLeft) return 'left'
  if (minDist === distRight) return 'right'
  if (minDist === distTop) return 'top'
  return 'bottom'
}

/** Insert `path` into a leaf's tab list (deduplicated) at `insertIndex` and make it active. */
export function leafWithAddedTab(
  leaf: PaneLeaf,
  path: string,
  insertIndex?: number
): PaneLeaf {
  const without = leaf.tabs.filter((t) => t !== path)
  const index =
    insertIndex == null
      ? without.length
      : Math.max(0, Math.min(without.length, insertIndex))
  const tabs = [...without.slice(0, index), path, ...without.slice(index)]
  return { ...leaf, tabs, activeTab: path }
}

export function leafWithoutTab(leaf: PaneLeaf, path: string): PaneLeaf | null {
  if (!leaf.tabs.includes(path)) return leaf
  const tabs = leaf.tabs.filter((t) => t !== path)
  if (tabs.length === 0) return null
  let activeTab = leaf.activeTab
  if (activeTab === path) {
    const idx = leaf.tabs.indexOf(path)
    activeTab = tabs[Math.min(idx, tabs.length - 1)] ?? tabs[0] ?? null
  }
  return { ...leaf, tabs, activeTab }
}

/** Reorder a tab within a single leaf. Returns the leaf unchanged when the move is a no-op. */
export function leafWithReorderedTab(
  leaf: PaneLeaf,
  dragPath: string,
  targetPath: string,
  position: 'before' | 'after'
): PaneLeaf {
  if (dragPath === targetPath) return leaf
  const from = leaf.tabs.indexOf(dragPath)
  const to = leaf.tabs.indexOf(targetPath)
  if (from === -1 || to === -1) return leaf
  const tabs = leaf.tabs.slice()
  tabs.splice(from, 1)
  const adjustedTarget = from < to ? to - 1 : to
  const insertAt = position === 'after' ? adjustedTarget + 1 : adjustedTarget
  tabs.splice(insertAt, 0, dragPath)
  return { ...leaf, tabs }
}
