/**
 * Which keys the database grid (Table view) answers, and what each one does.
 *
 * The grid's letters are Vim motions and Vim verbs (h/j/k/l, H/L, 0 ^ $,
 * gg/G, i, x, dd, a, o, O, c, m), so like every list in the app they are
 * Vim mode's alone. With Vim mode off the grid keeps the keys every list
 * keeps: the arrows move the cell cursor (ArrowUp past the first row
 * reaches the column header, as k does), Enter edits the cell or renames
 * the field on the header, Space selects the row (or toggles a checkbox
 * cell), Escape clears and leaves, and Shift+F10 or the Context Menu key
 * opens the row's menu (the column's on the header), as in the sidebar and
 * the note list. A chord (Ctrl, Alt or Cmd held) is never the grid's.
 *
 * One function, so the gating can be tested apart from the component.
 */
export type DatabaseGridKeyAction =
  | 'down'
  | 'up'
  | 'left'
  | 'right'
  | 'move-column-left'
  | 'move-column-right'
  | 'first-column'
  | 'last-column'
  | 'last-row'
  | 'g'
  | 'd'
  | 'edit'
  | 'space'
  | 'select'
  | 'open-page'
  | 'create-pages'
  | 'columns'
  | 'menu'
  | 'add-row'
  | 'escape'

export interface GridKey {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

/** Keys the grid answers in both modes. */
const UNIVERSAL = new Map<string, DatabaseGridKeyAction>(Object.entries({
  ArrowDown: 'down',
  ArrowUp: 'up',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'edit',
  ' ': 'space',
  Escape: 'escape',
  ContextMenu: 'menu'
}) as Array<[string, DatabaseGridKeyAction]>)

/** The grid's Vim keys: answered only with Vim mode on. */
const VIM_ONLY = new Map<string, DatabaseGridKeyAction>(Object.entries({
  j: 'down',
  k: 'up',
  h: 'left',
  l: 'right',
  H: 'move-column-left',
  L: 'move-column-right',
  '0': 'first-column',
  '^': 'first-column',
  $: 'last-column',
  G: 'last-row',
  g: 'g',
  d: 'd',
  i: 'edit',
  x: 'select',
  o: 'open-page',
  O: 'create-pages',
  c: 'columns',
  m: 'menu',
  a: 'add-row'
}) as Array<[string, DatabaseGridKeyAction]>)

export function databaseGridKeyAction(e: GridKey, vimMode: boolean): DatabaseGridKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null // leave global shortcuts alone
  if (e.key === 'F10') return e.shiftKey ? 'menu' : null
  const universal = UNIVERSAL.get(e.key)
  if (universal) return universal
  if (!vimMode) return null
  return VIM_ONLY.get(e.key) ?? null
}

