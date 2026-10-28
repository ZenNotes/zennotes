/**
 * Row-list panels — the sidebar, note list, connections, comments and outline —
 * all navigate the same way: each row carries a `data-<name>-idx`, the cursor
 * lives in the store, and moving it means finding the rows in visual order,
 * clamping, then scrolling the landing row into view.
 *
 * That mechanism used to exist three times over (VimNav's closures, pane-nav's
 * own copy, and nothing at all for non-Vim mode), which is how the two pane
 * navigations drifted apart in the first place (#477). It lives here once now,
 * so VimNav's panel handlers (which serve the panels in both modes) and pane
 * navigation agree about where a cursor is and where it goes next.
 */
import { useStore } from '../store'

export type IndexedDatasetKey =
  | 'sidebarIdx'
  | 'notelistIdx'
  | 'connectionsIdx'
  | 'commentsIdx'
  | 'outlineIdx'

/** Panels whose rows are addressed by a numeric cursor held in the store. The
 *  comments panel is deliberately absent: it tracks the active comment by id,
 *  not by row index, and VimNav walks it by that id. */
export type RowPanel = 'sidebar' | 'notelist' | 'connections' | 'outline'

export const ROW_PANEL_DEFS: Record<
  RowPanel,
  { selector: string; datasetKey: IndexedDatasetKey }
> = {
  sidebar: { selector: '[data-sidebar-idx]', datasetKey: 'sidebarIdx' },
  notelist: { selector: '[data-notelist-idx]', datasetKey: 'notelistIdx' },
  connections: { selector: '[data-connections-idx]', datasetKey: 'connectionsIdx' },
  outline: { selector: '[data-outline-idx]', datasetKey: 'outlineIdx' }
}

export function isRowPanel(panel: string | null | undefined): panel is RowPanel {
  return !!panel && panel in ROW_PANEL_DEFS
}

/** Rows currently on screen, in the order they are rendered (top to bottom,
 *  then left to right), falling back to the assigned index within a row. */
export function getIndexedElements(
  selector: string,
  datasetKey: IndexedDatasetKey
): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)]
    .filter((el) => el.getClientRects().length > 0)
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect()
      const bRect = b.getBoundingClientRect()
      const rowDelta = aRect.top - bRect.top

      // Follow the actual rendered row order first, then fall back
      // to the assigned index for stable ordering within the same row.
      if (Math.abs(rowDelta) > 2) return rowDelta

      const colDelta = aRect.left - bRect.left
      if (Math.abs(colDelta) > 2) return colDelta

      return getIndexedValue(a, datasetKey) - getIndexedValue(b, datasetKey)
    })
}

export function getIndexedValue(
  el: HTMLElement | null,
  datasetKey: IndexedDatasetKey
): number {
  const value = Number(el?.dataset[datasetKey] ?? -1)
  return Number.isFinite(value) ? value : -1
}

export function getIndexedElementByIndex(
  items: HTMLElement[],
  datasetKey: IndexedDatasetKey,
  index: number
): HTMLElement | undefined {
  return items.find((item) => getIndexedValue(item, datasetKey) === index)
}

/** Position in the sorted rows for a stored cursor index (no DOM focus needed).
 *  Clamps when the index is gone — a collapsed parent, an edited-away heading. */
export function findPositionByIndex(
  items: HTMLElement[],
  datasetKey: IndexedDatasetKey,
  cursorIndex: number
): number {
  const exact = items.findIndex((item) => getIndexedValue(item, datasetKey) === cursorIndex)
  if (exact >= 0) return exact
  return items.length === 0 ? 0 : Math.max(0, Math.min(cursorIndex, items.length - 1))
}

/** Update the cursor index and scroll the element into view. */
export function scrollToIndexedElement(
  el: HTMLElement | undefined,
  datasetKey: IndexedDatasetKey,
  setIndex: (idx: number) => void
): void {
  if (!el) return
  const idx = getIndexedValue(el, datasetKey)
  if (idx < 0) return
  setIndex(idx)
  el.scrollIntoView({ block: 'nearest' })
}

export function scrollToIndexedIndex(
  items: HTMLElement[],
  datasetKey: IndexedDatasetKey,
  index: number,
  setIndex: (idx: number) => void
): void {
  const target = getIndexedElementByIndex(items, datasetKey, index)
  setIndex(index)
  target?.scrollIntoView({ block: 'nearest' })
}

/** The store cursor behind a row panel, read and write. */
export function rowCursor(
  panel: RowPanel,
  state: ReturnType<typeof useStore.getState>
): { index: number; setIndex: (idx: number) => void } {
  switch (panel) {
    case 'sidebar':
      return { index: state.sidebarCursorIndex, setIndex: state.setSidebarCursorIndex }
    case 'notelist':
      return { index: state.noteListCursorIndex, setIndex: state.setNoteListCursorIndex }
    case 'connections':
      return { index: state.connectionsCursorIndex, setIndex: state.setConnectionsCursorIndex }
    case 'outline':
      return { index: state.outlineCursorIndex, setIndex: state.setOutlineCursorIndex }
  }
}

/** What a page key asks of a panel's cursor. */
export type PageMove = 'first' | 'last' | 'pageDown' | 'pageUp'

/**
 * Home, End, Page Up and Page Down in a focused panel, with Vim mode off: the
 * ends and a screenful of rows. Vim mode leaves all four as they were (gg and
 * G are its keys), so this is null there, and for a chord.
 */
export function pageMoveForKey(event: KeyboardEvent, vimMode: boolean): PageMove | null {
  if (vimMode || event.metaKey || event.ctrlKey || event.altKey) return null
  switch (event.key) {
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
    case 'PageDown':
      return 'pageDown'
    case 'PageUp':
      return 'pageUp'
    default:
      return null
  }
}

/** The box a panel's rows scroll in: the sidebar's, or one a panel marks. */
const PANEL_SCROLL_BOX = '.zn-sidebar-scroll, [data-panel-scroll]'

/**
 * A page in a list of same-height rows (the sidebar, the note list): the rows
 * the scroll box shows, less one, so the row the cursor leaves is still on
 * screen where it lands. A count rather than a row, because both lists render
 * only the rows near the viewport. A row is measured by its step to the next
 * one, gap included (the smallest step among the rows on screen, since a
 * section header makes some steps longer), and the box by the height inside
 * its padding: the note list's rows are 4 px apart in a padded box, and
 * counting them by their own height paged one row too far.
 */
export function pageRowCount(items: HTMLElement[], position: number): number {
  const row = items[position] ?? items[0]
  const box = row?.closest<HTMLElement>(PANEL_SCROLL_BOX)
  if (!row || !box) return 1
  let pitch = Infinity
  for (let i = 1; i < items.length; i++) {
    const step = items[i].getBoundingClientRect().top - items[i - 1].getBoundingClientRect().top
    if (step > 2 && step < pitch) pitch = step
  }
  if (!Number.isFinite(pitch)) pitch = row.getBoundingClientRect().height
  const style = window.getComputedStyle(box)
  const inner =
    box.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0)
  if (pitch <= 0 || inner <= 0) return 1
  return Math.max(1, Math.floor(inner / pitch) - 1)
}

/**
 * A page in a list whose rows are all rendered and may differ in height (the
 * connections and comments cards, the outline): the furthest row that still
 * fits on one screen together with the row the cursor leaves. With rows of
 * one height this is the page `pageRowCount` gives, and a tall card never
 * makes the cursor skip a row the screen has not shown. At least one row;
 * clamped at the ends.
 */
export function pageTargetPosition(
  items: HTMLElement[],
  current: number,
  direction: 1 | -1
): number {
  const last = items.length - 1
  if (last < 0) return 0
  const from = Math.max(0, Math.min(current, last))
  const step = Math.max(0, Math.min(from + direction, last))
  const row = items[from]
  const boxHeight = row?.closest<HTMLElement>(PANEL_SCROLL_BOX)?.clientHeight ?? 0
  if (!row || boxHeight <= 0) return step
  const leaving = row.getBoundingClientRect()
  let target = step
  for (let i = from + direction; i >= 0 && i <= last; i += direction) {
    const rect = items[i].getBoundingClientRect()
    const span = direction === 1 ? rect.bottom - leaving.top : leaving.bottom - rect.top
    if (span > boxHeight) break
    target = i
  }
  return target
}
