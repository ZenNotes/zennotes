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

/**
 * The Excalidraw canvas is deliberately NOT in the list above. VimNav's global
 * bindings are meant to work from inside a drawing: the leader on a Space tap
 * (#309), gt/gT between buffers, the Ctrl+W pane prefix. So VimNav lets those
 * run first and yields only afterwards, at the point where it would otherwise
 * route the key into a panel (#721: with the sidebar open, Escape went to the
 * sidebar's "back to editor" instead of leaving the Arrow tool). What the
 * canvas shares with the list is the handoff rule below: giving the keyboard
 * to the sidebar must take DOM focus away from it too.
 */
export const EXCALIDRAW_SURFACE = '[data-excalidraw-view]'

/** Every surface that keeps the keys while it holds DOM focus. */
const FOCUS_HANDOFF_SURFACES = `${SELF_KEYED_SURFACES}, ${EXCALIDRAW_SURFACE}`

/** Blur the active element when it sits inside a surface that keeps its own
 *  keys, so keys follow the store's focused panel instead of the surface's own
 *  handler. An interactive control inside the surface (a cell editor mid-edit,
 *  a header button, Excalidraw's text editor) keeps focus: blurring it commits
 *  or cancels the user's edit, the exact yank DatabaseTableView's claimFocus
 *  refuses in the other direction. The handoff only needs the surface's own
 *  container blurred. */
export function releaseSelfKeyedSurfaceFocus(): void {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !active.closest(FOCUS_HANDOFF_SURFACES)) return
  if (active.closest('input, textarea, button, [contenteditable="true"]')) return
  active.blur()
}
