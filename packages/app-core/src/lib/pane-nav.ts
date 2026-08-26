/**
 * Vim-style pane navigation. Given the active pane and a direction
 * (`h` left, `j` down, `k` up, `l` right), find the nearest neighbor
 * pane geometrically from the live DOM and focus it.
 *
 * We use bounding rects rather than walking the tree because the user's
 * mental model matches what they see on screen — sibling panes in a
 * deeply nested split still look like simple neighbors.
 */
import { isAtlasViewActive, isTasksViewActive, useStore } from '../store'
import { getVisiblePanelsNow, resolveNextPanel, type Panel } from './vim-nav'
import {
  ROW_PANEL_DEFS,
  findPositionByIndex,
  getIndexedElements,
  getIndexedValue,
  isRowPanel,
  rowCursor
} from './panel-rows'

export type PaneDirection = 'h' | 'j' | 'k' | 'l'

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

/** The panels currently on screen, left to right. Shared with vim's `<C-w>hjkl`
 *  so both navigations walk the exact same list. (#477) */
function getVisiblePanelList(state: ReturnType<typeof useStore.getState>): Panel[] {
  return getVisiblePanelsNow({
    sidebarOpen: state.sidebarOpen,
    noteListOpen: state.noteListOpen,
    unifiedSidebar: state.unifiedSidebar,
    tasksViewOpen: isTasksViewActive(state),
    atlasViewOpen: isAtlasViewActive(state)
  })
}

function resolveNeighborPanel(
  current: Panel,
  direction: PaneDirection,
  panels: Panel[]
): Panel | null {
  if (!panels.includes(current)) return null
  return resolveNextPanel(current, direction === 'h' || direction === 'k' ? 'left' : 'right', panels)
}

/**
 * Give `panel` keyboard focus, whichever kind of panel it is. One routine for
 * both pane navigations (and for any future entry point), because keeping two
 * copies of "how do I focus the comments panel" is exactly how `Alt+hjkl` ended
 * up reaching fewer panels than `<C-w>hjkl`. (#477)
 *
 * Row-list panels (sidebar / note list / connections / outline) don't take DOM
 * focus: their keys are handled centrally off `focusedPanel`, so we only blur
 * whatever held focus and scroll their cursor row back into view. The comments
 * and calendar panels own their keyboard handling, so they take real DOM focus.
 */
export function focusPanel(panel: Panel, direction?: PaneDirection): void {
  const state = useStore.getState()
  if (panel === 'editor') {
    if (direction) focusEditorEdgePane(direction)
    else {
      state.setFocusedPanel('editor')
      requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
    }
    return
  }
  if (panel === 'sidebar' && !state.sidebarOpen) state.toggleSidebar()
  state.setFocusedPanel(panel)
  ;(document.activeElement as HTMLElement | null)?.blur()
  if (panel === 'tasks' || panel === 'tags') return
  requestAnimationFrame(() => {
    if (panel === 'comments' || panel === 'calendar') {
      document
        .querySelector<HTMLElement>(`[data-${panel}-panel]`)
        ?.focus({ preventScroll: true })
      return
    }
    if (!isRowPanel(panel)) return
    const { selector, datasetKey } = ROW_PANEL_DEFS[panel]
    const { index, setIndex } = rowCursor(panel, state)
    const items = getIndexedElements(selector, datasetKey)
    const row = items[findPositionByIndex(items, datasetKey, index)]
    if (!row) return
    // Re-seat the cursor on the row we actually landed on, so the highlight and
    // the stored index agree even when the list shrank while we were away.
    const landed = getIndexedValue(row, datasetKey)
    if (landed >= 0 && landed !== index) setIndex(landed)
    row.scrollIntoView({ block: 'nearest' })
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
  const panels = getVisiblePanelList(state)

  // From the tab strip, down is the note under it. `<C-w>j` already lands
  // there; the Alt binding dead-ended because no pane sits below (#679).
  if (focused === 'tabs' && direction === 'j') {
    focusPanel('editor')
    return true
  }

  // When focus is already on a panel, move relative to THAT panel instead of
  // geometrically from activePaneId — otherwise `l` from the sidebar navigates
  // from the last active pane and skips the pane sitting right next to it
  // (#124). Every panel in the list qualifies, so the walk continues past
  // Connections into Comments / Outline / Calendar the way `<C-w>hjkl` does
  // rather than dead-ending. (#477)
  if (focused && focused !== 'editor' && focused !== 'tabs' && panels.includes(focused)) {
    const next = resolveNeighborPanel(focused, direction, panels)
    if (!next || next === focused) return false
    if (next === 'editor') return focusEditorEdgePane(direction)
    focusPanel(next)
    return true
  }

  if (focusPaneInDirection(direction)) return true

  const current: Panel = panels.includes('tasks') ? 'tasks' : 'editor'
  const next = resolveNeighborPanel(current, direction, panels)
  if (!next || next === current) return false
  focusPanel(next)
  return true
}
