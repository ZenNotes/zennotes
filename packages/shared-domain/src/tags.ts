/**
 * Single virtual tab path for the vault-wide Tag view. Unlike Tasks (which
 * is always a solo surface), the Tag view accumulates one or more selected
 * tags in the store — clicking more tag chips *adds* them to the current
 * tab rather than spawning new tabs.
 *
 * Starts with `zen://` so the path never collides with a real vault-
 * relative note path (which is always POSIX `folder/file.md`).
 */

export const TAGS_TAB_PATH = 'zen://tags'

/** True when `path` is the virtual Tags tab. */
export function isTagsTabPath(path: string | null | undefined): boolean {
  return path === TAGS_TAB_PATH
}
