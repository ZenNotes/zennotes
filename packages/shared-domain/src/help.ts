/**
 * Virtual path used to identify the in-app Help manual as a tab in the
 * pane layout. Uses the `zen://` scheme so it never collides with a
 * real vault-relative markdown path.
 */
export const HELP_TAB_PATH = 'zen://help'

/** True when `path` points at the built-in Help tab. */
export function isHelpTabPath(path: string | null | undefined): boolean {
  return path === HELP_TAB_PATH
}
