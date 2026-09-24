// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import type { WorkflowRunRecord } from '../store'

// A hand-rolled store, so this suite tests the trigger rather than the app: the
// only store facts a palette run reads are the notes it plans over, the dirty
// map it checks for collisions, and the run record every surface shares.
const storeState = {
  workflowsEnabled: true,
  notes: [] as NoteMeta[],
  noteDirty: {} as Record<string, boolean>,
  selectedPath: null as string | null,
  customTemplates: [],
  vaultSettings: { systemFolderPaths: {} },
  workflowRunRecord: null as WorkflowRunRecord | null,
  setWorkflowRunRecord: (
    next:
      | WorkflowRunRecord
      | null
      | ((prev: WorkflowRunRecord | null) => WorkflowRunRecord | null)
  ) => {
    storeState.workflowRunRecord =
      typeof next === 'function' ? next(storeState.workflowRunRecord) : next
  },
  persistNote: vi.fn().mockResolvedValue(undefined),
  refreshNotes: vi.fn().mockResolvedValue(undefined),
  // The editor-follows-its-note half lives in the real store; here it is a
  // no-op that records what the run promised to move.
  followWorkflowMoves: vi.fn((moves: readonly { from: string; to: string }[]) => {
    storeState.promised = [...moves]
    return async () => {}
  }),
  promised: [] as { from: string; to: string }[]
}

vi.mock('../store', () => ({ useStore: { getState: () => storeState } }))

// Every confirmation in the run ladder says yes; the ladder itself is covered
// by `workflow-run.test.ts`, and what is under test here is what happens after.
const confirmApp = vi.fn().mockResolvedValue(true)
vi.mock('./confirm-requests', () => ({ confirmApp: (...args: unknown[]) => confirmApp(...args) }))

const { runWorkflowById, announceInterruptedWorkflowRun } = await import('./workflow-trigger')
const { useToastStore } = await import('./toast')

const STAR_BOOKS = `---
name: Star books
description: Star every book note
status: active
trigger: manual
---
books = tag #book
books | add-tag #starred
`

function note(path: string, tags: string[] = []): NoteMeta {
  return {
    path,
    title: path.split('/').pop()?.replace(/\.md$/i, '') ?? path,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 1,
    updatedAt: 2,
    size: 0,
    tags,
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: ''
  }
}

function receipt(runId: string) {
  return {
    runId,
    workflowId: 'star-books',
    startedAt: 0,
    applied: 1,
    paths: ['inbox/Dune.md'],
    irreversible: 0
  }
}

function installZen(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      listWorkflows: vi
        .fn()
        .mockResolvedValue([
          { id: 'star-books', sourcePath: '.zennotes/workflows/star-books.md', raw: STAR_BOOKS }
        ]),
      applyWorkflow: vi.fn().mockResolvedValue(receipt('run-1')),
      undoWorkflowRun: vi.fn().mockResolvedValue({ runId: 'run-1', restored: 1 }),
      readNote: vi.fn().mockResolvedValue({ body: '' }),
      ...overrides
    }
  })
}

/** The toast a run left behind, which is where its Undo lives. */
function lastToast() {
  return useToastStore.getState().toasts.at(-1)
}

beforeEach(() => {
  storeState.workflowsEnabled = true
  storeState.notes = [note('inbox/Dune.md', ['book'])]
  storeState.noteDirty = {}
  storeState.workflowRunRecord = null
  confirmApp.mockClear()
  useToastStore.setState({ toasts: [] })
  installZen()
})

describe('running a workflow from the palette', () => {
  it('writes the same run record the view reads, so one workflow has one receipt', async () => {
    await runWorkflowById('star-books')

    expect(storeState.workflowRunRecord).toEqual({
      workflowId: 'star-books',
      receipt: receipt('run-1'),
      undone: null,
      undoError: null,
      // Nothing moved, so there is nothing for an undo to carry an editor back along.
      moves: []
    })
  })

  it('replaces an older run of the same workflow rather than leaving two', async () => {
    await runWorkflowById('star-books')
    installZen({ applyWorkflow: vi.fn().mockResolvedValue(receipt('run-2')) })
    await runWorkflowById('star-books')

    expect(storeState.workflowRunRecord?.receipt.runId).toBe('run-2')
  })
})

describe('the Undo an older receipt still carries', () => {
  it('refuses to fire once a newer run of the same workflow superseded it', async () => {
    await runWorkflowById('star-books')
    const stale = lastToast()
    expect(stale?.action).toBeDefined()

    // The second run lands while the first toast is still on screen: twelve
    // seconds is plenty of time for it.
    const undoWorkflowRun = vi.fn().mockResolvedValue({ runId: 'run-1', restored: 1 })
    installZen({ applyWorkflow: vi.fn().mockResolvedValue(receipt('run-2')), undoWorkflowRun })
    await runWorkflowById('star-books')

    stale?.action?.onClick()
    await Promise.resolve()
    await Promise.resolve()

    expect(undoWorkflowRun).not.toHaveBeenCalled()
    expect(lastToast()?.message).toContain('newer run of this workflow')
  })

  it('undoes the current run and marks the shared record undone', async () => {
    await runWorkflowById('star-books')
    lastToast()?.action?.onClick()
    await vi.waitFor(() => expect(storeState.workflowRunRecord?.undone).not.toBeNull())

    expect(storeState.workflowRunRecord?.undone).toEqual({ runId: 'run-1', restored: 1 })
  })

  it('names the files an undo overwrote when the applier reports them', async () => {
    installZen({
      undoWorkflowRun: vi
        .fn()
        .mockResolvedValue({ runId: 'run-1', restored: 2, driftedPaths: ['inbox/Dune.md'] })
    })
    await runWorkflowById('star-books')
    lastToast()?.action?.onClick()

    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message.includes('overwritten'))).toBe(
        true
      )
    )
  })
})

describe('announceInterruptedWorkflowRun', () => {
  it('offers an undo for a recent run the app died in the middle of', async () => {
    installZen({
      listWorkflowRuns: vi.fn().mockResolvedValue([
        {
          runId: 'run-1',
          workflowId: 'star-books',
          startedAt: Date.now() - 60_000,
          applied: 1,
          paths: ['inbox/Dune.md'],
          undoable: true,
          interrupted: true
        }
      ])
    })

    await announceInterruptedWorkflowRun()

    const toast = lastToast()
    expect(toast?.message).toContain('was interrupted before it finished')
    expect(toast?.action?.label).toBe('Undo 1 note')
  })

  it('says nothing on a bridge with no run history at all', async () => {
    installZen()
    await announceInterruptedWorkflowRun()
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('says nothing while the feature is switched off', async () => {
    storeState.workflowsEnabled = false
    installZen({ listWorkflowRuns: vi.fn().mockResolvedValue([]) })
    await announceInterruptedWorkflowRun()
    expect(useToastStore.getState().toasts).toEqual([])
  })
})
