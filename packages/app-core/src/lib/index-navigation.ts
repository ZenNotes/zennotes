export function boundedIndexCount(renderedCount: number, totalCount?: number | null): number {
  const safeRendered = Math.max(0, Math.floor(renderedCount))
  if (totalCount == null) return safeRendered

  const safeTotal = Math.max(0, Math.floor(totalCount))
  return Math.max(safeRendered, safeTotal)
}

export function clampIndex(index: number, count: number): number {
  const safeCount = Math.max(0, Math.floor(count))
  if (safeCount === 0) return 0

  const safeIndex = Number.isFinite(index) ? Math.floor(index) : 0
  return Math.max(0, Math.min(safeCount - 1, safeIndex))
}

export function moveIndex(index: number, count: number, delta: number): number {
  return clampIndex(clampIndex(index, count) + delta, count)
}
