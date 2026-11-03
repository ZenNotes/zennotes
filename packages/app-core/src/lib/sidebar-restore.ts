export type SidebarRestoreSlot = 'tab-strip' | 'note-header' | 'pane-strip' | 'home' | null

/**
 * Where a pane offers the way back to a hidden sidebar. A touch screen with no
 * keyboard has no ⌘1, so every state a pane can be in needs a control, or
 * hiding the sidebar locks the person out for good: the choice is saved, and
 * with note tabs off there is no tab strip to hold the button (zennotesios#88).
 *
 * Zen mode is left out on purpose: it hides all chrome, and has its own way out.
 */
export function sidebarRestoreSlot(pane: {
  sidebarOpen: boolean
  zenMode: boolean
  hasTabs: boolean
  hasNote: boolean
  hasVirtualTab: boolean
}): SidebarRestoreSlot {
  if (pane.sidebarOpen || pane.zenMode) return null
  if (pane.hasTabs) return 'tab-strip'
  if (pane.hasNote) return 'note-header'
  return pane.hasVirtualTab ? 'pane-strip' : 'home'
}
