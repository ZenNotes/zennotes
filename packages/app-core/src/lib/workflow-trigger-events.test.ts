// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import type { WorkflowRunRecord } from '../store'

// The same hand-rolled store `workflow-trigger.test.ts` uses, plus the kill
// switch an event run reads.
const storeState = {
  workflowsEnabled: true,
  workflowEventTriggers: true,
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

// A confirmation that can be left hanging, to hold a palette run at its dialog.
let confirmImpl: () => Promise<boolean> = async () => true
vi.mock('./confirm-requests', () => ({ confirmApp: () => confirmImpl() }))

const { runWorkflowForEvent, runWorkflowById, forgetTriggerNotices } = await import(
  './workflow-trigger'
)
const { useToastStore } = await import('./toast')

const FILE_TOPICS = `---
name: File topics
status: active
trigger: on note-saved
---
all | contains type: topic | move Topics
`

const STAMP_ALL = `---
name: Stamp all
status: active
trigger: on note-saved
---
all | add-tag #seen
`

function file(id: string, raw: string) {
  return { id, sourcePath: `.zennotes/workflows/${id}.md`, raw }
}

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

const BODIES: Record<string, string> = {
  'inbox/Dune.md': '# Dune\n\ntype: topic\n',
  'inbox/Arrakis.md': '# Arrakis\n\nplain prose\n',
  'Areas/Plan.md': '# Plan\n\ntype: topic\n'
}

let zen: Record<string, ReturnType<typeof vi.fn>>

function installZen(
  files: ReturnType<typeof file>[],
  overrides: Record<string, unknown> = {}
): void {
  zen = {
    listWorkflows: vi.fn().mockResolvedValue(files),
    applyWorkflow: vi.fn().mockImplementation(async ({ ops }: { ops: { path?: string }[] }) => ({
      runId: 'run-1',
      workflowId: 'file-topics',
      startedAt: 0,
      applied: ops.length,
      paths: [...new Set(ops.flatMap((op) => (op.path ? [op.path] : [])))],
      irreversible: 0
    })),
    undoWorkflowRun: vi.fn().mockResolvedValue({ runId: 'run-1', restored: 1 }),
    readNote: vi.fn().mockImplementation(async (path: string) => ({ body: BODIES[path] ?? '' })),
    ...overrides
  }
  Object.defineProperty(window, 'zen', { configurable: true, value: zen })
}

const toasts = () => useToastStore.getState().toasts

beforeEach(() => {
  storeState.workflowsEnabled = true
  storeState.workflowEventTriggers = true
  storeState.notes = [note('inbox/Dune.md'), note('inbox/Arrakis.md'), note('Areas/Plan.md')]
  storeState.noteDirty = {}
  storeState.workflowRunRecord = null
  confirmImpl = async () => true
  useToastStore.setState({ toasts: [] })
  forgetTriggerNotices()
  installZen([file('file-topics', FILE_TOPICS)])
})

describe('runWorkflowForEvent', () => {
  it('runs the pipeline over the note that fired and leaves a receipt with Undo', async () => {
    const outcome = await runWorkflowForEvent({
      id: 'file-topics',
      event: 'note-saved',
      path: 'inbox/Dune.md'
    })
    expect(outcome).toBe('ran')
    expect(zen.applyWorkflow).toHaveBeenCalledWith({
      workflowId: 'file-topics',
      ops: [{ kind: 'move', path: 'inbox/Dune.md', to: 'Topics' }]
    })
    const receipt = toasts().at(-1)
    expect(receipt?.message).toBe('File topics: Applied 1 change across 1 note.')
    expect(receipt?.action?.label).toBe('Undo 1 note')
    expect(storeState.workflowRunRecord?.receipt.runId).toBe('run-1')
    expect(storeState.refreshNotes).toHaveBeenCalled()
    // The store was told where the note is going before the run, so an editor
    // open on it can follow.
    expect(storeState.promised).toEqual([{ from: 'inbox/Dune.md', to: 'Topics/Dune.md' }])
    // And the record remembers them, so the Undo on the toast can carry the
    // editor back the same way.
    expect(storeState.workflowRunRecord?.moves).toEqual([{ from: 'inbox/Dune.md', to: 'Topics/Dune.md' }])
  })

  it('undoing from the toast carries the editor back with the note', async () => {
    await runWorkflowForEvent({ id: 'file-topics', event: 'note-saved', path: 'inbox/Dune.md' })
    storeState.followWorkflowMoves.mockClear()
    // The toast's action fires and forgets, as a click handler does.
    toasts().at(-1)?.action?.onClick()
    await vi.waitFor(() =>
      expect(storeState.workflowRunRecord?.undone).toEqual({ runId: 'run-1', restored: 1 })
    )
    expect(zen.undoWorkflowRun).toHaveBeenCalledWith('run-1')
    expect(storeState.followWorkflowMoves).toHaveBeenCalledWith(
      [{ from: 'Topics/Dune.md', to: 'inbox/Dune.md' }],
      { reverting: true }
    )
  })

  it('finds nothing to do when the note does not match, and says nothing', async () => {
    const outcome = await runWorkflowForEvent({
      id: 'file-topics',
      event: 'note-saved',
      path: 'inbox/Arrakis.md'
    })
    expect(outcome).toBe('nothing')
    expect(zen.applyWorkflow).not.toHaveBeenCalled()
    expect(toasts()).toEqual([])
  })

  it('scopes `all` to the note that fired, never the rest of the vault', async () => {
    installZen([file('stamp-all', STAMP_ALL)])
    await runWorkflowForEvent({ id: 'stamp-all', event: 'note-saved', path: 'inbox/Arrakis.md' })
    expect(zen.applyWorkflow).toHaveBeenCalledWith({
      workflowId: 'stamp-all',
      ops: [{ kind: 'add-tag', path: 'inbox/Arrakis.md', tag: 'seen' }]
    })
  })

  it('says nothing about a run that wrote no file', async () => {
    installZen([file('stamp-all', STAMP_ALL)], {
      applyWorkflow: vi.fn().mockResolvedValue({
        runId: 'run-2',
        workflowId: 'stamp-all',
        startedAt: 0,
        applied: 1,
        paths: [],
        irreversible: 0
      })
    })
    const outcome = await runWorkflowForEvent({
      id: 'stamp-all',
      event: 'note-saved',
      path: 'inbox/Dune.md'
    })
    expect(outcome).toBe('ran')
    expect(toasts()).toEqual([])
  })

  it('reports a run the host rolled back, naming the workflow', async () => {
    installZen([file('file-topics', FILE_TOPICS)], {
      applyWorkflow: vi.fn().mockResolvedValue({
        runId: 'run-3',
        workflowId: 'file-topics',
        startedAt: 0,
        applied: 0,
        paths: [],
        irreversible: 0,
        rolledBack: { reason: 'Cannot move inbox/Dune.md: the note is missing' }
      })
    })
    const outcome = await runWorkflowForEvent({
      id: 'file-topics',
      event: 'note-saved',
      path: 'inbox/Dune.md'
    })
    expect(outcome).toBe('skipped')
    expect(toasts().at(-1)).toMatchObject({
      type: 'error',
      message: '"File topics": Cannot move inbox/Dune.md: the note is missing'
    })
  })

  describe('the trigger condition', () => {
    const GATED = `---
name: Inbox topics
status: active
trigger: on note-saved where folder = inbox
---
all | contains type: topic | move Topics
`

    it('lets the run through when the note matches', async () => {
      installZen([file('inbox-topics', GATED)])
      const outcome = await runWorkflowForEvent({
        id: 'inbox-topics',
        event: 'note-saved',
        path: 'inbox/Dune.md'
      })
      expect(outcome).toBe('ran')
      expect(zen.applyWorkflow).toHaveBeenCalledTimes(1)
    })

    it('holds the run when the note does not match', async () => {
      installZen([file('inbox-topics', GATED)])
      const outcome = await runWorkflowForEvent({
        id: 'inbox-topics',
        event: 'note-saved',
        path: 'Areas/Plan.md'
      })
      expect(outcome).toBe('nothing')
      expect(zen.applyWorkflow).not.toHaveBeenCalled()
    })

    it('reads frontmatter from the body, like a where step does', async () => {
      installZen([
        file(
          'rated',
          '---\nname: Rated\ntrigger: on note-saved where rating >= 4\n---\nall | add-tag #good\n'
        )
      ])
      BODIES['inbox/Rated.md'] = '---\nrating: 5\n---\n# Rated\n'
      storeState.notes = [...storeState.notes, note('inbox/Rated.md')]
      const outcome = await runWorkflowForEvent({
        id: 'rated',
        event: 'note-saved',
        path: 'inbox/Rated.md'
      })
      expect(outcome).toBe('ran')
      delete BODIES['inbox/Rated.md']
    })

    it('refuses a condition the engine cannot read, once', async () => {
      installZen([
        file('broken', '---\nname: Broken\ntrigger: on note-saved where rating\n---\nall | add-tag #x\n')
      ])
      const first = await runWorkflowForEvent({ id: 'broken', event: 'note-saved', path: 'inbox/Dune.md' })
      const second = await runWorkflowForEvent({ id: 'broken', event: 'note-saved', path: 'inbox/Dune.md' })
      expect([first, second]).toEqual(['skipped', 'skipped'])
      expect(zen.applyWorkflow).not.toHaveBeenCalled()
      expect(toasts()).toHaveLength(1)
      expect(toasts()[0]).toMatchObject({ type: 'error' })
      expect(toasts()[0].message).toContain('"Broken" has a trigger condition the engine cannot read')
    })
  })

  describe('unsaved edits', () => {
    it('waits for the next save when the note that fired is dirty again', async () => {
      storeState.noteDirty = { 'inbox/Dune.md': true }
      const outcome = await runWorkflowForEvent({
        id: 'file-topics',
        event: 'note-saved',
        path: 'inbox/Dune.md'
      })
      expect(outcome).toBe('unsaved')
      expect(zen.applyWorkflow).not.toHaveBeenCalled()
      expect(toasts()).toEqual([])
    })

    it('leaves another dirty note alone, says so, and runs the rest', async () => {
      installZen([
        file(
          'log',
          '---\nname: Log\ntrigger: on note-saved\n---\nhit = all | contains type: topic\nhit | add-tag #topic\nhit | render list | write "inbox/Log.md"\n'
        )
      ])
      storeState.notes = [...storeState.notes, note('inbox/Log.md')]
      storeState.noteDirty = { 'inbox/Log.md': true }
      const outcome = await runWorkflowForEvent({ id: 'log', event: 'note-saved', path: 'inbox/Dune.md' })
      expect(outcome).toBe('ran')
      const ops = zen.applyWorkflow.mock.calls[0][0].ops as { kind: string; path?: string }[]
      expect(ops.map((op) => op.kind)).toEqual(['add-tag'])
      expect(toasts().map((t) => t.message)).toEqual([
        '"Log" left inbox/Log.md alone: unsaved edits there.',
        'Log: Applied 1 change across 1 note.'
      ])
    })
  })

  describe('what does not run', () => {
    it('a workflow whose file no longer names this event', async () => {
      const outcome = await runWorkflowForEvent({
        id: 'file-topics',
        event: 'note-created',
        path: 'inbox/Dune.md'
      })
      expect(outcome).toBe('skipped')
      expect(zen.applyWorkflow).not.toHaveBeenCalled()
    })

    it('a draft', async () => {
      installZen([file('file-topics', FILE_TOPICS.replace('status: active', 'status: draft'))])
      expect(
        await runWorkflowForEvent({ id: 'file-topics', event: 'note-saved', path: 'inbox/Dune.md' })
      ).toBe('skipped')
      expect(zen.applyWorkflow).not.toHaveBeenCalled()
    })

    it('anything while the kill switch is off', async () => {
      storeState.workflowEventTriggers = false
      expect(
        await runWorkflowForEvent({ id: 'file-topics', event: 'note-saved', path: 'inbox/Dune.md' })
      ).toBe('skipped')
      expect(zen.listWorkflows).not.toHaveBeenCalled()
    })

    it('a note the store no longer lists', async () => {
      expect(
        await runWorkflowForEvent({ id: 'file-topics', event: 'note-saved', path: 'inbox/Gone.md' })
      ).toBe('skipped')
      expect(zen.applyWorkflow).not.toHaveBeenCalled()
    })

    it('on a host with no run support', async () => {
      installZen([file('file-topics', FILE_TOPICS)], { applyWorkflow: undefined })
      expect(
        await runWorkflowForEvent({ id: 'file-topics', event: 'note-saved', path: 'inbox/Dune.md' })
      ).toBe('skipped')
    })
  })

  it('answers busy while a palette run is at its confirmation', async () => {
    installZen([file('file-topics', FILE_TOPICS.replace('trigger: on note-saved', 'trigger: manual'))])
    let release: (ok: boolean) => void = () => {}
    confirmImpl = () => new Promise<boolean>((resolve) => (release = resolve))
    const manual = runWorkflowById('file-topics')
    await vi.waitFor(() => expect(zen.readNote).toHaveBeenCalled())
    const outcome = await runWorkflowForEvent({
      id: 'file-topics',
      event: 'note-saved',
      path: 'inbox/Dune.md'
    })
    expect(outcome).toBe('busy')
    release(false)
    await manual
    expect(zen.applyWorkflow).not.toHaveBeenCalled()
  })
})
