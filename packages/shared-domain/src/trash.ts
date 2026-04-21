/**
 * Virtual path used to identify the built-in Trash view as a tab in the
 * pane layout. Uses the `zen://` scheme so it never collides with a real
 * vault-relative note path.
 */
export const TRASH_TAB_PATH = 'zen://trash'

/** True when `path` points at the built-in Trash tab. */
export function isTrashTabPath(path: string | null | undefined): boolean {
  return path === TRASH_TAB_PATH
}
