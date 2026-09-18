import { history, historyField, redoDepth, undoDepth } from '@codemirror/commands'
import type { EditorState, Extension, Text } from '@codemirror/state'
import { latestPathRewriteSeq, pathAfterRewrites, type PathRewrite } from './path-rewrites'

/**
 * Undo history that outlives a tab switch. (#793)
 *
 * A pane has ONE editor, and showing another note swaps that editor's
 * document. Since #247 the swap also empties the undo history, because a
 * history that crosses the swap lets Cmd+Z paste the previous note over the
 * current one. The cost was that leaving a note for a moment threw away every
 * undo step you had on it.
 *
 * So the history is not discarded any more: it is set aside under the note it
 * belongs to, and handed back when that note returns to an editor. #247 stays
 * fixed, because a history only ever goes back onto the note it was taken
 * from, and only while that note still reads exactly as it did then. Undo
 * steps are position-based edits; applied to any other text (the note was
 * changed by another pane, by sync, by an external editor) they would corrupt
 * it, so a mismatch drops them and the note starts a clean history, which is
 * what every switch did before.
 */

interface SetAside {
  /** The note's text when its history was set aside. `Text` is immutable. */
  doc: Text
  /** The value of CodeMirror's history field, immutable as well. */
  history: unknown
}

/** Notes whose undo history is kept at once. Least recently left goes first. */
export const NOTE_UNDO_HISTORY_LIMIT = 50

const setAside = new Map<string, SetAside>()

/** `key` names a note across panes: the vault root and the note's path. */
export function noteUndoHistoryKey(vaultRoot: string | null | undefined, path: string): string {
  return `${vaultRoot ?? ''}\n${path}`
}

/**
 * Set aside the undo history of the note `state` is showing. Call it while the
 * editor still holds that note: before the document is swapped for another
 * note's, and before the editor is destroyed.
 */
export function setAsideNoteUndoHistory(key: string, state: EditorState): void {
  const value = state.field(historyField, false)
  setAside.delete(key)
  if (value === undefined) return
  // Nothing to undo or redo is what a fresh history is, so there is nothing to
  // keep, and an entry left over from an earlier visit is stale by now.
  if (undoDepth(state) === 0 && redoDepth(state) === 0) return
  setAside.set(key, { doc: state.doc, history: value })
  while (setAside.size > NOTE_UNDO_HISTORY_LIMIT) {
    const oldest = setAside.keys().next().value
    if (oldest === undefined) break
    setAside.delete(oldest)
  }
}

/**
 * The history extension for an editor that is about to show `body` as the note
 * named by `key`: the note's own history when one was set aside and the text
 * still matches it, and an empty history otherwise.
 */
export function noteUndoHistoryFor(key: string | null, body: string): Extension {
  const saved = key ? setAside.get(key) : undefined
  if (!saved || saved.doc.length !== body.length || saved.doc.toString() !== body) {
    return history()
  }
  return [history(), historyField.init(() => saved.history)]
}

let followedRewriteSeq = 0

/**
 * Move what was set aside along with its note: a note that is renamed or moved
 * while it is not on screen (or whose folder is) keeps its history under the
 * new path, and a deleted note gives its history up. `log` is the store's
 * `recentPathRewrites`; entries already followed are skipped, so this is cheap
 * to call before every lookup. The text check in `noteUndoHistoryFor` still
 * has the last word, so a rename that also rewrote the note starts clean.
 */
export function followPathRewritesInNoteUndoHistories(log: readonly PathRewrite[]): void {
  const latest = latestPathRewriteSeq(log)
  if (latest <= followedRewriteSeq) return
  for (const [key, entry] of [...setAside]) {
    const split = key.indexOf('\n')
    const root = key.slice(0, split)
    const path = key.slice(split + 1)
    const next = pathAfterRewrites(log, root, path, followedRewriteSeq)
    if (next === path) continue
    setAside.delete(key)
    if (next !== null) setAside.set(noteUndoHistoryKey(root, next), entry)
  }
  followedRewriteSeq = latest
}

/** For tests: forget everything that was set aside. */
export function clearNoteUndoHistories(): void {
  setAside.clear()
  followedRewriteSeq = 0
}
