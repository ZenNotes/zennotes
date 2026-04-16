/**
 * Virtual path used to identify the built-in Archive view as a tab in the
 * pane layout. Uses the `zen://` scheme so it never collides with a real
 * vault-relative note path.
 */
export const ARCHIVE_TAB_PATH = 'zen://archive'

/** True when `path` points at the built-in Archive tab. */
export function isArchiveTabPath(path: string | null | undefined): boolean {
  return path === ARCHIVE_TAB_PATH
}
