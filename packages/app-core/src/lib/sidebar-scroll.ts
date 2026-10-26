export const SIDEBAR_POINTER_SCROLL_TARGET_MS = 1_200

export interface SidebarScrollAnchorInput {
  scrollTop: number
  anchorTop: number
  nextAnchorTop: number
  scrollHeight: number
  clientHeight: number
}

export function getScrollTopForPreservedSidebarAnchor({
  scrollTop,
  anchorTop,
  nextAnchorTop,
  scrollHeight,
  clientHeight
}: SidebarScrollAnchorInput): number {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
  const nextScrollTop = Math.max(0, scrollTop + nextAnchorTop - anchorTop)
  return Math.min(maxScrollTop, nextScrollTop)
}

export function isRecentSidebarPointerInteraction(
  lastPointerAt: number,
  now: number,
  windowMs = SIDEBAR_POINTER_SCROLL_TARGET_MS
): boolean {
  if (!Number.isFinite(lastPointerAt) || lastPointerAt <= 0) return false
  if (!Number.isFinite(now) || now < lastPointerAt) return false
  return now - lastPointerAt <= windowMs
}

/**
 * Whether the sidebar's reveal has a new selection to follow. The parts are
 * the things a person selects (the note, the view, the special views), and
 * they compare by identity. A reveal that ran for the same parts already put
 * the Vim cursor there, so re-running it can only pull the cursor back from
 * where the keys have since moved it. (#993)
 */
export function sidebarSelectionChanged(
  previous: readonly unknown[] | null,
  next: readonly unknown[]
): boolean {
  if (!previous || previous.length !== next.length) return true
  return next.some((part, i) => !Object.is(part, previous[i]))
}
