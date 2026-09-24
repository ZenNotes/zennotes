// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowIndexEntry } from './workflow-index'

// A hand-rolled store: the dispatcher reads four facts from it and nothing
// else, so the suite tests the timing and the routing rather than the app.
const storeState = {
  workflowsEnabled: true,
  workflowEventTriggers: true,
  workflowIndex: [] as WorkflowIndexEntry[],
  noteDirty: {} as Record<string, boolean>
}
vi.mock('../store', () => ({ useStore: { getState: () => storeState } }))

// The run itself is covered in `workflow-trigger-events.test.ts`; here it is a
// spy that answers whatever a case needs.
const runWorkflowForEvent = vi.fn()
vi.mock('./workflow-trigger', () => ({
  runWorkflowForEvent: (...args: unknown[]) => runWorkflowForEvent(...args)
}))

const { emitNoteEvent } = await import('./note-events')
const {
  EVENT_SETTLE_MS,
  installWorkflowEventTriggers,
  resetWorkflowEventTriggers,
  workflowsListeningTo
} = await import('./workflow-events')

function entry(
  id: string,
  trigger: WorkflowIndexEntry['trigger'],
  status: WorkflowIndexEntry['status'] = 'active'
): WorkflowIndexEntry {
  return { id, name: id, description: '', status, trigger, mutates: true }
}

const ON_SAVED = entry('file-topics', { type: 'event', event: 'note-saved' })
const ON_CREATED = entry('stamp-new', { type: 'event', event: 'note-created' })

/** Let the settle timer land and the run promise chain drain. */
async function settle(ms = EVENT_SETTLE_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  storeState.workflowsEnabled = true
  storeState.workflowEventTriggers = true
  storeState.workflowIndex = [ON_SAVED]
  storeState.noteDirty = {}
  runWorkflowForEvent.mockReset()
  runWorkflowForEvent.mockResolvedValue('ran')
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: { applyWorkflow: vi.fn() }
  })
  installWorkflowEventTriggers()
})

afterEach(() => {
  resetWorkflowEventTriggers()
  vi.useRealTimers()
})

describe('workflowsListeningTo', () => {
  it('finds the active workflows whose trigger names the event', () => {
    const index = [
      ON_SAVED,
      ON_CREATED,
      entry('draft-saved', { type: 'event', event: 'note-saved' }, 'draft'),
      entry('by-hand', { type: 'manual' }),
      entry('nightly', { type: 'schedule', cron: '0 2 * * *' })
    ]
    expect(workflowsListeningTo(index, 'note-saved').map((w) => w.id)).toEqual(['file-topics'])
    expect(workflowsListeningTo(index, 'note-created').map((w) => w.id)).toEqual(['stamp-new'])
    expect(workflowsListeningTo(index, 'tag-added')).toEqual([])
  })
})

describe('an event on a note', () => {
  it('runs the listening workflow once the note has settled', async () => {
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    await settle(EVENT_SETTLE_MS - 1)
    expect(runWorkflowForEvent).not.toHaveBeenCalled()
    await settle(1)
    expect(runWorkflowForEvent).toHaveBeenCalledTimes(1)
    expect(runWorkflowForEvent).toHaveBeenCalledWith({
      id: 'file-topics',
      event: 'note-saved',
      path: 'inbox/Dune.md'
    })
  })

  it('folds a burst of autosaves into one run, made after the last one', async () => {
    for (let i = 0; i < 5; i += 1) {
      emitNoteEvent('note-saved', 'inbox/Dune.md')
      await settle(EVENT_SETTLE_MS / 2)
    }
    expect(runWorkflowForEvent).not.toHaveBeenCalled()
    await settle(EVENT_SETTLE_MS / 2)
    expect(runWorkflowForEvent).toHaveBeenCalledTimes(1)
  })

  it('keeps the notes apart: each has its own timer', async () => {
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    await settle(EVENT_SETTLE_MS / 2)
    emitNoteEvent('note-saved', 'inbox/Arrakis.md')
    await settle(EVENT_SETTLE_MS / 2)
    expect(runWorkflowForEvent).toHaveBeenCalledTimes(1)
    expect(runWorkflowForEvent.mock.calls[0][0]).toMatchObject({ path: 'inbox/Dune.md' })
    await settle(EVENT_SETTLE_MS / 2)
    expect(runWorkflowForEvent).toHaveBeenCalledTimes(2)
    expect(runWorkflowForEvent.mock.calls[1][0]).toMatchObject({ path: 'inbox/Arrakis.md' })
  })

  it('fires the events a note collected together, in a fixed order', async () => {
    storeState.workflowIndex = [ON_SAVED, ON_CREATED]
    // Saved first, then created: a note written straight after it was made.
    emitNoteEvent('note-saved', 'inbox/New.md')
    emitNoteEvent('note-created', 'inbox/New.md')
    await settle()
    expect(runWorkflowForEvent.mock.calls.map((call) => call[0].event)).toEqual([
      'note-created',
      'note-saved'
    ])
  })

  it('runs every listener of an event, in index order', async () => {
    storeState.workflowIndex = [
      ON_SAVED,
      entry('second', { type: 'event', event: 'note-saved' })
    ]
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    await settle()
    expect(runWorkflowForEvent.mock.calls.map((call) => call[0].id)).toEqual([
      'file-topics',
      'second'
    ])
  })

  it('does nothing when no active workflow listens for it', async () => {
    storeState.workflowIndex = [ON_CREATED, entry('draft', { type: 'event', event: 'note-saved' }, 'draft')]
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    await settle()
    expect(runWorkflowForEvent).not.toHaveBeenCalled()
  })

  it('stays quiet while the kill switch or the feature is off', async () => {
    storeState.workflowEventTriggers = false
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    await settle()
    storeState.workflowEventTriggers = true
    storeState.workflowsEnabled = false
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    await settle()
    expect(runWorkflowForEvent).not.toHaveBeenCalled()
  })

  it('honours a kill switch flipped while a note was settling', async () => {
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    storeState.workflowEventTriggers = false
    await settle()
    expect(runWorkflowForEvent).not.toHaveBeenCalled()
  })

  it('stays quiet on a host that cannot apply a run', async () => {
    Object.defineProperty(window, 'zen', { configurable: true, value: {} })
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    await settle()
    expect(runWorkflowForEvent).not.toHaveBeenCalled()
  })

  it('waits for the next save of a note that is being typed in again', async () => {
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    storeState.noteDirty = { 'inbox/Dune.md': true }
    await settle()
    expect(runWorkflowForEvent).not.toHaveBeenCalled()
    // The next save lands with a clean note, and that one runs.
    storeState.noteDirty = {}
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    await settle()
    expect(runWorkflowForEvent).toHaveBeenCalledTimes(1)
  })

  it('tries again after a palette run that was at its confirmation', async () => {
    runWorkflowForEvent.mockResolvedValueOnce('busy')
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    await settle()
    expect(runWorkflowForEvent).toHaveBeenCalledTimes(1)
    await settle()
    expect(runWorkflowForEvent).toHaveBeenCalledTimes(2)
    expect(runWorkflowForEvent.mock.calls[1][0]).toMatchObject({ event: 'note-saved' })
  })

  it('carries only the events still to fire across a retry', async () => {
    storeState.workflowIndex = [ON_CREATED, ON_SAVED]
    runWorkflowForEvent.mockResolvedValueOnce('ran').mockResolvedValueOnce('busy')
    emitNoteEvent('note-created', 'inbox/New.md')
    emitNoteEvent('note-saved', 'inbox/New.md')
    await settle()
    expect(runWorkflowForEvent.mock.calls.map((call) => call[0].event)).toEqual([
      'note-created',
      'note-saved'
    ])
    await settle()
    // The created run is not repeated; the saved one is.
    expect(runWorkflowForEvent.mock.calls.map((call) => call[0].event)).toEqual([
      'note-created',
      'note-saved',
      'note-saved'
    ])
  })

  it('stops the chain when a run found the note being typed in again', async () => {
    storeState.workflowIndex = [ON_SAVED, entry('second', { type: 'event', event: 'note-saved' })]
    runWorkflowForEvent.mockResolvedValueOnce('unsaved')
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    await settle()
    expect(runWorkflowForEvent).toHaveBeenCalledTimes(1)
  })

  it('listens once however many times a vault is opened', async () => {
    installWorkflowEventTriggers()
    installWorkflowEventTriggers()
    emitNoteEvent('note-saved', 'inbox/Dune.md')
    await settle()
    expect(runWorkflowForEvent).toHaveBeenCalledTimes(1)
  })
})
