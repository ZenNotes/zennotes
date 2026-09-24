import { describe, expect, it } from 'vitest'
import type { NoteTemplate } from '@bridge-contract/templates'
import type {
  WorkflowRunSummary,
  WorkflowRunReceipt,
  WorkflowUndoResult
} from '@bridge-contract/workflows'
import type { Workflow, WorkflowOp } from '@shared/workflows/types'
import type { WorkflowRunRecord } from '../store'
import {
  canUndoReceipt,
  collectRunSideEffects,
  driftedPathsNote,
  driftedPathsOf,
  findTemplateByRef,
  formatPathList,
  interruptedRunHeadline,
  interruptedRunToOffer,
  irreversibleNote,
  opsExcludingPaths,
  planWritePaths,
  receiptHeadline,
  resolveTemplateOps,
  runConfirmDescription,
  runConfirmLabel,
  undoCollisionDescription,
  undoLabel,
  undoOfferFor,
  undoneHeadline,
  unknownTemplateDiagnostics,
  unsavedCollisionDescription,
  unsavedCollisions,
  promisedMoves
} from './workflow-run'

const OPS: WorkflowOp[] = [
  { kind: 'add-tag', path: 'inbox/A.md', tag: 'starred' },
  { kind: 'add-tag', path: 'inbox/B.md', tag: 'starred' },
  { kind: 'set-frontmatter', path: 'inbox/A.md', field: 'status', value: 'done' },
  { kind: 'notify', message: 'Two notes starred' }
]

function receipt(over: Partial<WorkflowRunReceipt> = {}): WorkflowRunReceipt {
  return {
    runId: 'run-1',
    workflowId: 'reading-log',
    startedAt: 0,
    applied: 3,
    paths: ['inbox/A.md', 'inbox/B.md'],
    irreversible: 0,
    ...over
  }
}

describe('planWritePaths', () => {
  it('lists each written path once, in the order the ops touch them', () => {
    expect(planWritePaths(OPS)).toEqual(['inbox/A.md', 'inbox/B.md'])
  })

  it('leaves out ops that write no file at all', () => {
    expect(planWritePaths([{ kind: 'clipboard', text: 'x' }])).toEqual([])
  })

  it('names the source of a move, never a guessed destination', () => {
    // `to` is a FOLDER here, so the destination path is the applier's to
    // compute; a confirmation must not invent one.
    const ops: WorkflowOp[] = [{ kind: 'move', path: 'inbox/A.md', to: 'archive/2026' }]
    expect(planWritePaths(ops)).toEqual(['inbox/A.md'])
  })
})

describe('unsavedCollisions', () => {
  it('finds the paths the run writes that are open with unsaved edits', () => {
    const dirty = { 'inbox/B.md': true, 'inbox/Z.md': true, 'inbox/A.md': false }
    expect(unsavedCollisions(planWritePaths(OPS), dirty)).toEqual(['inbox/B.md'])
  })

  it('is empty when nothing open is dirty', () => {
    expect(unsavedCollisions(['inbox/A.md'], {})).toEqual([])
  })
})

describe('opsExcludingPaths', () => {
  it('drops every op touching a skipped note', () => {
    const kept = opsExcludingPaths(OPS, ['inbox/A.md'])
    expect(kept.map((op) => ('path' in op ? op.path : op.kind))).toEqual(['inbox/B.md', 'notify'])
  })

  it('keeps pathless ops: skipping a note is not a reason to swallow a notify', () => {
    const kept = opsExcludingPaths(OPS, ['inbox/A.md', 'inbox/B.md'])
    expect(kept).toEqual([{ kind: 'notify', message: 'Two notes starred' }])
  })
})

describe('formatPathList', () => {
  it('reads as a sentence for a short list', () => {
    expect(formatPathList(['a.md'])).toBe('a.md')
    expect(formatPathList(['a.md', 'b.md'])).toBe('a.md and b.md')
    expect(formatPathList(['a.md', 'b.md', 'c.md'])).toBe('a.md, b.md and c.md')
  })

  it('caps a long list rather than filling the dialog', () => {
    expect(formatPathList(['a', 'b', 'c'], 2)).toBe('a, b and 1 more')
  })
})

describe('runConfirmDescription', () => {
  const lines = [
    { label: 'add-tag #starred', count: 2, irreversible: false },
    { label: 'notify Two notes starred', count: 1, irreversible: true }
  ]

  it('leads with the size of the change and lists it as the dry run grouped it', () => {
    const text = runConfirmDescription({
      workflowName: 'Reading log',
      lines,
      fileCount: 2,
      irreversibleCount: 1,
      errorCount: 0,
      unsaved: null
    })
    expect(text).toContain('3 changes across 2 notes.')
    expect(text).toContain('add-tag #starred ×2')
    expect(text).toContain('1 step cannot be undone.')
    expect(text).toContain('Undo restores every file this run writes, byte for byte.')
  })

  it('does not promise undo when the run writes no file', () => {
    const text = runConfirmDescription({
      workflowName: 'Ping',
      lines: [{ label: 'notify done', count: 1, irreversible: true }],
      fileCount: 0,
      irreversibleCount: 1,
      errorCount: 0,
      unsaved: null
    })
    expect(text).toContain('1 change, none of which writes a file.')
    expect(text).not.toContain('byte for byte')
  })

  it('names the notes it will save first', () => {
    const text = runConfirmDescription({
      workflowName: 'Reading log',
      lines,
      fileCount: 2,
      irreversibleCount: 0,
      errorCount: 0,
      unsaved: { paths: ['inbox/B.md'], resolution: 'save' }
    })
    expect(text).toContain('1 note has unsaved edits and will be saved first: inbox/B.md.')
  })

  it('names the notes it will skip', () => {
    const text = runConfirmDescription({
      workflowName: 'Reading log',
      lines,
      fileCount: 2,
      irreversibleCount: 0,
      errorCount: 2,
      unsaved: { paths: ['inbox/B.md', 'inbox/C.md'], resolution: 'skip' }
    })
    expect(text).toContain('2 notes with unsaved edits will be skipped: inbox/B.md and inbox/C.md.')
    expect(text).toContain('This workflow still reports 2 errors.')
  })

  it('counts the tail of a very wide plan instead of listing it', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      label: `rename to Note ${i}`,
      count: 1,
      irreversible: false
    }))
    const text = runConfirmDescription({
      workflowName: 'Rename',
      lines: many,
      fileCount: 12,
      irreversibleCount: 0,
      errorCount: 0,
      unsaved: null
    })
    expect(text).toContain('and 4 other kinds of change')
    expect(text).not.toContain('rename to Note 9')
  })
})

describe('runConfirmLabel', () => {
  it('says what pressing it does', () => {
    expect(runConfirmLabel([{ label: 'add-tag #x', count: 1, irreversible: false }])).toBe(
      'Apply 1 change'
    )
    expect(runConfirmLabel([{ label: 'add-tag #x', count: 4, irreversible: false }])).toBe(
      'Apply 4 changes'
    )
  })
})

describe('unsavedCollisionDescription', () => {
  it('names every colliding note', () => {
    const text = unsavedCollisionDescription(['inbox/A.md', 'inbox/B.md'])
    expect(text).toContain('inbox/A.md')
    expect(text).toContain('inbox/B.md')
    expect(text).toContain('2 notes')
  })
})

describe('undoCollisionDescription', () => {
  it('warns that the editor would write the run back, not that edits are lost', () => {
    const text = undoCollisionDescription(['inbox/A.md'])
    expect(text).toContain('inbox/A.md')
    expect(text).toContain('the next save would write them straight back')
  })
})

describe('receiptHeadline', () => {
  it('reads as the record of what changed', () => {
    expect(receiptHeadline(receipt())).toBe('Applied 3 changes across 2 notes.')
  })

  it('never presents a rolled-back run as a success', () => {
    const failed = receipt({ rolledBack: { reason: 'disk full' } })
    expect(receiptHeadline(failed)).toBe('Run failed. Every change was rolled back.')
    expect(receiptHeadline(failed)).not.toContain('Applied')
  })

  it('says so when the run wrote no file', () => {
    expect(receiptHeadline(receipt({ applied: 1, paths: [], irreversible: 1 }))).toBe(
      'Applied 1 change. No files were written.'
    )
  })
})

describe('canUndoReceipt', () => {
  it('offers undo for a run that wrote files', () => {
    expect(canUndoReceipt(receipt())).toBe(true)
  })

  it('does not offer to undo a run that already rolled itself back', () => {
    expect(canUndoReceipt(receipt({ rolledBack: { reason: 'boom' } }))).toBe(false)
  })

  it('does not offer to undo a notification', () => {
    expect(canUndoReceipt(receipt({ applied: 1, paths: [], irreversible: 1 }))).toBe(false)
  })
})

describe('irreversibleNote', () => {
  it('is silent when everything can be rolled back', () => {
    expect(irreversibleNote(receipt())).toBeNull()
  })

  it('declares what the undo will not take back', () => {
    expect(irreversibleNote(receipt({ irreversible: 2 }))).toContain('2 steps cannot be undone')
  })
})

describe('undo wording', () => {
  it('sizes the offer', () => {
    expect(undoLabel(receipt())).toBe('Undo 2 notes')
  })

  it('reports what came back', () => {
    expect(undoneHeadline({ runId: 'run-1', restored: 1 })).toBe(
      'Undone. 1 file restored to how it was.'
    )
    expect(undoneHeadline({ runId: 'run-1', restored: 3 })).toBe(
      'Undone. 3 files restored to how they were.'
    )
  })
})

describe('collectRunSideEffects', () => {
  it('keeps every notification in plan order and the last clipboard write', () => {
    const effects = collectRunSideEffects([
      { kind: 'notify', message: 'first' },
      { kind: 'clipboard', text: 'old' },
      { kind: 'add-tag', path: 'inbox/A.md', tag: 'x' },
      { kind: 'notify', message: 'second' },
      { kind: 'clipboard', text: 'new' }
    ])
    expect(effects.notifications).toEqual(['first', 'second'])
    expect(effects.clipboard).toBe('new')
  })

  it('reports nothing for a run of file ops', () => {
    expect(collectRunSideEffects(OPS.slice(0, 3))).toEqual({
      notifications: [],
      clipboard: null
    })
  })
})

/* -------------------------------------------------------------------------- */
/*  Templates                                                                 */
/* -------------------------------------------------------------------------- */

function template(over: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id: 'custom:book-review',
    name: 'Book Review',
    description: '',
    category: 'Custom',
    body: 'Rating: {{cursor}}\n\nThoughts on {{title}}.',
    builtin: false,
    ...over
  }
}

const TEMPLATES: NoteTemplate[] = [
  template(),
  template({ id: 'builtin.adr', name: 'ADR', body: '# {{title}}\n\nStatus: proposed', builtin: true })
]

describe('findTemplateByRef', () => {
  it('matches by id, by name ignoring case, and by slug', () => {
    expect(findTemplateByRef(TEMPLATES, 'custom:book-review')?.name).toBe('Book Review')
    expect(findTemplateByRef(TEMPLATES, 'book review')?.name).toBe('Book Review')
    expect(findTemplateByRef(TEMPLATES, 'book-review')?.name).toBe('Book Review')
    expect(findTemplateByRef(TEMPLATES, 'ADR')?.id).toBe('builtin.adr')
  })

  it('answers null for the unknown and the blank', () => {
    expect(findTemplateByRef(TEMPLATES, 'meeting-notes')).toBeNull()
    expect(findTemplateByRef(TEMPLATES, '  ')).toBeNull()
  })
})

describe('unknownTemplateDiagnostics', () => {
  const flow = (steps: Workflow['statements'][number]['steps']): Workflow => ({
    id: 'wf',
    name: 'Wf',
    description: '',
    trigger: { type: 'manual' },
    status: 'active',
    statements: [{ name: null, input: null, steps, line: 1 }],
    meta: {}
  })

  it('marks the step naming a template the vault does not have', () => {
    const workflow = flow([
      { kind: 'tag', args: { tag: 'book' }, line: 1 },
      { kind: 'apply-template', args: { template: 'meeting-notes' }, line: 1 }
    ])
    expect(unknownTemplateDiagnostics(workflow, TEMPLATES)).toEqual([
      {
        severity: 'error',
        message: '`apply-template` refers to `meeting-notes`, which is not a template in this vault',
        line: 1
      }
    ])
  })

  it('stays quiet for a resolvable name and leaves a missing arg to the parser', () => {
    const fine = flow([{ kind: 'apply-template', args: { template: 'book-review' }, line: 1 }])
    expect(unknownTemplateDiagnostics(fine, TEMPLATES)).toEqual([])
    const unbound = flow([{ kind: 'apply-template', args: {}, line: 1 }])
    expect(unknownTemplateDiagnostics(unbound, TEMPLATES)).toEqual([])
  })
})

describe('resolveTemplateOps', () => {
  const NOW = new Date(Date.UTC(2026, 6, 28, 12, 0, 0))
  const titles: Record<string, string> = { 'inbox/Dune.md': 'Dune' }
  const titleFor = (path: string): string => titles[path] ?? 'Untitled'

  it('replaces the name with the body rendered against each note', () => {
    const { ops, missing } = resolveTemplateOps(
      [
        { kind: 'apply-template', path: 'inbox/Dune.md', template: 'book-review' },
        { kind: 'add-tag', path: 'inbox/Dune.md', tag: 'reviewed' }
      ],
      TEMPLATES,
      titleFor,
      NOW
    )
    expect(missing).toEqual([])
    // `{{title}}` expanded, `{{cursor}}` removed: the body is what the palette
    // would have inserted, not the raw template text.
    expect(ops[0]).toEqual({
      kind: 'apply-template',
      path: 'inbox/Dune.md',
      template: 'Rating: \n\nThoughts on Dune.'
    })
    expect(ops[1]).toEqual({ kind: 'add-tag', path: 'inbox/Dune.md', tag: 'reviewed' })
  })

  it('collects each unresolvable name once and blocks nothing else', () => {
    const { ops, missing } = resolveTemplateOps(
      [
        { kind: 'apply-template', path: 'inbox/A.md', template: 'ghost' },
        { kind: 'apply-template', path: 'inbox/B.md', template: 'ghost' },
        { kind: 'apply-template', path: 'inbox/C.md', template: 'book-review' }
      ],
      TEMPLATES,
      titleFor,
      NOW
    )
    expect(missing).toEqual(['ghost'])
    expect(ops[2]).toMatchObject({ template: 'Rating: \n\nThoughts on Untitled.' })
  })
})

function record(over: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return { workflowId: 'reading-log', receipt: receipt(), undone: null, undoError: null, ...over }
}

function runSummary(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    runId: 'run-1',
    workflowId: 'reading-log',
    startedAt: 1_000,
    applied: 3,
    paths: ['inbox/A.md', 'inbox/B.md'],
    undoable: true,
    ...over
  }
}

describe('undoOfferFor', () => {
  it('lets the current record undo itself', () => {
    expect(undoOfferFor(record(), receipt())).toBe('ok')
  })

  it('refuses a second undo of a run already undone', () => {
    expect(undoOfferFor(record({ undone: { runId: 'run-1', restored: 2 } }), receipt())).toBe(
      'already-undone'
    )
  })

  it('refuses an older receipt once a newer run of the same workflow replaced it', () => {
    const newer = record({ receipt: receipt({ runId: 'run-2' }) })
    expect(undoOfferFor(newer, receipt({ runId: 'run-1' }))).toBe('superseded')
  })

  it('says nothing about a run when the record belongs to another workflow', () => {
    const other = record({ workflowId: 'archive-old', receipt: receipt({ runId: 'run-9' }) })
    expect(undoOfferFor(other, receipt())).toBe('ok')
  })

  it('treats a dismissed record as dismissed, not as superseded', () => {
    expect(undoOfferFor(null, receipt())).toBe('ok')
  })
})

describe('driftedPaths', () => {
  it('reads nothing from a bridge that does not report them', () => {
    expect(driftedPathsOf({ runId: 'run-1', restored: 2 })).toEqual([])
    expect(driftedPathsNote({ runId: 'run-1', restored: 2 })).toBeNull()
  })

  it('ignores a malformed field rather than showing junk', () => {
    // A bridge older than the field can send anything at all through it.
    const result = { runId: 'run-1', restored: 2, driftedPaths: ['inbox/A.md', 7, ''] }
    expect(driftedPathsOf(result as unknown as WorkflowUndoResult)).toEqual(['inbox/A.md'])
  })

  it('names what the undo overwrote, singular and plural', () => {
    expect(driftedPathsNote({ runId: 'run-1', restored: 2, driftedPaths: ['inbox/A.md'] })).toBe(
      '1 file you edited after the run was overwritten: inbox/A.md.'
    )
    expect(
      driftedPathsNote({
        runId: 'run-1',
        restored: 3,
        driftedPaths: ['inbox/A.md', 'inbox/B.md']
      })
    ).toBe('2 files you edited after the run were overwritten: inbox/A.md and inbox/B.md.')
  })

  it('caps the list so a wide run still reads as one sentence', () => {
    const note = driftedPathsNote({
      runId: 'run-1',
      restored: 5,
      driftedPaths: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']
    })
    expect(note).toBe('5 files you edited after the run were overwritten: a.md, b.md, c.md and 2 more.')
  })
})

describe('interruptedRunToOffer', () => {
  const now = 10_000

  it('offers the most recent run when it was interrupted and can still be undone', () => {
    const run = runSummary({ startedAt: 9_000, interrupted: true })
    expect(interruptedRunToOffer([runSummary({ runId: 'old', startedAt: 1 }), run], now)).toBe(run)
  })

  it('stays silent for a bridge that never sets the flag', () => {
    expect(interruptedRunToOffer([runSummary({ startedAt: 9_000 })], now)).toBeNull()
  })

  it('ignores an interrupted run that later runs have already buried', () => {
    const interrupted = runSummary({ runId: 'run-1', startedAt: 5_000, interrupted: true })
    const later = runSummary({ runId: 'run-2', startedAt: 9_000 })
    expect(interruptedRunToOffer([interrupted, later], now)).toBeNull()
  })

  it('never offers an undo the journal cannot honour', () => {
    const undone = runSummary({ startedAt: 9_000, undoable: false, interrupted: true })
    expect(interruptedRunToOffer([undone], now)).toBeNull()
    const nothingWritten = runSummary({ startedAt: 9_000, paths: [], interrupted: true })
    expect(interruptedRunToOffer([nothingWritten], now)).toBeNull()
  })

  it('lets an old one go rather than offering to undo over a week of later work', () => {
    const stale = runSummary({ startedAt: 0, interrupted: true })
    expect(interruptedRunToOffer([stale], 5 * 24 * 60 * 60 * 1000)).toBeNull()
  })

  it('says what happened and how much of it is still on disk', () => {
    expect(interruptedRunHeadline(runSummary())).toBe(
      '"reading-log" was interrupted before it finished. 2 notes on disk still carry it.'
    )
  })
})

describe('promisedMoves', () => {
  it('names where a move, a rename, an archive and a trash put a note', () => {
    expect(
      promisedMoves([
        { kind: 'move', path: 'inbox/Dune.md', to: 'Topics' },
        { kind: 'rename', path: 'inbox/Old.md', to: 'New name' },
        { kind: 'archive', path: 'inbox/Done.md' },
        { kind: 'trash', path: 'inbox/Gone.md' },
        { kind: 'add-tag', path: 'inbox/Stay.md', tag: 'x' }
      ])
    ).toEqual([
      { from: 'inbox/Dune.md', to: 'Topics/Dune.md' },
      { from: 'inbox/Old.md', to: 'inbox/New name.md' },
      { from: 'inbox/Done.md', to: 'archive/Done.md' },
      { from: 'inbox/Gone.md', to: 'trash/Gone.md' }
    ])
  })

  it('folds a note moved twice to its last stop, and respects remapped system folders', () => {
    expect(
      promisedMoves(
        [
          { kind: 'move', path: 'inbox/Dune.md', to: 'Topics' },
          { kind: 'rename', path: 'Topics/Dune.md', to: 'Arrakis' },
          { kind: 'archive', path: 'inbox/Done.md' }
        ],
        { archive: 'Shelf' }
      )
    ).toEqual([
      { from: 'inbox/Dune.md', to: 'Topics/Arrakis.md' },
      { from: 'inbox/Done.md', to: 'Shelf/Done.md' }
    ])
  })
})
