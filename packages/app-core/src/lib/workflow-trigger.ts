// Run a workflow from anywhere that is not the workflows view: the command
// palette, and the event triggers (`lib/workflow-events`), which are the
// background cousins of a palette run.
//
// The flow is the SAME trust ladder the view walks, built from the same pure
// pieces (`workflow-run`, `workflow-op-summary`): plan fresh, name the notes
// with unsaved edits and ask, resolve template names to bodies, confirm the
// exact op list, apply, perform the two renderer-side effects, and leave a
// receipt the user can act on. The one honest difference is where the receipt
// lives: the view has a card, this flow has a toast carrying the Undo action,
// because the user who ran from the palette never left whatever they were
// doing and a toast is the only surface that follows them there.
//
// An event run walks the same ladder with the questions taken out, because
// nobody is there to answer them: it sees only the note that fired, skips
// rather than asks when a note has unsaved edits, applies without a
// confirmation, and says nothing at all when it changed nothing. What it does
// write it reports the same way, on a toast with the Undo.

import { BUILTIN_TEMPLATES } from '@shared/builtin-templates'
import { mergeTemplates } from '@shared/template-files'
import { parseWorkflow } from '@shared/workflows/parse'
import { planWorkflow } from '@shared/workflows/engine'
import { validateWorkflow } from '@shared/workflows/validate'
import { isRunnable } from '@shared/workflows/types'
import type {
  Diagnostic,
  PlanContext,
  Workflow,
  WorkflowEvent,
  WorkflowOp
} from '@shared/workflows/types'
import type { NoteMeta } from '@shared/ipc'
import type { WorkflowRunReceipt, WorkflowRunSummary } from '@bridge-contract/workflows'
import { useStore } from '../store'
import { useToastStore } from './toast'
import { confirmApp } from './confirm-requests'
import { createVaultReader } from './workflow-vault-reader'
import { IRREVERSIBLE_KINDS, summarizeOps } from './workflow-op-summary'
import {
  collectRunSideEffects,
  driftedPathsNote,
  formatPathList,
  interruptedRunHeadline,
  interruptedRunToOffer,
  opsExcludingPaths,
  planWritePaths,
  promisedMoves,
  receiptHeadline,
  resolveTemplateOps,
  runConfirmDescription,
  runConfirmLabel,
  runConfirmTitle,
  supersededUndoMessage,
  undoCollisionDescription,
  undoCollisionTitle,
  undoLabel,
  undoOfferFor,
  undoneHeadline,
  unknownTemplateDiagnostics,
  unsavedCollisionDescription,
  unsavedCollisionTitle,
  unsavedCollisions,
  unsavedSkipDescription,
  unsavedSkipTitle
} from './workflow-run'
import type { UnsavedResolution } from './workflow-run'

/** Long enough to read the headline AND decide about the Undo it carries. */
const RECEIPT_TOAST_MS = 12_000

/**
 * One run at a time, across every surface that calls this. A palette entry
 * picked twice while the first confirm is still open must not stack a second
 * confirm behind it, and an event that lands during that confirm waits its
 * turn rather than writing underneath a dialog that is still describing the
 * vault as it was.
 */
let inFlight = false

/**
 * Things said once per session rather than once per save: an event fires on
 * every save, and a workflow whose trigger condition cannot be read would
 * otherwise say so every time someone pauses typing.
 */
const noticed = new Set<string>()

function toast(
  message: string,
  type: 'success' | 'error' | 'info' = 'info',
  action?: { label: string; onClick: () => void },
  durationMs?: number
): void {
  useToastStore.getState().addToast(message, type, action, durationMs)
}

function toastOnce(key: string, message: string, type: 'error' | 'info'): void {
  if (noticed.has(key)) return
  noticed.add(key)
  toast(message, type)
}

/** Forget what has already been said. For tests. */
export function forgetTriggerNotices(): void {
  noticed.clear()
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Distinct error diagnostics, the number the confirmation admits to. */
function countErrors(groups: readonly Diagnostic[][]): number {
  const seen = new Set<string>()
  for (const group of groups) {
    for (const diagnostic of group) {
      if (diagnostic.severity !== 'error') continue
      seen.add(`${diagnostic.line}\x00${diagnostic.message}`)
    }
  }
  return seen.size
}

/**
 * Undo one receipt's run, from the toast it rode in on.
 *
 * The same collision honesty as the view's undo: undo writes bytes to disk,
 * so a note open with unsaved edits would have the restored file overwritten
 * by its next save, and that is worth a question rather than a surprise.
 *
 * It also answers to the same store record the view's card does, which is what
 * stops a toast left over from an older run rolling back the newer one that
 * replaced it. Both checks are made HERE rather than when the toast was built:
 * the run that supersedes this one lands while the offer is on screen.
 */
async function undoFromToast(receipt: WorkflowRunReceipt): Promise<void> {
  const state = useStore.getState()
  if (typeof window.zen.undoWorkflowRun !== 'function') return
  const offer = undoOfferFor(state.workflowRunRecord, receipt)
  if (offer === 'already-undone') return
  if (offer === 'superseded') {
    toast(supersededUndoMessage(), 'error')
    return
  }
  const dirty = unsavedCollisions(receipt.paths, state.noteDirty)
  if (dirty.length > 0) {
    const ok = await confirmApp({
      title: undoCollisionTitle(dirty),
      description: undoCollisionDescription(dirty),
      confirmLabel: 'Undo anyway',
      cancelLabel: 'Keep the run',
      danger: true
    })
    if (!ok) return
  }
  // The notes the run moved go back where they were, and an editor open on
  // one goes back with it, the way it followed the run forward.
  const moves = state.workflowRunRecord?.receipt.runId === receipt.runId ? (state.workflowRunRecord.moves ?? []) : []
  const settle = state.followWorkflowMoves(
    moves.map(({ from, to }) => ({ from: to, to: from })),
    { reverting: true }
  )
  try {
    const result = await (async () => {
      try {
        return await window.zen.undoWorkflowRun(receipt.runId)
      } finally {
        await settle()
      }
    })()
    // The record follows the undo wherever it was pressed, so the view's card
    // stops offering an Undo this toast already spent.
    useStore
      .getState()
      .setWorkflowRunRecord((latest) =>
        latest && latest.receipt.runId === receipt.runId
          ? { ...latest, undone: result, undoError: null }
          : latest
      )
    toast(undoneHeadline(result), 'success')
    // Its own toast, not a clause on the success line: this is the one thing an
    // undo takes away rather than gives back, and it stays until dismissed.
    const drifted = driftedPathsNote(result)
    if (drifted) toast(drifted, 'error')
    await state.refreshNotes()
  } catch (err) {
    const message = errorText(err)
    useStore
      .getState()
      .setWorkflowRunRecord((latest) =>
        latest && latest.receipt.runId === receipt.runId
          ? { ...latest, undoError: message }
          : latest
      )
    toast(message, 'error')
  }
}

/**
 * Offer to undo a run the app died in the middle of, once per vault open.
 *
 * An interrupted run is the one case where a receipt never reached anyone: the
 * process went away between the first write and the toast, so the vault carries
 * changes nobody was told about. The journal outlived the process, so the offer
 * can be made on the way back in. Silent whenever there is nothing to say,
 * which is almost always.
 */
export async function announceInterruptedWorkflowRun(): Promise<void> {
  const state = useStore.getState()
  if (!state.workflowsEnabled) return
  if (typeof window.zen.listWorkflowRuns !== 'function') return
  if (typeof window.zen.undoWorkflowRun !== 'function') return
  let runs: WorkflowRunSummary[]
  try {
    runs = await window.zen.listWorkflowRuns()
  } catch {
    // A run history that cannot be read is not worth a message of its own; the
    // vault opened fine and nothing here is something the user asked for.
    return
  }
  const interrupted = interruptedRunToOffer(runs, Date.now())
  if (interrupted === null) return
  // Shaped as a receipt so this offer walks the same undo path every other one
  // in this file does. `irreversible` is 0 rather than unknown: the summary
  // does not carry it, and nothing on the undo path reads it, so the honest
  // value is the one that claims nothing.
  const receipt: WorkflowRunReceipt = {
    runId: interrupted.runId,
    workflowId: interrupted.workflowId,
    startedAt: interrupted.startedAt,
    applied: interrupted.applied,
    paths: interrupted.paths,
    irreversible: 0
  }
  // `error`, so it stays until it is dismissed (see `addToast`): this is the
  // one receipt whose owner was never shown it, and a timer would take the
  // offer away from someone who has not finished reading what happened.
  toast(interruptedRunHeadline(interrupted), 'error', {
    label: undoLabel(receipt),
    onClick: () => void undoFromToast(receipt)
  })
}

/**
 * Run a workflow by id, end to end. Safe to call with anything: every failure
 * is a toast, never a throw, because the caller is a palette row.
 */
export async function runWorkflowById(id: string): Promise<void> {
  // The single funnel for every headless entry point, so the master switch
  // holds even for a caller that captured a command object (or an ex name)
  // before the toggle flipped. Same defensive posture as `openWorkflowsView`.
  if (!useStore.getState().workflowsEnabled) {
    toast('Workflows are turned off. Enable them under Settings → Workflows.', 'error')
    return
  }
  if (inFlight) return
  inFlight = true
  try {
    await runWorkflow(id)
  } finally {
    inFlight = false
  }
}

/* -------------------------------------------------------------------------- */
/*  Shared rungs                                                              */
/* -------------------------------------------------------------------------- */

interface LoadedWorkflows {
  byId: Map<string, Workflow>
  /** Parse diagnostics per workflow id. */
  diagnostics: Map<string, Diagnostic[]>
}

/**
 * Read the vault's workflows fresh from disk rather than trusting the index a
 * palette row or a trigger timer was built from: the file may have changed
 * since, and what runs must be what is on disk.
 */
async function loadWorkflows(): Promise<LoadedWorkflows> {
  const files = await window.zen.listWorkflows()
  const byId = new Map<string, Workflow>()
  const diagnostics = new Map<string, Diagnostic[]>()
  for (const file of files) {
    const parsed = parseWorkflow(file.raw, file.id)
    byId.set(parsed.workflow.id, parsed.workflow)
    diagnostics.set(parsed.workflow.id, parsed.diagnostics)
  }
  return { byId, diagnostics }
}

function titleForPathIn(notes: readonly NoteMeta[]): (path: string) => string {
  const titleByPath = new Map(notes.map((note) => [note.path, note.title]))
  return (path: string): string => {
    const known = titleByPath.get(path)
    if (known !== undefined) return known
    const file = path.split('/').pop() ?? path
    return file.replace(/\.md$/i, '')
  }
}

function missingTemplatesMessage(workflowName: string, missing: readonly string[]): string {
  const names = missing.map((name) => `"${name}"`).join(', ')
  return missing.length === 1
    ? `${names} is not a template in this vault, so "${workflowName}" cannot run.`
    : `${names} are not templates in this vault, so "${workflowName}" cannot run.`
}

/**
 * Apply an op list and leave the receipt: the last rung, shared by both entry
 * points from the moment there is nothing left to ask. Throws only when the
 * host refused the run outright; a run that failed partway comes back as a
 * rolled-back receipt and is reported here.
 *
 * A `background` run says nothing about a run that wrote no file. An event
 * fires on every save, and a tag the note already carries or a move into the
 * folder it already sits in is a run that changed nothing, which is not news.
 * A manual run gets the receipt either way: someone pressed something and is
 * waiting to hear.
 */
async function applyAndReport(
  workflow: Workflow,
  ops: WorkflowOp[],
  background: boolean
): Promise<boolean> {
  const state = useStore.getState()
  // An editor open on a note the run moves follows it, the way it follows a
  // rename the app makes: shielded from the unlink echo during the run and
  // carried to the new path after it, if the note landed where promised.
  const moves = promisedMoves(ops, state.vaultSettings.systemFolderPaths)
  const settle = state.followWorkflowMoves(moves)
  let receipt: WorkflowRunReceipt
  try {
    receipt = await window.zen.applyWorkflow({ workflowId: workflow.id, ops })
  } catch (err) {
    await settle()
    throw err
  }
  await settle()
  // The same store record the view's Undo card reads, written from here too.
  // A palette run and a canvas run are one event with two doorways, and two
  // records for one workflow is exactly how an older Undo ends up reverting a
  // newer run: the newest write wins, on every surface at once.
  useStore.getState().setWorkflowRunRecord({
    workflowId: workflow.id,
    receipt,
    undone: null,
    undoError: null,
    moves
  })
  if (receipt.rolledBack !== undefined) {
    toast(
      background ? `"${workflow.name}": ${receipt.rolledBack.reason}` : receipt.rolledBack.reason,
      'error'
    )
    await state.refreshNotes()
    return false
  }
  const effects = collectRunSideEffects(ops)
  for (const message of effects.notifications) toast(message)
  if (effects.clipboard !== null) {
    try {
      await navigator.clipboard.writeText(effects.clipboard)
    } catch {
      toast('The run finished, but the clipboard write failed.', 'error')
    }
  }
  const undoable = receipt.paths.length > 0 && typeof window.zen.undoWorkflowRun === 'function'
  if (!background || receipt.paths.length > 0) {
    toast(
      background ? `${workflow.name}: ${receiptHeadline(receipt)}` : receiptHeadline(receipt),
      'success',
      undoable ? { label: undoLabel(receipt), onClick: () => void undoFromToast(receipt) } : undefined,
      undoable ? RECEIPT_TOAST_MS : undefined
    )
  }
  await state.refreshNotes()
  return true
}

/* -------------------------------------------------------------------------- */
/*  A palette run                                                             */
/* -------------------------------------------------------------------------- */

async function runWorkflow(id: string): Promise<void> {
  const state = useStore.getState()
  if (typeof window.zen.listWorkflows !== 'function' || typeof window.zen.applyWorkflow !== 'function') {
    toast('Running workflows is not available in this workspace.', 'error')
    return
  }

  let loaded: LoadedWorkflows
  try {
    loaded = await loadWorkflows()
  } catch (err) {
    toast(`Could not read the vault's workflows: ${errorText(err)}`, 'error')
    return
  }
  const { byId } = loaded
  const parseDiagnostics = loaded.diagnostics.get(id) ?? []

  const workflow = byId.get(id)
  if (!workflow) {
    toast(`There is no workflow named "${id}" in this vault.`, 'error')
    return
  }
  if (!isRunnable(workflow)) {
    toast(`"${workflow.name}" is a draft, so it cannot run. Activate it first.`, 'error')
    return
  }

  const notes = state.notes
  const activeNote = state.selectedPath
    ? (notes.find((note) => note.path === state.selectedPath) ?? null)
    : null
  const reader = createVaultReader({
    notes,
    readBody: async (path) => (await window.zen.readNote(path)).body,
    current: () => activeNote
  })

  const templates = mergeTemplates(BUILTIN_TEMPLATES, state.customTemplates)
  const plan = await planWorkflow(workflow, {
    reader,
    now: Date.now(),
    resolve: (other) => byId.get(other) ?? null,
    systemFolderDirs: state.vaultSettings.systemFolderPaths
  })

  if (plan.ops.length === 0) {
    toast(`"${workflow.name}" only reads. There is nothing to apply.`)
    return
  }

  // The same three questions the view asks, in the same order.
  const dirtyPaths = unsavedCollisions(planWritePaths(plan.ops), state.noteDirty)
  let ops: WorkflowOp[] = plan.ops
  let unsaved: { paths: string[]; resolution: UnsavedResolution } | null = null
  if (dirtyPaths.length > 0) {
    const saveFirst = await confirmApp({
      title: unsavedCollisionTitle(dirtyPaths),
      description: unsavedCollisionDescription(dirtyPaths),
      confirmLabel: 'Save and continue',
      cancelLabel: 'Do not save'
    })
    if (saveFirst) {
      unsaved = { paths: dirtyPaths, resolution: 'save' }
    } else {
      const skip = await confirmApp({
        title: unsavedSkipTitle(dirtyPaths),
        description: unsavedSkipDescription(dirtyPaths),
        confirmLabel: 'Skip them',
        cancelLabel: 'Cancel the run'
      })
      if (!skip) return
      unsaved = { paths: dirtyPaths, resolution: 'skip' }
      ops = opsExcludingPaths(plan.ops, dirtyPaths)
    }
  }
  if (ops.length === 0) {
    toast(
      'Every planned change touched a note with unsaved edits, so skipping them left nothing to run.',
      'error'
    )
    return
  }

  const withTemplates = resolveTemplateOps(ops, templates, titleForPathIn(notes), new Date())
  if (withTemplates.missing.length > 0) {
    toast(missingTemplatesMessage(workflow.name, withTemplates.missing), 'error')
    return
  }

  const lines = summarizeOps(ops)
  const irreversibleCount = ops.filter((op) => IRREVERSIBLE_KINDS.has(op.kind)).length
  const ok = await confirmApp({
    title: runConfirmTitle(workflow.name),
    description: runConfirmDescription({
      workflowName: workflow.name,
      lines,
      fileCount: planWritePaths(ops).length,
      irreversibleCount,
      errorCount: countErrors([
        parseDiagnostics,
        validateWorkflow(workflow, byId),
        plan.diagnostics,
        unknownTemplateDiagnostics(workflow, templates)
      ]),
      unsaved
    }),
    confirmLabel: runConfirmLabel(lines),
    danger: irreversibleCount > 0
  })
  if (!ok) return

  try {
    if (unsaved?.resolution === 'save') {
      await Promise.all(unsaved.paths.map((path) => state.persistNote(path)))
    }
    await applyAndReport(workflow, withTemplates.ops, false)
  } catch (err) {
    toast(errorText(err), 'error')
  }
}

/* -------------------------------------------------------------------------- */
/*  An event run                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What became of an event: `ran` wrote and left a receipt, `nothing` found
 * nothing to do (which is silent), `unsaved` found the note being typed in
 * again (its next save fires again), `busy` met a palette run at its
 * confirmation (the caller tries again), and `skipped` covers everything
 * that was said out loud or needed no saying.
 */
export type EventRunOutcome = 'ran' | 'nothing' | 'unsaved' | 'busy' | 'skipped'

export interface WorkflowEventRun {
  id: string
  event: WorkflowEvent
  /** The note the event is about, as the store knows it now. */
  path: string
}

/**
 * Run a workflow because one of its events fired for one note.
 *
 * The plan sees ONLY that note: every source, `all` and `folder` included,
 * resolves over it, and `current` is it. That is what keeps an event run cheap
 * (no whole-vault body reads on every autosave), what makes `all | contains
 * type: topic | move Topics` mean "file this note when it says so", and what
 * bounds what a run can touch to the note that changed plus whatever its
 * sinks write.
 */
export async function runWorkflowForEvent(run: WorkflowEventRun): Promise<EventRunOutcome> {
  const state = useStore.getState()
  if (!state.workflowsEnabled || !state.workflowEventTriggers) return 'skipped'
  if (typeof window.zen.listWorkflows !== 'function' || typeof window.zen.applyWorkflow !== 'function') {
    return 'skipped'
  }
  if (inFlight) return 'busy'
  inFlight = true
  try {
    return await runForEvent(run)
  } finally {
    inFlight = false
  }
}

async function runForEvent({ id, event, path }: WorkflowEventRun): Promise<EventRunOutcome> {
  const state = useStore.getState()
  const meta = state.notes.find((note) => note.path === path)
  // Gone (trashed, moved on, or a list that has not caught up with it yet).
  // Its next event arms the timer again, so skipping loses nothing.
  if (!meta) return 'skipped'

  let loaded: LoadedWorkflows
  try {
    loaded = await loadWorkflows()
  } catch (err) {
    toastOnce('load', `Could not read the vault's workflows: ${errorText(err)}`, 'error')
    return 'skipped'
  }
  const workflow = loaded.byId.get(id)
  // The index that armed the timer can be older than the file: a workflow made
  // manual, moved to another event, or set back to draft since is left alone.
  if (!workflow || !isRunnable(workflow)) return 'skipped'
  if (workflow.trigger.type !== 'event' || workflow.trigger.event !== event) return 'skipped'

  const reader = createVaultReader({
    notes: [meta],
    readBody: async (target) => (await window.zen.readNote(target)).body,
    current: () => meta
  })
  const ctx: PlanContext = {
    reader,
    now: Date.now(),
    resolve: (other) => loaded.byId.get(other) ?? null,
    systemFolderDirs: state.vaultSettings.systemFolderPaths
  }

  if (workflow.trigger.where !== undefined) {
    const gate = await triggerConditionHolds(workflow.trigger.where, ctx)
    if (gate === 'invalid') {
      toastOnce(
        `where:${id}:${workflow.trigger.where}`,
        `"${workflow.name}" has a trigger condition the engine cannot read (where ${workflow.trigger.where}), so it did not run.`,
        'error'
      )
      return 'skipped'
    }
    if (!gate) return 'nothing'
  }

  const plan = await planWorkflow(workflow, ctx)
  if (plan.ops.length === 0) return 'nothing'

  const dirty = unsavedCollisions(planWritePaths(plan.ops), state.noteDirty)
  // The note that fired is being typed in again. Its next save fires again,
  // with the text that save lands; anything planned now would be stale.
  if (dirty.includes(path)) return 'unsaved'
  const ops = dirty.length > 0 ? opsExcludingPaths(plan.ops, dirty) : plan.ops
  // Another note the run would write is open with unsaved edits: the manual
  // ladder asks, a background run cannot, so it leaves that note alone and
  // says so, since a silent skip is a change the author cannot account for.
  if (dirty.length > 0) {
    toast(`"${workflow.name}" left ${formatPathList(dirty)} alone: unsaved edits there.`)
  }
  if (ops.length === 0) return 'nothing'

  const templates = mergeTemplates(BUILTIN_TEMPLATES, state.customTemplates)
  const withTemplates = resolveTemplateOps(ops, templates, titleForPathIn(state.notes), new Date())
  if (withTemplates.missing.length > 0) {
    toastOnce(
      `template:${id}:${withTemplates.missing.join(',')}`,
      missingTemplatesMessage(workflow.name, withTemplates.missing),
      'error'
    )
    return 'skipped'
  }

  try {
    return (await applyAndReport(workflow, withTemplates.ops, true)) ? 'ran' : 'skipped'
  } catch (err) {
    toast(`"${workflow.name}": ${errorText(err)}`, 'error')
    return 'skipped'
  }
}

/**
 * Does the trigger's `where` hold for the note that fired?
 *
 * Evaluated by the engine itself, as the one-step pipeline `current | where
 * <condition>` over the same scoped reader the run will use, so the condition
 * means exactly what the same words mean on a `where` step, frontmatter read
 * from the body included. `invalid` is a condition the parser or the planner
 * refused, which is reported once and never silently treated as true.
 */
async function triggerConditionHolds(
  condition: string,
  ctx: PlanContext
): Promise<boolean | 'invalid'> {
  const parsed = parseWorkflow(`---\nname: gate\n---\ngate = current | where ${condition}\n`, 'gate')
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return 'invalid'
  const plan = await planWorkflow(parsed.workflow, ctx)
  if (plan.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return 'invalid'
  return (plan.wires.gate?.length ?? 0) > 0
}
