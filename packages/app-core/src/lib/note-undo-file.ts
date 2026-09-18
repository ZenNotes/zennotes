import { history, historyField, redoDepth, undoDepth } from '@codemirror/commands'
import { EditorState, type Extension } from '@codemirror/state'

/**
 * A note's undo history as text, for the hosts that can keep it between
 * launches (the desktop app, behind "Keep undo history after quitting": Vim's
 * `undofile`, #793). `note-undo-history` keeps histories alive while the app
 * runs; this is what is written when a note is left or the app quits, and read
 * back the first time the note is opened again.
 *
 * The same rule decides whether a saved history may be used: only on the text
 * it was taken from. Undo steps are edits at character positions, and a note
 * can change between two launches in ways the app never sees (sync, git,
 * another editor), so the file carries a fingerprint of the text, and a
 * mismatch means the note starts a clean history.
 */

const VERSION = 1
/** Past this the oldest undo steps are dropped until it fits. Matches what the
 *  desktop host accepts, with room to spare for the envelope. */
export const MAX_NOTE_UNDO_FILE_CHARS = 1_500_000

interface SavedHistory {
  v: number
  /** Fingerprint of the note's text when the history was saved. */
  text: string
  savedAt: number
  history: { done: unknown[]; undone: unknown[] }
}

/**
 * Length plus a 53-bit hash (cyrb53). It guards against applying undo steps to
 * other text, not against an adversary, so collision resistance at the level
 * of "two real versions of one note" is all it needs.
 */
export function noteTextFingerprint(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return `${text.length}:${hash.toString(36)}`
}

/** The history of `state` as a string to save, or `null` when there is nothing to undo or redo. */
export function serializeNoteUndoHistory(
  state: EditorState,
  maxChars: number = MAX_NOTE_UNDO_FILE_CHARS
): string | null {
  if (state.field(historyField, false) === undefined) return null
  if (undoDepth(state) === 0 && redoDepth(state) === 0) return null
  const json = state.toJSON({ history: historyField }) as {
    history?: { done?: unknown[]; undone?: unknown[] }
  }
  let done = json.history?.done ?? []
  const undone = json.history?.undone ?? []
  for (;;) {
    const saved: SavedHistory = {
      v: VERSION,
      text: noteTextFingerprint(state.doc.toString()),
      savedAt: Date.now(),
      history: { done, undone }
    }
    const text = JSON.stringify(saved)
    if (text.length <= maxChars) return text
    // The oldest steps are at the front. Dropping them only makes the history
    // shallower; what is left still applies to the text as it is now.
    if (done.length <= 1) return null
    done = done.slice(Math.ceil(done.length / 2))
  }
}

/**
 * The history extension holding what `saved` describes, or `null` when it does
 * not belong to `body` (or is not something this version can read).
 */
export function noteUndoHistoryFromFile(saved: string, body: string): Extension | null {
  try {
    const parsed = JSON.parse(saved) as Partial<SavedHistory> | null
    if (!parsed || parsed.v !== VERSION || typeof parsed.history !== 'object') return null
    if (parsed.text !== noteTextFingerprint(body)) return null
    const rebuilt = EditorState.fromJSON(
      { doc: body, selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 }, history: parsed.history },
      { extensions: history() },
      { history: historyField }
    )
    if (undoDepth(rebuilt) === 0 && redoDepth(rebuilt) === 0) return null
    const value = rebuilt.field(historyField)
    return [history(), historyField.init(() => value)]
  } catch {
    // A file from a newer version, a half-written one, anything else: the note
    // simply starts a clean history.
    return null
  }
}
