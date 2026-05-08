export const SIDEBAR_PROGRESSIVE_RENDER_THRESHOLD = 240
export const SIDEBAR_PROGRESSIVE_INITIAL_ROWS = 160
export const SIDEBAR_PROGRESSIVE_BATCH_ROWS = 128
export const SIDEBAR_PROGRESSIVE_SENTINEL_MARGIN_PX = 320
export const SIDEBAR_VISIBLE_PREFETCH_EDGE_ROWS = 24

export function getInitialSidebarEntryLimit(total: number, enabled: boolean): number {
  const safeTotal = Math.max(0, Math.floor(total))
  if (!enabled || safeTotal <= SIDEBAR_PROGRESSIVE_RENDER_THRESHOLD) return safeTotal
  return Math.min(safeTotal, SIDEBAR_PROGRESSIVE_INITIAL_ROWS)
}

export function getNextSidebarEntryLimit(current: number, total: number): number {
  const safeCurrent = Math.max(0, Math.floor(current))
  const safeTotal = Math.max(0, Math.floor(total))
  return Math.min(safeTotal, safeCurrent + SIDEBAR_PROGRESSIVE_BATCH_ROWS)
}

export function getSidebarEdgePrefetchPaths(
  paths: readonly (string | null | undefined)[],
  edgeRows = SIDEBAR_VISIBLE_PREFETCH_EDGE_ROWS
): string[] {
  const limit = Math.max(0, Math.floor(edgeRows))
  if (paths.length === 0 || limit === 0) return []

  const selected = new Set<string>()
  const addPath = (path: string | null | undefined): void => {
    if (path) selected.add(path)
  }

  const leading = paths.slice(0, limit)
  const trailing = paths.slice(-limit).reverse()
  for (let idx = 0; idx < limit; idx += 1) {
    addPath(trailing[idx])
    addPath(leading[idx])
    if (selected.size >= limit) break
  }

  if (selected.size === 0) {
    for (const path of paths) {
      addPath(path)
      if (selected.size >= limit) break
    }
  }

  return [...selected]
}
