/**
 * The sidebar's Vim cursor is a row NUMBER: `sidebarCursorIndex` names the row
 * whose `data-sidebar-idx` matches it. Sidebar hands those numbers out in
 * render order on every render, and render order is not even display order (a
 * folder numbers its notes before the subfolders it shows above them). So when
 * the listing changes under the cursor (a note written from outside the app, a
 * sync), every row numbered after the change moves up or down one, and the
 * cursor silently lands on whichever row inherits its number.
 *
 * The number stays the cursor (VimNav, panel-rows and the windowed rows all
 * speak it). What this adds is a note of which row the number named, taken
 * from the DOM when the cursor moves, so that Sidebar can put the number back
 * on that row after a render renumbers it.
 */

export interface SidebarCursorAnchor {
  /** The cursor's `data-sidebar-idx` when the anchor was taken. */
  index: number
  /** What the row is, from its identifying attributes (see sidebarRowIdentity). */
  identity: string
  /** Matches the row and any twin that shares its identity. */
  selector: string
  /** Which of those twins it is, in document order. Atlas and Workflows are
   *  both `data-sidebar-type="workflows"` with nothing else to tell them apart. */
  occurrence: number
  /** Its position among all sidebar rows in document order, to find the row
   *  that took its place when it goes away. */
  ordinal: number
  /** Its ancestor elements, nearest first, to tell which neighbor shared its
   *  folder when it goes away. */
  ancestors: Element[]
}

const ROW_SELECTOR = '[data-sidebar-idx]'

/** The attributes that say which row a row is. Display state (collapsed,
 *  expandable, the number itself) is left out on purpose. */
const IDENTITY_ATTRIBUTES = [
  'data-sidebar-type',
  'data-sidebar-select-key',
  'data-sidebar-path',
  'data-sidebar-key',
  'data-sidebar-folder',
  'data-sidebar-subpath',
  'data-sidebar-tag',
  'data-sidebar-datenav-key',
  'data-sidebar-database'
] as const

function escapeForAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

function rowIndex(row: Element): number {
  const value = Number(row.getAttribute('data-sidebar-idx'))
  return Number.isInteger(value) && value >= 0 ? value : -1
}

/**
 * A row's identity. A tree note and the same note pinned under Favorites are
 * different rows (only the tree row carries a select key), while a windowed
 * placeholder carries the attributes of the full row it stands in for, so the
 * two read as one row.
 */
export function sidebarRowIdentity(row: Element): string {
  return JSON.stringify(IDENTITY_ATTRIBUTES.map((name) => row.getAttribute(name)))
}

function sidebarRowSelector(row: Element): string {
  let selector = ROW_SELECTOR
  for (const name of IDENTITY_ATTRIBUTES) {
    const value = row.getAttribute(name)
    if (value !== null) selector += `[${name}="${escapeForAttr(value)}"]`
  }
  return selector
}

function rowTwins(root: ParentNode, selector: string, identity: string): Element[] {
  return [...root.querySelectorAll(selector)].filter((row) => sidebarRowIdentity(row) === identity)
}

/** The anchor for the row numbered `index`, or null when no row has it. */
export function anchorSidebarCursor(root: ParentNode, index: number): SidebarCursorAnchor | null {
  const rows = [...root.querySelectorAll(ROW_SELECTOR)]
  const ordinal = rows.findIndex((row) => rowIndex(row) === index)
  if (ordinal < 0) return null
  const row = rows[ordinal]
  const identity = sidebarRowIdentity(row)
  const selector = sidebarRowSelector(row)
  const ancestors: Element[] = []
  for (let node = row.parentElement; node; node = node.parentElement) ancestors.push(node)
  return {
    index,
    identity,
    selector,
    occurrence: Math.max(0, rowTwins(root, selector, identity).indexOf(row)),
    ordinal,
    ancestors
  }
}

/**
 * The number the anchored row has now, or null when it is gone. A twin that
 * went away takes its neighbor twin's place, which is also the row next to it.
 */
export function findSidebarCursorRow(root: ParentNode, anchor: SidebarCursorAnchor): number | null {
  const twins = rowTwins(root, anchor.selector, anchor.identity)
  if (twins.length === 0) return null
  const index = rowIndex(twins[Math.min(anchor.occurrence, twins.length - 1)])
  return index >= 0 ? index : null
}

/**
 * The rows on either side of where a gone row sat, as positions in `rows`
 * (-1 for none): the one that now sits in its place, and the one before it.
 * Rows the browser does not lay out are skipped, the way the j/k row scan
 * skips them, and so are rows without a number.
 */
export function sidebarCursorNeighbors(
  rows: readonly { index: number; rendered: boolean }[],
  ordinal: number
): { after: number; before: number } {
  const usable = (i: number): boolean => rows[i].index >= 0 && rows[i].rendered
  const start = Math.min(Math.max(ordinal, 0), rows.length)
  let after = start
  while (after < rows.length && !usable(after)) after++
  let before = start - 1
  while (before >= 0 && !usable(before)) before--
  return { after: after < rows.length ? after : -1, before }
}

/** How far up from `row` the nearest ancestor it shares with the anchored
 *  row is; Infinity when it shares none. */
function treeDistance(row: Element, ancestors: readonly Element[]): number {
  for (let node = row.parentElement; node; node = node.parentElement) {
    const at = ancestors.indexOf(node)
    if (at >= 0) return at
  }
  return Infinity
}

/**
 * Where the cursor goes when its row is gone (deleted, moved away, renamed to
 * another sort position): the row that now sits where it sat, so a note
 * renamed without changing its place keeps the cursor. When the row before
 * it is closer in the tree (the gone row was the last one in its folder, and
 * the row in its place belongs to another folder or another sidebar section),
 * the cursor stays in the folder and takes that one instead.
 */
export function sidebarCursorFallbackInDom(
  root: ParentNode,
  anchor: Pick<SidebarCursorAnchor, 'ordinal' | 'ancestors'>
): number | null {
  // Only reached when the cursor's row is gone, so the layout reads stay off
  // the path every render takes.
  const rows = [...root.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
  const { after, before } = sidebarCursorNeighbors(
    rows.map((row) => ({
      index: rowIndex(row),
      get rendered() {
        return row.getClientRects().length > 0
      }
    })),
    anchor.ordinal
  )
  if (after < 0 && before < 0) return null
  const pick =
    after < 0
      ? before
      : before < 0
        ? after
        : treeDistance(rows[before], anchor.ancestors) < treeDistance(rows[after], anchor.ancestors)
          ? before
          : after
  return rowIndex(rows[pick])
}
