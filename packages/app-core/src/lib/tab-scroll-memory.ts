/**
 * Per-note-tab scroll memory.
 *
 * The pane reuses a single editor + preview surface and renders only the
 * active tab's content, so switching tabs (or opening a diagram in a tab and
 * coming back) otherwise snaps a note to the top. This is a small imperative
 * cache — keyed by note path — that remembers each tab's editor and preview
 * scroll offsets so re-activating the tab can restore its position.
 *
 * It's intentionally a module-level cache, not store state: nothing renders
 * from it, it's read/written imperatively during tab switches and scrolls,
 * and it should never trigger React updates. Entries are capped with simple
 * LRU eviction so long sessions don't grow it without bound.
 */
export interface TabScrollPosition {
  editor: number
  preview: number
}

const TAB_SCROLL_MEMORY_LIMIT = 60
const memory = new Map<string, TabScrollPosition>()

export function rememberTabScroll(path: string, position: TabScrollPosition): void {
  if (!path) return
  // Re-insert so the most recently touched entry is last (LRU ordering).
  memory.delete(path)
  memory.set(path, position)
  while (memory.size > TAB_SCROLL_MEMORY_LIMIT) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

export function recallTabScroll(path: string): TabScrollPosition | undefined {
  return memory.get(path)
}

export function forgetTabScroll(path: string): void {
  memory.delete(path)
}

/** Test-only: drop all remembered positions. */
export function clearTabScrollMemory(): void {
  memory.clear()
}
