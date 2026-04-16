/**
 * Virtual path used to identify the built-in Quick Notes list view as a tab in
 * the pane layout. Uses the `zen://` scheme so it never collides with a real
 * vault-relative note path.
 */
export const QUICK_NOTES_TAB_PATH = 'zen://quick-notes'

/** True when `path` points at the built-in Quick Notes tab. */
export function isQuickNotesTabPath(path: string | null | undefined): boolean {
  return path === QUICK_NOTES_TAB_PATH
}
