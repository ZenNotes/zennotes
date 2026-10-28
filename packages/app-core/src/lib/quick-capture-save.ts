/**
 * Pure save logic for the quick-capture window.
 *
 * The quick-capture surface is single-field: you type in the editor and
 * the first non-empty line is the note's title (and filename). This
 * module owns the two decisions that were previously tangled inside a
 * React callback and caused the "rename creates a new file" bug:
 *
 *   1. What title does this body imply? (`deriveTitleFromBody`)
 *   2. Given the current mode + body, what vault operation should a save
 *      perform? (`planQuickCaptureSave`)
 *
 * Keeping these pure (no I/O, no React) makes the rules explicit and
 * unit-testable; the component just executes the returned plan.
 */

import { deriveTitleFromBody, timestampTitle } from '@shared/quick-note-title'

export { deriveTitleFromBody, timestampTitle }

/** Minimal shape of a loaded note — structurally satisfied by NoteMeta. */
export interface QuickCaptureNote {
  path: string
  title: string
  folder: string
}

export type QuickCaptureMode =
  | { kind: 'new' }
  | { kind: 'existing'; note: QuickCaptureNote }

/**
 * What a save should do at the vault level:
 *  - `noop`   — nothing to save (empty buffer).
 *  - `create` — brand-new note; create then write. The caller must adopt
 *               the result into `existing` mode so the NEXT save updates
 *               in place instead of creating a second file.
 *  - `write`  — overwrite an existing note in place; no rename.
 *  - `rename` — the title changed; rename the file in place, then write.
 *               Body is preserved if the rename fails (title clash).
 */
export type QuickCaptureSavePlan =
  | { op: 'noop' }
  | { op: 'create'; title: string; body: string }
  | { op: 'write'; path: string; body: string }
  | { op: 'rename'; path: string; title: string; body: string }

/**
 * Decide the vault operation for a save. Pure.
 *
 * Rename-in-place is applied only to notes in the `quick` folder: those
 * are the capture surface's own, and follow the first-line = title
 * convention. Notes opened from other folders via the picker keep their
 * filename (we only edit their text), so an arbitrary first line can
 * never silently rename a structured note.
 */
export function planQuickCaptureSave(
  mode: QuickCaptureMode,
  rawBody: string,
  now = new Date()
): QuickCaptureSavePlan {
  const body = rawBody.replace(/\s+$/u, '')
  if (!body) return { op: 'noop' }
  const out = `${body}\n`
  const title = deriveTitleFromBody(body) || timestampTitle(now)

  if (mode.kind === 'new') {
    return { op: 'create', title, body: out }
  }

  const note = mode.note
  if (note.folder === 'quick' && title !== note.title) {
    return { op: 'rename', path: note.path, title, body: out }
  }
  return { op: 'write', path: note.path, body: out }
}
