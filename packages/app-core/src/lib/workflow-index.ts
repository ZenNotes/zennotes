// The vault's workflows, reduced to what surfaces OUTSIDE the workflows view
// need to know: the command palette lists them, the trigger flow checks they
// may act, and the event triggers ask which of them listen for an event.
// Everything here derives from the same files the view reads, through the
// same parser, so the palette can never disagree with the editor about what
// exists or what may run.

import type { WorkflowFile } from '@bridge-contract/workflows'
import { parseWorkflow } from '@shared/workflows/parse'
import type { WorkflowStatus, WorkflowTrigger } from '@shared/workflows/types'
import { stepIsMutating } from '@shared/workflows/nodes'

export interface WorkflowIndexEntry {
  /** Filename stem; what `call` steps and the trigger flow resolve. */
  id: string
  name: string
  description: string
  status: WorkflowStatus
  /** As parsed: an unknown trigger has already degraded to manual here, so an
   *  event trigger in the index is one the engine knows how to fire. */
  trigger: WorkflowTrigger
  /** True when any step writes, i.e. running it will ask for confirmation. */
  mutates: boolean
}

/**
 * Parse raw workflow files into index entries, in the order given.
 *
 * Diagnostics are deliberately dropped: a workflow with a broken line still
 * has a name and a status, and the palette's job is to find it, not to lint
 * it. The run flow re-parses and surfaces problems where they can be read.
 */
export function buildWorkflowIndex(files: readonly WorkflowFile[]): WorkflowIndexEntry[] {
  return files.map((file) => {
    const { workflow } = parseWorkflow(file.raw, file.id)
    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      trigger: workflow.trigger,
      mutates: workflow.statements.some((statement) =>
        statement.steps.some((step) => stepIsMutating(step.kind))
      )
    }
  })
}
