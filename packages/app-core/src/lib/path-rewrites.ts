/**
 * A short log of "this path is now that path", so code that keys things by
 * note path can tell a note that was renamed or moved from a different note.
 *
 * The editor is the reader that needs it. It has one CodeMirror view per pane
 * and swaps the document when the pane's path changes, dropping the caret, the
 * scroll position and the undo history on the way, because for a different
 * note all three are meaningless (and the undo history is dangerous, #247). A
 * rename changes the path too, and without this log the editor cannot know the
 * note under the new path is the one it is already showing.
 *
 * The store appends an entry in the same update that rewrites the paths, so a
 * reader that sees the new path always finds the entry that explains it.
 */
export interface PathRewrite {
  /** Grows by one per rewrite, for the whole session. */
  seq: number
  /** Vault the paths belong to. Paths are vault-relative and can repeat. */
  root: string
  /** A note path, or a folder prefix ending in `/`. */
  from: string
  /** Where it went, in the same form; `null` when it was deleted. */
  to: string | null
}

/** A reader only needs the entries since it last looked, which is a render ago. */
export const PATH_REWRITE_LOG_LIMIT = 24

/** Whether `path` is `scope` itself, or sits under it when `scope` is a folder prefix. */
export function pathInScope(scope: string, path: string): boolean {
  return scope === '' || scope.endsWith('/') ? path.startsWith(scope) : path === scope
}

export function appendPathRewrite(
  log: readonly PathRewrite[],
  root: string,
  from: string,
  to: string | null
): PathRewrite[] {
  const seq = latestPathRewriteSeq(log) + 1
  return [...log, { seq, root, from, to }].slice(-PATH_REWRITE_LOG_LIMIT)
}

export function latestPathRewriteSeq(log: readonly PathRewrite[]): number {
  return log.length > 0 ? log[log.length - 1].seq : 0
}

/**
 * Where `path` lives after every rewrite newer than `afterSeq`, applied in
 * order (a note can be renamed twice between two looks). The same path when
 * nothing touched it, and `null` when it was deleted.
 */
export function pathAfterRewrites(
  log: readonly PathRewrite[],
  root: string,
  path: string,
  afterSeq: number
): string | null {
  let current = path
  for (const entry of log) {
    // A whole-vault scope is a lock the store takes, never a rename.
    if (entry.seq <= afterSeq || entry.root !== root || entry.from === '') continue
    if (!pathInScope(entry.from, current)) continue
    if (entry.to === null) return null
    current = entry.to + current.slice(entry.from.length)
  }
  return current
}
