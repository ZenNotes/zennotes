// Event triggers: the store says "this app just saved / created / moved /
// tagged a note", and an active workflow whose `trigger:` names that event
// runs over that one note a moment later.
//
// Only edits made in this app fire. A change that arrives by sync, or one that
// another device made, does not: two synced desktops both firing on each
// other's writes would run every non-idempotent step once per device and
// bounce an `append` between them forever. Firing where the human edited means
// each edit fires exactly once, on exactly one machine, and the single-executor
// model in `docs/ideas/workflows.md` can arrive later without changing what a
// workflow file means. What a run writes never fires either: the host applies
// it, and nothing about it passes through the store's save path.
//
// A note settles before it fires (`EVENT_SETTLE_MS` after its last event), so
// a burst of autosaves while someone types is one run, made once the typing
// paused, and a note still being typed in when the timer lands waits for its
// next save instead. The events one note collected fire together, in a fixed
// order, and every run goes through the same one-at-a-time funnel as a
// palette run (`lib/workflow-trigger`).

import type { WorkflowEvent } from '@shared/workflows/types'
import { useStore } from '../store'
import { onNoteEvent } from './note-events'
import type { WorkflowIndexEntry } from './workflow-index'

/** How long a note has to be quiet before its events fire. */
export const EVENT_SETTLE_MS = 1500

/** The order the events one note collected fire in: what exists, where it is,
 *  what it says, what it is tagged. */
const EVENT_ORDER: readonly WorkflowEvent[] = ['note-created', 'note-moved', 'note-saved', 'tag-added']

interface Pending {
  events: Set<WorkflowEvent>
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let detach: (() => void) | null = null

/** The active workflows whose trigger names `event`, in index order. */
export function workflowsListeningTo(
  index: readonly WorkflowIndexEntry[],
  event: WorkflowEvent
): WorkflowIndexEntry[] {
  return index.filter(
    (entry) =>
      entry.status === 'active' && entry.trigger.type === 'event' && entry.trigger.event === event
  )
}

/** Start listening. Idempotent: the store calls this on every vault open. */
export function installWorkflowEventTriggers(): void {
  if (detach) return
  detach = onNoteEvent(noteChanged)
}

/** Forget every pending firing and stop listening. For tests. */
export function resetWorkflowEventTriggers(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
  detach?.()
  detach = null
}

/**
 * A note changed in this app. Cheap by design, because it runs on every save:
 * the index says whether anyone is listening at all, and only then does the
 * note get a timer.
 */
export function noteChanged(event: WorkflowEvent, path: string): void {
  const state = useStore.getState()
  if (!state.workflowsEnabled || !state.workflowEventTriggers) return
  if (typeof window.zen?.applyWorkflow !== 'function') return
  if (workflowsListeningTo(state.workflowIndex, event).length === 0) return
  arm(path, [event])
}

function arm(path: string, events: Iterable<WorkflowEvent>): void {
  const existing = pending.get(path)
  if (existing) clearTimeout(existing.timer)
  const merged = new Set(existing?.events ?? [])
  for (const event of events) merged.add(event)
  pending.set(path, {
    events: merged,
    timer: setTimeout(() => void fire(path), EVENT_SETTLE_MS)
  })
}

async function fire(path: string): Promise<void> {
  const entry = pending.get(path)
  if (!entry) return
  pending.delete(path)
  const state = useStore.getState()
  if (!state.workflowsEnabled || !state.workflowEventTriggers) return
  // Being typed in again. Its next save arms it again, with the text that save
  // lands, which is the text a run should see.
  if (state.noteDirty[path]) return
  const { runWorkflowForEvent } = await import('./workflow-trigger')
  const order = EVENT_ORDER.filter((event) => entry.events.has(event))
  for (const [index, event] of order.entries()) {
    for (const workflow of workflowsListeningTo(useStore.getState().workflowIndex, event)) {
      const outcome = await runWorkflowForEvent({ id: workflow.id, event, path })
      // A palette run is at its confirmation: come back once it is done, with
      // this event and the ones after it still to fire.
      if (outcome === 'busy') {
        arm(path, order.slice(index))
        return
      }
      // Typed in again while a run was planning: the next save re-arms it.
      if (outcome === 'unsaved') return
    }
  }
}
