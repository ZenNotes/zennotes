/**
 * Surfaces that run their own keyboard, which the global VimNav listener must
 * not touch.
 *
 * VimNav's handler is CAPTURE-PHASE on window and calls
 * stopImmediatePropagation, so by default it wins every key in the app and
 * routes it into sidebar and note-list navigation. Any panel with its own
 * focus and its own keys has to be excluded there, and forgetting does not
 * look like a routing bug: the panel simply appears to have no keyboard at
 * all. Both Workflows surfaces shipped with exactly that symptom (arrows
 * moved the SIDEBAR cursor, Backspace "focused the left sidebar", m opened
 * the sidebar folder menu), and each was diagnosed from scratch because the
 * previous fix was an anonymous copy of the same three lines.
 *
 * One list and one condition, so a new surface is one entry rather than a
 * fourth near-identical block, and the Ctrl+W passthrough cannot be got wrong
 * per surface. Ctrl+W and its pending direction key always survive, so a
 * panel can still hand off to pane and tab navigation.
 *
 * The list is shared with `setFocusedPanel`: the yield means a store
 * `focusedPanel` that disagrees with DOM focus makes the app deaf (the
 * sidebar renders its vim cursor and `m` hint while the grid quietly keeps
 * every key), so handing the keyboard to the sidebar must also release DOM
 * focus from these surfaces.
 */
export const SELF_KEYED_SURFACES = [
  // Runs its own vim-style motion grid.
  '[data-zen-db-grid]',
  '[data-workflow-list-pane]',
  '[data-workflow-canvas]',
  // Owns bracket region navigation before global Vim buffer prefixes.
  '[data-atlas-view]'
].join(', ')

/** Blur the active element when it sits inside a self-keyed surface, so keys
 *  follow the store's focused panel instead of the surface's own handler.
 *  An interactive control inside the surface (a cell editor mid-edit, a
 *  header button) keeps focus: blurring it commits or cancels the user's
 *  edit, the exact yank DatabaseTableView's claimFocus refuses in the other
 *  direction. The handoff only needs the surface's own grid element blurred. */
export function releaseSelfKeyedSurfaceFocus(): void {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !active.closest(SELF_KEYED_SURFACES)) return
  if (active.closest('input, textarea, button, [contenteditable="true"]')) return
  active.blur()
}
