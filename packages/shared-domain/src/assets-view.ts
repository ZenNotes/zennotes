/**
 * Virtual path used to identify the built-in Assets view as a tab in the pane
 * layout. Uses the `zen://` scheme so it never collides with a real vault path.
 * Distinct from `zen://asset/<path>` (a single asset opened as a tab).
 */
export const ASSETS_VIEW_TAB_PATH = 'zen://assets'

/** True when `path` points at the built-in Assets view tab. */
export function isAssetsViewTabPath(path: string | null | undefined): boolean {
  return path === ASSETS_VIEW_TAB_PATH
}

/**
 * The canonical top-level folder where the vault keeps its assets (images,
 * PDFs, and other attachments), unified so they no longer mix with notes.
 */
export const ASSETS_DIR = 'assets'
