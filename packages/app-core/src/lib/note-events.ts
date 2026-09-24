// The store's one-line announcements that THIS app changed a note, for the
// workflow event triggers to hear (`lib/workflow-events`).
//
// Deliberately without an import of its own: the store calls `emitNoteEvent`
// from its save path, and the workflows code must not ride onto the boot path
// on the back of that. The listening side is installed lazily when a vault
// opens, and until then an event simply has nobody to tell.
//
// Only edits made in this app pass through here, which is the whole point:
// what a workflow run writes is applied by the host and never comes back as
// an event, and a change that arrives by sync never happened in this app.

import type { WorkflowEvent } from '@shared/workflows/types'

type NoteEventListener = (event: WorkflowEvent, path: string) => void

const listeners = new Set<NoteEventListener>()

/** Subscribe; the returned function unsubscribes. */
export function onNoteEvent(listener: NoteEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Tell every listener. Never throws: a listener that fails must not fail the
 * save it was told about, so the failure is logged and the save goes on.
 */
export function emitNoteEvent(event: WorkflowEvent, path: string): void {
  for (const listener of listeners) {
    try {
      listener(event, path)
    } catch (err) {
      console.error('note event listener failed', err)
    }
  }
}
