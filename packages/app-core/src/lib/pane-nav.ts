/**
 * Vim-style pane navigation. Given the active pane and a direction
 * (`h` left, `j` down, `k` up, `l` right), find the nearest neighbor
 * pane geometrically from the live DOM and focus it.
 *
 * We use bounding rects rather than walking the tree because the user's
 * mental model matches what they see on screen — sibling panes in a
 * deeply nested split still look like simple neighbors.
 */
import { useStore } from '../store'

export type PaneDirection = 'h' | 'j' | 'k' | 'l'
type EdgePanel = 'sidebar' | 'notelist' | 'editor' | 'connections'

interface PaneRect {
  id: string
  rect: DOMRect
}

function getPaneRects(): PaneRect[] {
  if (typeof document === 'undefined') return []
  const nodes = document.querySelectorAll<HTMLElement>('[data-pane-id]')
  const rects: PaneRect[] = []
  for (const el of Array.from(nodes)) {
    const id = el.dataset.paneId
    if (!id) continue
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    rects.push({ id, rect })
  }
  return rects
}

/** Pick the nearest pane in the requested direction, or null if none fits. */
export function findNeighborPaneId(
  panes: PaneRect[],
  currentId: string,
  direction: PaneDirection
): string | null {
  const current = panes.find((p) => p.id === currentId)
  if (!current) return null
  const cx = current.rect.left + current.rect.width / 2
  const cy = current.rect.top + current.rect.height / 2

  const tolerance = 2
  const candidates = panes.filter((p) => {
    if (p.id === currentId) return false
    const r = p.rect
    switch (direction) {
      case 'h':
        return r.right <= current.rect.left + tolerance
      case 'l':
        return r.left >= current.rect.right - tolerance
      case 'k':
        return r.bottom <= current.rect.top + tolerance
      case 'j':
        return r.top >= current.rect.bottom - tolerance
    }
  })
  if (candidates.length === 0) return null

  const score = (p: PaneRect): number => {
    const pcx = p.rect.left + p.rect.width / 2
    const pcy = p.rect.top + p.rect.height / 2
    // Primary axis: distance along the direction of travel.
    // Secondary axis: perpendicular offset (closer-aligned wins ties).
    if (direction === 'h' || direction === 'l') {
      const perpendicular = Math.abs(pcy - cy)
      const aligned =
        direction === 'h' ? current.rect.left - p.rect.right : p.rect.left - current.rect.right
      return perpendicular * 10 + Math.max(0, aligned)
    }
    const perpendicular = Math.abs(pcx - cx)
    const aligned =
      direction === 'k' ? current.rect.top - p.rect.bottom : p.rect.top - current.rect.bottom
    return perpendicular * 10 + Math.max(0, aligned)
  }
  candidates.sort((a, b) => score(a) - score(b))
  return candidates[0].id
}

/** The pinned reference pane lives outside `paneLayout`; we handle its
 *  focus by targeting its DOM directly instead of `setActivePane`. */
const PINNED_REF_PANE_ID = 'pinned-ref'

function focusPinnedRefDom(): void {
  const cm = document.querySelector<HTMLElement>(
    `[data-pane-id="${PINNED_REF_PANE_ID}"] .cm-content`
  )
  cm?.focus()
}

function getVisibleEdgePanels(state: ReturnType<typeof useStore.getState>): EdgePanel[] {
  const panels: EdgePanel[] = []
  if (state.sidebarOpen) panels.push('sidebar')
  if (state.noteListOpen && !state.unifiedSidebar) panels.push('notelist')
  panels.push('editor')
  if (document.querySelector('[data-connections-panel]')) panels.push('connections')
  return panels
}

function resolveNeighborEdgePanel(
  current: EdgePanel,
  direction: PaneDirection,
  panels: EdgePanel[]
): EdgePanel | null {
  const index = panels.indexOf(current)
  if (index === -1) return null
  if (direction === 'h' || direction === 'k') {
    return index > 0 ? panels[index - 1] : current
  }
  return index < panels.length - 1 ? panels[index + 1] : current
}

function findIndexedElement(
  selector: string,
  datasetKey: 'sidebarIdx' | 'notelistIdx' | 'connectionsIdx',
  targetIndex: number
): HTMLElement | null {
  const items = Array.from(document.querySelectorAll<HTMLElement>(selector))
    .map((el) => ({
      el,
      index: Number(el.dataset[datasetKey])
    }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index)
  return items.find((entry) => entry.index === targetIndex)?.el ?? items[0]?.el ?? null
}

function focusEdgePanel(panel: Exclude<EdgePanel, 'editor'>): void {
  const state = useStore.getState()
  state.setFocusedPanel(panel)
  ;(document.activeElement as HTMLElement | null)?.blur()
  requestAnimationFrame(() => {
    const target =
      panel === 'sidebar'
        ? findIndexedElement('[data-sidebar-idx]', 'sidebarIdx', state.sidebarCursorIndex)
        : panel === 'notelist'
          ? findIndexedElement('[data-notelist-idx]', 'notelistIdx', state.noteListCursorIndex)
          : findIndexedElement(
              '[data-connections-idx]',
              'connectionsIdx',
              state.connectionsCursorIndex
            )
    target?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * Focus the pane in the given direction from the currently active one.
 * No-op if no neighbor exists that way. Also sets the editor panel
 * focused so keyboard input lands in the new pane's CodeMirror view.
 */
export function focusPaneInDirection(direction: PaneDirection): boolean {
  const state = useStore.getState()
  const rects = getPaneRects()
  // Treat the pinned reference pane as the "currently focused" pane
  // when its CodeMirror is the active element — geometric nav picks up
  // from where the cursor actually lives, not from activePaneId.
  const activeEl = document.activeElement as HTMLElement | null
  const inPinned =
    activeEl?.closest(`[data-pane-id="${PINNED_REF_PANE_ID}"]`) != null
  const currentId = inPinned ? PINNED_REF_PANE_ID : state.activePaneId
  const targetId = findNeighborPaneId(rects, currentId, direction)
  if (!targetId) return false
  if (targetId === PINNED_REF_PANE_ID) {
    state.setFocusedPanel('editor')
    requestAnimationFrame(focusPinnedRefDom)
    return true
  }
  state.setActivePane(targetId)
  state.setFocusedPanel('editor')
  requestAnimationFrame(() => {
    useStore.getState().editorViewRef?.focus()
  })
  return true
}

/** Focus the editor pane at the left or right edge of the editor area. Used
 *  when crossing in from an edge panel (sidebar / note list / connections) so
 *  we land on the pane that actually sits next to it, not wherever
 *  `activePaneId` happened to be. */
function focusEditorEdgePane(direction: PaneDirection): boolean {
  const rects = getPaneRects().filter((p) => p.id !== PINNED_REF_PANE_ID)
  if (rects.length === 0) return false
  const sorted = rects.slice().sort((a, b) => a.rect.left - b.rect.left)
  const target = direction === 'l' ? sorted[0] : sorted[sorted.length - 1]
  const state = useStore.getState()
  state.setActivePane(target.id)
  state.setFocusedPanel('editor')
  requestAnimationFrame(() => {
    const cm = document.querySelector<HTMLElement>(
      `[data-pane-id="${target.id}"] .cm-content`
    )
    if (cm) cm.focus()
    else useStore.getState().editorViewRef?.focus()
  })
  return true
}

export function focusPaneOrEdgePanel(direction: PaneDirection): boolean {
  const state = useStore.getState()
  const focused = state.focusedPanel

  // When focus is on a horizontal edge panel, move relative to THAT panel
  // instead of geometrically from activePaneId — otherwise `l` from the sidebar
  // navigates from the last active pane and skips the pane that sits right next
  // to the sidebar. (#124)
  if (
    (direction === 'h' || direction === 'l') &&
    (focused === 'sidebar' || focused === 'notelist' || focused === 'connections')
  ) {
    const next = resolveNeighborEdgePanel(focused, direction, getVisibleEdgePanels(state))
    if (!next || next === focused) return false
    if (next === 'editor') return focusEditorEdgePane(direction)
    focusEdgePanel(next)
    return true
  }

  if (focusPaneInDirection(direction)) return true

  const next = resolveNeighborEdgePanel('editor', direction, getVisibleEdgePanels(state))
  if (!next || next === 'editor') return false
  focusEdgePanel(next)
  return true
}
