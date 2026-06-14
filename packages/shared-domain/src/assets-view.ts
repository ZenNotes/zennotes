/**
 * Virtual path used to identify the built-in Assets (resources) view as a tab
 * in the pane layout. Uses the `zen://` scheme so it never collides with a real
 * vault-relative note path. Note this is distinct from `zen://asset/<path>`
 * (an individual asset opened in a tab) — this one has no trailing slot.
 */
export const ASSETS_VIEW_TAB_PATH = 'zen://assets'

/** True when `path` points at the built-in Assets view tab. */
export function isAssetsViewTabPath(path: string | null | undefined): boolean {
  return path === ASSETS_VIEW_TAB_PATH
}
