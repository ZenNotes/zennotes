import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject
} from 'react'
import { Background, Handle, Panel, Position, ReactFlow } from '@xyflow/react'
import type {
  Connection,
  Edge,
  Node,
  NodeChange,
  NodeProps,
  NodeTypes,
  ReactFlowInstance
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type {
  WorkflowFile,
  WorkflowRunReceipt,
  WorkflowUndoResult,
  WriteWorkflowInput
} from '@bridge-contract/workflows'
import { WORKFLOWS_REL_DIR } from '@shared/workflows-view'
import { NODE_DEFS, nodeDef } from '@shared/workflows/nodes'
import type { NodeCategory, NodeDef, ParamSpec } from '@shared/workflows/nodes'
import { CONSUMED_KEYS, RAW_ARG, WORKFLOW_EVENTS, parseWorkflow } from '@shared/workflows/parse'
// Structural edits. Every one of them is `Workflow -> Workflow`, which is what
// lets the canvas author a file it never has to know the text of: parse the
// draft, hand it to one of these, serialize the answer back. The `.md` stays the
// storage format, so text editing is one of two ways in rather than the way in.
import {
  addStatement,
  addStep,
  freshWireName,
  moveStep,
  removeStatement,
  removeStep,
  setStatementInput,
  setStatementName,
  setStepArg
} from '@shared/workflows/edit'
import { serializeWorkflow } from '@shared/workflows/serialize'
// The recipes the gallery offers and the completions the editor pops up. Both
// are data derived from `NODE_DEFS`, which is why neither lives here: this file
// renders them, it does not decide what the language contains.
import {
  PRESET_CATEGORIES,
  hiddenPresetsInOrder,
  presetById,
  visiblePresetsByCategory
} from '@shared/workflows/presets'
import type { WorkflowPreset } from '@shared/workflows/presets'
import { paramSignature, suggestAt } from '@shared/workflows/suggest'
import type { MatchRange, Suggestion } from '@shared/workflows/suggest'
// Sharing, both directions. A workflow is a `.md` file, so export is the file;
// import is the file plus a review, and the review is pure and lives there so
// that "what would this do to my vault" is answered by one testable function
// rather than by a dialog nobody can run without React.
import {
  reviewWorkflowImport,
  summarizeWorkflowWrites,
  workflowExportFilename
} from '@shared/workflows/share'
import type { WorkflowImportReview } from '@shared/workflows/share'
import { validateWorkflow } from '@shared/workflows/validate'
import { planWorkflow } from '@shared/workflows/engine'
import { layoutWorkflow } from '@shared/workflows/layout'
// Draft or active: whether a workflow may ACT, which is a different question
// from whether it is written to disk. Everything in this view that could set a
// change in motion asks `isRunnable` rather than comparing the field, so the
// rule is stated once for Run today and for the event and schedule triggers
// that will land later.
import { isRunnable } from '@shared/workflows/types'
import type {
  ArgValue,
  Diagnostic,
  RunPlan,
  Workflow,
  WorkflowOp,
  WorkflowStatement,
  WorkflowStatus,
  WorkflowStep,
  WorkflowTrigger
} from '@shared/workflows/types'
import { useStore } from '../store'
import type { WorkflowRunRecord } from '../store'
import { useToastStore } from '../lib/toast'
import { createVaultReader } from '../lib/workflow-vault-reader'
import { canManageWorkflows } from '../lib/workflow-workspace'
import {
  advanceSequence,
  formatKeyToken,
  getKeymapBinding,
  isMacPlatform,
  matchesSequenceToken
} from '../lib/keymaps'
import { isPaletteNextKey, isPalettePreviousKey } from '../lib/palette-nav'
// One way to open a context menu from the keyboard, shared with the sidebar and
// the tab strip: the row's own `contextmenu` handler answers, so the mouse and
// the keyboard can never drift into two different menus.
import { dispatchKeyboardContextMenu, keyboardMenuPosition } from '../lib/keyboard-context-menu'
import { confirmApp } from '../lib/confirm-requests'
import {
  bodyLineOffset,
  isWorkflowDraftDirty,
  lineRange,
  newWorkflowDraft,
  slugifyWorkflowName,
  uniqueWorkflowSlug,
  workflowFileText,
  workflowNameRange
} from '../lib/workflow-authoring'
import {
  LAYOUT_META_KEY,
  parseLayoutOverrides,
  pruneLayoutOverrides,
  withLayoutOverrides,
  withLayoutOverridesText
} from '../lib/workflow-layout-overrides'
import type { LayoutOverrides } from '../lib/workflow-layout-overrides'
import {
  activateConfirmDescription,
  activateConfirmTitle,
  withWorkflowStatusText
} from '../lib/workflow-status'
import {
  canUndoReceipt,
  collectRunSideEffects,
  driftedPathsNote,
  irreversibleNote,
  opsExcludingPaths,
  planWritePaths,
  receiptHeadline,
  resolveTemplateOps,
  runConfirmDescription,
  runConfirmLabel,
  runConfirmTitle,
  undoCollisionDescription,
  undoCollisionTitle,
  undoLabel,
  undoneHeadline,
  unknownTemplateDiagnostics,
  unsavedCollisionDescription,
  unsavedCollisionTitle,
  unsavedCollisions,
  unsavedSkipDescription,
  unsavedSkipTitle
} from '../lib/workflow-run'
import type { UnsavedResolution } from '../lib/workflow-run'
import { BUILTIN_TEMPLATES } from '@shared/builtin-templates'
import { mergeTemplates } from '@shared/template-files'
import { IRREVERSIBLE_KINDS, pathsTooltip, summarizeOps } from '../lib/workflow-op-summary'
import type { OpSummary } from '../lib/workflow-op-summary'
import { TUTORIAL_STEPS, TUTORIAL_WORKFLOW_SLUG } from '../lib/workflow-tutorial'
import { finishWorkflowTutorial } from '../lib/workflow-tutorial-flow'
import { Button, IconButton } from './ui/Button'
import { Modal } from './ui/Modal'
import { ContextMenu } from './ContextMenu'
import type { ContextMenuItem } from './ContextMenu'
import { CloseIcon, PencilIcon, PlusIcon, TrashIcon, ZapIcon } from './icons'
import { NodeInspector } from './workflows/NodeInspector'
import type { InspectorVocabulary } from './workflows/NodeInspector'
import { ImportReviewDialog } from './workflows/ImportReviewDialog'
import { TutorialPanel } from './workflows/TutorialPanel'
import { WorkflowListPane } from './workflows/WorkflowListPane'
import type { WorkflowListRow } from './workflows/WorkflowListPane'
import { WorkflowStatusToggle } from './workflows/WorkflowStatusToggle'
import { StepPicker } from './workflows/StepPicker'
import {
  CATEGORY_BLURB,
  CATEGORY_CHIP,
  CATEGORY_TITLE
} from './workflows/node-presentation'

/* -------------------------------------------------------------------------- */
/*  Grid                                                                      */
/* -------------------------------------------------------------------------- */

// Layout returns grid coordinates, never pixels, so the spacing lives here.
// Wide enough that a labelled wire has room for `name · count` between two
// nodes, which is the one thing on this canvas that must always be readable.
const COLUMN_WIDTH = 260
const ROW_HEIGHT = 110

/* -------------------------------------------------------------------------- */
/*  Teaching the format                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The four sentences that make the rest of the language guessable.
 *
 * Everything else in this file (the reference, the completions, the gallery)
 * shows WHAT can be written; this is the only place that says what a workflow
 * IS, which is the question someone opening this view for the first time is
 * actually asking.
 */
const MODEL_RULES: readonly string[] = [
  'A wire carries a set of notes. Every step takes that set and hands on another one.',
  'A line that starts `name =` names the wire it produces, so later lines can read it.',
  'A line with no `=` is terminal: it ends in a step that writes or shows something.',
  'Fan-out is two lines reading the same wire. There is no branch keyword.'
]

/**
 * What each frontmatter key is for. The KEYS come from the parser
 * (`CONSUMED_KEYS`) so the reference lists exactly what the format understands;
 * only the sentences live here, and a key without one still gets a row.
 */
const HEADER_KEY_HELP: Record<string, string> = {
  name: 'What it is called, and the filename it saves under.',
  description: 'One line, shown in the list on the left.',
  trigger: `manual, "on <event>", or "schedule <cron>". Events: ${WORKFLOW_EVENTS.join(', ')}.`,
  // Stated here as well as shown as a badge, because the file is the state:
  // someone reading the `.md` has to be able to tell whether it can act.
  status: 'draft or active. A draft is saved but cannot run. Missing means active.',
  key: 'Optional keybinding, e.g. <leader>wr.'
}

const HEADER_KEYS: readonly string[] = [...CONSUMED_KEYS]

/**
 * `where field op value`: how a step is written, derived from its params.
 *
 * `paramSignature` is the completions' own renderer, reused here on purpose:
 * the popup's detail column and this reference describe the same step, so they
 * have to bracket optional arguments the same way or one of them is lying.
 */
function stepSignature(def: NodeDef): string {
  const params = paramSignature(def)
  return params === '' ? def.kind : `${def.kind} ${params}`
}

/**
 * Every step kind, grouped by category, in the order the registry declares them.
 *
 * Built from `NODE_DEFS` rather than written out, so a node added to the
 * registry appears in the reference on the same commit and one that is renamed
 * can never leave a lie behind in the documentation.
 */
const REFERENCE_GROUPS: readonly { category: NodeCategory; defs: NodeDef[] }[] = (() => {
  const groups = new Map<NodeCategory, NodeDef[]>()
  for (const def of NODE_DEFS) {
    const bucket = groups.get(def.category)
    if (bucket) bucket.push(def)
    else groups.set(def.category, [def])
  }
  return [...groups].map(([category, defs]) => ({ category, defs }))
})()

/* -------------------------------------------------------------------------- */
/*  Labels                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Wire name a statement publishes into `RunPlan.wires`.
 *
 * Mirrors the engine's own key so a count can be looked up for an unnamed
 * terminal statement too. `RunPlan.wires` documents the `#<line>` fallback as
 * part of its contract, precisely so the canvas can label every edge.
 */
function wireKeyOf(statement: WorkflowStatement): string {
  return statement.name ?? `#${statement.line}`
}

/** Types whose source text was probably quoted, so a label reads like the file. */
const QUOTED_TYPES: ReadonlySet<ParamSpec['type']> = new Set([
  'path',
  'heading',
  'template',
  'folder',
  'glob'
])

function formatArg(spec: ParamSpec, value: ArgValue | undefined): string {
  if (value === undefined) return ''
  const text = String(value)
  if (text === '') return ''
  // The parser strips the `#`; put it back so the node reads like the line the
  // author wrote.
  if (spec.type === 'tag') return `#${text}`
  if (QUOTED_TYPES.has(spec.type) && /\s/.test(text)) return `"${text}"`
  return text
}

/** `where rating >= 4`: the verb plus the arguments that make it specific. */
function stepLabel(step: WorkflowStep): string {
  const def = nodeDef(step.kind)
  if (!def) {
    // An unrecognized verb has no params to bind, so the parser parks its raw
    // tokens. Showing them beats rendering a bare kind the author cannot place.
    const raw = step.args[RAW_ARG]
    return raw === undefined || raw === '' ? step.kind : `${step.kind} ${String(raw)}`
  }
  const args = def.params
    .map((param) => formatArg(param, step.args[param.name]))
    .filter(Boolean)
    .join(' ')
  return args ? `${step.kind} ${args}` : step.kind
}

function triggerLabel(trigger: WorkflowTrigger): string {
  switch (trigger.type) {
    case 'event':
      return trigger.where ? `on ${trigger.event} where ${trigger.where}` : `on ${trigger.event}`
    case 'schedule':
      return `schedule ${trigger.cron}`
    default:
      return 'manual'
  }
}

/* -------------------------------------------------------------------------- */
/*  Planned operations                                                        */
/* -------------------------------------------------------------------------- */

// Shared with the palette trigger (`lib/workflow-trigger`), which shows the
// same confirmation this view does. See `lib/workflow-op-summary`.

/* -------------------------------------------------------------------------- */
/*  Diagnostics                                                               */
/* -------------------------------------------------------------------------- */

const SEVERITY_ORDER: Record<Diagnostic['severity'], number> = { error: 0, warning: 1 }

/**
 * Parse, validate and plan all report on the same lines and sometimes on the
 * same problem, so they are merged and deduped before display. Sorted by line,
 * errors first, which is the order the file reads in.
 */
function mergeDiagnostics(...groups: readonly Diagnostic[][]): Diagnostic[] {
  const seen = new Set<string>()
  const all: Diagnostic[] = []
  for (const group of groups) {
    for (const diagnostic of group) {
      const key = `${diagnostic.severity}\x00${diagnostic.line}\x00${diagnostic.message}`
      if (seen.has(key)) continue
      seen.add(key)
      all.push(diagnostic)
    }
  }
  return all.sort(
    (a, b) => a.line - b.line || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  )
}

/* -------------------------------------------------------------------------- */
/*  Canvas node                                                               */
/* -------------------------------------------------------------------------- */

interface StepNodeData extends Record<string, unknown> {
  label: string
  /** `unknown` is a step kind the registry does not have, not a real category. */
  category: NodeCategory | 'unknown'
  title: string
  mutating: boolean
  severity: Diagnostic['severity'] | null
  line: number
  /** Notes leaving this step, when it ends a statement nothing reads. */
  outCount: number | null
  outWire: string | null
  /**
   * Selection is tracked by this view rather than by React Flow.
   *
   * `nodes` is a controlled prop and `onNodesChange` deliberately forwards only
   * position, so React Flow's own `selected` flag never makes it back into the
   * node. Carrying it in `data` keeps one answer to "which step is the
   * inspector describing", and it is the same answer the ring is drawn from.
   */
  isSelected: boolean
  /** Whether a wire may be dragged out of this step. */
  connectable: boolean
  /** Null when this step ends the pipeline, so nothing may follow it. */
  onInsertAfter: (() => void) | null
}

type StepNode = Node<StepNodeData, 'workflowStep'>

// Inline rather than a class: React Flow ships its own `.react-flow__handle`
// rule, and an inline style wins without an `!important` this codebase does not
// otherwise use. Handles exist only so edges have somewhere to attach.
const HANDLE_STYLE = {
  width: 6,
  height: 6,
  border: 'none',
  background: 'rgb(var(--z-grey-dim))'
} as const

function WorkflowStepNode({ data }: NodeProps<StepNode>): JSX.Element {
  const border =
    data.severity === 'error'
      ? 'border-danger'
      : data.mutating
        ? 'border-warning/70'
        : 'border-paper-300'
  return (
    <div
      title={`${data.title} (line ${data.line})`}
      className={`relative w-52 rounded-lg border ${border} bg-paper-100 px-3 py-2 text-left shadow-panel ${
        data.isSelected ? 'ring-2 ring-accent/60' : ''
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={data.connectable}
        style={HANDLE_STYLE}
      />
      <div className="flex items-center gap-1.5">
        <span
          className={`rounded px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide ${CATEGORY_CHIP[data.category]}`}
        >
          {data.category}
        </span>
        {data.mutating && (
          <span
            title="This step plans a change to your notes"
            className="rounded bg-warning/20 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-warning"
          >
            writes
          </span>
        )}
        {data.severity === 'error' && (
          <span className="ml-auto text-2xs font-semibold uppercase tracking-wide text-danger">
            error
          </span>
        )}
      </div>
      <div className="mt-1.5 truncate font-mono text-xs text-ink-900" title={data.label}>
        {data.label}
      </div>
      {data.outCount !== null && (
        <div className="mt-1 truncate text-2xs text-ink-500">
          {data.outWire === null ? '' : `${data.outWire} · `}
          {data.outCount} {data.outCount === 1 ? 'note' : 'notes'}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={data.connectable}
        style={HANDLE_STYLE}
      />
      {data.onInsertAfter && (
        // A real button, always visible and in the tab order: the insert-after
        // affordance is how the canvas grows a pipeline, and one that appears
        // on hover is one a keyboard never finds. `nodrag`/`nopan` so pressing
        // it is a click rather than the start of a drag.
        <button
          type="button"
          title="Add a step after this one"
          aria-label={`Add a step after ${data.label}`}
          onClick={(event) => {
            event.stopPropagation()
            data.onInsertAfter?.()
          }}
          className="nodrag nopan absolute -bottom-2.5 -right-2.5 flex h-5 w-5 items-center justify-center rounded-full border border-paper-300 bg-paper-100 text-ink-500 shadow-panel transition-colors hover:bg-paper-200 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <PlusIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

// Stable identity: React Flow re-registers node types whenever this object
// changes, which would remount every node on each render.
const NODE_TYPES: NodeTypes = { workflowStep: WorkflowStepNode }

type FlowInstance = ReactFlowInstance<StepNode, Edge>

/** How every automatic fit frames a graph. maxZoom above 1, deliberately: a
 *  typical workflow is five or six nodes, and capping the fit at 100% left
 *  them small and swimming in padding on every first open. 1.35 frames a
 *  small graph at a readable size while a large one still zooms out as far
 *  as it needs to. */
const FIT_VIEW_OPTIONS = { padding: 0.15, maxZoom: 1.35 } as const

/* -------------------------------------------------------------------------- */
/*  Node ids                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `statement:step` read back apart. Null for an id of some other shape.
 *
 * The format belongs to `stepId` in `@shared/workflows/layout`; this is the one
 * place that reverses it, so a canvas control can name the statement and step it
 * was rendered for without the graph carrying a second copy of the coordinates.
 */
function parseNodeId(id: string): { statement: number; step: number } | null {
  const match = /^(\d+):(\d+)$/.exec(id)
  return match === null ? null : { statement: Number(match[1]), step: Number(match[2]) }
}

/**
 * Is this key aimed at somewhere text is being typed?
 *
 * Backspace on the canvas deletes the selected step, and there is exactly one
 * way that goes wrong: doing it while someone is halfway through typing a note
 * path. In a field the key means "erase a character" and nothing else, so every
 * text entry is excluded, since the inspector's comboboxes are real `<input>`s with
 * `role="combobox"`, and the Edit-as-text editor is a textarea.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.closest('[role="combobox"], [contenteditable="true"]') !== null
}

/**
 * The source step of the first line: the node a workflow reads from the top.
 *
 * Named rather than spelled out at the one call site, because `'0:0'` in the
 * middle of a create says nothing about which node it is. Only meaningful for
 * a workflow that HAS a first statement with a step in it; callers check.
 */
const FIRST_NODE_ID = '0:0'

/**
 * Where a node id ends up after a structural edit, or null when it is gone.
 *
 * Node ids are POSITIONS, so inserting a step renumbers every step after it and
 * deleting a statement renumbers every statement after it. Two things are keyed
 * by that id and would otherwise be silently misapplied: the hand-placed
 * positions in the frontmatter (a deleted statement would hand its coordinates
 * to whichever statement slid up into its index) and the current selection.
 */
type NodeIdRemap = (id: string) => string | null

const IDENTITY_REMAP: NodeIdRemap = (id) => id

function remapOverrides(overrides: LayoutOverrides, remap: NodeIdRemap): LayoutOverrides {
  const next: LayoutOverrides = new Map()
  for (const [id, position] of overrides) {
    const moved = remap(id)
    if (moved !== null) next.set(moved, position)
  }
  return next
}

/** Ids after a step is inserted at `at` in `statement`. */
function afterStepInsert(statement: number, at: number): NodeIdRemap {
  return (id) => {
    const parsed = parseNodeId(id)
    if (parsed === null || parsed.statement !== statement || parsed.step < at) return id
    return `${parsed.statement}:${parsed.step + 1}`
  }
}

/** Ids after the step at `at` in `statement` is removed. */
function afterStepRemove(statement: number, at: number): NodeIdRemap {
  return (id) => {
    const parsed = parseNodeId(id)
    if (parsed === null || parsed.statement !== statement || parsed.step < at) return id
    return parsed.step === at ? null : `${parsed.statement}:${parsed.step - 1}`
  }
}

/** Ids after the whole of `statement` is removed. */
function afterStatementRemove(statement: number): NodeIdRemap {
  return (id) => {
    const parsed = parseNodeId(id)
    if (parsed === null || parsed.statement < statement) return id
    return parsed.statement === statement ? null : `${parsed.statement - 1}:${parsed.step}`
  }
}

/**
 * Ids after steps are reordered inside `statement`.
 *
 * Every coordinate in that line is dropped rather than followed: the boxes have
 * swapped places on purpose, so carrying their old positions along would undo
 * the very move that was asked for. The rest of the graph keeps its layout.
 */
function afterStepMove(statement: number): NodeIdRemap {
  return (id) => {
    const parsed = parseNodeId(id)
    return parsed !== null && parsed.statement === statement ? null : id
  }
}

/* -------------------------------------------------------------------------- */
/*  What is legal where                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The step kinds that may be inserted at `index` of `statement`.
 *
 * The grammar has exactly two positional rules and both are read off the
 * registry: a source opens a pipeline and may appear nowhere else, and a
 * terminal ends one so nothing may follow it. Offering an illegal step and then
 * marking the result red would teach the grammar by punishment, so the picker
 * is never shown a kind that cannot go where it is being asked for.
 */
function legalKindsAt(statement: WorkflowStatement, index: number): NodeDef[] {
  // Position 0 of a line that reads no wire is where the pipeline OPENS, so
  // only a source belongs there, and only while nothing already opens it.
  if (index === 0 && statement.input === null) {
    if (statement.steps.length > 0) return []
    return NODE_DEFS.filter((def) => def.source)
  }
  const atEnd = index >= statement.steps.length
  return NODE_DEFS.filter((def) => !def.source && (!def.terminal || atEnd))
}

/* -------------------------------------------------------------------------- */
/*  Wires                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every wire a statement reads: the one flowing into its pipeline plus any
 * named in a `wire` argument (`union other`).
 *
 * Read off the registry rather than by matching on `union`/`subtract`, exactly
 * as `layout` and `validate` do, so a future combining node is understood by
 * the cycle check the day it is added.
 */
function statementInputs(workflow: Workflow, index: number): string[] {
  const statement = workflow.statements[index]
  if (statement === undefined) return []
  const wires: string[] = []
  if (statement.input !== null && statement.input !== '') wires.push(statement.input)
  for (const step of statement.steps) {
    const def = nodeDef(step.kind)
    if (!def) continue
    for (const param of def.params) {
      if (param.type !== 'wire') continue
      const value = step.args[param.name]
      if (typeof value === 'string' && value !== '') wires.push(value)
    }
  }
  return wires
}

/** First statement to name each wire, matching `validate`'s first-one-wins rule. */
function wireProducers(workflow: Workflow): Map<string, number> {
  const producers = new Map<string, number>()
  workflow.statements.forEach((statement, index) => {
    if (statement.name === null || producers.has(statement.name)) return
    producers.set(statement.name, index)
  })
  return producers
}

/**
 * Does statement `from` already depend on statement `target`?
 *
 * Asked before a connection is made: wiring `target` to read `from` closes a
 * loop exactly when `from` already reads `target`, directly or through a chain.
 * `validate` would report the cycle afterwards, but a canvas that lets you draw
 * an impossible graph and then complains is worse than one that declines with a
 * reason, so this runs first and the drag is refused.
 */
function dependsOnStatement(workflow: Workflow, from: number, target: number): boolean {
  const producers = wireProducers(workflow)
  const seen = new Set<number>()
  const stack: number[] = [from]
  while (stack.length > 0) {
    const at = stack.pop()
    if (at === undefined || seen.has(at)) continue
    seen.add(at)
    if (at === target) return true
    for (const wire of statementInputs(workflow, at)) {
      const producer = producers.get(wire)
      if (producer !== undefined) stack.push(producer)
    }
  }
  return false
}

/** Wire names this workflow defines, in file order. */
function wireNamesOf(workflow: Workflow): string[] {
  const names: string[] = []
  for (const statement of workflow.statements) {
    if (statement.name !== null && !names.includes(statement.name)) names.push(statement.name)
  }
  return names
}

/**
 * Fallback base for a wire name when the step it comes from has no usable one.
 *
 * `freshWireName` in `@shared/workflows/edit` does the actual naming: it skips
 * names already taken AND registry verbs, because a wire named after a node
 * kind reads back as that kind wherever it is referenced.
 */
const NEW_WIRE_BASE = 'notes'

/* -------------------------------------------------------------------------- */
/*  Loaded files                                                              */
/* -------------------------------------------------------------------------- */

interface LoadedWorkflow {
  file: WorkflowFile
  workflow: Workflow
  parseDiagnostics: Diagnostic[]
}

/** One file as the list holds it. The only place raw bytes become a workflow. */
function loadWorkflowFile(file: WorkflowFile): LoadedWorkflow {
  const { workflow, diagnostics } = parseWorkflow(file.raw, file.id)
  return { file, workflow, parseDiagnostics: diagnostics }
}

/**
 * What can act, then what cannot.
 *
 * Sorted HERE, where the list is loaded, rather than in the pane that draws the
 * two groups. The keyboard counts rows (`cursor`, `data-workflow-row`, the
 * `findIndex` after a save), so the order the eye sees and the order the arrows
 * walk have to be one order; a pane that regrouped rows for display would make
 * `j` jump around the column it is moving through.
 *
 * Stable within each group, so the vault's own ordering survives and a workflow
 * does not change places for any reason but the one the heading names.
 */
function sortForDisplay(items: readonly LoadedWorkflow[]): LoadedWorkflow[] {
  return [...items].sort(
    (a, b) => Number(isRunnable(b.workflow)) - Number(isRunnable(a.workflow))
  )
}

/**
 * Would writing this workflow back under its own id land on the file it was
 * read from?
 *
 * `writeWorkflow` derives the path from the slug it is given, so a file whose
 * stem is not already a slug (`Reading Log.md`, written by hand) would be
 * written to a SECOND file and the vault would quietly hold two copies of one
 * workflow. Saving through the editor is allowed to move a file because the
 * author asked for it by renaming; a drag is not, so those files simply do not
 * offer dragging and their layout stays computed.
 */
function writesBackToItsOwnFile(item: LoadedWorkflow): boolean {
  const slug = slugifyWorkflowName(item.workflow.id)
  // Mirrors MAX_SLUG_LENGTH in the main process's `workflows.ts`, which
  // truncates a longer stem and would therefore write somewhere else.
  if (slug.length > 64) return false
  return `${WORKFLOWS_REL_DIR}/${slug}.md` === item.file.sourcePath
}

/* -------------------------------------------------------------------------- */
/*  Authoring                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How long typing has to pause before the graph is redrawn.
 *
 * Short enough that the canvas reads as live (watching the graph change as you
 * type IS the feature) and long enough that a burst of keystrokes plans the
 * vault once instead of once per character.
 */
const GRAPH_DEBOUNCE_MS = 150

/**
 * How long the VAULT has to settle before the plan is recomputed for it.
 *
 * Planning reads note bodies over IPC, and the notes slice is rebuilt by every
 * external change, every save and every refresh anywhere in the app, so a view
 * left open in a split pane was issuing a burst of reads for edits happening
 * somewhere else entirely. The workflow's own text is exempt (see the plan
 * effect): watching the counts move as you type is the feature, and only a
 * vault moving underneath a view nobody is touching waits.
 */
const PLAN_DEBOUNCE_MS = 350

/**
 * How long dragging has to settle before the moved nodes are written.
 *
 * Nudging three boxes into place is one thought, so it is one write. Short
 * enough that letting go of a node and immediately reloading still keeps the
 * position, long enough that a burst never turns into a burst of file writes.
 */
const LAYOUT_WRITE_DEBOUNCE_MS = 400

/**
 * How long an edit has to settle before it is written to disk on its own.
 *
 * Editing autosaves because a draft cannot act and an active workflow someone
 * is editing is one they already chose to trust, so "is it saved" stopped being
 * a question worth interrupting anyone with. Long enough that filling in three
 * arguments is one write rather than three, short enough that letting go of the
 * mouse and closing the window keeps the change.
 */
const AUTOSAVE_DEBOUNCE_MS = 600

/**
 * A layout write waiting on the debounce, resolved down to bytes and a
 * filename.
 *
 * Deliberately holds no reference to the view's state. The debounce is a window
 * in which the selection can move, the editor can open, and the list can be
 * re-read, and a write that consulted any of those when it fired would either
 * record the drag against the wrong file or lose it. Everything it needs is
 * decided at the moment the node was let go.
 */
interface PendingLayoutWrite {
  /** Filename stem, which is also the workflow id. */
  slug: string
  raw: string
}

/**
 * A workflow file open in the editor.
 *
 * The text is the source and the graph is a projection of it, so this holds no
 * canvas state at all. `sourcePath` is null for a workflow that has never been
 * written: it decides both whether a save is a create or a move, and whether
 * discarding the draft loses a file or nothing.
 */
interface WorkflowDraft {
  /** Workflow id the draft is parsed under; re-derived from the name on save. */
  id: string
  sourcePath: string | null
  text: string
  /** Text last written to disk, which is what `dirty` is measured against. */
  saved: string
}

/**
 * A workflow someone wants to bring in, reviewed and waiting on an answer.
 *
 * Holds the REVIEW rather than the raw text, and the review holds the bytes an
 * accept would write. That ordering is the safety property: there is no path
 * from "a file arrived" to "a file was written" that does not pass through
 * `reviewWorkflowImport`, because the text an accept uses is the one the review
 * produced. `slug` is resolved before the dialog opens, so the target named in
 * it is the file that is actually created and no existing workflow is at risk.
 */
interface PendingImport {
  /** Where it came from, in words: `the clipboard`, `reading-log.md`. */
  source: string
  /** Free filename stem it will be written under. Never an existing one. */
  slug: string
  review: WorkflowImportReview
}

/**
 * An open step picker, and what picking from it does.
 *
 * The legality filtering and the insertion both belong to the position that
 * opened it, so both are decided there and carried here. The picker itself only
 * renders and never asks what it is inserting into, which is why the same
 * component serves "start a new line" and "add a step after this one".
 */
interface PickerRequest {
  title: string
  subtitle: string
  defs: readonly NodeDef[]
  onPick: (def: NodeDef) => void
}

/**
 * Rewrite the `name:` line of a workflow file.
 *
 * Used when a recipe is taken twice: the filename stem follows the name, so a
 * second copy has to be named as well as filed apart. Returns the text
 * unchanged when there is no name line to rewrite, which is the honest answer
 * for a file whose frontmatter says nothing about a name.
 */
function renameWorkflowText(raw: string, name: string): string {
  const range = workflowNameRange(raw)
  if (range === null) return raw
  return `${raw.slice(0, range.start)}${name}${raw.slice(range.end)}`
}

/* -------------------------------------------------------------------------- */
/*  Completions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The two columns of the popup and its height ceiling, in px.
 *
 * These are the numbers the anchor math uses, so they are declared here rather
 * than left implicit in a Tailwind class: a popup measured with one width and
 * drawn with another is a popup that hangs off the edge of the pane.
 */
const SUGGEST_LIST_WIDTH = 216
const SUGGEST_DOCS_WIDTH = 264
const SUGGEST_MAX_HEIGHT = 240
/** Breathing room kept between the popup and the far edge of the editor. */
const SUGGEST_GUTTER = 12

/** Where the popup hangs, in px inside the textarea's own box. */
interface SuggestAnchor {
  left: number
  /** `below` measures from the top edge, `above` from the bottom one. */
  placement: 'below' | 'above'
  offset: number
  /** Measured against the pane, so the popup can never run off it. */
  width: number
  /** Docs beside the list, or under it when the pane is too narrow for both. */
  layout: 'beside' | 'stacked'
}

/**
 * Why completions are being computed.
 *
 * `typed` is the caller looking again because the text or the caret changed: it
 * only produces a popup when there is a prefix to filter by. `explicit` is the
 * user asking (Ctrl+Space, or a `|` that opened a fresh slot), which is the one
 * case where an empty prefix should list everything that could go there.
 *
 * This distinction is the whole fix for the reported bug. Without it the caret
 * arriving on a blank line and the user asking what goes there are the same
 * event, so the popup either never helps or never leaves.
 */
type SuggestTrigger = 'typed' | 'explicit'

/** Live completions, with the range they would replace and where to draw them. */
interface ActiveSuggest {
  from: number
  to: number
  items: readonly Suggestion[]
  anchor: SuggestAnchor
}

// Measured per resolved font, not per keystroke: the editor's font never
// changes within a session, and `measureText` is the expensive half of placing
// the popup.
const CHAR_WIDTHS = new Map<string, number>()
let measureCanvas: HTMLCanvasElement | null = null

function measureCharWidth(style: CSSStyleDeclaration): number {
  const font = style.font || `${style.fontSize} ${style.fontFamily}`
  const cached = CHAR_WIDTHS.get(font)
  if (cached !== undefined) return cached
  // Roughly a monospace advance, and the answer whenever a 2d context is
  // unavailable: a popup a few pixels off the caret still reads as attached to
  // it, and one pinned to the left edge does not.
  const fallback = parseFloat(style.fontSize) * 0.6
  if (measureCanvas === null) measureCanvas = document.createElement('canvas')
  const ctx = measureCanvas.getContext('2d')
  if (ctx === null) return fallback
  ctx.font = font
  const width = ctx.measureText('M').width || fallback
  CHAR_WIDTHS.set(font, width)
  return width
}

/**
 * Where to hang the completion popup for a caret at `offset`.
 *
 * The editor is a MONOSPACE textarea with wrapping off (both deliberate: a
 * wrapped line would make the line the eye counts differ from the line a
 * diagnostic names), so a column times the width of one character is the x
 * offset exactly. That is why there is no mirror element here: there is nothing
 * to keep in sync with the textarea beyond the font the browser resolved for
 * it, and no second copy of the text to reflow on every keystroke.
 */
function suggestAnchor(el: HTMLTextAreaElement, offset: number): SuggestAnchor {
  const style = window.getComputedStyle(el)
  const fontSize = parseFloat(style.fontSize)
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.5
  const charWidth = measureCharWidth(style)
  const lines = el.value.slice(0, offset).split('\n')
  const column = lines[lines.length - 1].length
  const x = parseFloat(style.paddingLeft) + column * charWidth - el.scrollLeft
  const y = parseFloat(style.paddingTop) + (lines.length - 1) * lineHeight - el.scrollTop
  const below = y + lineHeight
  // The popup may never cover the line being typed, so it flips above the caret
  // when the room below has run out and there is more of it above.
  const flip = below + SUGGEST_MAX_HEIGHT > el.clientHeight && y > el.clientHeight - below
  // A pane narrow enough that list and docs will not sit side by side stacks
  // them instead. Dropping the docs would be the easier answer and the wrong
  // one: they are the point of the popup, not a decoration on it.
  const room = Math.max(0, el.clientWidth - SUGGEST_GUTTER)
  const beside = SUGGEST_LIST_WIDTH + SUGGEST_DOCS_WIDTH
  const layout: 'beside' | 'stacked' = room >= beside ? 'beside' : 'stacked'
  const width = Math.min(layout === 'beside' ? beside : SUGGEST_DOCS_WIDTH, room)
  return {
    left: Math.max(0, Math.min(x, el.clientWidth - width)),
    placement: flip ? 'above' : 'below',
    offset: flip ? Math.max(0, el.clientHeight - y) : below,
    width,
    layout
  }
}

/** `books = tag #book`: the assignment that names a wire, anchored like the parser's. */
const WIRE_ASSIGN_RE = /^[ \t]*([A-Za-z_][\w-]*)[ \t]*=(?!=)/

/**
 * Whether the caret sits inside a step whose verb the registry knows.
 *
 * This is what makes a SPACE a request for help: after `where` (or after
 * `where rating`) the next thing to type is a slot the registry can describe,
 * so a space there is the user stepping into it. A space anywhere else is prose
 * or a wire name and gets no popup. Being generous past the first parameter
 * costs nothing, because a position the registry cannot describe returns no
 * items and the popup never opens.
 */
function inKnownStep(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const head = text.slice(lineStart, offset)
  // Only the current pipeline segment: `books | where ` is a `where` step, and
  // the wire name in front of the pipe has nothing to do with it.
  const segment = head.slice(head.lastIndexOf('|') + 1)
  const body = segment.replace(WIRE_ASSIGN_RE, '')
  const first = body.trim().split(/\s+/)[0] ?? ''
  return first !== '' && nodeDef(first) !== null
}

/**
 * The character just typed, and what it means for the popup.
 *
 * `null` is "this keystroke opens nothing": a backspace, a newline, a paste, a
 * quote. The caller still refreshes an OPEN popup on those, because deleting a
 * letter should refilter rather than freeze the list; it just never opens one.
 */
function triggerForInput(data: string | null, text: string, offset: number): SuggestTrigger | null {
  if (data === null || data.length !== 1) return null
  // A word character or a `#` starts a token, so there is a prefix to filter by
  // and the list narrows as it grows.
  if (/[\w#]/.test(data)) return 'typed'
  // These open an empty slot on purpose: a pipe starts a step, an `=` starts a
  // pipeline, and an opening quote starts a path. There is nothing to filter by
  // yet, and "what can follow this?" is exactly what was asked.
  if (data === '|' || data === '=' || data === '"' || data === "'") return 'explicit'
  if (data === ' ' && inKnownStep(text, offset)) return 'explicit'
  return null
}

/**
 * Wire names the draft defines, read from the TEXT rather than from the parsed
 * workflow.
 *
 * Completions have to answer for the character just typed, and the parse the
 * canvas draws from is a debounce behind, so a wire named half a second ago
 * would not be offerable yet. `skipLines` is the frontmatter, where a `key: a=b`
 * would otherwise read as an assignment.
 */
function wireNamesIn(text: string, skipLines: number): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const lines = text.split('\n')
  for (let i = Math.max(0, skipLines); i < lines.length; i += 1) {
    const match = WIRE_ASSIGN_RE.exec(lines[i])
    if (match === null || seen.has(match[1])) continue
    seen.add(match[1])
    names.push(match[1])
  }
  return names
}

/**
 * Ctrl+Space, or Cmd+I on a Mac where Ctrl+Space belongs to the OS.
 *
 * `event.key` for the space bar is `' '`, and `code` is checked too because a
 * layout that puts something else on that key still reports `Space` there.
 */
function isExplicitSuggestKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.key === ' ' || event.code === 'Space') return true
  }
  return event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'i'
}

/** Keys that move the caret without changing the text, so completions re-run. */
const CARET_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown'
])

/* -------------------------------------------------------------------------- */
/*  Running                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a run left behind.
 *
 * Held until it is dismissed, never on a timer: a run that mutated files has to
 * leave a visible record, and a toast that fades is exactly the affordance that
 * lets someone walk away not knowing what changed. It is also where Undo lives,
 * so dismissing it is a deliberate "I am done with this run".
 */
// The run record (receipt + undo state) lives in the STORE, not here: leaving
// the view must not cost the Undo. See `WorkflowRunRecord` in store.ts.

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The Workflows canvas: every workflow file in the vault, its graph, what
 * running it WOULD do, and the editor that authors it.
 *
 * Selecting a workflow plans it, and planning writes nothing: the engine
 * returns ops and the caller applies them, so the panel below the graph is what
 * a run WOULD do rather than a log of something that already happened. Applying
 * is a separate, explicit act. It is confirmed against that very panel, it
 * leaves a receipt that can be undone, and until it happens the footer keeps
 * saying nothing has been written, because nothing has.
 *
 * Editing is CANVAS editing, with text as the second way in. Selecting a
 * workflow shows the graph and an inspector over it: steps come from a picker
 * built out of the registry, arguments are typed into a control chosen by their
 * declared type, and wiring is dragged between lines. The text editor is one
 * toggle away and keeps everything it ever had.
 *
 * The two surfaces cannot drift, because there is only one representation of a
 * workflow anywhere in this view. Every canvas edit is `parseWorkflow` -> a
 * `Workflow -> Workflow` function from `@shared/workflows/edit` ->
 * `serializeWorkflow`, landing back in the same draft text the textarea edits.
 * Switching between them therefore converts nothing, the `.md` file stays the
 * storage format, and a workflow written by hand is still one the canvas can
 * edit.
 *
 * Nodes can also be moved, and that does not weaken the projection because what
 * a drag stores is an OVERRIDE rather than a layout: auto-layout remains the
 * default and only the nodes someone actually moved carry a coordinate. See
 * `../lib/workflow-layout-overrides`.
 */
export function WorkflowsView(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const selectedPath = useStore((s) => s.selectedPath)
  const vimMode = useStore((s) => s.vimMode)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const workspaceMode = useStore((s) => s.workspaceMode)
  // Templates change on template CRUD and vault refresh, nowhere near every
  // keystroke, so unlike `noteDirty` this one is cheap to subscribe to. It has
  // to be reactive: `apply-template` diagnostics must clear the moment the
  // named template is created.
  const customTemplates = useStore((s) => s.customTemplates)
  const tutorialStep = useStore((s) => s.workflowTutorialStep)
  const setTutorialStep = useStore((s) => s.setWorkflowTutorialStep)
  // For the tutorial's "run from anywhere" chapter, which watches for the
  // command palette opening over this view.
  const paletteOpen = useStore((s) => s.commandPaletteOpen)
  // The tutorial's activation chapter watches the index rather than this
  // view's own list, because the index is refreshed by the same CRUD paths
  // that change a status and is already store-shaped.
  const workflowIndexEntries = useStore((s) => s.workflowIndex)
  // Actions, not state: both identities are stable, so subscribing to them
  // costs nothing. `noteDirty` is deliberately NOT subscribed to here; it is
  // rebuilt on every keystroke in any editor pane, and reading it lazily when
  // Run is pressed is both cheaper and more correct than a snapshot from the
  // last render.
  const persistNote = useStore((s) => s.persistNote)
  const refreshNotes = useStore((s) => s.refreshNotes)

  // null while the first load is in flight, so "no workflows yet" and "not
  // asked yet" render differently.
  const [items, setItems] = useState<LoadedWorkflow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Tagged with the workflow it describes: a plan that arrives after the
  // selection moved on would otherwise label the new graph with the old
  // workflow's counts, which is worse than showing none.
  const [planned, setPlanned] = useState<{ id: string; plan: RunPlan } | null>(null)
  const [planning, setPlanning] = useState(false)
  // Bumped after a run or an undo: the vault moved under the plan, so the wire
  // counts and the dry run have to be derived again before they can be read as
  // describing the vault as it is now.
  const [planToken, setPlanToken] = useState(0)

  // Running state. The record outlives the run itself AND this view: it is
  // store state, so glancing at a note and coming back keeps the Undo.
  const [running, setRunning] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const record = useStore((s) => s.workflowRunRecord)
  const setRecord = useStore((s) => s.setWorkflowRunRecord)

  // Authoring state. `draft === null` is the read-only view; nothing below here
  // matters until the editor is open.
  const [draft, setDraft] = useState<WorkflowDraft | null>(null)
  // The draft text the graph is drawn from: the same string, one debounce tick
  // behind, so the canvas keeps up with typing without re-planning the vault on
  // every keystroke.
  const [previewText, setPreviewText] = useState('')
  const [saving, setSaving] = useState(false)
  // A draft/active flip in flight. Separate from `saving`, which is about the
  // author's own edit: these two writes can never overlap on one file (the flip
  // goes into the draft while one is open), and telling them apart is what lets
  // the badge stop answering without the header claiming an edit is unsaved.
  const [statusPending, setStatusPending] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  // Bumped once per editor session, so focus (and the name selection on a new
  // workflow) is applied when the editor opens rather than on every keystroke.
  const [editSession, setEditSession] = useState(0)
  /**
   * Is the TEXT editor showing?
   *
   * Separate from `draft` on purpose: a draft is unsaved text, and the canvas
   * now produces plenty of that without anyone opening a textarea. Conflating
   * the two is what would make a structural edit yank the user into a view they
   * did not ask for.
   */
  const [textMode, setTextMode] = useState(false)

  // Canvas editing state. All three are view state over the same draft text:
  // nothing here is a second representation of the workflow.
  /**
   * Selection, which is a LIST because a canvas can hold a group (#534).
   *
   * `selectedNodeId` below is the same state read as "the one node", and it is
   * what almost everything here wants: the options panel edits one step, delete
   * removes one step, the context menu acts on one node. Those all go on
   * reading a single id, and a group simply reads as no single node, so nothing
   * that edits one step can fire against five.
   */
  const [selectedNodeIds, setSelectedNodeIds] = useState<readonly string[]>([])
  const selectedNodeId = selectedNodeIds.length === 1 ? selectedNodeIds[0] : null
  /**
   * Select exactly one node, or nothing. Accepts the updater form because the
   * remap after a structural edit needs to see the current id.
   */
  const setSelectedNodeId = useCallback(
    (next: string | null | ((current: string | null) => string | null)): void => {
      setSelectedNodeIds((current) => {
        const single = current.length === 1 ? current[0] : null
        const value = typeof next === 'function' ? next(single) : next
        return value === null ? [] : [value]
      })
    },
    []
  )
  const selectedIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  const [picker, setPicker] = useState<PickerRequest | null>(null)
  // Why a connection was refused, shown over the canvas that refused it.
  const [connectError, setConnectError] = useState<string | null>(null)
  /**
   * A request to put the keyboard on a wire name, and the node it was made
   * for.
   *
   * Which node matters: the inspector is remounted per selection, so a bare
   * counter would still be raised when the panel reopened on some unrelated
   * step and would steal the keyboard into a field nobody asked about.
   */
  const [wireFocus, setWireFocus] = useState<{ nodeId: string; token: number } | null>(null)
  /**
   * The right-click menu on a node, and the node it was aimed at.
   *
   * The id is carried rather than the resolved step: the menu is rebuilt from
   * the workflow on every render, so a move made from inside it re-points its
   * own Move up / Move down instead of describing where the step used to be.
   */
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; id: string } | null>(null)

  // Teaching state. The gallery is how a workflow is created (a blank file is
  // the LAST entry in it, not the only one), and the reference is the answer to
  // "how do I know what to write", so both are plain view state: nothing here
  // touches the vault.
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [referenceOpen, setReferenceOpen] = useState(false)
  /**
   * A workflow that arrived from outside, reviewed and awaiting an answer.
   *
   * Nothing is written while this is set: an import is a decision, and this is
   * where the decision waits. See `PendingImport`.
   */
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null)
  const [importing, setImporting] = useState(false)
  /** The Copy / Export menu, anchored under the button that opened it. */
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null)
  const [suggest, setSuggest] = useState<ActiveSuggest | null>(null)
  const [suggestIndex, setSuggestIndex] = useState(0)

  /**
   * Nodes moved here, since the file last said where they are.
   *
   * Only the in-flight half of a drag: the file remains the source, and this is
   * what stands in for it between letting go of a node and the write landing.
   * Tagged with the workflow it belongs to, so it is never read over a
   * different graph, which is also what lets it be resolved during render
   * rather than seeded by an effect. Seeding would show the previous workflow's
   * positions for the frame that `fitView` runs in.
   */
  const [dragged, setDragged] = useState<{ id: string; map: LayoutOverrides } | null>(null)
  // The same value one render earlier: a drag's last position change and its
  // drag stop arrive in one React batch, so the flush has to read something
  // already up to date rather than the state of the previous render.
  const draggedRef = useRef<{ id: string; map: LayoutOverrides } | null>(null)

  // This view's own subtree. Every lookup that is not already anchored to a
  // more specific ref goes through it: the view can be open in TWO panes, and a
  // `document.querySelector` then answers with whichever copy React mounted
  // first, which is how a keystroke in one pane moves the other one.
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  // The canvas column, so a deletion can hand the keyboard back to it instead
  // of leaving focus on the node it just unmounted.
  const canvasRef = useRef<HTMLDivElement>(null)
  // The live React Flow instance (refreshed by `onInit` on every graphKey
  // remount) and whether the USER has panned or zoomed it. Auto-refits, on
  // mount and on container resize, run only until the first hand movement:
  // a viewport someone placed is theirs, and snapping it back on a pane
  // resize would fight them mid-thought.
  const flowInstanceRef = useRef<FlowInstance | null>(null)
  const viewportTouchedRef = useRef(false)

  // The pane the canvas lives in settles its size a frame or two after the
  // view mounts (and again when sidebars toggle). React Flow's mount-time
  // `fitView` measures whatever size exists at that instant, which is how a
  // first open ended with the graph stranded tiny in a corner. Refit on every
  // container resize until the user takes the viewport over.
  useEffect(() => {
    const el = canvasRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (viewportTouchedRef.current) return
      const instance = flowInstanceRef.current
      if (instance) void instance.fitView(FIT_VIEW_OPTIONS)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // The node a workflow should open with selected, handed across the render
  // that makes it the active one. Creating a workflow wants the inspector
  // already open on its source step, and the reset that clears the canvas
  // selection runs on exactly that render, so the wish cannot be a `setState`
  // made before it: it would be the thing the reset wipes.
  const pendingNodeId = useRef<string | null>(null)

  // Claim the keyboard when the view opens.
  //
  // `openWorkflowsView` blurs whatever launched it (a sidebar row, the command
  // palette) so those do not keep swallowing keys, and every other focus call in
  // this file is on a TRANSITION: leaving text mode, closing the gallery, after
  // a save. First open is the one path with no previous owner to hand off from,
  // so focus stayed on <body> and j/k went to the document and died. In a
  // keyboard-first app that reads as the whole view being broken.
  useEffect(() => {
    listRef.current?.focus()
  }, [])
  // Where the caret goes once React has committed text this view spliced (a
  // completion, or a step clicked out of the reference). A controlled textarea
  // puts the caret at the end of the new value otherwise, which would strand it
  // at the bottom of the file after every accepted completion.
  const pendingCaret = useRef<number | null>(null)
  // Whether the text just spliced in left a slot open for another completion.
  // See the layout effect that lands the caret for why it is not always true.
  const pendingChain = useRef(false)
  // Escape dismissed the popup: it stays dismissed until the text changes or
  // the caret is moved by hand, so Escape means "leave me alone" rather than
  // "close for one keystroke".
  const suggestOff = useRef(false)
  // Why the popup on screen is open, so a redraw that is not a new question (a
  // scroll) does not quietly turn an explicit list into a filtered one.
  const suggestTrigger = useRef<SuggestTrigger>('typed')
  const suggestListRef = useRef<HTMLUListElement>(null)
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()
  const layoutWriteTimer = useRef<ReturnType<typeof setTimeout>>()
  // Draft text an autosave already failed on, so the retry is the author's next
  // keystroke rather than a timer hammering a disk that said no. See the
  // autosave effect.
  const autosaveBlocked = useRef<string | null>(null)
  // The whole write, resolved when the drag ended rather than when the debounce
  // fires: leaving one workflow for another inside the window must still record
  // the drag that was made, and must record it against the file it was made on.
  const pendingLayoutWrite = useRef<PendingLayoutWrite | null>(null)

  // Desktop owns local workflow files directly. Remote workspaces (web or
  // Electron) own them through a server that explicitly advertises journalled
  // workflow support; older servers stay read-only. For a desktop remote
  // workspace the static preload capabilities describe the app, not the
  // server, so ask the server itself. (#618)
  const appInfo = window.zen.getAppInfo()
  const capabilities = window.zen.getCapabilities()
  const [remoteWorkflowsSupported, setRemoteWorkflowsSupported] = useState<boolean | null>(null)
  useEffect(() => {
    if (workspaceMode !== 'remote' || appInfo.runtime !== 'desktop') return
    let cancelled = false
    window.zen
      .getServerCapabilities()
      .then((caps) => {
        if (!cancelled) setRemoteWorkflowsSupported(caps?.supportsWorkflows === true)
      })
      .catch(() => {
        if (!cancelled) setRemoteWorkflowsSupported(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceMode])
  const effectiveCapabilities =
    appInfo.runtime === 'desktop' && workspaceMode === 'remote'
      ? { ...capabilities, supportsWorkflows: remoteWorkflowsSupported === true }
      : capabilities
  const writableWorkspace = canManageWorkflows(appInfo.runtime, workspaceMode, effectiveCapabilities)
  const nativeLocalVault = appInfo.runtime === 'desktop' && workspaceMode !== 'remote'
  const canWrite = writableWorkspace && typeof window.zen.writeWorkflow === 'function'
  const canDelete = writableWorkspace && typeof window.zen.deleteWorkflow === 'function'
  // Applying is the only thing in this view that writes NOTES, and it runs in
  // the main process, so it is gated exactly like the authoring affordances:
  // a bridge that predates these methods offers no Run button at all rather
  // than one that throws.
  const canApply = writableWorkspace && typeof window.zen.applyWorkflow === 'function'
  const canUndoRuns = writableWorkspace && typeof window.zen.undoWorkflowRun === 'function'
  // `revealNote` reveals any VAULT-RELATIVE path, which is what a workflow's
  // `sourcePath` is, so the file manager entry needs no bridge of its own. Gated
  // the same way as the rest: a workspace with no local files gets no item at
  // all rather than one that opens nothing.
  const canReveal = nativeLocalVault && typeof window.zen.revealNote === 'function'
  // Saving a copy somewhere else, and reading one back, both need a native file
  // dialog and a filesystem, so both are desktop-only and hidden elsewhere
  // rather than offered and then refused. Copying to the CLIPBOARD is not gated
  // this way on purpose: it needs nothing but a clipboard, and it is the form of
  // sharing that actually travels through a chat message or a gist.
  const canExportFile = nativeLocalVault && typeof window.zen.exportWorkflow === 'function'
  const canImportFile = canWrite && typeof window.zen.importWorkflowFile === 'function'
  // A stable action, so subscribing costs nothing; see the selectors above.
  const addToast = useToastStore((s) => s.addToast)

  const loadWorkflows = useCallback(async (): Promise<LoadedWorkflow[]> => {
    if (typeof window.zen.listWorkflows !== 'function') return []
    const files = await window.zen.listWorkflows()
    // The palette's Run entries read the store's index, and this view is the
    // one place workflows change from inside the app, so every re-list here
    // refreshes that index too. Fire and forget: the palette needs it by the
    // time it next opens, not before this list renders.
    void useStore.getState().loadWorkflowIndex()
    return sortForDisplay(files.map(loadWorkflowFile))
  }, [])

  /**
   * Re-read the vault and hand the fresh list back to the caller.
   *
   * A save has to re-list (the left column shows the name and description from
   * the file, both of which the edit may have changed) and then select what it
   * just wrote, which means it needs the new list in the same turn rather than
   * on some later render.
   */
  const refresh = useCallback(async (): Promise<LoadedWorkflow[]> => {
    try {
      const loaded = await loadWorkflows()
      setLoadError(null)
      setItems(loaded)
      return loaded
    } catch (err) {
      setItems([])
      setLoadError(err instanceof Error ? err.message : String(err))
      return []
    }
  }, [loadWorkflows])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const loaded = await loadWorkflows()
        if (cancelled) return
        setLoadError(null)
        setItems(loaded)
      } catch (err) {
        if (cancelled) return
        setItems([])
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [loadWorkflows, reloadToken])

  const list = useMemo(() => items ?? [], [items])

  const selected = useMemo(
    () => list.find((item) => item.workflow.id === selectedId) ?? null,
    [list, selectedId]
  )

  // Split out of `draft` so the memos below re-run when the debounced text
  // changes, not on every keystroke: `setDraft` hands back a new object each
  // time, and depending on it would defeat the debounce entirely.
  const draftId = draft?.id ?? null
  const draftSourcePath = draft?.sourcePath ?? null
  const draftText = draft?.text ?? null
  // The TEXTAREA is on screen, which is a narrower question than "is there a
  // draft": the canvas produces drafts too, and the completion popup, the
  // caret and the focus handoff all belong to the textarea rather than to the
  // fact that something is unsaved.
  const editingNow = draft !== null && textMode

  useEffect(() => {
    if (draftText === null) return
    const timer = setTimeout(() => setPreviewText(draftText), GRAPH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draftText])

  /**
   * The draft as a workflow, parsed from the text on screen.
   *
   * Shaped as a `LoadedWorkflow` so the graph, the counts, the diagnostics and
   * the dry run all read one value whether they are showing a file or an
   * unsaved edit. A second rendering path for "preview" would be the thing that
   * eventually drifts from what a save actually produces.
   */
  const editing = useMemo<LoadedWorkflow | null>(() => {
    if (draftId === null) return null
    const { workflow, diagnostics } = parseWorkflow(previewText, draftId)
    return {
      file: {
        id: draftId,
        // A workflow that has never been saved has no file yet; showing where
        // it WILL land beats showing an empty path.
        sourcePath: draftSourcePath ?? `${WORKFLOWS_REL_DIR}/${draftId}.md`,
        raw: previewText
      },
      workflow,
      parseDiagnostics: diagnostics
    }
  }, [draftId, draftSourcePath, previewText])

  const active = editing ?? selected

  const activeId = active?.workflow.id ?? null
  // The stored value, not the meta record: the record's identity changes on
  // every re-parse of unchanged text, and a string only changes when the
  // recorded positions actually do.
  const activeLayoutMeta = active?.workflow.meta[LAYOUT_META_KEY] ?? null

  /**
   * Where the moved nodes of the workflow on screen are.
   *
   * Resolved during render rather than kept in state: a drag outranks the file
   * only for the workflow it belongs to, and everything else reads straight
   * from the frontmatter, so switching workflows lands on the right positions
   * on the FIRST frame, which is the frame `fitView` measures.
   */
  const overrides = useMemo<LayoutOverrides>(() => {
    if (active === null) return new Map()
    if (dragged !== null && dragged.id === active.workflow.id) return dragged.map
    return parseLayoutOverrides(active.workflow.meta)
  }, [active, dragged])

  // Once the file (or the draft text) says what the drag said, the local copy
  // has nothing left to add. Dropping it here is also what stops a drag that
  // was cancelled along with the rest of an edit from outliving the text it
  // came from.
  useEffect(() => {
    draggedRef.current = null
    setDragged(null)
  }, [activeId, activeLayoutMeta])

  // A selection, a refused connection and a half-open picker all describe ONE
  // graph. Moving to another workflow leaves every one of them meaningless, so
  // they go rather than hang over a graph they were never about.
  //
  // The one exception is a node the ARRIVING workflow asked to open with: a
  // workflow that was just created wants its source step under the inspector,
  // and this reset is the only thing that runs late enough to be trusted with
  // that. Consumed here so it can never leak onto the next workflow.
  useEffect(() => {
    const wanted = pendingNodeId.current
    pendingNodeId.current = null
    setSelectedNodeId(wanted)
    setConnectError(null)
    setPicker(null)
  }, [activeId])

  // A refusal is an answer to a gesture, not a state of the workflow, so it
  // fades on its own. Long enough to read a sentence, short enough that it is
  // gone before the next attempt.
  useEffect(() => {
    if (connectError === null) return
    const timer = setTimeout(() => setConnectError(null), 7000)
    return () => clearTimeout(timer)
  }, [connectError])

  // Every workflow by id, for `validate`'s cross-file call-cycle check and for
  // the engine to resolve `call` steps against.
  const byId = useMemo(() => {
    const map = new Map<string, Workflow>()
    for (const item of list) map.set(item.workflow.id, item.workflow)
    // The draft outranks the file it came from: a `call` into the workflow
    // being edited has to resolve to the text on screen, or validate would
    // clear a cycle the author just typed.
    if (editing) map.set(editing.workflow.id, editing.workflow)
    return map
  }, [list, editing])

  // Opening the view with nothing shown on the right would hide the whole
  // point, so the first workflow is selected as soon as one exists. EXCEPT
  // during the tutorial: its first todo is "select the workflow", and an
  // auto-selection landing after the chapter card mounts is indistinguishable
  // from the user doing it, which both stole the lesson and turned the page
  // by itself.
  useEffect(() => {
    if (tutorialStep !== null) return
    if (selectedId === null && list.length > 0) setSelectedId(list[0].workflow.id)
  }, [list, selectedId, tutorialStep])

  useEffect(() => {
    if (cursor > 0 && cursor >= list.length) setCursor(Math.max(0, list.length - 1))
  }, [cursor, list.length])

  const activeNote = useMemo(
    () => (selectedPath ? (notes.find((note) => note.path === selectedPath) ?? null) : null),
    [notes, selectedPath]
  )

  // Bumped when the window comes back to the front. A hidden window plans
  // nothing (see the plan effect), so this is what puts the plan back.
  const [revealToken, setRevealToken] = useState(0)
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') setRevealToken((n) => n + 1)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // What the last plan was computed for. Compared rather than counted, so the
  // effect can tell "the workflow on screen changed" (plan now) from "the
  // vault moved underneath it" (plan once it settles).
  const plannedForRef = useRef<string | null>(null)

  // Plan the workflow on screen. `planWorkflow` never writes, so this runs on
  // selection, again whenever the vault changes underneath it, and again on
  // every debounced keystroke while editing: the counts on the wires are only
  // worth reading if they answer for the text under the cursor.
  useEffect(() => {
    if (!active) {
      setPlanned(null)
      return
    }
    // Nothing is planned for a window nobody is looking at. Sync, an external
    // editor and the app's own watcher all keep rewriting the notes slice while
    // the app sits in the background, and each rewrite reached here as a fresh
    // burst of note-body reads for counts that were never on screen. The reveal
    // token above is what plans them when there is someone to read them.
    if (document.visibilityState === 'hidden') return

    let cancelled = false
    const id = active.workflow.id
    // The workflow's own text is what the author is watching change; the notes
    // slice is the vault moving on its own. Only the first is worth the round
    // trip immediately, and `previewText` has already coalesced the typing that
    // produces it.
    const planKey = `${id}\x00${planToken}\x00${revealToken}\x00${active.file.raw}`
    const immediate = plannedForRef.current !== planKey
    plannedForRef.current = planKey

    const run = (): void => {
      const reader = createVaultReader({
        notes,
        readBody: async (path) => (await window.zen.readNote(path)).body,
        current: () => activeNote
        // No `selection`: the app has no multi-note selection, and the engine
        // reports "not available in this context" rather than planning over an
        // empty set that looks like a real answer.
      })
      setPlanning(true)
      planWorkflow(active.workflow, {
        reader,
        now: Date.now(),
        resolve: (other) => byId.get(other) ?? null,
        systemFolderDirs: useStore.getState().vaultSettings.systemFolderPaths
      })
        .then((result) => {
          if (!cancelled) setPlanned({ id, plan: result })
        })
        .catch(() => {
          // A malformed file must never blank the canvas; the graph below still
          // renders from the parse, just without counts.
          if (!cancelled) setPlanned(null)
        })
        .finally(() => {
          if (!cancelled) setPlanning(false)
        })
    }

    const timer = setTimeout(run, immediate ? 0 : PLAN_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active, notes, activeNote, byId, planToken, revealToken])

  const plan = active && planned?.id === active.workflow.id ? planned.plan : null

  // The full template list `apply-template` resolves against. Merged rather
  // than raw custom files so an edited copy of a built-in shadows it here the
  // same way it does in the palette. Display prefs (hidden built-ins) do not
  // apply: resolution is a semantic question, not a picker.
  const templates = useMemo(() => mergeTemplates(BUILTIN_TEMPLATES, customTemplates), [customTemplates])

  const diagnostics = useMemo(() => {
    if (!active) return []
    return mergeDiagnostics(
      active.parseDiagnostics,
      validateWorkflow(active.workflow, byId),
      plan?.diagnostics ?? [],
      unknownTemplateDiagnostics(active.workflow, templates)
    )
  }, [active, byId, plan, templates])

  /**
   * Lines the parser counts from the body; the editor shows the whole file.
   *
   * Applied to every diagnostic so a line number always means "line N of the
   * file you are looking at", in the editor and in the read-only view alike.
   */
  const lineOffset = useMemo(
    () => bodyLineOffset(draftText ?? active?.file.raw ?? ''),
    [draftText, active]
  )

  /* ---------------------------------------------------------------------- */
  /*  What the completions know about this vault                            */
  /* ---------------------------------------------------------------------- */

  // Bare, exactly as `NoteMeta.tags` and `WorkflowNote.tags` carry them: the
  // parser strips the `#` when it binds a tag param, so the two vocabularies
  // already agree and adding the sigil here would break the match.
  const vaultTags = useMemo(() => {
    const seen = new Set<string>()
    for (const note of notes) for (const tag of note.tags) seen.add(tag)
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [notes])

  const vaultPaths = useMemo(() => notes.map((note) => note.path), [notes])

  /**
   * Frontmatter field names, taken from the notes this workflow actually
   * touched.
   *
   * `NoteMeta` carries no frontmatter (it is parsed out of the body, which the
   * store never loads), so the plan is the only place in the renderer where
   * real field names exist: any step with `needsBody` makes the engine read the
   * bodies, and the notes it puts on a wire come back with their frontmatter
   * attached. Suggesting a field nobody has ever written would be worse than
   * suggesting none, so this stays empty until the workflow has looked at a
   * body.
   */
  const vaultFields = useMemo(() => {
    const seen = new Set<string>()
    for (const set of Object.values(plan?.wires ?? {})) {
      for (const note of set) for (const field of Object.keys(note.frontmatter)) seen.add(field)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [plan])

  /**
   * Every folder a note lives in, ancestors included.
   *
   * Derived from the note paths rather than from the store's folder tree
   * because that is exactly what the engine sees: `WorkflowNote.folder` is the
   * vault-relative DIRECTORY, while `NoteMeta.folder` is the system bucket. A
   * combobox offering the bucket would suggest folders that match nothing.
   */
  const vaultFolders = useMemo(() => {
    const seen = new Set<string>()
    for (const note of notes) {
      const cut = note.path.lastIndexOf('/')
      if (cut === -1) continue
      let directory = note.path.slice(0, cut)
      while (directory !== '' && !seen.has(directory)) {
        seen.add(directory)
        const up = directory.lastIndexOf('/')
        directory = up === -1 ? '' : directory.slice(0, up)
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [notes])

  // A diagnostic carries a line, and a whole pipeline lives on one line, so a
  // bad step marks every step of its statement. Line is the finest grain the
  // engine reports, and marking the statement beats marking nothing.
  const worstByLine = useMemo(() => {
    const map = new Map<number, Diagnostic['severity']>()
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === 'error' || !map.has(diagnostic.line)) {
        map.set(diagnostic.line, diagnostic.severity)
      }
    }
    return map
  }, [diagnostics])

  /* ---------------------------------------------------------------------- */
  /*  Editing on the canvas                                                 */
  /* ---------------------------------------------------------------------- */

  /** Drop a layout write still waiting on its debounce, without writing it. */
  const cancelPendingLayoutWrite = useCallback((): void => {
    if (layoutWriteTimer.current !== undefined) {
      clearTimeout(layoutWriteTimer.current)
      layoutWriteTimer.current = undefined
    }
    pendingLayoutWrite.current = null
  }, [])

  /**
   * The workflow the canvas is editing, parsed from the text that is
   * authoritative right now.
   *
   * Deliberately NOT `active.workflow`: that one is a debounce behind whenever
   * text is being typed, and an edit computed from it would quietly revert
   * whatever was written in the meantime. Re-reading here is also what lets two
   * edits in the same tick compose, because the second sees what the first
   * produced.
   */
  const currentWorkflow = useCallback((): Workflow | null => {
    if (active === null) return null
    return parseWorkflow(draft?.text ?? active.file.raw, draft?.id ?? active.workflow.id).workflow
  }, [active, draft])

  /**
   * Apply a structural edit, and write the result back as text.
   *
   * The entire canvas editor is this function: parse, hand the workflow to one
   * of the `Workflow -> Workflow` editors, serialize, put the answer in the
   * draft. There is no separate canvas model to keep in step, which is why
   * switching to the text view cannot lose an edit made here and why a file
   * written by hand stays editable on the canvas.
   *
   * An edit lands in the DRAFT rather than on disk, exactly like typing does:
   * the same Save writes both, the same Cancel throws both away, and the same
   * "unsaved" badge tells the truth about both.
   *
   * Returns the workflow that was written, so a caller can select the node it
   * just created; null when nothing changed.
   */
  const applyEdit = useCallback(
    (
      mutate: (workflow: Workflow) => Workflow,
      remap: NodeIdRemap = IDENTITY_REMAP
    ): Workflow | null => {
      if (!canWrite || active === null) return null
      const id = draft?.id ?? active.workflow.id
      const base = draft?.text ?? active.file.raw
      const { workflow } = parseWorkflow(base, id)
      const edited = mutate(workflow)
      // The editors return the workflow they were given when they refuse an
      // edit (an argument the file cannot spell, a wire name already taken), so
      // identity is the signal that nothing happened. Checked before
      // serializing, because serializing is CANONICAL: a hand-aligned file
      // would otherwise be reformatted, and marked unsaved, by an edit that was
      // declined.
      if (edited === workflow) return null
      // Hand-placed positions are keyed by node id and an edit renumbers ids,
      // so they are carried across here rather than left to land on whichever
      // step slid into a vacated index. Ids that no longer name a step are
      // dropped at the same time, which is what stops a file accumulating
      // coordinates for steps nobody can see. A drag still sitting on the write
      // debounce is part of what is on screen, so it is folded in as well and
      // the file write it was waiting for is dropped: two writers for one file
      // is how a position gets lost.
      const live: string[] = []
      edited.statements.forEach((statement, s) =>
        statement.steps.forEach((_step, p) => live.push(`${s}:${p}`))
      )
      const next: Workflow = {
        ...edited,
        meta: withLayoutOverrides(
          edited.meta,
          pruneLayoutOverrides(remapOverrides(overrides, remap), live)
        )
      }
      const text = serializeWorkflow(next)
      if (text === base) return null
      cancelPendingLayoutWrite()
      draggedRef.current = null
      setDragged(null)
      setWriteError(null)
      setSelectedNodeId((current) => (current === null ? null : remap(current)))
      setDraft((current) =>
        current === null
          ? { id, sourcePath: active.file.sourcePath, text, saved: active.file.raw }
          : { ...current, text }
      )
      // Straight to the canvas rather than through the typing debounce: a click
      // whose result appears a sixth of a second later reads as one that missed.
      setPreviewText(text)
      return next
    },
    [active, canWrite, cancelPendingLayoutWrite, draft, overrides]
  )

  const insertStep = useCallback(
    (statementIndex: number, index: number, kind: string): void => {
      const written = applyEdit(
        (workflow) => addStep(workflow, { statement: statementIndex, index, kind }),
        afterStepInsert(statementIndex, index)
      )
      // The step just added is the one whose arguments still need filling in,
      // so the inspector moves to it rather than staying where it was.
      if (written !== null) setSelectedNodeId(`${statementIndex}:${index}`)
    },
    [applyEdit]
  )

  const startStatement = useCallback(
    (kind: string): void => {
      const written = applyEdit((workflow) =>
        // Named as it is created. An unnamed line with no output warns that
        // nothing reads its result, and the name is what the next line will be
        // dragged from anyway. `freshWireName` is what makes the name after the
        // source verb (`tag`, `tag2`) safe to use as a wire.
        addStatement(workflow, { kind, name: freshWireName(workflow, kind) })
      )
      // A statement with no input is appended, so it is the last one. Its only
      // step is the source that was just picked.
      if (written !== null) setSelectedNodeId(`${written.statements.length - 1}:0`)
    },
    [applyEdit]
  )

  const deleteNode = useCallback(
    (statementIndex: number, stepIndex: number): void => {
      const statement = currentWorkflow()?.statements[statementIndex]
      if (statement === undefined) return
      // Deleting the only step of a line deletes the line. A statement with no
      // steps left is a bare wire rename, which is not what "delete this box"
      // means to anyone looking at the canvas.
      const whole = statement.steps.length <= 1
      applyEdit(
        (workflow) =>
          whole
            ? removeStatement(workflow, statementIndex)
            : removeStep(workflow, { statement: statementIndex, index: stepIndex }),
        whole ? afterStatementRemove(statementIndex) : afterStepRemove(statementIndex, stepIndex)
      )
      setSelectedNodeId(null)
    },
    [applyEdit, currentWorkflow]
  )

  const moveNode = useCallback(
    (statementIndex: number, stepIndex: number, delta: number): void => {
      const statement = currentWorkflow()?.statements[statementIndex]
      if (statement === undefined) return
      const to = stepIndex + delta
      if (to < 0 || to >= statement.steps.length) return
      const written = applyEdit(
        (workflow) => moveStep(workflow, { statement: statementIndex, index: stepIndex }, to),
        afterStepMove(statementIndex)
      )
      if (written !== null) setSelectedNodeId(`${statementIndex}:${to}`)
    },
    [applyEdit, currentWorkflow]
  )

  const setArg = useCallback(
    (statementIndex: number, stepIndex: number, name: string, value: ArgValue): void => {
      applyEdit((workflow) =>
        setStepArg(workflow, { statement: statementIndex, index: stepIndex }, name, value)
      )
    },
    [applyEdit]
  )

  /**
   * Name, rename, or unname the wire a line produces.
   *
   * One call for all three, because `setStatementName` already routes a rename
   * through `renameWire` so every reader follows, and already refuses to drop a
   * name something still reads. Editing the label on a wire and renaming the
   * wire are the same act, and this is what keeps them one outcome.
   */
  const setWireName = useCallback(
    (statementIndex: number, next: string): void => {
      applyEdit((workflow) => setStatementName(workflow, statementIndex, next === '' ? null : next))
    },
    [applyEdit]
  )

  /** Which wire a line reads. Null is the disconnect: the line reads nothing. */
  const setInput = useCallback(
    (statementIndex: number, wire: string | null): void => {
      applyEdit((workflow) => setStatementInput(workflow, statementIndex, wire))
    },
    [applyEdit]
  )

  const openInsertPicker = useCallback(
    (statementIndex: number, index: number): void => {
      if (!canWrite) return
      const statement = currentWorkflow()?.statements[statementIndex]
      if (statement === undefined) return
      const defs = legalKindsAt(statement, index)
      if (defs.length === 0) return
      const before = index > 0 ? statement.steps[index - 1] : null
      const after = statement.steps[index]
      setPicker({
        title: before === null ? 'Add a step to this line' : `Add a step after \`${before.kind}\``,
        subtitle:
          after === undefined
            ? 'It goes at the end of the line, so it may end the line as well.'
            : `It goes in front of \`${after.kind}\`, so it cannot end the line.`,
        defs,
        onPick: (def) => insertStep(statementIndex, index, def.kind)
      })
    },
    [canWrite, currentWorkflow, insertStep]
  )

  /**
   * The same opener, with an identity that never changes.
   *
   * Every node on the canvas carries an insert callback, and React Flow rebuilds
   * every node whenever the `nodes` array does. `openInsertPicker` closes over
   * the draft text, which changes on every keystroke, so passing it straight
   * into the graph would re-lay-out and re-render the whole canvas once per
   * character typed in the text editor. Behind a ref it is the same function to
   * call and a stable one to depend on, and it is only ever invoked from a user
   * event, i.e. long after the effect that keeps it current has run.
   */
  const openInsertPickerRef = useRef(openInsertPicker)
  useEffect(() => {
    openInsertPickerRef.current = openInsertPicker
  }, [openInsertPicker])
  const requestInsert = useCallback((statementIndex: number, index: number): void => {
    openInsertPickerRef.current(statementIndex, index)
  }, [])

  const openNewStatementPicker = useCallback((): void => {
    if (!canWrite || active === null) return
    setPicker({
      title: 'Start a new line',
      subtitle: 'A line opens with a source: the set of notes every step after it works on.',
      defs: NODE_DEFS.filter((def) => def.source),
      onPick: (def) => startStatement(def.kind)
    })
  }, [active, canWrite, startStatement])

  /**
   * A wire dragged from one line to another: "this line reads that one".
   *
   * Both ends resolve to their STATEMENT rather than to the box the pointer
   * happened to touch, because a wire is what a whole line produces. The three
   * refusals are the three ways the drop cannot mean anything, and each says
   * which one it was: the language has no self-reference, a line that makes its
   * own notes has nothing to read, and a cycle is a workflow that never
   * finishes.
   */
  const onConnect = useCallback(
    (connection: Connection): void => {
      const from = parseNodeId(connection.source)
      const to = parseNodeId(connection.target)
      const workflow = currentWorkflow()
      if (workflow === null || from === null || to === null) return
      if (workflow.statements[from.statement] === undefined) return
      if (from.statement === to.statement) {
        setConnectError('A line cannot read the wire it produces.')
        return
      }
      const target = workflow.statements[to.statement]
      if (target === undefined) return
      const opener = target.steps.length > 0 ? nodeDef(target.steps[0].kind) : null
      if (opener?.source === true) {
        setConnectError(
          `That line starts from \`${opener.kind}\`, so it makes its own notes and cannot read a wire. Delete that step first.`
        )
        return
      }
      if (dependsOnStatement(workflow, from.statement, to.statement)) {
        setConnectError(
          'That would make the two lines feed each other, and a wire cannot depend on itself.'
        )
        return
      }
      setConnectError(null)
      applyEdit((current) => {
        const producer = current.statements[from.statement]
        if (producer === undefined) return current
        // A wire has to be named before anything can read it, so an unnamed
        // producer is named here rather than the drag being refused for a
        // reason the person dragging cannot act on. The name follows the step
        // that produces the set, which is what someone reading the file would
        // have called it.
        if (producer.name !== null) return setStatementInput(current, to.statement, producer.name)
        const seed = producer.steps[producer.steps.length - 1]?.kind ?? NEW_WIRE_BASE
        const name = freshWireName(current, seed)
        return setStatementInput(
          setStatementName(current, from.statement, name),
          to.statement,
          name
        )
      })
    },
    [applyEdit, currentWorkflow]
  )

  /**
   * Clicking a wire label is a request to rename that wire.
   *
   * The label names the line that PRODUCES the wire, so the click selects that
   * line's last step and puts the keyboard in its name field. Renaming there
   * goes through `renameWire`, so every reader follows the new name. Clearing
   * the field, or the "reads" select on the far end, is how a wire is
   * disconnected.
   */
  const onEdgeClick = useCallback(
    (_event: ReactMouseEvent, edge: Edge): void => {
      const from = parseNodeId(edge.source)
      const to = parseNodeId(edge.target)
      if (from === null || to === null || from.statement === to.statement) return
      const producer = currentWorkflow()?.statements[from.statement]
      if (producer === undefined || producer.steps.length === 0) return
      const nodeId = `${from.statement}:${producer.steps.length - 1}`
      setSelectedNodeId(nodeId)
      setWireFocus((current) => ({ nodeId, token: (current?.token ?? 0) + 1 }))
    },
    [currentWorkflow]
  )

  /**
   * May the graph be restructured here?
   *
   * Only writing matters. A drag has the extra condition that the file has to
   * be writable back in place (see `canDragNodes`), but a structural edit goes
   * through the draft and the ordinary Save, which knows how to move a file
   * whose name changed, so a hand-named workflow is editable like any other.
   */
  const canEditGraph = canWrite && active !== null

  const graph = useMemo(() => {
    if (!active) return { nodes: [] as StepNode[], edges: [] as Edge[] }
    const workflow = active.workflow
    const layout = layoutWorkflow(workflow)

    // Steps whose output already appears as a labelled wire downstream. Their
    // count is on that edge, so repeating it on the node would say the same
    // thing twice; a terminal statement has no such edge and gets the pill.
    const countedOnAnEdge = new Set(
      layout.edges.filter((edge) => edge.wire !== null).map((edge) => edge.from)
    )

    const nodes: StepNode[] = layout.nodes.map((node) => {
      const statement = workflow.statements[node.statement]
      const step = statement.steps[node.step]
      const def = nodeDef(step.kind)
      const last = node.step === statement.steps.length - 1
      const wire = last && !countedOnAnEdge.has(node.id) ? wireKeyOf(statement) : null
      const outSet = wire === null ? undefined : plan?.wires[wire]
      // A node someone moved keeps where they put it; every other node stays
      // auto-laid-out, which is what makes an override a correction to the
      // layout rather than a replacement for it. A stale id (the text above
      // this node was edited) simply misses, so the node falls back to its
      // computed spot instead of appearing somewhere that means nothing.
      const placed = overrides.get(node.id)
      return {
        id: node.id,
        type: 'workflowStep',
        // React Flow drags every SELECTED node together, so this is what makes
        // a group move as one. It reads the flag off the node rather than from
        // any state of its own.
        selected: selectedIdSet.has(node.id),
        // Copied, never the map's own object: React Flow keeps what it is given
        // and the map is compared against fresh drags.
        position: placed
          ? { x: placed.x, y: placed.y }
          : { x: node.column * COLUMN_WIDTH, y: node.row * ROW_HEIGHT },
        data: {
          label: stepLabel(step),
          category: def?.category ?? 'unknown',
          title: def?.title ?? `Unknown step \`${step.kind}\``,
          mutating: def?.mutating ?? false,
          severity: worstByLine.get(step.line) ?? null,
          line: step.line,
          outCount: outSet ? outSet.length : null,
          // Only name the wire when the author did; `#12` is an internal key.
          outWire: wire === null ? null : statement.name,
          isSelected: selectedIdSet.has(node.id),
          connectable: canEditGraph,
          // Absent rather than disabled where nothing may follow: a terminal
          // step ends the pipeline, and a `+` that explains itself only after
          // being pressed is worse than no `+` at all.
          onInsertAfter:
            canEditGraph && legalKindsAt(statement, node.step + 1).length > 0
              ? (): void => requestInsert(node.statement, node.step + 1)
              : null
        }
      }
    })

    const edges: Edge[] = layout.edges.map((edge, index) => {
      // `plan.wires[...]` is the NoteSet itself, so this must take its length.
      // Interpolating the array straight into the label renders the notes as
      // `[object Object],[object Object]` and destroys the one thing the edge
      // exists to show.
      const set = edge.wire === null ? undefined : plan?.wires[edge.wire]
      const count = set === undefined ? undefined : set.length
      return {
        id: `${edge.from}\x00${edge.to}\x00${edge.wire ?? ''}\x00${index}`,
        source: edge.from,
        target: edge.to,
        // The count on the wire is the feature: it turns a diagram into a
        // debugger, so it is rendered on the edge itself and not in a panel.
        label:
          edge.wire === null
            ? undefined
            : count === undefined
              ? edge.wire
              : `${edge.wire} · ${count}`,
        labelShowBg: true,
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 4,
        labelStyle: { fill: 'rgb(var(--z-fg))', fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: 'rgb(var(--z-bg-1))' },
        style: { stroke: 'rgb(var(--z-grey-dim))' },
        animated: false
      }
    })

    return { nodes, edges }
  }, [active, canEditGraph, overrides, plan, requestInsert, selectedIdSet, worstByLine])

  const summaries = useMemo(() => (plan ? summarizeOps(plan.ops) : []), [plan])

  /* ---------------------------------------------------------------------- */
  /*  The selected step                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * The step the inspector is describing, resolved against the workflow on
   * screen.
   *
   * Resolved rather than stored: an id whose statement or step no longer exists
   * (the text was edited, a line was deleted) resolves to null and the panel
   * closes, instead of the inspector describing a step nobody can see.
   */
  const selectedNode = useMemo(() => {
    if (active === null || selectedNodeId === null) return null
    const parsed = parseNodeId(selectedNodeId)
    if (parsed === null) return null
    const statement = active.workflow.statements[parsed.statement]
    const step = statement?.steps[parsed.step]
    if (statement === undefined || step === undefined) return null
    return { statementIndex: parsed.statement, stepIndex: parsed.step, statement, step }
  }, [active, selectedNodeId])

  /** Wire names this workflow defines, for the inspector's `wire` selects. */
  const activeWires = useMemo(
    () => (active === null ? [] : wireNamesOf(active.workflow)),
    [active]
  )

  /**
   * Wires the selected line could read without closing a loop.
   *
   * The same check the drag makes, offered ahead of time: a select that lists
   * only legal answers is the clearest possible statement of the rule.
   */
  const inputChoices = useMemo(() => {
    if (active === null || selectedNode === null) return []
    const workflow = active.workflow
    const out: string[] = []
    workflow.statements.forEach((statement, index) => {
      if (index === selectedNode.statementIndex || statement.name === null) return
      if (dependsOnStatement(workflow, index, selectedNode.statementIndex)) return
      out.push(statement.name)
    })
    return out
  }, [active, selectedNode])

  /** How many other lines read the selected line's wire. */
  const wireReaders = useMemo(() => {
    if (active === null || selectedNode === null) return 0
    const name = selectedNode.statement.name
    if (name === null) return 0
    let count = 0
    active.workflow.statements.forEach((statement, index) => {
      if (index === selectedNode.statementIndex) return
      if (statementInputs(active.workflow, index).includes(name)) count += 1
    })
    return count
  }, [active, selectedNode])

  const inspectorVocabulary = useMemo<InspectorVocabulary>(
    () => ({
      tags: vaultTags,
      fields: vaultFields,
      paths: vaultPaths,
      folders: vaultFolders,
      wires: activeWires,
      workflows: [...byId.keys()]
    }),
    [activeWires, byId, vaultFields, vaultFolders, vaultPaths, vaultTags]
  )

  /* ---------------------------------------------------------------------- */
  /*  Moved nodes                                                           */
  /* ---------------------------------------------------------------------- */

  /** Node ids that still exist, i.e. the ones an override may name. */
  const liveNodeIds = useMemo(() => graph.nodes.map((node) => node.id), [graph])

  /**
   * Write whatever layout is waiting on the debounce.
   *
   * Reads nothing but the stash, which is why it is safe to call from a timer,
   * from an explicit reset, and from unmount alike: by the time it runs, the
   * selection may have moved and this component may be gone, and neither
   * changes which file the drag belonged to.
   */
  const flushLayoutWrite = useCallback(async (): Promise<void> => {
    if (layoutWriteTimer.current !== undefined) {
      clearTimeout(layoutWriteTimer.current)
      layoutWriteTimer.current = undefined
    }
    const pending = pendingLayoutWrite.current
    pendingLayoutWrite.current = null
    if (pending === null) return
    try {
      // No `previousSourcePath`: the slug IS the file's own stem (checked by
      // `writesBackToItsOwnFile` before this was stashed), so the write lands
      // on the file it came from and a drag can never move, rename or fork a
      // workflow.
      const file = await window.zen.writeWorkflow({ slug: pending.slug, raw: pending.raw })
      // Spliced rather than re-listed. `writeWorkflow` hands back the file
      // exactly as `listWorkflows` would report it, and a directory read on
      // every drag would re-plan the vault for a change that cannot alter a
      // plan: coordinates are not part of the graph.
      setItems((current) =>
        current === null
          ? current
          : current.map((other) =>
              other.workflow.id === file.id ? loadWorkflowFile(file) : other
            )
      )
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  /**
   * Take the moved nodes as they stand and turn them into a change.
   *
   * Two destinations, because there are two kinds of "the workflow on screen".
   * With the editor open the file is not the truth, the textarea is, so a drag
   * is a TEXT edit: it rewrites the draft's frontmatter, shows up as unsaved
   * the moment the node is let go, and rides along with the author's own save.
   * Writing the file there would save text they never asked to save, which is
   * the one thing this view spends the rest of its code refusing to do.
   *
   * With the editor closed there is no draft to carry it, so the drag writes
   * the file itself, through the same `writeWorkflow` the Save button calls.
   * Only that half is debounced: nudging three boxes into place is one thought,
   * so it is one write.
   */
  const recordOverrides = useCallback(
    (id: string, map: LayoutOverrides, immediate: boolean): void => {
      if (!canWrite) return
      // Stale keys are dropped here rather than on read: a text edit that
      // removed a statement leaves its coordinate behind, and this is the next
      // write that can notice. Reading already ignores them, so this is only
      // about not accumulating coordinates for statements nobody can see.
      const next = pruneLayoutOverrides(map, liveNodeIds)

      if (draft !== null) {
        // The id check on every path: a record made over one workflow must
        // never be applied to another.
        if (id !== draft.id) return
        // Functional update, and derived from the CURRENT text: the frontmatter
        // is rewritten on top of whatever has been typed since the drag began.
        // Returning `current` unchanged is what keeps an identical rewrite from
        // marking a clean draft dirty.
        setDraft((current) => {
          if (current === null) return null
          const text = withLayoutOverridesText(current.text, next)
          return text === current.text ? current : { ...current, text }
        })
        return
      }

      const item = selected
      if (item === null || item.workflow.id !== id || !writesBackToItsOwnFile(item)) return
      const raw = withLayoutOverridesText(item.file.raw, next)
      if (layoutWriteTimer.current !== undefined) {
        clearTimeout(layoutWriteTimer.current)
        layoutWriteTimer.current = undefined
      }
      // Identical bytes mean the nodes ended where the file already said they
      // were, which is what a pixel of pointer drift produces. Not a write, and
      // it also retires an earlier drag in the same burst that has been undone
      // by this one.
      if (raw === item.file.raw) {
        pendingLayoutWrite.current = null
        return
      }
      pendingLayoutWrite.current = { slug: item.workflow.id, raw }
      if (immediate) {
        void flushLayoutWrite()
        return
      }
      layoutWriteTimer.current = setTimeout(() => {
        void flushLayoutWrite()
      }, LAYOUT_WRITE_DEBOUNCE_MS)
    },
    [canWrite, draft, flushLayoutWrite, liveNodeIds, selected]
  )

  const applyDrag = useCallback((id: string, map: LayoutOverrides): void => {
    const value = { id, map }
    draggedRef.current = value
    setDragged(value)
  }, [])

  /**
   * React Flow renders from the `nodes` prop, so a drag is only visible if the
   * position changes it reports come back as new positions.
   *
   * Position and SELECTION are handled. Dimensions are measured into React
   * Flow's own store and never needed the prop, so they stay unforwarded.
   *
   * Selection is forwarded because React Flow owns the gestures for it, and
   * those gestures are the feature: shift or ctrl clicking a second node, and
   * dragging a box across several. Consuming its select changes is what lets
   * one list of ids stay the only answer to "what is selected", rather than
   * this file guessing at modifier keys and disagreeing with the canvas. (#534)
   */
  const onNodesChange = useCallback(
    (changes: NodeChange<StepNode>[]): void => {
      const selections = changes.filter(
        (change): change is Extract<NodeChange<StepNode>, { type: 'select' }> =>
          change.type === 'select'
      )
      if (selections.length > 0) {
        setSelectedNodeIds((current) => {
          const next = new Set(current)
          for (const change of selections) {
            if (change.selected) next.add(change.id)
            else next.delete(change.id)
          }
          // Order follows the graph so the group reads top-to-bottom, and a
          // reference that did not change stays the same object.
          if (next.size === current.length && current.every((id) => next.has(id))) return current
          return Array.from(next)
        })
      }
      if (activeId === null) return
      // From the ref when it already describes this workflow, so a burst of
      // pointer moves accumulates instead of each one starting from the render
      // that happened to be committed.
      const current = draggedRef.current
      const base = current !== null && current.id === activeId ? current.map : overrides
      let next: LayoutOverrides | null = null
      for (const change of changes) {
        if (change.type !== 'position' || change.position === undefined) continue
        if (next === null) next = new Map(base)
        // Rounded during the drag and not only on the way out, so what is on
        // screen is byte-comparable with what is in the file and a drag that
        // ends where it started writes nothing.
        next.set(change.id, {
          x: Math.round(change.position.x),
          y: Math.round(change.position.y)
        })
      }
      if (next !== null) applyDrag(activeId, next)
    },
    [activeId, applyDrag, overrides]
  )

  const onNodeDragStop = useCallback((): void => {
    // From the ref, not from `overrides`: the drag's last position change and
    // this event arrive in one React batch, so the render that carries it has
    // not happened yet.
    const pending = draggedRef.current
    if (pending !== null) recordOverrides(pending.id, pending.map, false)
  }, [recordOverrides])

  /**
   * Back to computed positions, for every node.
   *
   * The escape hatch that makes dragging safe to try: whatever a canvas ends up
   * looking like, one click returns the workflow to a file with no coordinates
   * in it at all.
   */
  const resetLayout = useCallback((): void => {
    if (activeId === null) return
    // An empty map IS the change here, which is why it goes down the same path
    // a drag does: the write removes the key rather than adding one.
    const cleared: LayoutOverrides = new Map()
    applyDrag(activeId, cleared)
    // Explicit, so it writes now rather than on a debounce meant for a burst of
    // drags that is plainly over.
    recordOverrides(activeId, cleared, true)
  }, [activeId, applyDrag, recordOverrides])

  useEffect(() => {
    return () => {
      // A drag followed straight away by closing the view still has to reach
      // disk. The stash is self-contained, so the write does not need this
      // component to be mounted; only the state updates afterwards do, and
      // those are re-read from disk the next time the view opens.
      void flushLayoutWrite()
    }
  }, [flushLayoutWrite])

  // The half-typed `g` of a `g g` outlives the view otherwise: the timer that
  // retires it is the one timer in this file with nothing cancelling it, so
  // closing the tab mid-sequence left a callback holding this component's refs
  // for half a second. Everything else here is cleaned up on unmount; so is
  // this.
  useEffect(() => {
    return () => {
      if (gTimer.current !== undefined) clearTimeout(gTimer.current)
      gPending.current = 0
    }
  }, [])

  const openCursor = useCallback(() => {
    const item = list[cursor]
    if (item) setSelectedId(item.workflow.id)
  }, [list, cursor])

  const moveCursor = useCallback(
    (delta: number) => {
      if (list.length === 0) return
      setCursor((index) => Math.max(0, Math.min(list.length - 1, index + delta)))
    },
    [list.length]
  )

  /* ---------------------------------------------------------------------- */
  /*  Authoring                                                             */
  /* ---------------------------------------------------------------------- */

  const dirty = draft !== null && isWorkflowDraftDirty(draft.saved, draft.text)

  /**
   * The filename stem a workflow with this name would be saved under.
   *
   * The stem is the workflow id, so a name that slugs onto another workflow's
   * file takes the next free suffix rather than overwriting a file the author
   * never opened. One definition, used by the save and by the header that
   * promises what the save will do.
   */
  const slugFor = useCallback(
    (name: string): string => {
      const taken = list
        .filter((item) => item.file.sourcePath !== draftSourcePath)
        .map((item) => item.workflow.id)
      return uniqueWorkflowSlug(slugifyWorkflowName(name), taken)
    },
    [draftSourcePath, list]
  )

  /**
   * Write the draft to disk. Resolves true when the file now says what the
   * screen says.
   *
   * One function behind three callers: the autosave debounce, Cmd+S in the text
   * editor, and anything that is about to walk away from a canvas edit. They
   * differ only in WHEN they fire, which is the whole point of separating "is it
   * saved" from "may it run": a draft can be written as often as we like,
   * because a draft cannot do anything.
   */
  const saveDraft = useCallback(async (): Promise<boolean> => {
    if (draft === null) return true
    // Nothing this function can do about either: a read-only workspace has
    // nowhere to write, and a write already in flight owns the file until it
    // lands. Both answer no, so a caller that was about to walk away from the
    // edit stays put for a moment instead of dropping it.
    if (!canWrite || saving) return false
    setSaving(true)
    setWriteError(null)
    const written = draft.text
    try {
      const raw = workflowFileText(written)
      // The filename follows the NAME in the frontmatter: renaming a workflow
      // in the text is how its file is renamed, and `previousSourcePath` is
      // what makes that a move rather than a second copy left behind. Parsed
      // from the live text, not the debounced preview, so a save that lands
      // within a keystroke of a rename still uses the name that was typed.
      const { workflow } = parseWorkflow(raw, draft.id)
      const input: WriteWorkflowInput = { slug: slugFor(workflow.name), raw }
      if (draft.sourcePath !== null) input.previousSourcePath = draft.sourcePath
      const file = await window.zen.writeWorkflow(input)
      // Functional update, and only of the identity: typing continues during
      // the write, and replacing `text` here would undo whatever was typed
      // while the file was in flight.
      setDraft((current) => {
        if (current === null) return null
        const next = { ...current, id: file.id, sourcePath: file.sourcePath, saved: written }
        // Editing on the canvas has no reason to keep a draft open once it is
        // on disk: the file is the truth again and Run works against a file.
        // The text editor does keep its session, because Cmd+S mid-sentence is
        // a save, not a farewell.
        return textMode || isWorkflowDraftDirty(written, next.text) ? next : null
      })
      // Re-list: the left column shows the name and description straight from
      // the file, and this edit may have changed both.
      const loaded = await refresh()
      setSelectedId(file.id)
      const index = loaded.findIndex((item) => item.workflow.id === file.id)
      if (index >= 0) setCursor(index)
      return true
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setSaving(false)
    }
  }, [canWrite, draft, refresh, saving, slugFor, textMode])

  /**
   * Settle the open draft before the caller walks away from it.
   *
   * Resolves true when there is nothing left in memory that the file does not
   * already say. A CANVAS edit is not a question: it has autosaved, or it is
   * about to, so leaving simply flushes it and the debounce stays invisible.
   * The only refusal is a write that FAILED, where the error banner is on
   * screen and moving on would drop the edit silently.
   *
   * Text is the exception, and deliberately the same exception as everywhere
   * else in this feature: a half-typed pipeline is a real intermediate state, so
   * it is saved when the author says so and discarding it is a question.
   */
  const confirmLeaveDraft = useCallback(async (): Promise<boolean> => {
    if (draft === null || !isWorkflowDraftDirty(draft.saved, draft.text)) return true
    if (!textMode) return saveDraft()
    return confirmApp({
      title: 'Discard unsaved changes?',
      description:
        draft.sourcePath === null
          ? 'This new workflow has never been written to your vault.'
          : `${draft.sourcePath} has edits that were never saved.`,
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      danger: true
    })
  }, [draft, saveDraft, textMode])

  /**
   * Write what the canvas changed, once the changes stop coming.
   *
   * Only outside the text editor. Autosaving a textarea would write a
   * half-finished line on every keystroke, churning the file and the graph for
   * an intermediate state the author has not finished expressing; every other
   * edit in this view is a completed act (a step added, an argument chosen, a
   * node moved) and has nothing to be half of.
   */
  useEffect(() => {
    if (draft === null || textMode || !canWrite || saving) return
    if (!isWorkflowDraftDirty(draft.saved, draft.text)) return
    // Text that has already failed to write is not tried again on its own. The
    // error is on screen, the edit is still in front of the author, and a
    // background retry every few hundred milliseconds would be a busy loop
    // against a disk that has already said no. Editing anything clears it,
    // because the block is the text itself.
    if (autosaveBlocked.current === draft.text) return
    const attempted = draft.text
    const timer = setTimeout(() => {
      void saveDraft().then((ok) => {
        autosaveBlocked.current = ok ? null : attempted
      })
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [canWrite, draft, saveDraft, saving, textMode])

  /* ---------------------------------------------------------------------- */
  /*  Draft and active                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * The workflow as the SCREEN shows it: the draft when one is open on this
   * file, the file otherwise.
   *
   * Only the surfaces describing what is in front of the user ask this. The
   * list column deliberately does not: every field it shows (name, description,
   * trigger) has always come from the file, and its `editing` marker is what
   * says the screen holds something newer.
   */
  const shownWorkflow = useCallback(
    (item: LoadedWorkflow): Workflow =>
      editing !== null && draft !== null && draft.sourcePath === item.file.sourcePath
        ? editing.workflow
        : item.workflow,
    [draft, editing]
  )

  /**
   * Record a workflow as draft or active.
   *
   * Two destinations, for the same reason a node drag has two (see
   * `recordOverrides`): with an edit open, the draft is the truth and the file
   * is not, so the status goes into the draft text and rides along with the
   * autosave. Writing the file underneath an open draft would be a second
   * writer for one file, and the next save would silently undo the flip.
   *
   * The write is SURGERY on the frontmatter, never a re-serialization: flipping
   * a switch may not reformat a file someone hand-aligned.
   */
  const setWorkflowStatus = useCallback(
    async (item: LoadedWorkflow, status: WorkflowStatus): Promise<void> => {
      if (!canWrite) return

      if (draft !== null && draft.sourcePath === item.file.sourcePath) {
        const text = withWorkflowStatusText(draft.text, status)
        if (text === draft.text) return
        setWriteError(null)
        setDraft((current) => (current === null ? null : { ...current, text }))
        // Straight to the canvas rather than through the typing debounce: a
        // badge that answers a sixth of a second later reads as one that missed.
        setPreviewText(text)
        return
      }

      const raw = withWorkflowStatusText(item.file.raw, status)
      if (raw === item.file.raw) return
      // Written back in place wherever the file's own stem is what a write would
      // produce. A hand-named file (`Reading Log.md`) cannot be, so it moves to
      // its slug exactly as saving it would, rather than being forked into a
      // second copy that disagrees with the first.
      const slug = writesBackToItsOwnFile(item)
        ? item.workflow.id
        : uniqueWorkflowSlug(
            slugifyWorkflowName(item.workflow.name),
            list
              .filter((other) => other.file.sourcePath !== item.file.sourcePath)
              .map((other) => other.workflow.id)
          )
      const input: WriteWorkflowInput = { slug, raw }
      if (slug !== item.workflow.id) input.previousSourcePath = item.file.sourcePath
      setStatusPending(true)
      try {
        const file = await window.zen.writeWorkflow(input)
        setWriteError(null)
        // Re-listed rather than spliced, unlike a layout write: this is the one
        // write that changes which GROUP a row belongs to, and the group order
        // is decided when the list is loaded.
        const loaded = await refresh()
        setSelectedId((current) => (current === item.workflow.id ? file.id : current))
        const index = loaded.findIndex((other) => other.workflow.id === file.id)
        if (index >= 0) setCursor(index)
      } catch (err) {
        setWriteError(err instanceof Error ? err.message : String(err))
      } finally {
        setStatusPending(false)
      }
    },
    [canWrite, draft, list, refresh]
  )

  /**
   * Flip a workflow, with the friction on the consequential side only.
   *
   * Activating a workflow that WRITES asks first, and names what it writes in
   * the registry's own words, because that is the moment someone hands a
   * pipeline permission to change their notes. Activating a read-only workflow
   * asks nothing, and DEACTIVATING never asks at all: taking permission away
   * cannot cost anyone anything, and a dialog in front of it would only teach
   * people to click through dialogs.
   *
   * `current` is the status the caller DISPLAYED, so the flip always goes the
   * way the thing that was pressed said it would.
   */
  const toggleWorkflowStatus = useCallback(
    async (item: LoadedWorkflow, current: WorkflowStatus): Promise<void> => {
      if (!canWrite || statusPending) return
      if (current === 'active') {
        await setWorkflowStatus(item, 'draft')
        return
      }
      const workflow = shownWorkflow(item)
      const writes = summarizeWorkflowWrites(workflow)
      if (writes.length > 0) {
        const ok = await confirmApp({
          title: activateConfirmTitle(workflow.name),
          description: activateConfirmDescription(writes),
          confirmLabel: 'Activate',
          cancelLabel: 'Keep it a draft'
        })
        listRef.current?.focus()
        if (!ok) return
      }
      await setWorkflowStatus(item, 'active')
    },
    [canWrite, setWorkflowStatus, shownWorkflow, statusPending]
  )

  /**
   * Show the text editor over whatever the canvas is already editing.
   *
   * Nothing is converted on the way in, because there is nothing to convert:
   * every canvas edit has already been serialized into this same draft text.
   * The one thing that has NOT reached the text is a node drag still sitting on
   * the write debounce, so it is folded in here and the file write it was
   * waiting for is dropped. Otherwise that write would land on the file a
   * moment after the draft was opened from it, and the drag would be lost the
   * first time the draft was saved.
   */
  const revealText = useCallback((): void => {
    if (!canWrite || active === null) return
    if (draft === null) {
      const item = selected
      if (item === null) return
      cancelPendingLayoutWrite()
      const text = withLayoutOverridesText(item.file.raw, overrides)
      draggedRef.current = null
      setDragged(null)
      setWriteError(null)
      setDraft({
        id: item.workflow.id,
        sourcePath: item.file.sourcePath,
        text,
        saved: item.file.raw
      })
      // Seeded here as well as on the debounce so the first frame of the editor
      // shows this workflow rather than the previous one for 150ms.
      setPreviewText(text)
    }
    setTextMode(true)
    setEditSession((n) => n + 1)
  }, [active, canWrite, cancelPendingLayoutWrite, draft, overrides, selected])

  /**
   * Back to the canvas, without closing the draft.
   *
   * `previewText` is pushed forward rather than left to the typing debounce:
   * the graph is the thing being returned to, so it has to answer for the last
   * keystroke immediately. That IS the reparse; nothing else is needed, because
   * the text was the only representation either surface was editing.
   */
  const hideText = useCallback((): void => {
    if (draft !== null) setPreviewText(draft.text)
    setTextMode(false)
    listRef.current?.focus()
  }, [draft])

  const editWorkflow = useCallback(
    async (item: LoadedWorkflow | null): Promise<void> => {
      if (!item || !canWrite) return
      // Already editing this one: this is a request for the text, not a request
      // to reopen the file and throw away what has been done to it.
      if (draft !== null && draft.sourcePath === item.file.sourcePath) {
        revealText()
        return
      }
      if (!(await confirmLeaveDraft())) return
      setWriteError(null)
      setDraft({
        id: item.workflow.id,
        sourcePath: item.file.sourcePath,
        text: item.file.raw,
        saved: item.file.raw
      })
      setPreviewText(item.file.raw)
      setSelectedId(item.workflow.id)
      setTextMode(true)
      setEditSession((n) => n + 1)
    },
    [canWrite, confirmLeaveDraft, draft, revealText]
  )

  /**
   * Write a brand-new workflow to the vault, and land on it, on the canvas.
   *
   * Creating WRITES. A note is created by writing the file and then editing it,
   * and a workflow is now created the same way: there is no such thing as a
   * workflow you made but have not saved, so there is nothing to lose by
   * clicking the wrong thing next, nothing to explain about a row that is not
   * in the list yet, and no second "unsaved new file" model for every other
   * path here to reason about. Editing from here is editing a saved file, with
   * exactly the Save and Cancel that editing any other workflow has.
   *
   * Cancel therefore keeps its one meaning, "put the file back the way it was
   * on disk", rather than gaining a second one for the first few seconds of a
   * workflow's life. Nothing is silently left behind either: what a create
   * leaves behind is a named row in the list, and Delete is how a row goes.
   *
   * The canvas, not the text, because the canvas is the editor. The gallery
   * already asked about unsaved text before it opened, so this asks nothing.
   *
   * Everything created here arrives as a DRAFT, whichever door it came through:
   * a blank starter, a recipe from the gallery, or a file someone was sent. A
   * workflow you have not read yet is not one you have agreed to let loose on
   * your notes, and forcing it in one place is what makes that true of doors
   * added later as well.
   */
  const createWorkflow = useCallback(
    // Resolves to the write error, or null once the workflow really is in the
    // list. The gallery doors ignore the answer (the error banner is enough
    // feedback there); the import door must not, because it follows up with a
    // success toast that would otherwise fire over a failed write.
    async (slug: string, text: string): Promise<string | null> => {
      if (!canWrite) return 'This vault is read-only here.'
      try {
        const file = await window.zen.writeWorkflow({
          slug,
          raw: withWorkflowStatusText(workflowFileText(text), 'draft')
        })
        setWriteError(null)
        // No draft: the file IS the workflow now, so the header shows Run and
        // Delete rather than Save and Cancel over text nobody typed.
        setDraft(null)
        setTextMode(false)
        // Open on the first step, so a new workflow arrives as something to
        // configure rather than a picture to look at. Guarded by the parse,
        // because a preset with no statements would name a node that is not
        // on the canvas and leave the inspector describing nothing.
        const { workflow } = parseWorkflow(file.raw, file.id)
        const hasFirstStep = (workflow.statements[0]?.steps.length ?? 0) > 0
        pendingNodeId.current = hasFirstStep ? FIRST_NODE_ID : null
        const loaded = await refresh()
        setSelectedId(file.id)
        const index = loaded.findIndex((item) => item.workflow.id === file.id)
        if (index >= 0) setCursor(index)
        // The gallery had the keyboard; the list is what the keys mean now.
        listRef.current?.focus()
        return null
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setWriteError(message)
        return message
      }
    },
    [canWrite, refresh]
  )

  /**
   * The blank end of the gallery: the starter file, written and opened.
   *
   * The starter is a WORKING workflow (see `starterWorkflowText`), which is
   * what lets it land on the canvas as a source step wired to a terminal one
   * instead of an empty grid with nothing to click.
   */
  const createBlankWorkflow = useCallback(async (): Promise<void> => {
    if (!canWrite) return
    // Unique among the ids already on disk, so a second "New workflow" is
    // called "New workflow 2" and filed under its own stem rather than
    // overwriting the first.
    const created = newWorkflowDraft(list.map((item) => item.workflow.id))
    await createWorkflow(created.slug, created.text)
  }, [canWrite, createWorkflow, list])

  /**
   * Take a recipe and write it as a new workflow.
   *
   * The preset's own text is what lands in the vault, unedited except for its
   * name: a recipe teaches by being a working workflow you can read, and a
   * "personalized" version of it would be a second thing to keep correct. The
   * name is the exception, because the filename stem is derived from it: taking
   * the same recipe twice has to produce two names as well as two files, or the
   * list shows two rows nobody can tell apart.
   */
  const createFromPreset = useCallback(
    async (preset: WorkflowPreset): Promise<void> => {
      if (!canWrite) return
      // Parsed from the raw file rather than read off `preset.name`, because the
      // frontmatter is what the write will slugify.
      const name = parseWorkflow(preset.raw, preset.id).workflow.name
      const base = slugifyWorkflowName(name)
      const slug = uniqueWorkflowSlug(
        base,
        list.map((item) => item.workflow.id)
      )
      const text =
        slug === base
          ? preset.raw
          : renameWorkflowText(preset.raw, `${name} ${slug.slice(base.length + 1)}`)
      await createWorkflow(slug, text)
    },
    [canWrite, createWorkflow, list]
  )

  /**
   * Creating a workflow starts with a gallery, not a blank file.
   *
   * The question this feature kept failing was "how do I create one", and the
   * honest answer is "pick something that already works and change it". The
   * unsaved-text guard runs HERE rather than on each entry, so browsing the
   * recipes asks once and picking one never asks again.
   */
  const openGallery = useCallback(async (): Promise<void> => {
    if (!canWrite) return
    if (!(await confirmLeaveDraft())) return
    setGalleryOpen(true)
  }, [canWrite, confirmLeaveDraft])

  const closeGallery = useCallback((): void => {
    setGalleryOpen(false)
    // The gallery took the keyboard; give it back rather than stranding focus
    // on a modal that just unmounted.
    listRef.current?.focus()
  }, [])

  /* ---------------------------------------------------------------------- */
  /*  Completions                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Work out what could be written at the caret, and where to draw it.
   *
   * Reads the textarea rather than React state on purpose: this runs from
   * `onChange`, from key-ups, from clicks and from the effect that lands a
   * spliced completion, and in three of those four the DOM is already a
   * keystroke ahead of the state. The element is the only thing that always
   * knows both the text and the caret at the same instant.
   */
  const refreshSuggest = useCallback(
    (trigger: SuggestTrigger): void => {
      const el = editorRef.current
      if (el === null) return
      if (suggestOff.current) {
        setSuggest(null)
        return
      }
      const text = el.value
      const offset = el.selectionStart
      // A selection is not a caret. Completing over one would replace text the
      // author deliberately highlighted.
      if (offset !== el.selectionEnd) {
        setSuggest(null)
        return
      }
      const result = suggestAt({
        text,
        offset,
        // The one bit of state `suggestAt` cannot work out for itself: whether
        // this keystroke was a question. Over an empty prefix it decides between
        // the whole vocabulary and nothing at all.
        explicit: trigger === 'explicit',
        // Live from the text: the parsed workflow is a debounce behind, so a wire
        // named a moment ago would not be offerable yet.
        wires: wireNamesIn(text, bodyLineOffset(text)),
        tags: vaultTags,
        fields: vaultFields,
        paths: vaultPaths
      })
      // No matches closes the popup rather than showing an empty box, which is
      // also how "the caret left the token" ends up handled: the prefix goes
      // empty, a `typed` refresh returns nothing, and the popup goes away.
      if (result.items.length === 0) {
        setSuggest(null)
        return
      }
      // Remembered so a scroll can redraw the popup without changing its mind
      // about why it is open: an explicit list must survive being moved.
      suggestTrigger.current = trigger
      setSuggest({
        from: result.from,
        to: result.to,
        items: result.items,
        anchor: suggestAnchor(el, offset)
      })
      // The best match is always the one under the keyboard. A list that
      // refilters under a stale index is how you accept something you never saw.
      setSuggestIndex(0)
    },
    [vaultFields, vaultPaths, vaultTags]
  )

  /** Refilter an OPEN popup after the caret or the text moved under it. */
  const followSuggest = useCallback((): void => {
    // Never opens one: a caret arriving somewhere is not a request, which is the
    // whole complaint about how this behaved before.
    if (suggest === null) return
    refreshSuggest('typed')
  }, [refreshSuggest, suggest])

  const dismissSuggest = useCallback((): void => {
    suggestOff.current = true
    setSuggest(null)
  }, [])

  /**
   * Put text where the caret is, and leave the caret after it.
   *
   * One splice for both writers: an accepted completion (which replaces the
   * range it was computed for) and a step clicked out of the reference (which
   * replaces the selection, or nothing). Neither may touch the file: this is a
   * text edit on the draft, and it shows as unsaved like any other.
   */
  const spliceIntoDraft = useCallback((from: number, to: number, insert: string): void => {
    const el = editorRef.current
    if (el === null) return
    const text = el.value
    const next = `${text.slice(0, from)}${insert}${text.slice(to)}`
    const caret = from + insert.length
    suggestOff.current = false
    // A completion that ends in a space (`trigger: `) has put the caret in a new
    // slot; one that ends in a word has finished the word. Only the first is
    // worth asking about again.
    pendingChain.current = insert.endsWith(' ')
    setSuggest(null)
    // Accepting a completion for what was already typed changes no text, so
    // there is no re-render to land the caret in: it moves now, and nothing is
    // left pending for the next unrelated edit to pick up.
    if (next === text) {
      el.focus()
      el.setSelectionRange(caret, caret)
      return
    }
    pendingCaret.current = caret
    setDraft((current) => (current === null ? null : { ...current, text: next }))
  }, [])

  const acceptSuggestion = useCallback(
    (item: Suggestion): void => {
      if (suggest === null) return
      spliceIntoDraft(suggest.from, suggest.to, item.insert)
    },
    [spliceIntoDraft, suggest]
  )

  /** Insert a step from the reference panel at the caret, or at the very end. */
  const insertAtCaret = useCallback(
    (snippet: string): void => {
      const el = editorRef.current
      if (el === null) return
      spliceIntoDraft(el.selectionStart, el.selectionEnd, snippet)
    },
    [spliceIntoDraft]
  )

  /**
   * Throw the edit away and go back to the file, canvas edits included.
   *
   * One button for both surfaces, because there is one draft behind both: an
   * afternoon of rewiring on the canvas is discarded by the same Cancel that
   * discards a mistyped line, and asked about by the same confirm.
   */
  const closeEditor = useCallback(async (): Promise<void> => {
    if (draft === null) return
    if (!(await confirmLeaveDraft())) return
    setDraft(null)
    setTextMode(false)
    setWriteError(null)
  }, [confirmLeaveDraft, draft])

  const removeWorkflow = useCallback(
    async (item: LoadedWorkflow): Promise<void> => {
      if (!canDelete) return
      const ok = await confirmApp({
        title: `Delete "${item.workflow.name}"?`,
        description: `${item.file.sourcePath} is removed from your vault. This cannot be undone.`,
        confirmLabel: 'Delete workflow',
        danger: true
      })
      listRef.current?.focus()
      if (!ok) return
      const removedAt = list.findIndex((other) => other.file.sourcePath === item.file.sourcePath)
      try {
        await window.zen.deleteWorkflow(item.file.sourcePath)
      } catch (err) {
        setWriteError(err instanceof Error ? err.message : String(err))
        return
      }
      // Editing the file that just went away: the draft has nothing to save
      // back to, so the editor closes rather than writing the file again.
      if (draft?.sourcePath === item.file.sourcePath) {
        setDraft(null)
        setTextMode(false)
      }
      const loaded = await refresh()
      // The row that slid up into the same index takes the selection, so a run
      // of deletions keeps working without moving the hands.
      const index = Math.max(0, Math.min(removedAt === -1 ? cursor : removedAt, loaded.length - 1))
      setCursor(index)
      setSelectedId(loaded.length === 0 ? null : loaded[index].workflow.id)
    },
    [canDelete, cursor, draft, list, refresh]
  )

  /**
   * Copy a workflow to a new file, and land on the copy.
   *
   * The stem is the workflow id, so the copy is filed under the next free slug
   * and RENAMED to match. Two rows called "Reading log" over two different files
   * would be indistinguishable in the list, and the pair would disagree the
   * moment either one was saved: the save derives the filename from the name.
   * That is the same rule the gallery follows when a recipe is taken twice.
   *
   * The base stem is treated as taken whatever the list says, so a workflow read
   * out of a hand-named file (`Reading Log.md`, whose id is not a slug) still
   * copies to a free name instead of overwriting a file nobody opened.
   */
  const duplicateWorkflow = useCallback(
    async (item: LoadedWorkflow): Promise<void> => {
      if (!canWrite) return
      // Landing on the copy leaves whatever is open, so it asks exactly as
      // clicking another row does: a duplicate is never worth losing text for.
      if (!(await confirmLeaveDraft())) return
      const base = slugifyWorkflowName(item.workflow.name)
      const taken = new Set(list.map((other) => other.workflow.id))
      taken.add(base)
      const slug = uniqueWorkflowSlug(base, taken)
      const name = `${item.workflow.name} ${slug.slice(base.length + 1)}`
      try {
        const file = await window.zen.writeWorkflow({
          slug,
          raw: renameWorkflowText(item.file.raw, name)
        })
        setWriteError(null)
        setDraft(null)
        setTextMode(false)
        const loaded = await refresh()
        setSelectedId(file.id)
        const index = loaded.findIndex((other) => other.workflow.id === file.id)
        if (index >= 0) setCursor(index)
      } catch (err) {
        setWriteError(err instanceof Error ? err.message : String(err))
      }
    },
    [canWrite, confirmLeaveDraft, list, refresh]
  )

  /* ---------------------------------------------------------------------- */
  /*  Sharing                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Put a workflow on the clipboard, exactly as it sits on disk.
   *
   * This is the one that makes sharing actually work: a workflow is a text
   * file, so pasting it into a message, a gist or an issue IS distribution, and
   * the person on the other end pastes it back. No bundle, no archive, nothing
   * that needs this app at both ends.
   *
   * The FILE, not the draft: what someone receives has to be a thing that
   * exists, and unsaved text is not one.
   */
  const copyWorkflow = useCallback(
    async (item: LoadedWorkflow): Promise<void> => {
      try {
        await navigator.clipboard.writeText(item.file.raw)
        addToast('Workflow copied. Paste it anywhere as text.', 'success')
      } catch (err) {
        setWriteError(
          `Could not copy this workflow: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    [addToast]
  )

  /**
   * Save a copy of the file through a native save dialog.
   *
   * Desktop only, and absent rather than disabled elsewhere: a web workspace has
   * no filesystem to save into, and a control that explains that after being
   * pressed is worse than one that is not there. The clipboard entry beside it
   * is the answer in those workspaces.
   */
  const exportWorkflowToFile = useCallback(
    async (item: LoadedWorkflow): Promise<void> => {
      if (!canExportFile) return
      try {
        const saved = await window.zen.exportWorkflow?.({
          suggestedName: workflowExportFilename(item.workflow.id),
          raw: item.file.raw
        })
        // Null is a cancelled dialog, which is an answer rather than a failure.
        if (!saved) return
        addToast(
          'Workflow exported.',
          'success',
          typeof window.zen.revealFilePath === 'function'
            ? { label: 'Show in folder', onClick: () => void window.zen.revealFilePath(saved) }
            : undefined
        )
      } catch (err) {
        setWriteError(
          `Could not export this workflow: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    [addToast, canExportFile]
  )

  /**
   * Review a workflow that arrived from outside. Writes NOTHING.
   *
   * Both import sources land here, so there is one place where an outside file
   * becomes a decision and exactly one set of rules behind it. The slug is
   * resolved first, against both the ids in the vault and the stems they would
   * be written under, so the file that gets created cannot be one the user
   * already has: an import may add a workflow, never replace one.
   *
   * The name follows the same rule Duplicate does, because the filename stem is
   * derived from the name: a second copy of a recipe has to be *called*
   * something else too, or the list shows two rows nobody can tell apart.
   */
  const beginImport = useCallback(
    async (raw: string, fallbackId: string, source: string): Promise<void> => {
      if (!canWrite) return
      // Landing on the imported workflow leaves whatever is open, so it asks
      // exactly as clicking another row does.
      if (!(await confirmLeaveDraft())) return
      // Parsed once here for its name only: the frontmatter is what decides the
      // filename, the same way it does for a recipe from the gallery.
      const named = parseWorkflow(raw, fallbackId).workflow
      const base = slugifyWorkflowName(named.name)
      const taken = new Set<string>()
      for (const other of list) {
        taken.add(other.workflow.id)
        // A hand-named file (`Reading Log.md`) has an id that is not a slug, and
        // its stem is what a write would collide with, so both are claimed.
        taken.add(slugifyWorkflowName(other.workflow.id))
      }
      const slug = uniqueWorkflowSlug(base, taken)
      const name = slug === base ? null : `${named.name} ${slug.slice(base.length + 1)}`
      const others = new Map(list.map((other) => [other.workflow.id, other.workflow]))
      const takenKeys = list
        .map((other) => other.workflow.key)
        .filter((key): key is string => key !== undefined)
      const review = reviewWorkflowImport({
        raw,
        id: slug,
        ...(name === null ? {} : { name }),
        others,
        takenKeys
      })
      setWriteError(null)
      setPendingImport({ source, slug, review })
    },
    [canWrite, confirmLeaveDraft, list]
  )

  /** The clipboard half of import: what someone was sent in a chat message. */
  const pasteWorkflow = useCallback(async (): Promise<void> => {
    if (!canWrite) return
    let text = ''
    try {
      text = (await navigator.clipboard?.readText()) ?? ''
    } catch (err) {
      setWriteError(
        `Could not read the clipboard: ${err instanceof Error ? err.message : String(err)}`
      )
      return
    }
    if (text.trim() === '') {
      setWriteError('There is no text on your clipboard to import.')
      return
    }
    // `imported-workflow` is only the fallback id for a file whose frontmatter
    // never named itself; a named one is filed under its own name.
    await beginImport(text, 'imported-workflow', 'the clipboard')
  }, [beginImport, canWrite])

  /** The file half of import: a `.md` someone downloaded. */
  const importWorkflowFromFile = useCallback(async (): Promise<void> => {
    if (!canImportFile) return
    try {
      const file = await window.zen.importWorkflowFile?.()
      // A cancelled dialog, which is not an error and gets no message.
      if (!file) return
      await beginImport(file.raw, file.name, `${file.name}.md`)
    } catch (err) {
      setWriteError(
        `Could not read that file: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }, [beginImport, canImportFile])

  /**
   * Accept a reviewed import: write it, select it, and stop there.
   *
   * Through `createWorkflow`, the same path the gallery uses, so an imported
   * workflow lands on the canvas as a saved DRAFT like every other create. It
   * does NOT run, and nothing here offers to: the user activates it and presses
   * Run, always.
   */
  const acceptImport = useCallback(async (): Promise<void> => {
    const pending = pendingImport
    if (pending === null || !pending.review.ok || pending.review.text === null) return
    setImporting(true)
    try {
      const failure = await createWorkflow(pending.slug, pending.review.text)
      if (failure !== null) {
        // The dialog stays open: nothing was imported, so there is nothing to
        // review "later", and closing over an error toast would leave the two
        // messages disagreeing about what just happened.
        addToast(`Could not import "${pending.review.name}": ${failure}`, 'error')
        return
      }
      setPendingImport(null)
      addToast(
        `Imported "${pending.review.name}" as a draft. Activate it when you want to run it.`,
        'success'
      )
    } finally {
      setImporting(false)
    }
  }, [addToast, createWorkflow, pendingImport])

  const cancelImport = useCallback((): void => {
    setPendingImport(null)
    // The dialog took the keyboard; give it back rather than stranding focus on
    // a modal that just unmounted.
    listRef.current?.focus()
  }, [])

  const selectRow = useCallback(
    async (index: number): Promise<void> => {
      const item = list[index]
      if (!item) return
      // Clicking the row already open in the editor is not a request to leave
      // it, so it moves the cursor and nothing else.
      if (draft !== null && draft.sourcePath === item.file.sourcePath) {
        setCursor(index)
        return
      }
      // Clicking any other workflow does leave the editor, so it goes through
      // the same guard as Escape: unsaved text is never dropped silently.
      if (!(await confirmLeaveDraft())) return
      setDraft(null)
      setTextMode(false)
      setCursor(index)
      setSelectedId(item.workflow.id)
    },
    [confirmLeaveDraft, draft, list]
  )

  /**
   * Point the view at the row a right-click landed on, asking nothing.
   *
   * A right-click is aim, not navigation: it says "this one", and the menu it
   * opens has to appear whatever else is going on. `selectRow` cannot do the
   * job, because leaving unsaved text is a QUESTION, and a question cannot be
   * asked in the same tick as a menu: the confirm took the screen while the
   * menu sat pending behind it, and the right-click read as having done
   * nothing at all.
   *
   * So this moves what it can move for free. The cursor always follows the
   * pointer, because that is what the keyboard reads next; the selection
   * follows too, unless following it would cost unsaved text, in which case it
   * stays where the author put it. That is not a half-measure the menu has to
   * be warned about: every entry but Run names the row it was opened on, and
   * Run already refuses when the aimed row is not the selected one, so an
   * aimed menu can only ever act on what was aimed at or say no.
   */
  const aimRow = useCallback(
    (index: number): void => {
      const item = list[index]
      if (!item) return
      setCursor(index)
      // Aiming at the row already open in the editor is not a request to leave
      // it, exactly as clicking it is not.
      if (draft !== null && draft.sourcePath === item.file.sourcePath) return
      if (dirty) return
      setDraft(null)
      setTextMode(false)
      setSelectedId(item.workflow.id)
    },
    [dirty, draft, list]
  )

  const reload = useCallback(async (): Promise<void> => {
    // A reload re-reads every file from disk, so it cannot leave an editor open
    // over text that may no longer match what is on disk.
    if (!(await confirmLeaveDraft())) return
    setDraft(null)
    setTextMode(false)
    setReloadToken((n) => n + 1)
  }, [confirmLeaveDraft])

  /* ---------------------------------------------------------------------- */
  /*  Running                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Why Run is unavailable, or null when it is available.
   *
   * One expression behind both the disabled button and its tooltip, so the
   * affordance never says no without saying why. Null while `canApply` is
   * false too: there is no button at all in that workspace.
   *
   * What blocks a run is UNSAVED text, not an open draft. A run reads the file
   * from disk, so it is only meaningful once the file says what the screen
   * says; but with the canvas as the editor a draft is open half the time, and
   * refusing to run a clean one would mean toggling to text and back turned Run
   * off for no reason anyone could see.
   */
  const runBlockedReason =
    draft !== null && draft.sourcePath === null
      ? 'Save this workflow before running it.'
      : dirty
        ? textMode
          ? 'Save your changes before running this workflow.'
          : // The canvas autosaves, so this is a fact about the next half second
            // rather than something to go and do.
            'Your changes are still being saved.'
        : selected === null
          ? 'Select a workflow to run.'
          : active !== null && active.workflow.id !== selected.workflow.id
            ? 'Select a workflow to run.'
            : // Read off the FILE, which is what a run reads: `dirty` is already
              // false here, so the file and the screen say the same thing.
              !isRunnable(selected.workflow)
              ? 'This workflow is a draft, so it cannot run. Activate it first.'
              : plan === null
                ? 'Still working out what this workflow would do.'
                : plan.ops.length === 0
                  ? 'This workflow only reads. There is nothing to apply.'
                  : null

  const canRunNow = canApply && runBlockedReason === null && !running

  /**
   * Apply the plan the author is looking at, after showing them exactly it.
   *
   * The ops sent are the ones captured when Run was pressed and confirmed, not
   * whatever the next re-plan produces: the user agreed to a specific list, and
   * applying a different one because the vault moved between the dialog and the
   * click would break the only promise this screen makes.
   */
  const runSelected = useCallback(async (): Promise<void> => {
    // Re-checked rather than assumed: `R` can fire while the button is
    // disabled, and this is the one path in the view that writes notes.
    if (!canApply || running || runBlockedReason !== null) return
    const item = selected
    const current = plan
    if (!item || !current || current.ops.length === 0) return
    // Asked again, at the one path in this view that writes notes. `R` fires
    // whether or not a button is disabled, and "may this act" is exactly the
    // question a draft exists to answer no to. One function decides it, so the
    // event and schedule triggers that land later cannot forget the rule.
    if (!isRunnable(item.workflow)) return

    // Read the dirty map now rather than subscribing to it; see the store
    // selectors at the top of this component.
    const dirtyPaths = unsavedCollisions(planWritePaths(current.ops), useStore.getState().noteDirty)
    let ops: WorkflowOp[] = current.ops
    let unsaved: { paths: string[]; resolution: UnsavedResolution } | null = null

    if (dirtyPaths.length > 0) {
      // Three answers out of a two-button confirm, asked in the order that
      // keeps the safest one reachable: save first, else skip, else Escape and
      // nothing has happened. This is a MANUAL run, so asking is right; a
      // background trigger would have to skip silently instead, which is why
      // the skip branch exists at all.
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
        if (!skip) {
          listRef.current?.focus()
          return
        }
        unsaved = { paths: dirtyPaths, resolution: 'skip' }
        ops = opsExcludingPaths(current.ops, dirtyPaths)
      }
    }

    if (ops.length === 0) {
      listRef.current?.focus()
      setRunError(
        'Every planned change touched a note with unsaved edits, so skipping them left nothing to run.'
      )
      return
    }

    // Template names become rendered bodies before anything is confirmed, so a
    // name that resolves to nothing refuses the run here instead of after the
    // user agreed to it. The confirmation below still summarizes the NAMED ops
    // (`apply-template book-review ×12` reads; a rendered body does not), while
    // what is sent carries the bodies the applier will actually write.
    const titleByPath = new Map(notes.map((note) => [note.path, note.title]))
    const titleForPath = (path: string): string => {
      const known = titleByPath.get(path)
      if (known !== undefined) return known
      const file = path.split('/').pop() ?? path
      return file.replace(/\.md$/i, '')
    }
    const withTemplates = resolveTemplateOps(ops, templates, titleForPath, new Date())
    if (withTemplates.missing.length > 0) {
      listRef.current?.focus()
      const names = withTemplates.missing.map((name) => `"${name}"`).join(', ')
      // No leading "Cannot run": the banner this lands in already opens with
      // "Could not run this workflow", and a doubled preamble reads as a bug.
      setRunError(
        withTemplates.missing.length === 1
          ? `${names} is not a template in this vault.`
          : `${names} are not templates in this vault.`
      )
      return
    }

    // Re-grouped from the ops that will actually be sent: after a skip, the
    // counts in the dry-run footer are no longer the counts being confirmed.
    const lines = summarizeOps(ops)
    const irreversibleCount = ops.filter((op) => IRREVERSIBLE_KINDS.has(op.kind)).length
    const ok = await confirmApp({
      title: runConfirmTitle(item.workflow.name),
      description: runConfirmDescription({
        workflowName: item.workflow.name,
        lines,
        fileCount: planWritePaths(ops).length,
        irreversibleCount,
        errorCount: diagnostics.filter((d) => d.severity === 'error').length,
        unsaved
      }),
      confirmLabel: runConfirmLabel(lines),
      // Not `danger` for writing notes, which is the point of the feature, but
      // for the part of it that cannot be taken back.
      danger: irreversibleCount > 0
    })
    listRef.current?.focus()
    if (!ok) return

    setRunError(null)
    setRunning(true)
    try {
      if (unsaved?.resolution === 'save') {
        // Before applying, not after: the workflow reads and rewrites what is
        // on disk, so the edits have to be on disk before the run reads them.
        await Promise.all(unsaved.paths.map((path) => persistNote(path)))
      }
      const receipt = await window.zen.applyWorkflow({
        workflowId: item.workflow.id,
        ops: withTemplates.ops
      })
      setRecord({ workflowId: item.workflow.id, receipt, undone: null, undoError: null })
      // The two op kinds the main process cannot perform (a toast and the
      // clipboard live here, not there) happen now, and only for a run that
      // stood: a rolled-back run announcing itself, or writing its output to
      // the clipboard, would be reporting work that was unwound.
      if (receipt.rolledBack === undefined) {
        const effects = collectRunSideEffects(withTemplates.ops)
        for (const message of effects.notifications) addToast(message)
        if (effects.clipboard !== null) {
          try {
            await navigator.clipboard.writeText(effects.clipboard)
          } catch {
            addToast('The run finished, but the clipboard write failed.', 'error')
          }
        }
      }
      // Even a rolled-back run touched files on the way to failing, so the
      // vault is re-read either way before the counts are shown again.
      await refreshNotes()
      setPlanToken((n) => n + 1)
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }, [
    addToast,
    canApply,
    diagnostics,
    notes,
    persistNote,
    plan,
    refreshNotes,
    runBlockedReason,
    running,
    selected,
    templates
  ])

  /**
   * Put every file this run wrote back to the bytes it had before it.
   *
   * Restoring recorded bytes is the whole mechanism: there is no per-op inverse
   * to get wrong. What that cannot do is take back a notification or a
   * clipboard write, which is why the record declares those separately and the
   * button is sized in files rather than in changes.
   */
  const undoRun = useCallback(async (): Promise<void> => {
    const current = record
    if (!current || !canUndoRuns || undoing) return
    if (current.undone !== null || !canUndoReceipt(current.receipt)) return

    // Undo writes to disk while the editor still holds newer text for the same
    // file, so the next autosave would put the run back. Named rather than
    // discovered afterwards.
    const dirtyNow = unsavedCollisions(current.receipt.paths, useStore.getState().noteDirty)
    if (dirtyNow.length > 0) {
      const ok = await confirmApp({
        title: undoCollisionTitle(dirtyNow),
        description: undoCollisionDescription(dirtyNow),
        confirmLabel: 'Undo anyway',
        cancelLabel: 'Keep the run',
        danger: true
      })
      listRef.current?.focus()
      if (!ok) return
    }

    setUndoing(true)
    try {
      const result = await window.zen.undoWorkflowRun(current.receipt.runId)
      setRecord((latest) =>
        latest && latest.receipt.runId === current.receipt.runId
          ? { ...latest, undone: result, undoError: null }
          : latest
      )
      // The card below states what the undo restored; this is the one thing it
      // took away. A toast rather than a line on the card, because it is news
      // about files that may not be the ones on screen, and it is what sends
      // someone to their editor's own undo.
      const drifted = driftedPathsNote(result)
      if (drifted) addToast(drifted, 'error')
      await refreshNotes()
      setPlanToken((n) => n + 1)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setRecord((latest) =>
        latest && latest.receipt.runId === current.receipt.runId
          ? { ...latest, undoError: message }
          : latest
      )
    } finally {
      setUndoing(false)
    }
  }, [addToast, canUndoRuns, record, refreshNotes, undoing])

  /* ---------------------------------------------------------------------- */
  /*  The list pane                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Every workflow, worded for the column that shows them.
   *
   * The pane takes rows rather than parsed workflows on purpose: it is a list
   * with a menu on it, and nothing it does needs to know what a wire is.
   */
  const rows = useMemo<WorkflowListRow[]>(
    () =>
      list.map((item) => ({
        id: item.workflow.id,
        name: item.workflow.name,
        description: item.workflow.description,
        trigger: triggerLabel(item.workflow.trigger),
        // The FILE's status, like every other field on this row. The column
        // describes the vault: what exists and what is armed. What the screen
        // holds that the file does not is what the `editing` marker is for.
        status: item.workflow.status,
        binding: item.workflow.key ?? null,
        errors: item.parseDiagnostics.filter((d) => d.severity === 'error').length,
        editing:
          draft !== null && draft.sourcePath === item.file.sourcePath
            ? dirty
              ? 'dirty'
              : 'clean'
            : null,
        selected: item.workflow.id === selectedId
      })),
    [dirty, draft, list, selectedId]
  )

  /**
   * Should this menu offer the single-letter key beside an entry?
   *
   * Only in Vim mode, which is the one rule every list in this app follows: with
   * it off, `R`, `e`, `n` and `d` do nothing, and a menu that advertised them
   * would be teaching a keyboard that is not there. The ACTIONS stay, because
   * the menu is how you reach them without the keys.
   */
  const menuHint = useCallback(
    (key: string): string | undefined => (vimMode ? key : undefined),
    [vimMode]
  )

  /**
   * The menu behind a right-click (or `m`) on one workflow row.
   *
   * Every entry is wired to the function the view already has, so the menu is a
   * second way to reach the header's buttons rather than a second implementation
   * of them. Built on demand, during render, which is what lets a disabled Run
   * become available under an open menu the moment its dry run lands.
   */
  const rowMenuItems = useCallback(
    (id: string): ContextMenuItem[] => {
      const item = list.find((other) => other.workflow.id === id)
      if (!item) return []
      const items: ContextMenuItem[] = []
      if (canApply) {
        items.push({
          label: 'Run',
          hint: menuHint('R'),
          // `runSelected` runs the SELECTED workflow, and right-clicking a row
          // selects it on the way here whenever that is free. When it was not
          // (see `aimRow`: unsaved text keeps the selection where it is), the
          // row under the pointer is NOT the one a run would apply, so the entry
          // says no rather than quietly running something nobody aimed at.
          disabled: !canRunNow || selected?.workflow.id !== item.workflow.id,
          onSelect: () => void runSelected()
        })
      }
      if (canWrite) {
        // Beside Run, because it is the answer to a disabled one: a draft
        // cannot run, and this is the entry that changes that. Named for what
        // it would DO rather than for the setting it changes, so the menu reads
        // as a list of actions.
        items.push({
          label: isRunnable(item.workflow) ? 'Deactivate' : 'Activate',
          hint: menuHint('t'),
          disabled: statusPending,
          onSelect: () => void toggleWorkflowStatus(item, item.workflow.status)
        })
        items.push({
          label: 'Edit as text',
          hint: menuHint('e'),
          onSelect: () => void editWorkflow(item)
        })
        items.push({ label: 'Duplicate', onSelect: () => void duplicateWorkflow(item) })
      }
      // Copying is offered wherever there is a clipboard, including a read-only
      // workspace: taking a workflow OUT of a vault changes nothing in it.
      items.push({
        label: 'Copy workflow',
        hint: menuHint('y'),
        onSelect: () => void copyWorkflow(item)
      })
      if (canExportFile) {
        items.push({ label: 'Export to file…', onSelect: () => void exportWorkflowToFile(item) })
      }
      if (canReveal) {
        // Worded as the repo words it everywhere else: this app runs on three
        // file managers, and only one of them is called Finder.
        items.push({
          label: 'Reveal in File Manager',
          onSelect: () => void window.zen.revealNote(item.file.sourcePath)
        })
      }
      if (canWrite) {
        items.push({ kind: 'separator' })
        items.push({
          label: 'New workflow',
          hint: menuHint('n'),
          onSelect: () => void openGallery()
        })
        // The other way a workflow arrives. Beside New rather than beside Copy,
        // because what it produces is a new row in this list, not a change to
        // the one under the pointer.
        items.push({
          label: 'Paste workflow…',
          hint: menuHint('p'),
          onSelect: () => void pasteWorkflow()
        })
        if (canImportFile) {
          items.push({
            label: 'Import from file…',
            onSelect: () => void importWorkflowFromFile()
          })
        }
      }
      if (canDelete) {
        items.push({ kind: 'separator' })
        items.push({
          label: 'Delete',
          hint: menuHint('d'),
          danger: true,
          // The same confirm the header's Delete goes through: one flow, so the
          // sentence naming the file can never be skipped by taking a shortcut.
          onSelect: () => void removeWorkflow(item)
        })
      }
      return items
    },
    [
      canApply,
      canDelete,
      canExportFile,
      canImportFile,
      canReveal,
      canRunNow,
      canWrite,
      copyWorkflow,
      duplicateWorkflow,
      editWorkflow,
      exportWorkflowToFile,
      importWorkflowFromFile,
      list,
      menuHint,
      openGallery,
      pasteWorkflow,
      removeWorkflow,
      runSelected,
      selected,
      statusPending,
      toggleWorkflowStatus
    ]
  )

  /**
   * The two ways a workflow someone else wrote gets in.
   *
   * One list, behind the header's Import button and inside both context menus,
   * so the answer to "how do I bring one in" is the same wherever it is asked.
   * The file entry is dropped where there is no filesystem; the clipboard entry
   * is the one that always survives, which is also the one that works when a
   * workflow arrives as text in a message.
   */
  const importMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!canWrite) return []
    const items: ContextMenuItem[] = [
      {
        label: 'Paste workflow…',
        hint: menuHint('p'),
        onSelect: () => void pasteWorkflow()
      }
    ]
    if (canImportFile) {
      items.push({ label: 'Import from file…', onSelect: () => void importWorkflowFromFile() })
    }
    return items
  }, [canImportFile, canWrite, importWorkflowFromFile, menuHint, pasteWorkflow])

  /**
   * The menu for the empty space in the pane.
   *
   * What you can mean by right-clicking a column of workflows with no workflow
   * under the pointer: make one, or bring one in.
   */
  const paneMenuItems = useMemo<ContextMenuItem[]>(
    () =>
      canWrite
        ? [
            { label: 'New workflow', hint: menuHint('n'), onSelect: () => void openGallery() },
            ...importMenuItems
          ]
        : [],
    [canWrite, importMenuItems, menuHint, openGallery]
  )

  /**
   * Put the keyboard in the options panel for the selected step.
   *
   * A frame late on purpose: "Edit step" is chosen from a menu that SELECTS the
   * node on the way in, so the panel it focuses is mounted by the same state
   * change and does not exist yet when the entry runs. Falls back to the panel
   * itself when the step takes no arguments, which is still an answer to "put
   * me in there" rather than leaving the focus on a node that is about to lose
   * its ring.
   */
  const focusInspector = useCallback((): void => {
    requestAnimationFrame(() => {
      const panel = rootRef.current?.querySelector<HTMLElement>('[data-workflow-inspector]')
      if (panel == null) return
      const field = panel.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled])'
      )
      ;(field ?? panel).focus()
    })
  }, [])

  /**
   * The menu behind a right-click on one node of the canvas.
   *
   * Same rule as the list's row menu: every entry calls the function the view
   * already has, so this is a second way to reach the inspector's buttons
   * rather than a second implementation of them. Resolved against the workflow
   * on every render, so a step that stops being movable (or stops existing)
   * says so under an open menu instead of lying until it is reopened.
   */
  const nodeMenuItems = useCallback(
    (id: string): ContextMenuItem[] => {
      const parsed = parseNodeId(id)
      if (parsed === null) return []
      const statement = currentWorkflow()?.statements[parsed.statement]
      const step = statement?.steps[parsed.step]
      if (statement === undefined || step === undefined) return []
      const items: ContextMenuItem[] = [
        {
          label: 'Edit step',
          onSelect: () => {
            setSelectedNodeId(id)
            focusInspector()
          }
        }
      ]
      if (canEditGraph) {
        // Absent rather than disabled where nothing may follow, exactly as the
        // `+` on the node itself is: a terminal step ends the pipeline, and an
        // entry that explains that only after being pressed is worse than no
        // entry at all.
        if (legalKindsAt(statement, parsed.step + 1).length > 0) {
          items.push({
            label: 'Add step after',
            onSelect: () => openInsertPicker(parsed.statement, parsed.step + 1)
          })
        }
        items.push({
          label: 'Move up',
          disabled: parsed.step === 0,
          onSelect: () => moveNode(parsed.statement, parsed.step, -1)
        })
        items.push({
          label: 'Move down',
          disabled: parsed.step >= statement.steps.length - 1,
          onSelect: () => moveNode(parsed.statement, parsed.step, 1)
        })
        items.push({ kind: 'separator' })
        items.push({
          label: 'Delete',
          // Not Vim-gated like the list's letters: Backspace deletes here
          // whether or not Vim mode is on, so the hint is always true.
          hint: 'Backspace',
          danger: true,
          onSelect: () => deleteNode(parsed.statement, parsed.step)
        })
      }
      return items
    },
    [canEditGraph, currentWorkflow, deleteNode, focusInspector, moveNode, openInsertPicker]
  )

  /**
   * Right-clicking a node opens that menu, on the node under the pointer.
   *
   * Aiming at a node selects it first, the same rule the workflow list follows:
   * a menu that acted on whatever happened to be selected beforehand is a menu
   * that deletes the step nobody pointed at.
   */
  const onNodeContextMenu = useCallback((event: ReactMouseEvent, node: StepNode): void => {
    event.preventDefault()
    setSelectedNodeId(node.id)
    // A ContextMenu keypress on a focused node synthesizes this event at
    // (0,0), and anchoring there draws the menu in the window's corner,
    // nowhere near the node. A position-less event is re-anchored to the
    // node's own box, exactly how the list anchors its keyboard menu to the
    // row (`keyboardMenuPosition` is the same math both ways).
    let x = event.clientX
    let y = event.clientY
    if (x === 0 && y === 0) {
      const el =
        (event.target as HTMLElement | null)?.closest?.('.react-flow__node') ??
        // Node ids are `<digits>:<digits>`, so the quoted attribute value
        // needs no escaping.
        canvasRef.current?.querySelector(`.react-flow__node[data-id="${node.id}"]`)
      if (el) ({ x, y } = keyboardMenuPosition(el.getBoundingClientRect()))
    }
    setNodeMenu({ x, y, id: node.id })
  }, [])

  const closeNodeMenu = useCallback((): void => setNodeMenu(null), [])

  /**
   * Open the row menu from the keyboard, on the row the cursor is on.
   *
   * Dispatches the same `contextmenu` event a right-click would, at the row's
   * own position, rather than reaching into the pane's menu state: there is then
   * exactly one path that opens this menu, and the keyboard cannot drift from
   * the mouse. With no row under the cursor it falls back to the pane itself, so
   * the key still answers on an empty column instead of going dead.
   */
  const openRowMenuAtCursor = useCallback((): void => {
    const target =
      listRef.current?.querySelector<HTMLElement>(`[data-workflow-row="${cursor}"]`) ??
      rootRef.current?.querySelector<HTMLElement>('[data-workflow-list-pane]')
    if (target == null) return
    dispatchKeyboardContextMenu(target)
  }, [cursor])

  // Focus the textarea when the editor opens, caret at the top.
  //
  // Nothing arrives here with a range to select any more: creating a workflow
  // used to open the text with its name selected, and creating now writes the
  // file and lands on the canvas, so every way into this editor is a request
  // to READ a workflow from its first line.
  useEffect(() => {
    if (editSession === 0) return
    const textarea = editorRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(0, 0)
  }, [editSession])

  // Leaving the editor hands the keyboard back to the list; otherwise focus is
  // stranded on a textarea that just unmounted and no key does anything.
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !editingNow) listRef.current?.focus()
    wasEditing.current = editingNow
  }, [editingNow])

  /**
   * Land the caret after text this view spliced in, then look again.
   *
   * A layout effect rather than an effect: the browser must never paint a frame
   * with the caret at the end of the file. Looking again is what makes a
   * completion continue into the next one, so accepting `where ` immediately
   * offers the values it wants.
   *
   * Only when the inserted text OPENED a slot, though. `trigger: ` ends in a
   * space and has an obvious next question; `where` does not, and reopening
   * there would show a one-row popup listing the word just accepted, which is
   * the kind of thing that makes people stop trusting a completion popup.
   */
  useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (caret === null) return
    pendingCaret.current = null
    const chain = pendingChain.current
    pendingChain.current = false
    const el = editorRef.current
    if (el === null) return
    el.focus()
    el.setSelectionRange(caret, caret)
    if (chain) refreshSuggest('explicit')
  }, [draftText, refreshSuggest])

  // Closing the editor takes the popup with it: it is anchored inside the
  // textarea, and a dismissal is per editing session, not per app session.
  useEffect(() => {
    if (editingNow) return
    suggestOff.current = false
    setSuggest(null)
  }, [editingNow])

  // Keep the highlighted completion in view when the keyboard walks past the
  // bottom of the popup.
  useEffect(() => {
    if (suggest === null) return
    const row = suggestListRef.current?.querySelector<HTMLElement>(
      `[data-suggest-index="${suggestIndex}"]`
    )
    row?.scrollIntoView({ block: 'nearest' })
  }, [suggest, suggestIndex])

  /** Put the caret on the line a diagnostic is about. */
  const jumpToLine = useCallback(
    (line: number) => {
      const textarea = editorRef.current
      if (!textarea || draftText === null) return
      const range = lineRange(draftText, line <= 0 ? 1 : line + bodyLineOffset(draftText))
      textarea.focus()
      textarea.setSelectionRange(range.start, range.end)
    },
    [draftText]
  )

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-workflow-row="${cursor}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  // Claim the keyboard on open so the list works without a click, but only when
  // nothing else has focus: this view can mount in a background pane, and
  // stealing focus from the editor there would be a bug, not a convenience.
  //
  // Keyed on the first load rather than on mount alone, because the loading
  // placeholder has nothing focusable in it: a mount-only effect would leave a
  // freshly opened view (and its `n` shortcut) reachable by mouse only.
  const firstLoadDone = items !== null
  useEffect(() => {
    if (!firstLoadDone) return
    if (document.activeElement === null || document.activeElement === document.body) {
      listRef.current?.focus()
    }
  }, [firstLoadDone])

  // The list owns its own keys rather than a window listener: this view can be
  // open in two panes, and only the focused list should move.
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const native = event.nativeEvent
    const consume = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    // Vim off means the single-key shortcuts are off; arrows and Enter always
    // work, so the list is never mouse-only.
    const seq = (id: Parameters<typeof matchesSequenceToken>[2]): boolean =>
      vimMode && matchesSequenceToken(native, keymapOverrides, id)
    // The authoring keys are plain letters, so they follow the same rule: with
    // Vim off they are off, and the header hint stops offering them.
    const letter = (key: string): boolean => vimMode && !event.shiftKey && event.key === key
    // `R` runs, `r` reloads. Shift is the entire difference between the two, so
    // they are matched apart and neither can ever fire the other.
    const shifted = (key: string): boolean => vimMode && event.shiftKey && event.key === key

    if (event.key === 'ArrowDown' || seq('nav.moveDown')) {
      consume()
      moveCursor(1)
      return
    }
    if (event.key === 'ArrowUp' || seq('nav.moveUp')) {
      consume()
      moveCursor(-1)
      return
    }
    // Escape closes a panel and leaves the workflow alone. Never handled when
    // there is nothing open, so it still falls through to whatever owns Escape
    // outside this view.
    if (event.key === 'Escape') {
      if (selectedNodeId === null) return
      consume()
      setSelectedNodeId(null)
      return
    }
    if (event.key === 'Home') {
      consume()
      setCursor(0)
      return
    }
    if (event.key === 'End' || seq('nav.jumpBottom')) {
      consume()
      setCursor(Math.max(0, list.length - 1))
      return
    }
    if (
      vimMode &&
      advanceSequence(
        native,
        getKeymapBinding(keymapOverrides, 'nav.jumpTop'),
        gPending,
        gTimer,
        () => setCursor(0),
        consume,
        500
      )
    ) {
      return
    }
    // The row menu, by the three keys that ask for one. `m` is the house key
    // (sidebar rows and tabs already use it) and follows the Vim-mode rule with
    // every other letter; the OS keys do NOT, because with Vim off they are the
    // only way to reach Duplicate and Reveal without a mouse, and this view may
    // never become mouse-only.
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10') || letter('m')) {
      consume()
      openRowMenuAtCursor()
      return
    }
    if (letter('n')) {
      consume()
      void openGallery()
      return
    }
    // `y` yanks the workflow under the cursor onto the clipboard and `p` pastes
    // one back in, which is what those two keys already mean to the hands this
    // app is built for. Vim-gated with every other letter here, and the menu
    // (`m`) is how both are reached with Vim off.
    if (letter('y')) {
      consume()
      const item = list[cursor]
      if (item) void copyWorkflow(item)
      return
    }
    if (letter('p')) {
      consume()
      void pasteWorkflow()
      return
    }
    // `?` is the reference. Shifted like `R`, and Vim-gated like every other
    // single-key shortcut in this view.
    if (vimMode && event.key === '?') {
      consume()
      setReferenceOpen((open) => !open)
      return
    }
    if (letter('r')) {
      consume()
      void reload()
      return
    }
    if (shifted('R')) {
      consume()
      // Guarded inside `runSelected` too: the key fires whether or not the
      // button is disabled, and only one of the two may decide.
      void runSelected()
      return
    }
    // `a` adds a step, which on this canvas means starting a new line. The
    // per-node insert lives on the node itself, where the position it inserts
    // at is unambiguous.
    if (letter('a')) {
      consume()
      openNewStatementPicker()
      return
    }
    // `t` toggles the workflow under the cursor between draft and active. The
    // one key for the one thing that decides whether a workflow may act, so
    // disarming a row is as fast as reading it. Vim-gated like every other
    // letter here; the menu (`m`) is how it is reached with Vim off.
    if (letter('t')) {
      consume()
      const item = list[cursor]
      if (item) void toggleWorkflowStatus(item, item.workflow.status)
      return
    }
    // `e` is the text editor. It used to be the only editor; it is now the
    // second way in, and the hint says "text" rather than "edit" because of it.
    if (letter('e')) {
      consume()
      void editWorkflow(list[cursor] ?? selected)
      return
    }
    // `d` is what this view documents, `nav.delete` (x by default) is what the
    // other list views use and what Settings can rebind; both land here.
    if (letter('d') || seq('nav.delete')) {
      consume()
      const item = list[cursor]
      if (item) void removeWorkflow(item)
      return
    }
    if (event.key === 'Enter' || seq('nav.openResult')) {
      consume()
      const item = list[cursor]
      if (!item) return
      // Enter opens the workflow under the cursor; pressing it again on the one
      // already on screen is how you get into the text. Browsing the list and
      // editing a workflow are then the same key twice, and the graph stays
      // visible either way.
      if (item.workflow.id === selectedId) void editWorkflow(item)
      else openCursor()
    }
  }

  // Escape and save live on the textarea rather than a window listener: the
  // editor is a text field, and every global handler in the app already stands
  // down for one, which is exactly why they cannot be relied on to fire here.
  //
  // The completion popup is layered UNDER all of that: while it is open it gets
  // first refusal on the navigation keys, and when it is closed every key means
  // exactly what it meant before it existed. Enter still inserts a newline;
  // Escape still leaves the editor.
  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const consume = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      consume()
      void saveDraft()
      return
    }
    // The reference is readable while typing, so it toggles from inside the
    // editor too. A chord rather than `?`, which is a character here.
    if ((event.metaKey || event.ctrlKey) && event.key === '/') {
      consume()
      setReferenceOpen((open) => !open)
      return
    }
    // "What can I write here?", asked out loud. Ctrl+Space is the completion
    // chord everywhere; Cmd+I is the one macOS leaves free, since Ctrl+Space is
    // taken there by the input-source switcher.
    if (isExplicitSuggestKey(event)) {
      consume()
      // Escape said "leave me alone"; asking again is taking that back.
      suggestOff.current = false
      refreshSuggest('explicit')
      return
    }

    const open = suggest !== null && suggest.items.length > 0
    if (open) {
      const count = suggest.items.length
      if (isPaletteNextKey(event)) {
        consume()
        setSuggestIndex((index) => (index + 1) % count)
        return
      }
      if (isPalettePreviousKey(event)) {
        consume()
        setSuggestIndex((index) => (index - 1 + count) % count)
        return
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        consume()
        acceptSuggestion(suggest.items[Math.min(suggestIndex, count - 1)])
        return
      }
      if (event.key === 'Escape') {
        // Dismisses the popup and NOTHING else: leaving the editor on the same
        // keystroke would throw away an edit the author was still making.
        consume()
        dismissSuggest()
        return
      }
    }

    if (event.key === 'Escape') {
      consume()
      void closeEditor()
    }
  }

  /**
   * The canvas's own keys.
   *
   * React Flow makes nodes focusable, so Tab already walks them and the `+` on
   * each one is a real button that Enter presses. What it does not give is a
   * way to open the OPTIONS for the node under the keyboard, so Enter does
   * that, and Escape puts the panel away without leaving the workflow.
   *
   * Backspace and Delete remove the selected step. React Flow's own delete key
   * is switched OFF (`deleteKeyCode={null}` below) so exactly one thing answers
   * the key, and it is this: the graph is controlled from the workflow text, so
   * a deletion has to go through the same `deleteNode` the inspector's Delete
   * button uses or it would vanish from the canvas without touching the file.
   */
  const onCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Select every step (#534). Ahead of the modifier guard below because it is
    // the one key here that WANTS a modifier, and behind the text-entry check
    // because Cmd+A in the options panel still means "select this text".
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a') {
      if (isTextEntryTarget(event.target)) return
      if (graph.nodes.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      setSelectedNodeIds(graph.nodes.map((node) => node.id))
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'Escape') {
      // Escape clears the whole group, not just a single node, so one press
      // always means "nothing is selected now".
      if (selectedNodeIds.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      setSelectedNodeIds([])
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      // `selectedNode` is null while a GROUP is selected, so this cannot fire
      // against several steps. Deleting a group is deliberately not a thing
      // yet: a deletion rewrites the file by statement and step index, so
      // removing several at once has to renumber as it goes, and half of that
      // going wrong leaves a workflow nobody asked for. (#534)
      if (selectedNode === null || !canEditGraph) return
      if (isTextEntryTarget(event.target)) return
      // The node menu is portalled, but a portal still bubbles up the REACT
      // tree, so its Backspace (which deletes a character from the menu's
      // type-to-filter query) would arrive here as well and delete the step
      // out from under the open menu. Its own Delete entry is the way.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[data-ctx-menu]') !== null
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      deleteNode(selectedNode.statementIndex, selectedNode.stepIndex)
      // The node the keyboard was on is about to unmount, and focus would fall
      // to the document body, where the next Backspace is the sidebar's again.
      // Parking it on the canvas keeps the keys pointed at the canvas.
      requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }))
      return
    }
    if (event.key !== 'Enter') return
    // A button inside a node answers Enter for itself (that is how the `+`
    // opens the picker from the keyboard), so this never speaks over one.
    const target = event.target
    if (!(target instanceof HTMLElement) || target.closest('button') !== null) return
    // `.react-flow__node` and its `data-id` are React Flow's own documented
    // markup, and reading the focused node off the DOM is the only way to know
    // which node the keyboard is on: selection is tracked here, but FOCUS is
    // React Flow's.
    const focused = target.closest<HTMLElement>('.react-flow__node')
    const id = focused?.dataset.id
    if (id === undefined) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedNodeId(id)
  }

  // The tutorial seeds its workflow from OUTSIDE this view (Settings). When
  // the view is already mounted at that moment there is no mount-time load to
  // pick the file up, and the workflows directory has no watcher, so the
  // tutorial's arrival is the reload trigger. Once per activation, not per
  // step: `reload` clears selection state, and re-running it on every chapter
  // would fight the user mid-lesson.
  const tutorialReloadedRef = useRef(false)
  useEffect(() => {
    if (tutorialStep === null) {
      tutorialReloadedRef.current = false
      return
    }
    if (tutorialReloadedRef.current) return
    tutorialReloadedRef.current = true
    void reload()
  }, [tutorialStep, reload])

  /** End the guided tutorial, from Finish or from abandoning it: same cleanup
   *  either way, with a confirm only when chapters remain (Finish on the last
   *  chapter is the expected exit and should not be second-guessed). */
  const endTutorial = useCallback(async (): Promise<void> => {
    const step = useStore.getState().workflowTutorialStep
    if (step !== null && step < TUTORIAL_STEPS.length - 1) {
      const ok = await confirmApp({
        title: 'Leave the tutorial?',
        description:
          'The practice folder, the tutorial workflow, and its run history are removed either way; leaving now just skips the remaining chapters.',
        confirmLabel: 'Leave and clean up',
        cancelLabel: 'Keep going'
      })
      if (!ok) return
    }
    await finishWorkflowTutorial()
    await reload()
    listRef.current?.focus()
  }, [reload])

  const tutorial =
    tutorialStep !== null ? (
      <TutorialPanel
        step={tutorialStep}
        signals={{
          'select-tutorial': selectedId === TUTORIAL_WORKFLOW_SLUG,
          'node-inspected': selectedNodeId !== null,
          'text-mode': textMode,
          'canvas-mode': !textMode,
          'where-inspected': selectedNode?.step.kind === 'where',
          'threshold-eased':
            active?.workflow.id === TUTORIAL_WORKFLOW_SLUG &&
            active.workflow.statements.some((statement) =>
              statement.steps.some(
                (step) =>
                  step.kind === 'where' &&
                  step.args.field === 'rating' &&
                  step.args.value === '3'
              )
            ),
          'workflow-active': workflowIndexEntries.some(
            (entry) => entry.id === TUTORIAL_WORKFLOW_SLUG && entry.status === 'active'
          ),
          'run-applied':
            record?.workflowId === TUTORIAL_WORKFLOW_SLUG &&
            record.undone === null &&
            record.receipt.rolledBack === undefined,
          'run-undone': record?.workflowId === TUTORIAL_WORKFLOW_SLUG && record?.undone !== null,
          'palette-opened': paletteOpen
        }}
        onStepChange={(step) =>
          setTutorialStep(Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, step)))
        }
        onFinish={() => void endTutorial()}
      />
    ) : null

  // Both live outside the three returns below, because both are reachable from
  // every one of them: the gallery is how a workflow is created whether or not
  // any exist yet, and the reference answers the same question in an empty
  // vault as in a full one.
  const gallery = galleryOpen ? (
    <WorkflowGallery
      onPick={(preset) => {
        setGalleryOpen(false)
        void createFromPreset(preset)
      }}
      onBlank={() => {
        setGalleryOpen(false)
        void createBlankWorkflow()
      }}
      onClose={closeGallery}
    />
  ) : null

  // Rendered from every return for the same reason the gallery is: a workflow
  // can be brought in from the header on an empty vault as readily as on a full
  // one, and the review is the only thing standing between an outside file and
  // this vault, so it may never be the one surface a branch forgets to draw.
  const importDialog =
    pendingImport !== null ? (
      <ImportReviewDialog
        source={pendingImport.source}
        target={`${WORKFLOWS_REL_DIR}/${pendingImport.slug}.md`}
        review={pendingImport.review}
        // Null while the write is in flight, so a second press cannot land a
        // second copy.
        onImport={importing ? null : () => void acceptImport()}
        onCancel={cancelImport}
      />
    ) : null

  const reference = referenceOpen ? (
    <SyntaxReference
      // Clicking a step only inserts where there is text to insert into. On the
      // canvas and in the read-only view it is documentation, and a control
      // that silently does nothing would be worse than one that is plainly not
      // a control.
      onInsert={editingNow ? insertAtCaret : null}
      onClose={() => setReferenceOpen(false)}
    />
  ) : null

  // Rendered from every return below for the same reason the gallery is: the
  // picker is how a step is added, and that has to work on the empty screen as
  // well as the full one.
  const stepPicker =
    picker !== null ? (
      <StepPicker
        title={picker.title}
        subtitle={picker.subtitle}
        defs={picker.defs}
        onPick={(def) => {
          setPicker(null)
          picker.onPick(def)
        }}
        onClose={() => {
          setPicker(null)
          // The picker took the keyboard; give it back rather than stranding
          // focus on a modal that just unmounted.
          listRef.current?.focus()
        }}
      />
    ) : null

  if (items === null) {
    return (
      <div
        ref={rootRef}
        className="relative flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900"
      >
        <WorkflowsHeader
          count={0}
          vimMode={vimMode}
          editing={false}
          canCreate={canWrite}
          canRun={canApply}
          referenceOpen={referenceOpen}
          importItems={importMenuItems}
          onCreate={() => void openGallery()}
          onToggleReference={() => setReferenceOpen((open) => !open)}
          onReload={() => void reload()}
        />
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-400">
          Loading workflows…
        </div>
        {gallery}
        {stepPicker}
        {importDialog}
      </div>
    )
  }

  // Nothing on disk and nothing being written: the fresh-vault case, whose job
  // is to make the next keystroke obvious rather than to explain where files
  // live. What a workflow can say is one click away in the gallery, and how it
  // is written is one key away in the Syntax panel, so neither is restated
  // here.
  if (list.length === 0 && draft === null) {
    return (
      <div
        ref={rootRef}
        className="relative flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900"
      >
        <WorkflowsHeader
          count={0}
          vimMode={vimMode}
          editing={false}
          canCreate={canWrite}
          canRun={canApply}
          referenceOpen={referenceOpen}
          importItems={importMenuItems}
          onCreate={() => void openGallery()}
          onToggleReference={() => setReferenceOpen((open) => !open)}
          onReload={() => void reload()}
        />
        <div className="flex min-h-0 flex-1">
          <div
            ref={listRef}
            // The same stand-down marker `WorkflowListPane` carries. Without it
            // VimNav's capture-phase handler swallows every key on the one
            // screen a brand-new vault opens to, and `n`/`?` die exactly where
            // the copy above is promising they work.
            data-workflow-list-pane="true"
            tabIndex={0}
            onKeyDown={onListKeyDown}
            className="min-h-0 min-w-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
          >
            <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
              <div>
                <h3 className="font-serif text-xl font-semibold text-ink-900">
                  Make your vault do the filing
                </h3>
                <p className="mt-2 text-sm text-ink-600">
                  A workflow pipes a set of notes through steps. New ones are drafts: they save as
                  you edit but cannot run until you activate them, and every run can be undone.
                </p>
                {loadError && (
                  <p className="mt-2 text-sm text-danger">Could not read workflows: {loadError}</p>
                )}
              </div>

              {/* One sentence and one action. Everything this screen used to
                  explain lives somewhere that is already one click away: the
                  recipes are the gallery this button opens, and the grammar is
                  the Syntax panel in the header. Repeating them here made the
                  first thing a new user sees the densest screen in the app. */}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  size="md"
                  disabled={!canWrite}
                  title="Start from a recipe · n"
                  onClick={() => void openGallery()}
                >
                  <PlusIcon className="h-4 w-4" />
                  New workflow
                </Button>
                {!canWrite && (
                  <span className="text-xs text-ink-400">
                    This workspace is read-only, so workflows can only be viewed here.
                  </span>
                )}
              </div>
            </div>
          </div>
          {reference}
        </div>
        {gallery}
        {stepPicker}
        {importDialog}
      </div>
    )
  }

  // The record is shown only over the workflow it belongs to: a receipt is a
  // statement about one graph, and hanging it under another one would credit
  // the wrong workflow with the change.
  const runRecord = record !== null && active?.workflow.id === record.workflowId ? record : null

  /**
   * The line the dry run closes with.
   *
   * The promise stands until a run happens, and is replaced by what that run
   * did rather than sitting next to it: "nothing has been written" is the whole
   * reason this panel can be trusted, so it may never be shown once it is
   * false for the workflow on screen.
   */
  const vaultNote = runRecord
    ? runRecord.undone
      ? undoneHeadline(runRecord.undone)
      : receiptHeadline(runRecord.receipt)
    : 'Nothing has been written to your vault.'

  // Where a save would land. The stem follows the frontmatter name, so this is
  // also how a rename announces itself before it happens.
  const draftTarget =
    editing === null ? null : `${WORKFLOWS_REL_DIR}/${slugFor(editing.workflow.name)}.md`
  const renaming = draft !== null && draft.sourcePath !== null && draftTarget !== draft.sourcePath

  // Remounting is what re-runs `fitView`, so switching workflows always lands
  // on a framed graph, and so does adding a step: a new node gets framed
  // instead of drawn off the edge of the canvas.
  //
  // The node count is the WHOLE key beyond the id, deliberately. Keying on
  // "is there a draft" as well would refit the view the first time an argument
  // was typed into the inspector, because that is the moment a draft appears,
  // and a graph that jumps when you edit a text box is a graph you stop
  // trusting to stay where you put it.
  const graphKey = active === null ? 'empty' : `${active.workflow.id}\x00${graph.nodes.length}`

  /**
   * May a node be moved here?
   *
   * Only when the move can be kept. A read-only workspace has nowhere to put
   * it, and a hand-named file cannot be written back in place (see
   * `writesBackToItsOwnFile`), so both leave the canvas fixed rather than
   * offering a drag that silently evaporates on the next reload.
   */
  const canDragNodes =
    canWrite && (draft !== null || (selected !== null && writesBackToItsOwnFile(selected)))

  /** The one control that is always on the canvas, however empty it is. */
  const addStepButton = canEditGraph ? (
    <Button
      variant="secondary"
      title={vimMode ? 'Start a new line with a source · a' : 'Start a new line with a source'}
      onClick={openNewStatementPicker}
    >
      <PlusIcon className="h-3.5 w-3.5" />
      Add step
    </Button>
  ) : null

  const graphCanvas =
    active && graph.nodes.length > 0 ? (
      <ReactFlow
        key={graphKey}
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={NODE_TYPES}
        // Positions are computed by `layoutWorkflow`, and a drag stores an
        // OVERRIDE of one rather than a layout, so the file still has no
        // coordinates in it until someone moves something and returns to none
        // when they reset. `onNodesChange` is what makes the drag visible at
        // all: `nodes` is a controlled prop, so a moved node only moves if the
        // change comes back as a new position.
        nodesDraggable={canDragNodes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        // Wiring IS draggable now. A drag between two lines says "this line
        // reads that one", which the file spells as a wire name, so `onConnect`
        // names the wire when it has to and writes the input on the other end.
        nodesConnectable={canEditGraph}
        onConnect={onConnect}
        onNodeClick={(event, node) => {
          // A modifier click is React Flow adding to or removing from the
          // group, and it reports that through `onNodesChange`. Forcing a
          // single selection here would undo it on the way past.
          if (event.shiftKey || event.metaKey || event.ctrlKey) return
          setSelectedNodeId(node.id)
        }}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => setSelectedNodeId(null)}
        // React Flow's own Backspace handling, off. It deletes from ITS copy of
        // the graph, and this graph is derived from the workflow text, so its
        // delete would take a node off the canvas and leave the step in the
        // file. `onCanvasKeyDown` owns the key instead, and owning it in one
        // place is the point: two handlers on one keypress is how a single
        // Backspace ends up deleting twice.
        deleteKeyCode={null}
        // Shift, and the platform's own command key, add a node to the group
        // instead of replacing it. Shift is in both lists on purpose: held on
        // the pane it drags a selection box, held on a node it adds that node,
        // which is the pair of gestures people arrive expecting. (#534)
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        elementsSelectable
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        // React Flow's default floor is 0.5, which quietly forbids fitting a
        // long pipeline into a narrow pane: the "fit" then overflows both
        // edges. A workflow is a wide thing by nature, so the floor bends.
        minZoom={0.2}
        // A fresh mount is a fresh framing: the remount is how switching
        // workflows refits, so the hands-off rule resets with it. The resize
        // observer on the container (see `canvasRef`) handles the pane
        // settling its real size after this instant.
        onInit={(instance) => {
          flowInstanceRef.current = instance
          viewportTouchedRef.current = false
        }}
        onMoveStart={(event) => {
          // Programmatic moves (our own fits) arrive without an input event;
          // only a real hand on the canvas takes the viewport over.
          if (event) viewportTouchedRef.current = true
        }}
        // React Flow's own badge, off. It sits over the canvas looking like a
        // control of ours and answers to nobody: people ask what it is, which
        // means it reads as a bug in this feature rather than as an attribution.
        proOptions={{ hideAttribution: true }}
        className="bg-paper-100"
      >
        <Background color="rgb(var(--z-bg-3))" gap={18} size={1} />
        {addStepButton && <Panel position="top-left">{addStepButton}</Panel>}
      </ReactFlow>
    ) : (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-ink-400">
        <span>
          {active
            ? 'No steps yet. Add one and the graph appears as you build it.'
            : 'Select a workflow to see its graph.'}
        </span>
        {/* The empty canvas offers the first action rather than describing it:
            "add a pipeline line" is only an instruction if you already know
            what one is. */}
        {active && addStepButton}
      </div>
    )

  /**
   * The options for the selected step.
   *
   * Keyed by the node so the panel is remounted when the selection moves: every
   * control in it holds the text being typed into it, and carrying that across
   * to a different step would show one step's argument under another's name.
   */
  const inspector =
    selectedNode !== null ? (
      <NodeInspector
        key={selectedNodeId ?? ''}
        def={nodeDef(selectedNode.step.kind)}
        step={selectedNode.step}
        statement={selectedNode.statement}
        nodeId={selectedNodeId ?? ''}
        stepIndex={selectedNode.stepIndex}
        inputChoices={inputChoices}
        wireReaders={wireReaders}
        vocabulary={inspectorVocabulary}
        editable={canEditGraph}
        focusWireToken={
          wireFocus !== null && wireFocus.nodeId === selectedNodeId ? wireFocus.token : 0
        }
        onSetArg={(name, value) =>
          setArg(selectedNode.statementIndex, selectedNode.stepIndex, name, value)
        }
        onSetWireName={(name) => setWireName(selectedNode.statementIndex, name)}
        onSetInput={(wire) => setInput(selectedNode.statementIndex, wire)}
        onInsertAfter={
          canEditGraph &&
          legalKindsAt(selectedNode.statement, selectedNode.stepIndex + 1).length > 0
            ? () => openInsertPicker(selectedNode.statementIndex, selectedNode.stepIndex + 1)
            : null
        }
        onMoveStep={(delta) =>
          moveNode(selectedNode.statementIndex, selectedNode.stepIndex, delta)
        }
        onDelete={() => deleteNode(selectedNode.statementIndex, selectedNode.stepIndex)}
        onClose={() => setSelectedNodeId(null)}
      />
    ) : null

  /**
   * The canvas, its refusals, and the panel that configures what is on it.
   *
   * Shown under the text editor as well as on its own, so a connection dragged
   * while the textarea is open still lands and still says why when it cannot.
   */
  const canvasPane = (
    <div className="flex min-h-0 flex-1">
      <div
        ref={canvasRef}
        // The marker VimNav looks for. Without it the global capture-phase
        // listener eats Backspace, Delete and the arrows before the canvas ever
        // sees them and moves the focus to the sidebar instead (see the bail in
        // VimNav.tsx). Focusable so a deletion has somewhere to leave the
        // keyboard when the node it was on unmounts.
        data-workflow-canvas
        tabIndex={-1}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none"
        onKeyDown={onCanvasKeyDown}
      >
        <div className="min-h-0 min-w-0 flex-1">{graphCanvas}</div>
        {connectError !== null && (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-popover flex justify-center px-4">
            <span
              role="status"
              className="max-w-lg rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger shadow-panel"
            >
              {connectError}
            </span>
          </div>
        )}
        {/* Resolved here rather than when the menu opened, so a step deleted or
            renumbered under an open menu closes it instead of offering moves
            for something that is no longer there. */}
        {nodeMenu !== null &&
          (() => {
            const items = nodeMenuItems(nodeMenu.id)
            return items.length === 0 ? null : (
              <ContextMenu
                x={nodeMenu.x}
                y={nodeMenu.y}
                items={items}
                onClose={closeNodeMenu}
              />
            )
          })()}
      </div>
      {inspector}
    </div>
  )

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900"
    >
      <WorkflowsHeader
        count={list.length}
        vimMode={vimMode}
        // The hint describes the surface the keyboard is on, and that is the
        // TEXT editor only while it is showing: the canvas has its own keys.
        editing={textMode && draft !== null}
        canCreate={canWrite}
        canRun={canApply}
        referenceOpen={referenceOpen}
        importItems={importMenuItems}
        onCreate={() => void openGallery()}
        onToggleReference={() => setReferenceOpen((open) => !open)}
        onReload={() => void reload()}
      />
      <div className="flex min-h-0 flex-1">
        <WorkflowListPane
          rows={rows}
          cursor={cursor}
          listRef={listRef}
          onKeyDown={onListKeyDown}
          onSelect={selectRow}
          onAim={aimRow}
          onOpen={(index) => void editWorkflow(list[index] ?? null)}
          onToggleStatus={
            canWrite
              ? (index) => {
                  const item = list[index]
                  if (item) void toggleWorkflowStatus(item, item.workflow.status)
                }
              : null
          }
          onCreate={canWrite ? () => void openGallery() : null}
          createTitle={vimMode ? 'Start from a recipe · n' : 'Start from a recipe'}
          rowMenuItems={rowMenuItems}
          paneMenuItems={paneMenuItems}
        />

        {/* `min-w-0`, or a flex item's automatic minimum keeps this column at
            its content width and the reference panel beside it is pushed off
            the edge of the window instead of taking its 20rem. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {active && (
            // `flex-wrap`: buttons neither wrap their labels nor shrink (see
            // ui/Button), so when this row truly runs out of width the action
            // cluster drops to a second line rather than clipping Export and
            // Delete off the edge of the pane.
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-paper-300/50 px-4 py-2">
              <h3 className="shrink-0 truncate text-sm font-semibold text-ink-900">
                {active.workflow.name}
              </h3>
              <span
                className="min-w-0 truncate font-mono text-2xs text-ink-400"
                title={draft !== null && draft.sourcePath === null ? 'Not saved yet' : undefined}
              >
                {draftTarget ?? active.file.sourcePath}
                {draft !== null && draft.sourcePath === null && ' (new)'}
                {renaming && ' · renamed on save'}
              </span>
              {/* The state that decides whether this workflow may act, on the
                  line that names it. Pressable in both directions, because the
                  friction belongs on the consequential one only: activating
                  something that writes asks first, deactivating never does. */}
              {selected !== null && (
                <WorkflowStatusToggle
                  status={active.workflow.status}
                  busy={statusPending}
                  onToggle={
                    canWrite
                      ? () => void toggleWorkflowStatus(selected, active.workflow.status)
                      : null
                  }
                />
              )}
              {dirty &&
                (textMode ? (
                  <span className="shrink-0 rounded bg-warning/20 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-warning">
                    unsaved
                  </span>
                ) : (
                  // Not a warning, because nothing is at risk: the write is on
                  // its way. This is the whole of what the header has to say
                  // about saving now that the canvas has no Save button.
                  <span className="shrink-0 text-2xs text-ink-400">Saving…</span>
                ))}
              {planning && <span className="shrink-0 text-2xs text-ink-400">Planning…</span>}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {canApply &&
                  (isRunnable(active.workflow) ? (
                    // First in the cluster so it keeps its place when the text
                    // editor opens and Save takes over as the emphasized action.
                    <Button
                      variant={textMode ? 'ghost' : 'primary'}
                      disabled={!canRunNow}
                      title={
                        runBlockedReason ?? (vimMode ? 'Run this workflow · R' : 'Run this workflow')
                      }
                      onClick={() => void runSelected()}
                    >
                      <ZapIcon className="h-3.5 w-3.5" />
                      {running ? 'Running…' : 'Run'}
                    </Button>
                  ) : canWrite && selected !== null ? (
                    // A draft cannot run, and a disabled Run with an explanation
                    // hidden in a tooltip is a dead end. The control says what to
                    // do about it instead, in the place Run would have been.
                    <Button
                      variant={textMode ? 'ghost' : 'primary'}
                      disabled={statusPending}
                      title={
                        vimMode
                          ? 'This workflow is a draft. Activate it to make it runnable · t'
                          : 'This workflow is a draft. Activate it to make it runnable'
                      }
                      onClick={() => void toggleWorkflowStatus(selected, 'draft')}
                    >
                      <ZapIcon className="h-3.5 w-3.5" />
                      Activate to run
                    </Button>
                  ) : (
                    // A workspace that can apply but not write: no way out of
                    // the draft from here, so Run says why it is off.
                    <Button variant="ghost" disabled title={runBlockedReason ?? undefined}>
                      <ZapIcon className="h-3.5 w-3.5" />
                      Run
                    </Button>
                  ))}
                {canDragNodes && overrides.size > 0 && (
                  // Shown only once something has been moved, so it doubles as
                  // the answer to "does this file have coordinates in it?" and
                  // is never a control that would do nothing.
                  <Button
                    variant="ghost"
                    title="Put every node back where the layout would place it, and take the coordinates back out of the file"
                    onClick={resetLayout}
                  >
                    Reset layout
                  </Button>
                )}
                {canWrite && (
                  // The text editor is now a VIEW of the workflow rather than
                  // the way to edit it, so it toggles rather than opening: the
                  // same draft is behind both, and neither is the "real" one.
                  <Button
                    variant="ghost"
                    aria-pressed={textMode}
                    title={
                      textMode
                        ? 'Go back to the canvas. Nothing is lost either way; both edit the same file.'
                        : vimMode
                          ? 'Edit this workflow as text · e'
                          : 'Edit this workflow as text'
                    }
                    onClick={() => (textMode ? hideText() : revealText())}
                  >
                    <PencilIcon className="h-3.5 w-3.5" />
                    {textMode ? 'Edit on canvas' : 'Edit as text'}
                  </Button>
                )}
                {!textMode && selected !== null && (
                  // Sharing lives beside Delete rather than in the row menu
                  // alone: the file on screen is the one someone wants to send,
                  // and a menu two clicks away is where a feature goes to be
                  // undiscovered. Hidden while the TEXT editor is open, because
                  // what travels is the file and text is the one surface that
                  // holds something the file has not agreed to yet; a canvas
                  // edit is on its way to disk already.
                  <Button
                    variant="ghost"
                    aria-haspopup="menu"
                    aria-expanded={exportMenu !== null}
                    title="Share this workflow as text or as a file · y copies it"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      setExportMenu({ x: rect.left, y: rect.bottom + 4 })
                    }}
                  >
                    Export
                  </Button>
                )}
                {exportMenu !== null && selected !== null && (
                  <ContextMenu
                    x={exportMenu.x}
                    y={exportMenu.y}
                    items={[
                      {
                        label: 'Copy workflow',
                        hint: menuHint('y'),
                        onSelect: () => void copyWorkflow(selected)
                      },
                      ...(canExportFile
                        ? [
                            {
                              label: 'Export to file…',
                              onSelect: () => void exportWorkflowToFile(selected)
                            }
                          ]
                        : [])
                    ]}
                    onClose={() => setExportMenu(null)}
                  />
                )}
                {!textMode && canDelete && selected && (
                  <Button variant="ghost" onClick={() => void removeWorkflow(selected)}>
                    <TrashIcon className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                )}
                {/* Only the TEXT editor keeps them. A half-typed pipeline is a
                    real intermediate state, so it is written when the author
                    says so and discarded when they say that instead. Every
                    other edit in this view is a completed act and autosaves. */}
                {textMode && draft !== null && (
                  <>
                    <Button variant="ghost" onClick={() => void closeEditor()}>
                      Cancel
                    </Button>
                    <Button variant="primary" disabled={saving} onClick={() => void saveDraft()}>
                      {saving ? 'Saving…' : 'Save'}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {writeError && (
            <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-4 py-1.5 text-xs text-danger">
              {writeError}
            </div>
          )}

          {runError && (
            <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-4 py-1.5 text-xs text-danger">
              Could not run this workflow: {runError}
            </div>
          )}

          {runRecord && (
            <RunRecordCard
              record={runRecord}
              canUndo={canUndoRuns}
              undoing={undoing}
              onUndo={() => void undoRun()}
              onDismiss={() => setRecord(null)}
            />
          )}

          {/* The canvas is the default surface; the text editor is a view of the
              same draft, one toggle away. Both branches render the canvas, so a
              structural edit made from either one shows up in both. */}
          {textMode && draft !== null ? (
            <>
              {/* Text above, graph below: the file is one statement per line, so
                  the eye travels between a line and its nodes vertically, and a
                  narrow pane never squeezes either of them into a column. */}
              <div className="flex min-h-0 flex-[3] flex-col border-b border-paper-300/50">
                {/* `relative` so the completion popup can be positioned in the
                    textarea's own coordinates: it is measured from the caret,
                    and the caret is measured inside this box. */}
                <div className="relative flex min-h-0 flex-1">
                  <textarea
                    ref={editorRef}
                    value={draft.text}
                    onChange={(event) => {
                      const el = event.target
                      const text = el.value
                      // Typing is the one thing that always revives a dismissed
                      // popup: Escape means "not for this caret", not "never".
                      suggestOff.current = false
                      setDraft((current) => (current === null ? null : { ...current, text }))
                      // `data` is the character this input inserted, and null for
                      // a delete or a paste. It is the only reliable way to tell
                      // "typed a letter" from "removed one" on a change event.
                      const data =
                        event.nativeEvent instanceof InputEvent ? event.nativeEvent.data : null
                      const trigger = triggerForInput(data, text, el.selectionStart)
                      // An edit that opens nothing still refilters what is open:
                      // backspacing a letter should narrow the list back, not
                      // freeze it on a prefix that is no longer there.
                      if (trigger !== null) refreshSuggest(trigger)
                      else followSuggest()
                    }}
                    onKeyDown={onEditorKeyDown}
                    onKeyUp={(event) => {
                      // Caret movement only, and only to FOLLOW a popup that is
                      // already open. Moving the caret is not a question, so it
                      // can close the popup but never open one.
                      if (!CARET_KEYS.has(event.key)) return
                      const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown'
                      // Consumed on the way down to walk the list.
                      if (suggest !== null && vertical) return
                      followSuggest()
                    }}
                    onClick={() => {
                      // Putting the caret somewhere by hand is a new position,
                      // so a dismissal from the old one does not carry over. It
                      // is still not a request: clicking into a word gets you a
                      // caret, not a popup.
                      suggestOff.current = false
                      followSuggest()
                    }}
                    // The popup is anchored to a caret that scrolled, so it has
                    // to move with it rather than float over the wrong line.
                    onScroll={() => {
                      // The same question, redrawn: a scroll must not turn an
                      // explicit list into a filtered one behind the user's back.
                      if (suggest !== null) refreshSuggest(suggestTrigger.current)
                    }}
                    // Clicking a completion never blurs (see the popup's
                    // `onMouseDown`), so a blur means focus genuinely left the
                    // editor and the popup has nothing left to complete into.
                    onBlur={() => setSuggest(null)}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    autoComplete="off"
                    // No soft wrapping: a wrapped line would make the line the eye
                    // counts differ from the line a diagnostic names.
                    wrap="off"
                    aria-label={`${active?.workflow.name ?? 'Workflow'} source`}
                    aria-autocomplete="list"
                    aria-expanded={suggest !== null}
                    className="min-h-0 w-full flex-1 resize-none bg-paper-50 px-4 py-3 font-mono text-xs leading-relaxed text-ink-900 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40"
                  />
                  {suggest !== null && (
                    <SuggestPopup
                      suggest={suggest}
                      index={suggestIndex}
                      listRef={suggestListRef}
                      onHover={setSuggestIndex}
                      onAccept={acceptSuggestion}
                    />
                  )}
                </div>
                <div className="max-h-32 shrink-0 overflow-auto border-t border-paper-300/50 bg-paper-50/70 px-4 py-2">
                  <div className="mb-1 flex items-center gap-2">
                    <h4 className="text-2xs font-semibold uppercase tracking-wide text-ink-500">
                      Diagnostics
                    </h4>
                    <span className="text-2xs text-ink-400">
                      {diagnostics.length === 0
                        ? 'none'
                        : `${diagnostics.length} ${diagnostics.length === 1 ? 'issue' : 'issues'}`}
                    </span>
                  </div>
                  {diagnostics.length === 0 ? (
                    // A file mid-edit is usually invalid, so the two states have
                    // to read the same way: informative, never alarming.
                    <p className="text-xs text-ink-500">
                      This workflow parses cleanly. Every wire below carries a live count.
                    </p>
                  ) : (
                    <DiagnosticsList
                      diagnostics={diagnostics}
                      lineOffset={lineOffset}
                      onSelectLine={jumpToLine}
                    />
                  )}
                </div>
              </div>

              <div className="flex min-h-0 flex-[2] flex-col">{canvasPane}</div>

              <div className="flex shrink-0 items-center gap-2 border-t border-paper-300/50 bg-paper-50/60 px-4 py-1.5 text-2xs text-ink-400">
                <span>
                  {plan
                    ? `${plan.ops.length} planned ${plan.ops.length === 1 ? 'change' : 'changes'}`
                    : 'not planned'}
                </span>
                <span className="ml-auto truncate">{vaultNote}</span>
              </div>
            </>
          ) : (
            <>
              {diagnostics.length > 0 && (
                <div className="max-h-28 shrink-0 overflow-auto border-b border-paper-300/50 bg-paper-50/70 px-4 py-2">
                  <DiagnosticsList diagnostics={diagnostics} lineOffset={lineOffset} />
                </div>
              )}

              <div className="flex min-h-0 flex-1 flex-col">{canvasPane}</div>

              <div className="max-h-64 shrink-0 overflow-auto border-t border-paper-300/50 bg-paper-50/60">
                <div className="flex items-center gap-2 px-4 py-2">
                  <h4 className="text-2xs font-semibold uppercase tracking-wide text-ink-500">
                    Dry run
                  </h4>
                  <span className="text-2xs text-ink-400">
                    {plan
                      ? `${plan.ops.length} planned ${plan.ops.length === 1 ? 'change' : 'changes'}`
                      : 'not planned'}
                  </span>
                  <span className="ml-auto text-2xs text-ink-400">{vaultNote}</span>
                </div>

                {plan && plan.irreversible.length > 0 && (
                  <div className="mx-4 mb-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                    <span className="font-semibold">
                      {plan.irreversible.length}{' '}
                      {plan.irreversible.length === 1 ? 'operation' : 'operations'} cannot be
                      undone.
                    </span>{' '}
                    Notifications and clipboard writes leave nothing to roll back.
                  </div>
                )}

                {plan && summaries.length === 0 && (
                  <p className="px-4 pb-3 text-xs text-ink-500">
                    This workflow only reads. Running it would change nothing.
                  </p>
                )}

                {summaries.length > 0 && (
                  <ul className="flex flex-col gap-0.5 px-4 pb-3">
                    {summaries.map((summary) => (
                      <li
                        key={summary.label}
                        title={pathsTooltip(summary)}
                        className="flex items-baseline gap-2 font-mono text-xs text-ink-700"
                      >
                        <span className="min-w-0 truncate">{summary.label}</span>
                        {summary.count > 1 && (
                          <span className="shrink-0 text-ink-400">×{summary.count}</span>
                        )}
                        {summary.irreversible && (
                          <span className="shrink-0 font-sans text-2xs uppercase tracking-wide text-danger">
                            no undo
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
        {reference}
      </div>
      {gallery}
      {stepPicker}
      {importDialog}
      {tutorial}
    </div>
  )
}

/**
 * The diagnostics under a workflow, merged from parse, validate and plan.
 *
 * `lineOffset` turns the parser's body-relative line into the line of the file
 * on screen. `onSelectLine` is set only in the editor, where a line number can
 * actually be jumped to; without it the rows are plain text rather than
 * controls that do nothing when clicked.
 */
function DiagnosticsList({
  diagnostics,
  lineOffset,
  onSelectLine
}: {
  diagnostics: Diagnostic[]
  lineOffset: number
  onSelectLine?: (line: number) => void
}): JSX.Element {
  return (
    <ul className="flex flex-col gap-0.5">
      {diagnostics.map((diagnostic, index) => {
        const where = diagnostic.line > 0 ? `line ${diagnostic.line + lineOffset}` : 'file'
        const body = (
          <>
            <span className="shrink-0 font-mono text-2xs opacity-70">{where}</span>
            <span className="min-w-0 text-left">{diagnostic.message}</span>
          </>
        )
        return (
          <li
            key={`${diagnostic.line}-${index}`}
            className={`text-xs ${diagnostic.severity === 'error' ? 'text-danger' : 'text-warning'}`}
          >
            {onSelectLine ? (
              <button
                type="button"
                onClick={() => onSelectLine(diagnostic.line)}
                title="Go to this line"
                className="flex w-full gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-paper-200/60"
              >
                {body}
              </button>
            ) : (
              <div className="flex gap-2 px-1 py-0.5">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * What a run did, kept on screen until the author dismisses it.
 *
 * This is the only thing in the view that outlives the state it describes, and
 * deliberately so: everything else here is a projection of a file, but a run
 * changed notes, and a change to someone's notes has to leave a record they
 * dismiss rather than one that expires. Undo lives here because this is the one
 * place that knows the run id.
 */
function RunRecordCard({
  record,
  canUndo,
  undoing,
  onUndo,
  onDismiss
}: {
  record: WorkflowRunRecord
  canUndo: boolean
  undoing: boolean
  onUndo: () => void
  onDismiss: () => void
}): JSX.Element {
  const { receipt, undone, undoError } = record
  const rolledBack = receipt.rolledBack
  const irreversible = irreversibleNote(receipt)
  // Undo is offered only while there is something to restore: see
  // `canUndoReceipt`. A bridge without the method offers nothing at all.
  const offerUndo = canUndo && undone === null && canUndoReceipt(receipt)
  return (
    <div
      className={`shrink-0 border-b px-4 py-2 ${
        rolledBack ? 'border-danger/30 bg-danger/10' : 'border-paper-300/50 bg-paper-50'
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className={`text-xs font-semibold ${rolledBack ? 'text-danger' : 'text-ink-900'}`}>
            {undone ? undoneHeadline(undone) : receiptHeadline(receipt)}
          </div>
          {rolledBack && <div className="mt-0.5 text-xs text-danger">{rolledBack.reason}</div>}
          {undone && (
            // The run stays on the record. Undoing it is a second event, not an
            // erasure of the first.
            <div className="mt-0.5 text-2xs text-ink-500">{receiptHeadline(receipt)}</div>
          )}
          {!rolledBack && receipt.paths.length > 0 && (
            <div
              title={receipt.paths.join('\n')}
              className="mt-0.5 truncate font-mono text-2xs text-ink-500"
            >
              {receipt.paths.join(' · ')}
            </div>
          )}
          {irreversible && <div className="mt-0.5 text-2xs text-warning">{irreversible}</div>}
          {undoError && <div className="mt-0.5 text-xs text-danger">Undo failed: {undoError}</div>}
        </div>
        {offerUndo && (
          <Button
            variant="secondary"
            disabled={undoing}
            title="Restore every file this run wrote to the bytes it had before"
            onClick={onUndo}
          >
            {undoing ? 'Undoing…' : undoLabel(receipt)}
          </Button>
        )}
        <IconButton
          size="sm"
          title="Dismiss this run record"
          aria-label="Dismiss run record"
          onClick={onDismiss}
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  )
}

function WorkflowsHeader({
  count,
  vimMode,
  editing,
  canCreate,
  canRun,
  referenceOpen,
  importItems,
  onCreate,
  onToggleReference,
  onReload
}: {
  count: number
  vimMode: boolean
  editing: boolean
  canCreate: boolean
  canRun: boolean
  referenceOpen: boolean
  /** Empty where nothing can be imported, which hides the button entirely. */
  importItems: ContextMenuItem[]
  onCreate: () => void
  onToggleReference: () => void
  onReload: () => void
}): JSX.Element {
  // Where the Import menu is drawn. Anchored to the button rather than to the
  // pointer, so the keyboard opens it in the same place a click does.
  const [importMenu, setImportMenu] = useState<{ x: number; y: number } | null>(null)
  const importRef = useRef<HTMLButtonElement>(null)
  // The hint has to describe the mode you are actually in and offer only keys
  // that actually fire: the single-letter shortcuts are Vim-mode only (the same
  // rule every other list view follows), and an empty vault has nothing to
  // move through or open. Every binding this view added is in here too, because
  // a hint that lists half the keyboard is how someone concludes the other half
  // does not exist.
  const hint = editing
    ? // Through the formatter so the chords read ⌘S / ⌘/ on macOS and Ctrl+…
      // elsewhere.
      [
        `${formatKeyToken('Mod+S')} saves`,
        // Typing a prefix opens the popup on its own, but asking on an empty
        // slot needs a key, so that key has to be written down somewhere the
        // user is already looking. macOS gets the chord it can actually press:
        // Ctrl+Space there belongs to the system input-source switcher whenever
        // the user has more than one layout.
        `${formatKeyToken(isMacPlatform() ? 'Mod+I' : 'Ctrl+Space')} completes`,
        `${formatKeyToken('Mod+/')} syntax`,
        'Esc exits'
      ].join(' · ')
    : count === 0
      ? // Nothing to list means the only things on screen are the three
        // labelled buttons beside this hint, so spelling their keys out here
        // just says the same thing twice on the emptiest screen in the app.
        // The primary button carries its own key in its tooltip.
        ''
      : vimMode
        ? [
            'j / k move',
            'Enter opens',
            // Straight after the two motions, because it is the key that reveals
            // every other one: the menu it opens lists Run, Edit as text,
            // Duplicate, Reveal, New and Delete with their own letters beside
            // them, so it is also how the rest of this hint is discovered.
            'm menu',
            // Offered only where a run can actually happen; `R` does nothing in
            // a workspace whose bridge cannot apply one.
            ...(canRun ? ['R run'] : []),
            // Next to Run, because it is what makes Run possible: a draft is
            // saved but inert, and `t` is the whole of arming and disarming one.
            ...(canCreate ? ['t draft/active'] : []),
            // The canvas keys come first among the authoring ones, because the
            // canvas is what is on screen: `a` adds a step and `e` is the way
            // to the text, which is now the second surface rather than the
            // only one.
            ...(canCreate ? ['a add step', 'e text'] : []),
            'n new',
            // Sharing, both directions, next to each other so the pair is
            // learned as a pair: y takes one out, p brings one in.
            'y copy',
            ...(importItems.length > 0 ? ['p paste'] : []),
            'd delete',
            '? syntax',
            'r reload'
          ].join(' · ')
        : // Vim off takes the single letters with it, so the menu is offered by
          // the key that is never gated. It is the only way left to reach
          // Duplicate and Reveal without a mouse.
          'Arrows move · Enter opens · Shift+F10 menu'
  return (
    <header className="glass-header flex h-12 shrink-0 items-center gap-2 px-4">
      <ZapIcon className="h-4 w-4 shrink-0 text-ink-500" />
      <h2 className="text-sm font-semibold text-ink-900">Workflows</h2>
      <span className="shrink-0 text-xs text-ink-500">{count}</span>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-2xs text-ink-400">{hint}</span>
        <Button
          variant="ghost"
          aria-pressed={referenceOpen}
          title={
            editing
              ? `Every step you can write, with its arguments · ${formatKeyToken('Mod+/')}`
              : 'Every step you can write, with its arguments · ?'
          }
          onClick={onToggleReference}
        >
          Syntax
        </Button>
        {importItems.length > 0 && (
          // Beside New workflow, because it answers the same question from the
          // other end: the community writes these, and a workflow someone sent
          // you should not need a menu hunt to get in.
          <Button
            ref={importRef}
            variant="ghost"
            aria-haspopup="menu"
            aria-expanded={importMenu !== null}
            title="Bring in a workflow someone shared with you · p"
            onClick={() => {
              const rect = importRef.current?.getBoundingClientRect()
              setImportMenu({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 })
            }}
          >
            Import
          </Button>
        )}
        {canCreate && (
          // Labelled, and the emphasized action in this header: "how do I make
          // one" was being answered by a bare plus sign in a row of words.
          <Button variant="primary" title="Start from a recipe · n" onClick={onCreate}>
            <PlusIcon className="h-3.5 w-3.5" />
            New workflow
          </Button>
        )}
        {importMenu !== null && (
          <ContextMenu
            x={importMenu.x}
            y={importMenu.y}
            items={importItems}
            onClose={() => setImportMenu(null)}
          />
        )}
        <Button variant="ghost" title="Read the workflows again from disk · r" onClick={onReload}>
          Reload
        </Button>
      </div>
    </header>
  )
}

/* -------------------------------------------------------------------------- */
/*  Teaching surfaces                                                         */
/* -------------------------------------------------------------------------- */

/** One badge, wherever something is declared to change the vault. */
function WritesBadge(): JSX.Element {
  return (
    <span
      title="Running this plans changes to your notes. You confirm them first, and can undo them after."
      className="shrink-0 rounded bg-warning/20 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-warning"
    >
      writes
    </span>
  )
}

/**
 * A label with the part the user typed marked.
 *
 * The range comes from `suggestAt`, which did the matching, rather than being
 * re-derived from the text here: two implementations of "where did this match"
 * would eventually disagree, and the one on screen would be the wrong one.
 */
function MarkedLabel({ label, match }: { label: string; match?: MatchRange }): JSX.Element {
  if (!match || match.start < 0 || match.end <= match.start || match.end > label.length) {
    return <>{label}</>
  }
  return (
    <>
      {label.slice(0, match.start)}
      <mark className="bg-transparent font-semibold text-accent">
        {label.slice(match.start, match.end)}
      </mark>
      {label.slice(match.end)}
    </>
  )
}

/**
 * What the selected step means, beside the list that is selecting it.
 *
 * This is the answer to "show what it does": a list of verbs teaches nothing on
 * its own, and the reference panel is a different pane the user has to go and
 * open. Deliberately quiet, because it sits next to a list and is not a dialog:
 * no heading weight, no border of its own, one accent for the signature.
 */
function SuggestDocs({ item }: { item: Suggestion }): JSX.Element {
  // A tag or a path has no registry entry, so its one-line `detail` is the whole
  // documentation there is. Better than an empty pane that reads as broken.
  const description = item.description ?? item.detail
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-ink-900">{item.label}</span>
        <span className="shrink-0 text-2xs uppercase tracking-wide text-ink-400">{item.kind}</span>
      </div>
      {item.signature && (
        <p className="font-mono text-2xs text-ink-500">
          {item.label} <span className="text-accent">{item.signature}</span>
        </p>
      )}
      {description && <p className="text-2xs leading-relaxed text-ink-600">{description}</p>}
      {item.example && (
        <p className="whitespace-pre-wrap break-words rounded bg-paper-200/70 px-1.5 py-1 font-mono text-2xs text-ink-700">
          {item.example}
        </p>
      )}
    </div>
  )
}

/**
 * The completion popup, hung off the caret: the list, and what the selection
 * means.
 *
 * Rendered inline rather than in a portal: it belongs to the textarea it is
 * measured against, and a portal would have to track that element's position on
 * every scroll of every ancestor to say the same thing. Its width and placement
 * are decided by `suggestAnchor` against the pane, so it never covers the line
 * being typed and never runs off the edge.
 */
function SuggestPopup({
  suggest,
  index,
  listRef,
  onHover,
  onAccept
}: {
  suggest: ActiveSuggest
  index: number
  listRef: RefObject<HTMLUListElement>
  onHover: (index: number) => void
  onAccept: (item: Suggestion) => void
}): JSX.Element | null {
  const { anchor, items } = suggest
  if (items.length === 0) return null
  // The keyboard index is clamped rather than trusted: a refilter can shorten
  // the list between a key press and this render. Clamped ONCE and used for both
  // the highlight and the docs, so the pane can never describe a row other than
  // the one lit up beside it.
  const active = Math.min(Math.max(index, 0), items.length - 1)
  const selected = items[active]
  const beside = anchor.layout === 'beside'
  return (
    <div
      style={{
        left: anchor.left,
        width: anchor.width,
        maxHeight: SUGGEST_MAX_HEIGHT,
        ...(anchor.placement === 'below' ? { top: anchor.offset } : { bottom: anchor.offset })
      }}
      className={`absolute z-popover flex overflow-hidden rounded-lg border border-paper-300 bg-paper-100 shadow-float ${
        beside ? 'flex-row' : 'flex-col'
      }`}
    >
      <ul
        ref={listRef}
        role="listbox"
        aria-label="Completions"
        style={beside ? { width: SUGGEST_LIST_WIDTH } : undefined}
        className={`min-h-0 overflow-y-auto overflow-x-hidden py-1 ${
          beside ? 'shrink-0 border-r border-paper-300/70' : 'max-h-32 border-b border-paper-300/70'
        }`}
      >
        {items.map((item, i) => (
          <li key={`${item.kind}:${item.insert}:${i}`} role="presentation">
            <button
              type="button"
              data-suggest-index={i}
              role="option"
              aria-selected={i === active}
              // The caret is the whole context of a completion, and a blur takes
              // it away: mousedown is prevented so the textarea never loses focus.
              onMouseDown={(event) => {
                event.preventDefault()
                onAccept(item)
              }}
              onMouseMove={() => onHover(i)}
              className={`flex w-full items-baseline gap-2 px-2 py-1 text-left ${
                i === active ? 'bg-paper-200' : 'hover:bg-paper-200/60'
              }`}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-900">
                <MarkedLabel label={item.label} match={item.match} />
              </span>
              {/* The kind badge used to live here. The pane beside says it now,
                  and a 216px column is not the place to say it twice. */}
              {item.detail && (
                <span className="min-w-0 shrink truncate text-2xs text-ink-400">{item.detail}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <SuggestDocs item={selected} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Gallery                                                                   */
/* -------------------------------------------------------------------------- */

/** A row in the gallery: the blank file, or one of the recipes. */
type GalleryItem = { kind: 'preset'; id: string } | { kind: 'blank' }

/** Heading for the blank row, kept out of the preset categories on purpose. */
const BLANK_GROUP = 'Start from nothing'

/**
 * The front door: the blank file, then every recipe, grouped.
 *
 * A gallery rather than a blank editor because the format is small but not
 * guessable, and the fastest way to learn a pipeline language is to read four
 * working lines and change one of them. Blank sits at the top so someone who
 * already knows what they want is one Enter away from it, without scrolling
 * past eight recipes they have read before.
 *
 * Keyboard first, like every list in this app: arrows or j/k move, Enter picks,
 * Escape cancels. There is deliberately no filter box, because a text field
 * would take j and k away from the list they belong to.
 */
function WorkflowGallery({
  onPick,
  onBlank,
  onClose
}: {
  onPick: (preset: WorkflowPreset) => void
  onBlank: () => void
  onClose: () => void
}): JSX.Element {
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const keysRef = useRef<HTMLInputElement>(null)
  const vimMode = useStore((s) => s.vimMode)
  const hiddenPresets = useStore((s) => s.hiddenWorkflowPresets)
  const hidePreset = useStore((s) => s.hideWorkflowPreset)

  // Grouped and ordered by `PRESET_CATEGORIES`, which the presets module
  // declares as "the gallery's tab order, stated here so the view does not
  // invent its own". A category with nothing in it is dropped rather than shown
  // as an empty heading.
  const groups = useMemo(() => {
    // Blank goes FIRST. It was last on the reasoning that a newcomer should read
    // working examples before facing an empty file, but that buries the one row
    // a returning user wants under eight they have already read, and the cursor
    // starts on it so Enter is the fast path to a blank file.
    const out: { title: string; items: GalleryItem[] }[] = [
      { title: BLANK_GROUP, items: [{ kind: 'blank' }] }
    ]
    for (const category of PRESET_CATEGORIES) {
      const items: GalleryItem[] = visiblePresetsByCategory(category, hiddenPresets).map(
        (preset) => ({
          kind: 'preset',
          id: preset.id
        })
      )
      if (items.length > 0) out.push({ title: category, items })
    }
    // A hidden recipe leaves the gallery ENTIRELY: no greyed pile at the
    // bottom to scroll past, which on an all-hidden gallery would be taller
    // than the gallery itself. The footer carries a one-line breadcrumb to
    // Settings → Workflows, which is where Hide all / Restore all live.
    return out
  }, [hiddenPresets])

  // One flat index across the groups: the cursor moves through rows, not
  // through headings.
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const starts = useMemo(() => {
    let next = 0
    return groups.map((group) => {
      const start = next
      next += group.items.length
      return start
    })
  }, [groups])

  useEffect(() => {
    keysRef.current?.focus()
  }, [])

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-gallery-index="${cursor}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  // Hiding the last row of the list (or restoring the only hidden one) shrinks
  // `flat`; the cursor must land on a row that still exists.
  useEffect(() => {
    setCursor((index) => Math.max(0, Math.min(flat.length - 1, index)))
  }, [flat.length])

  const choose = (item: GalleryItem): void => {
    if (item.kind === 'blank') {
      onBlank()
      return
    }
    const preset = presetById(item.id)
    if (preset) onPick(preset)
  }

  /** `x` (the gallery's dialect, like its j/k) and Delete/Backspace: hide the
   *  recipe under the cursor. Blank is furniture. Restoring lives in
   *  Settings → Workflows, where Hide all sits next to Restore all. */
  const hideAtCursor = (): void => {
    const item = flat[cursor]
    if (item?.kind === 'preset') hidePreset(item.id)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const move = (delta: number): void => {
      event.preventDefault()
      event.stopPropagation()
      setCursor((index) => Math.max(0, Math.min(flat.length - 1, index + delta)))
    }
    // The house rule, which this modal used to be the one exception to: a plain
    // letter is a Vim-mode key. The read-only field means they could never
    // steal typed input, but "j moves" being true here and false in the list
    // behind it is the kind of split someone has to discover twice. Named keys
    // (arrows, Enter, Escape, Delete) stay universal, so the gallery is never
    // mouse-only with Vim off.
    const letter = (key: string): boolean => vimMode && event.key === key
    if (isPaletteNextKey(event) || letter('j')) {
      move(1)
      return
    }
    if (isPalettePreviousKey(event) || letter('k')) {
      move(-1)
      return
    }
    if (event.key === 'Home' || letter('g')) {
      event.preventDefault()
      setCursor(0)
      return
    }
    if (event.key === 'End' || letter('G')) {
      event.preventDefault()
      setCursor(Math.max(0, flat.length - 1))
      return
    }
    if (letter('x') || event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      hideAtCursor()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      const item = flat[cursor]
      if (item) choose(item)
    }
  }

  return (
    <Modal
      size="2xl"
      layer="modal"
      align="top"
      onClose={onClose}
      labelledBy="workflow-gallery-title"
    >
      <div className="border-b border-paper-300/70 px-5 py-4">
        <div id="workflow-gallery-title" className="text-sm font-semibold text-ink-900">
          New workflow
        </div>
        <p className="mt-1 text-xs text-ink-500">
          The recipe gallery: every one of these is a working workflow you can read and change. It
          arrives as a draft, so it cannot run until you activate it.
        </p>
      </div>
      {/* The keyboard lives on a read-only text field, not on the list.
          `VimNav`'s global capture listener runs before any handler inside this
          modal and routes j / k / arrows / Enter to the sidebar unless the
          event came from a text field, which is exactly how every palette in
          this app takes the keyboard. Read-only because the keys here are
          motions, not input: there is nothing to type. */}
      <input
        ref={keysRef}
        readOnly
        role="combobox"
        aria-expanded="true"
        aria-controls="workflow-gallery-list"
        aria-label="Workflow recipes"
        aria-activedescendant={`workflow-preset-${cursor}`}
        onKeyDown={onKeyDown}
        className="sr-only"
      />
      <div
        ref={listRef}
        id="workflow-gallery-list"
        role="listbox"
        aria-label="Workflow recipes"
        className="max-h-[52vh] overflow-y-auto px-2 py-2 outline-none"
      >
        {groups.map((group, groupIndex) => (
          <div key={group.title} className="mb-2 last:mb-0">
            <div className="px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-ink-400">
              {group.title}
            </div>
            {group.items.map((item, itemIndex) => {
              const index = starts[groupIndex] + itemIndex
              const preset = item.kind === 'preset' ? presetById(item.id) : null
              return (
                // A div, not a button, because the row carries a real button of
                // its own (hide) and interactive content may not nest. The
                // keyboard never focuses rows either way: it lives on the
                // combobox field, listbox-style.
                <div
                  key={item.kind === 'blank' ? 'blank' : item.id}
                  id={`workflow-preset-${index}`}
                  data-gallery-index={index}
                  role="option"
                  aria-selected={index === cursor}
                  // Focus stays on the field that owns the keys, so a click and
                  // then an arrow key still moves this list rather than
                  // stranding the keyboard on a row.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item)}
                  onMouseMove={() => setCursor(index)}
                  className={`group mb-1 flex w-full cursor-pointer items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                    index === cursor ? 'bg-paper-200' : 'hover:bg-paper-200/60'
                  }`}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-ink-900">
                        {preset ? preset.name : 'Blank workflow'}
                      </span>
                      {preset?.mutating && <WritesBadge />}
                    </span>
                    <span className="text-xs text-ink-600">
                      {preset
                        ? preset.description
                        : 'A starter file with one pipeline in it, for when you already know what you want.'}
                    </span>
                    {preset && (
                      // The rationale, not a second description: why anyone would
                      // want this workflow, which is the part a name cannot carry.
                      <span className="text-2xs text-ink-400">{preset.rationale}</span>
                    )}
                  </div>
                  {item.kind === 'preset' && (
                    // The mouse's way to hide. Revealed on hover or cursor so
                    // the gallery does not read as eight delete buttons.
                    <IconButton
                      size="sm"
                      aria-label={`Hide ${preset?.name ?? 'recipe'} from the gallery`}
                      title={vimMode ? 'Hide from the gallery (x)' : 'Hide from the gallery (del)'}
                      tabIndex={-1}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation()
                        hidePreset(item.id)
                      }}
                      className={`transition-opacity ${
                        index === cursor ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      }`}
                    >
                      <CloseIcon className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-paper-300/70 bg-paper-50 px-5 py-2 text-2xs text-ink-500">
        {/* Where the recipes went, since they leave without a trace above. */}
        <span className="min-w-0 truncate text-ink-400">
          {hiddenPresetsInOrder(hiddenPresets).length > 0
            ? `${hiddenPresetsInOrder(hiddenPresets).length} hidden · restore under Settings → Workflows`
            : ''}
        </span>
        {/* Vocabulary follows the mode, like the view's own header hint: with
            Vim off the letters do nothing, and offering them is how someone
            concludes the gallery is broken. */}
        <span className="flex shrink-0 items-center gap-4">
          <span>
            <kbd className="rounded bg-paper-200 px-1">↑↓</kbd>
            {vimMode && (
              <>
                {' '}
                <kbd className="rounded bg-paper-200 px-1">j / k</kbd>
              </>
            )}{' '}
            move
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">↵</kbd> create
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">{vimMode ? 'x' : 'del'}</kbd> hide
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd> cancel
          </span>
        </span>
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/*  Reference                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every step the language has, written out from `NODE_DEFS`.
 *
 * A panel rather than a modal, and that is the whole design: the entries insert
 * themselves at the caret, so it has to be readable WHILE typing. A dialog
 * would take the focus, and with it the caret it was about to write into.
 *
 * Nothing here is a second copy of the language. Kinds, categories, params and
 * titles are all read off the registry, so a node added to `NODE_DEFS` shows up
 * here on the same commit, and one that is renamed cannot leave a lie behind.
 */
function SyntaxReference({
  onInsert,
  onClose
}: {
  /** Null in the read-only view, where there is no caret to insert into. */
  onInsert: ((snippet: string) => void) | null
  onClose: () => void
}): JSX.Element {
  return (
    <aside
      aria-label="Workflow syntax"
      className="flex w-80 shrink-0 flex-col border-l border-paper-300/50 bg-paper-50"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-paper-300/50 px-3 py-2">
        <h3 className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Syntax</h3>
        <IconButton
          size="sm"
          className="ml-auto"
          title="Hide the syntax reference"
          aria-label="Hide the syntax reference"
          onClick={onClose}
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <ul className="mb-3 flex flex-col gap-1.5">
          {MODEL_RULES.map((rule) => (
            <li key={rule} className="text-xs leading-relaxed text-ink-600">
              {rule}
            </li>
          ))}
        </ul>
        <p className="mb-4 text-2xs text-ink-400">
          In the signatures below, a [bracketed] argument is optional.
          {onInsert ? ' Click any step to write it at the caret.' : ''}
        </p>

        <div className="mb-4">
          <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-400">
            File header
          </div>
          <ul className="flex flex-col gap-1">
            {HEADER_KEYS.map((key) => (
              <li key={key} className="text-xs text-ink-600">
                <span className="font-mono text-ink-900">{key}:</span>{' '}
                {HEADER_KEY_HELP[key] ?? ''}
              </li>
            ))}
          </ul>
        </div>

        {REFERENCE_GROUPS.map((group) => (
          <div key={group.category} className="mb-4">
            <div className="text-2xs font-semibold uppercase tracking-wide text-ink-400">
              {CATEGORY_TITLE[group.category]}
            </div>
            <p className="mb-1.5 mt-0.5 text-2xs leading-relaxed text-ink-500">
              {CATEGORY_BLURB[group.category]}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.defs.map((def) => {
                const body = (
                  <>
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate font-mono text-xs text-ink-900">
                        {stepSignature(def)}
                      </span>
                      {def.mutating && <WritesBadge />}
                    </span>
                    <span className="text-2xs text-ink-500">{def.title}</span>
                  </>
                )
                return (
                  <li key={def.kind}>
                    {onInsert ? (
                      <button
                        type="button"
                        // The verb and a space, not the whole signature: what
                        // lands in the file has to be text the parser can read,
                        // and the completions take over from the space onwards
                        // with this vault's own tags, fields and paths.
                        onClick={() => onInsert(`${def.kind} `)}
                        title={`Insert \`${def.kind}\` at the caret`}
                        className="flex w-full flex-col gap-0.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-paper-200/70"
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="flex flex-col gap-0.5 px-1.5 py-1">{body}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </aside>
  )
}
