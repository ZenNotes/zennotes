import { useRef } from 'react'

/**
 * Mutable counter threaded through the sidebar tree while it renders, handing
 * out the sequential `data-sidebar-idx` every row carries. The Vim cursor is
 * stored as one of these numbers, so a row must keep its number for as long as
 * the rows above it have not changed. Sidebar restarts it from 0 each render.
 */
export interface SidebarIdxCounter {
  value: number
}

/**
 * Identity of one render of a component that numbers rows. A tree component
 * receives a new one each time its parent renders it, and keeps seeing the
 * same one when it re-renders on its own. Compared by reference only.
 */
export type SidebarIdxPass = object

/**
 * Keep a tree component's row numbers stable when it re-renders on its own.
 *
 * The counter is only right for a component that renders as part of its
 * parent's render. One that re-renders alone (its progressive entry limit
 * resetting as the sidebar gains or loses focus, a drag hover) used to read
 * whatever the counter had been left at, and two things leave it wrong:
 *
 * - A full Sidebar render ends on the sidebar's total row count, so every row
 *   under the component jumped by that much. The stored Vim cursor then
 *   matched no row: coming back to the sidebar after opening a note hid the
 *   cursor, and the next j/k clamped to a position near the end of the list
 *   and landed on Assets or Trash.
 * - React also runs Sidebar's body and then bails out without rendering its
 *   children, which restarts the counter and leaves it just past Sidebar's own
 *   rows. Rows numbered from there collide with the folder rows above them.
 *
 * That second case is why a counter-side "Sidebar rendered" flag cannot tell
 * the two kinds of render apart; only a prop can, because props change exactly
 * when the parent really rendered this component. So: on a new `parentPass`,
 * remember the counter value this component starts from; on the same one,
 * restart from the remembered value. Call it before the component's first read
 * of the counter, and hand the returned pass to every tree component it
 * renders, which makes their numbering follow the same rule.
 */
export function useStableSidebarIdxBase(
  counter: SidebarIdxCounter,
  parentPass: SidebarIdxPass
): SidebarIdxPass {
  const seen = useRef<{ pass: SidebarIdxPass; base: number } | null>(null)
  if (seen.current?.pass === parentPass) {
    counter.value = seen.current.base
  } else {
    seen.current = { pass: parentPass, base: counter.value }
  }
  return {}
}
