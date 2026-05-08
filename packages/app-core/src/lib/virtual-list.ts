export interface VirtualRangeInput {
  itemCount: number
  itemSize: number
  scrollTop: number
  viewportHeight: number
  overscan?: number
}

export interface VirtualRange {
  start: number
  end: number
  totalSize: number
}

export function getVirtualRange({
  itemCount,
  itemSize,
  scrollTop,
  viewportHeight,
  overscan = 6
}: VirtualRangeInput): VirtualRange {
  const count = Math.max(0, Math.floor(itemCount))
  if (count === 0) return { start: 0, end: 0, totalSize: 0 }

  const size = Math.max(1, itemSize)
  const safeScrollTop = Math.max(0, scrollTop)
  const safeOverscan = Math.max(0, Math.floor(overscan))
  const visibleStart = Math.min(count - 1, Math.floor(safeScrollTop / size))
  const visibleCount =
    viewportHeight > 0 ? Math.max(1, Math.ceil(viewportHeight / size)) : safeOverscan + 1

  const start = Math.max(0, visibleStart - safeOverscan)
  const end = Math.min(count, visibleStart + visibleCount + safeOverscan)

  return {
    start,
    end,
    totalSize: count * size
  }
}

export interface VirtualIndexScrollInput {
  index: number
  itemCount: number
  itemSize: number
  currentScrollTop: number
  viewportHeight: number
}

export function getScrollTopForVirtualIndex({
  index,
  itemCount,
  itemSize,
  currentScrollTop,
  viewportHeight
}: VirtualIndexScrollInput): number {
  const count = Math.max(0, Math.floor(itemCount))
  if (count === 0) return Math.max(0, currentScrollTop)

  const size = Math.max(1, itemSize)
  const safeViewportHeight = Math.max(1, viewportHeight)
  const safeIndex = Math.max(0, Math.min(count - 1, Math.floor(index)))
  const current = Math.max(0, currentScrollTop)
  const itemTop = safeIndex * size
  const itemBottom = itemTop + size
  const viewportBottom = current + safeViewportHeight

  let next = current
  if (itemTop < current) {
    next = itemTop
  } else if (itemBottom > viewportBottom) {
    next = itemBottom - safeViewportHeight
  }

  const maxScrollTop = Math.max(0, count * size - safeViewportHeight)
  return Math.max(0, Math.min(maxScrollTop, next))
}
