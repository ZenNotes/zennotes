// The workflow engine: turn a parsed `Workflow` into a `RunPlan`.
//
// The invariant that shapes every line below is that this module NEVER writes.
// It reads the vault through `VaultReader` (which has no write method) and
// returns `WorkflowOp`s for the caller to apply. Dry run is therefore not a flag
// somebody can forget to pass, it is the only thing the engine is able to do.
//
// Four rules keep the rest of the file honest:
//
//   1. Nothing throws. A missing arg, an uncompilable pattern, an unknown wire,
//      a reader that rejects: each becomes a `Diagnostic` and the plan carries
//      on. A half-written workflow still has to plan, because the canvas draws
//      the plan and the author is editing while looking at it.
//   2. A step that cannot be evaluated never *widens* the note set. It yields
//      the empty set (an unevaluable filter matches nothing) or aborts the rest
//      of that one pipeline. The engine must never invent a write the author did
//      not ask for, and every failure mode is chosen with that in mind.
//   3. A statement that raised an ERROR contributes no ops at all. Rule 2 hands
//      a broken filter the empty set, and an empty set is a perfectly good thing
//      to render, so `all | where title matches [unclosed | write "Report.md"`
//      planned a zero-byte overwrite of the report right next to the diagnostic
//      saying the filter never ran. The diagnostics survive, the writes do not.
//      A wire that is genuinely empty and raised nothing still writes, because
//      an empty report is a report somebody asked for. The limits go through the
//      same rule: a run stopped by `maxOps` or `maxDepth` leaves behind the
//      statements that fitted whole, and never half of one, so a note can never
//      end up with the first of its two tags and not the second.
//   4. Note bodies are read lazily, only for steps whose `NodeDef.needsBody` is
//      set, only for the notes actually on the wire at that point, and cached
//      for the whole run including across `call` recursion. A `where` over 5000
//      notes therefore touches disk exactly zero times.
//
// Statements are executed in dependency order rather than file order, so an
// author can reference a wire defined lower down. Cycles are a static error
// (see `validate`), but a resolver that changes between runs can still build one
// dynamically, which is what `maxDepth` and `maxOps` are for.

import { compileMatcher } from './matches'
import type { Matcher } from './matches'
import { isCompareOp, nodeDef, RENDER_STYLES } from './nodes'
import type { CompareOp, NodeDef, RenderStyle } from './nodes'
import {
  folderPathProblem,
  folderTarget,
  moveTarget,
  noteExtensionOf,
  notePathProblem,
  NOTE_EXTENSIONS,
  relBasename,
  relDirname,
  renameTarget,
  stripNoteExtension
} from './paths'
import { parseFrontmatter } from '../template-files'
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_OPS, IRREVERSIBLE_OP_KINDS, isRunnable } from './types'
import type {
  Diagnostic,
  NoteSet,
  PlanContext,
  RunPlan,
  Workflow,
  WorkflowNote,
  WorkflowOp,
  WorkflowStatement,
  WorkflowStep
} from './types'

/* -------------------------------------------------------------------------- */
/*  Run state                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Everything that lives for the whole run, including nested `call`s.
 *
 * The caches (`notes`, `bodies`) and the budgets (`ops`, `stopped`) are shared
 * by every workflow in the call tree on purpose: a child that re-reads the same
 * note, or that blows past `maxOps` on its own, would defeat the point of having
 * a ceiling at all.
 *
 * `prefix` is the wire namespace of the workflow currently running (`''` at the
 * top level, `parent-child.` inside a call). It doubles as the diagnostic label
 * so a message from a called workflow is attributable, since `Diagnostic` has a
 * line but no source file.
 */
interface RunState {
  ctx: PlanContext
  ops: WorkflowOp[]
  diagnostics: Diagnostic[]
  wires: Record<string, NoteSet>
  /** path -> body, so a path is read at most once per run. */
  bodies: Map<string, string>
  /** `listNotes()` result, or null until the first source asks for it. */
  notes: WorkflowNote[] | null
  /** Every path a `create-each` has already claimed, so two notes with the same
   *  title cannot plan the same new note twice. See `uniqueCreatePath`. */
  created: Set<string>
  /** Error diagnostics so far. `runStatement` reads it before and after a
   *  statement to decide whether that statement may keep its ops (rule 3). */
  errors: number
  maxDepth: number
  maxOps: number
  /** Set when a limit was hit. Every loop checks it and unwinds. */
  stopped: boolean
  prefix: string
}

/** What a step hands to the next one: the wire, plus any rendered text. */
interface StepResult {
  notes: NoteSet
  /** Text produced by a preceding `render`, for a `consumesText` sink. */
  text: string | null
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Plan a run: resolve every wire, and collect the ops the caller would apply.
 *
 * Returns a partial plan rather than failing when something is wrong, because
 * the diagnostics are the product too: the editor shows them next to the step
 * that produced them while the rest of the graph keeps rendering.
 */
export async function planWorkflow(workflow: Workflow, ctx: PlanContext): Promise<RunPlan> {
  const state: RunState = {
    ctx,
    ops: [],
    diagnostics: [],
    wires: {},
    bodies: new Map(),
    notes: null,
    created: new Set(),
    errors: 0,
    maxDepth: ctx.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxOps: ctx.maxOps ?? DEFAULT_MAX_OPS,
    stopped: false,
    prefix: ''
  }

  await runWorkflow(workflow, state, 0)

  return {
    ops: state.ops,
    wires: state.wires,
    diagnostics: state.diagnostics,
    irreversible: state.ops.filter((op) => IRREVERSIBLE_OP_KINDS.has(op.kind))
  }
}

/* -------------------------------------------------------------------------- */
/*  Diagnostics                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Record a diagnostic, and with an error also record that SOMETHING in the
 * statement being evaluated could not be worked out. `runStatement` reads the
 * count to decide whether the ops that statement planned are trustworthy, which
 * is rule 3 of the module header, so every error raised anywhere in this file
 * participates in that rule by construction rather than by remembering to.
 */
function diagnose(state: RunState, severity: Diagnostic['severity'], message: string, line: number): void {
  const label = state.prefix ? `${state.prefix.slice(0, -1)}: ` : ''
  state.diagnostics.push({ severity, message: `${label}${message}`, line })
  if (severity === 'error') state.errors += 1
}

function fail(state: RunState, message: string, line: number): null {
  diagnose(state, 'error', message, line)
  return null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/*  Statement ordering                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Order statements so every wire is produced before it is read.
 *
 * Dependencies come from two places: the wire a statement reads (`input`) and
 * the wire a `union`/`subtract` step reaches sideways for. A statement that
 * re-assigns its own name (`books = books | limit 5`) does not depend on itself,
 * which is what makes that idiom work instead of looking like a cycle.
 *
 * Anything left over when no statement is ready is cyclic. It is returned rather
 * than thrown so the caller can report every member of the cycle and still plan
 * the statements that are fine.
 */
function orderStatements(statements: readonly WorkflowStatement[]): {
  order: number[]
  cyclic: number[]
} {
  const producers = new Map<string, number[]>()
  statements.forEach((statement, index) => {
    if (!statement.name) return
    const existing = producers.get(statement.name)
    if (existing) existing.push(index)
    else producers.set(statement.name, [index])
  })

  const deps = statements.map((statement, index) => {
    const set = new Set<number>()
    const add = (wire: string | null | undefined): void => {
      if (!wire) return
      for (const producer of producers.get(wire) ?? []) {
        if (producer !== index) set.add(producer)
      }
    }
    add(statement.input)
    // Wire dependencies are found from the registry rather than by naming
    // `union` and `subtract`, so a future node that takes a wire is ordered
    // correctly the day it is added. `validate` derives them the same way, and
    // the two must agree or a graph would validate but run out of order.
    for (const step of statement.steps) {
      const def = nodeDef(step.kind)
      if (!def) continue
      for (const param of def.params) {
        if (param.type !== 'wire') continue
        const wire = step.args[param.name]
        if (typeof wire === 'string') add(wire)
      }
    }
    return set
  })

  const done = new Set<number>()
  const order: number[] = []
  let progressed = true
  while (progressed) {
    progressed = false
    for (let index = 0; index < statements.length; index++) {
      if (done.has(index)) continue
      let ready = true
      for (const dep of deps[index]) {
        if (!done.has(dep)) {
          ready = false
          break
        }
      }
      if (!ready) continue
      done.add(index)
      order.push(index)
      progressed = true
    }
  }

  const cyclic: number[] = []
  for (let index = 0; index < statements.length; index++) {
    if (!done.has(index)) cyclic.push(index)
  }
  return { order, cyclic }
}

/* -------------------------------------------------------------------------- */
/*  Running a workflow                                                        */
/* -------------------------------------------------------------------------- */

async function runWorkflow(workflow: Workflow, state: RunState, depth: number): Promise<void> {
  const scope = new Map<string, NoteSet>()
  const { order, cyclic } = orderStatements(workflow.statements)

  for (const index of cyclic) {
    const statement = workflow.statements[index]
    diagnose(
      state,
      'error',
      `\`${wireKey(statement)}\` is part of a cycle of wires and was skipped`,
      statement.line
    )
    // Still publish an (empty) wire: the canvas draws an edge per statement and
    // an edge without a count looks like a rendering bug rather than an error.
    setWire(state, statement, [])
  }

  for (const index of order) {
    if (state.stopped) return
    await runStatement(workflow.statements[index], state, scope, depth)
  }
}

function wireKey(statement: WorkflowStatement): string {
  return statement.name ?? `#${statement.line}`
}

function setWire(state: RunState, statement: WorkflowStatement, notes: NoteSet): void {
  state.wires[`${state.prefix}${wireKey(statement)}`] = notes
}

async function runStatement(
  statement: WorkflowStatement,
  state: RunState,
  scope: Map<string, NoteSet>,
  depth: number
): Promise<void> {
  let current: NoteSet = []
  const opsBefore = state.ops.length
  const errorsBefore = state.errors

  if (statement.input !== null) {
    const upstream = scope.get(statement.input)
    if (!upstream) {
      // Skip rather than run the pipeline over an empty set: a sink at the end
      // would otherwise emit an op (a notify, a cleared section) for a wire the
      // author never actually produced.
      diagnose(state, 'error', `unknown wire \`${statement.input}\``, statement.line)
      setWire(state, statement, [])
      return
    }
    current = [...upstream]
  } else {
    const first = statement.steps[0]
    const def = first ? nodeDef(first.kind) : null
    if (!def?.source) {
      diagnose(
        state,
        'error',
        'pipeline must start with a source or a wire name',
        statement.line
      )
      setWire(state, statement, [])
      return
    }
  }

  let text: string | null = null
  for (let index = 0; index < statement.steps.length; index += 1) {
    const step = statement.steps[index]
    if (state.stopped) break
    const def = nodeDef(step.kind)
    if (!def) {
      diagnose(state, 'error', `unknown step \`${step.kind}\``, step.line)
      break
    }
    // A source anywhere but the head of a sourceless statement would REPLACE the
    // wire with a fresh vault-wide query. `validate` already reports it; the
    // engine must also refuse to run it, because `books | tag #x | trash` would
    // otherwise plan a trash over every `#x` note in the vault, which is the
    // set-widening rule 2 exists to forbid. Same message as `validate`, so the
    // merged diagnostics show one row rather than two.
    if (def.source && (index > 0 || statement.input !== null)) {
      const message =
        index > 0
          ? `\`${def.kind}\` is a source, so it can only start a pipeline`
          : `\`${def.kind}\` is a source, so it cannot read from wire \`${statement.input}\``
      fail(state, message, step.line)
      break
    }
    // Sources fetch their own notes, so there is nothing on the wire to load for
    // them yet. `search` loads inside its own case, per note, and only when the
    // title has not already matched.
    if (def.needsBody && !def.source) current = await loadBodies(state, current, step.line)
    const result = await runStep(def, step, current, text, state, scope, depth)
    if (!result) break
    current = result.notes
    text = result.text
  }

  // Rule 3. The wire is still published, because the canvas draws it and the
  // author is looking at what their half-written statement selected; it is only
  // the WRITES that are withdrawn. Dropping them here rather than at each sink
  // is what makes the rule cover a sink that ran before the error as well as
  // one that ran after it.
  if (state.errors > errorsBefore) state.ops.length = opsBefore

  setWire(state, statement, current)
  if (statement.name) scope.set(statement.name, current)
}

/* -------------------------------------------------------------------------- */
/*  Reader access                                                             */
/* -------------------------------------------------------------------------- */

async function allNotes(state: RunState, line: number): Promise<WorkflowNote[]> {
  if (state.notes) return state.notes
  try {
    state.notes = await state.ctx.reader.listNotes()
  } catch (error) {
    state.notes = []
    diagnose(state, 'error', `could not list notes: ${errorText(error)}`, line)
  }
  return state.notes
}

/**
 * The working vault: everything except the Trash and the Archive.
 *
 * `all`, `tag` and `search` describe the notes someone is working with, and a
 * bulk write into the Trash (whose files vanish on the next empty) or the
 * Archive is never what those words meant. Both stay reachable on purpose,
 * spelled out loud: `folder trash` and `folder archive`.
 */
function workingNotes(notes: WorkflowNote[]): WorkflowNote[] {
  return notes.filter((note) => {
    // The reader's classification wins when present: with remapped system
    // folders (vault.json `systemFolderPaths`) the directory name stops
    // saying "trash", and this is the filter that keeps `all` honest.
    if (note.system) return note.system !== 'trash' && note.system !== 'archive'
    const top = normalizeFolder(note.folder).split('/')[0]?.toLowerCase() ?? ''
    return top !== 'trash' && top !== 'archive'
  })
}

/**
 * Fill in `body` for every note on the wire, reading each path at most once per
 * run. Returns copies rather than mutating: the same note object can sit on
 * several wires, and the caller's cache owns those objects.
 */
async function loadBodies(state: RunState, notes: NoteSet, line: number): Promise<NoteSet> {
  const out: NoteSet = []
  for (const note of notes) {
    out.push(await withBody(state, note, line))
  }
  return out
}

/**
 * Attach a note's body, and with it the frontmatter parsed out of that body.
 *
 * `frontmatter` and `body` look like independent fields but they are not: a
 * source that lists notes in bulk usually has no frontmatter to give, because
 * reading it means reading the file. Filling in only `body` here left
 * `frontmatter` as `{}` forever, so `where rating >= 4` matched nothing and
 * `where rating < 4` matched everything, with no diagnostic to explain it.
 * Deriving it here rather than in each adapter means no caller can reintroduce
 * that. Anything the adapter already supplied wins, since it may know fields
 * the text does not carry.
 */
async function withBody(state: RunState, note: WorkflowNote, line: number): Promise<WorkflowNote> {
  if (note.body !== undefined) return note
  const cached = state.bodies.get(note.path)
  if (cached !== undefined) return hydrate(note, cached)
  let body = ''
  try {
    body = await state.ctx.reader.readBody(note.path)
  } catch (error) {
    diagnose(state, 'warning', `could not read \`${note.path}\`: ${errorText(error)}`, line)
  }
  // Cache the failure too, so one unreadable note cannot be retried once per step.
  state.bodies.set(note.path, body)
  return hydrate(note, body)
}

function hydrate(note: WorkflowNote, body: string): WorkflowNote {
  const parsed = parseFrontmatter(body).data
  return { ...note, body, frontmatter: { ...parsed, ...note.frontmatter } }
}

/* -------------------------------------------------------------------------- */
/*  Ops budget                                                                */
/* -------------------------------------------------------------------------- */

/** Append an op unless the run has spent its budget. False means "stop". */
function pushOp(state: RunState, op: WorkflowOp, line: number): boolean {
  if (state.ops.length >= state.maxOps) {
    state.stopped = true
    diagnose(state, 'error', `run stopped after ${state.maxOps} operations (maxOps)`, line)
    return false
  }
  state.ops.push(op)
  return true
}

/* -------------------------------------------------------------------------- */
/*  Args                                                                      */
/* -------------------------------------------------------------------------- */

function argString(step: WorkflowStep, name: string): string | null {
  const value = step.args[name]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function argNumber(step: WorkflowStep, name: string): number | null {
  const value = step.args[name]
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Report a step whose required arg never bound and abort the rest of the
 * pipeline. Aborting (rather than passing the wire through) is deliberate: a
 * broken filter followed by `trash` must not trash everything upstream of it.
 */
function missingArg(state: RunState, step: WorkflowStep, name: string): null {
  return fail(state, `\`${step.kind}\` is missing ${name}`, step.line)
}

/* -------------------------------------------------------------------------- */
/*  Field vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One field vocabulary shared by `where`, `sort`, `render table` and the
 * `{{...}}` patterns: flat frontmatter plus a handful of pseudo-fields that
 * every note has whether or not its author wrote any frontmatter.
 */
function fieldValue(note: WorkflowNote, field: string): string | number | undefined {
  switch (field) {
    case 'title':
      return note.title
    case 'path':
      return note.path
    case 'folder':
      return note.folder
    case 'created':
      return note.createdAt
    case 'updated':
      return note.updatedAt
    default:
      return note.frontmatter[field]
  }
}

function asText(value: string | number | undefined): string {
  return value === undefined ? '' : String(value)
}

/** Finite number, or null. Blank is null, NOT zero: `where rating >= 4` on a
 *  note with no rating must compare as text and lose, not compare as 0. */
function toNumber(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * `2026-07-01`, optionally with a time, as LOCAL epoch milliseconds, or null.
 * Local because that is what a person means when they type a date about their
 * own notes; `created`/`updated` are local-clock epochs from the filesystem.
 */
const DATE_VALUE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/

function parseDateValue(raw: string): number | null {
  const m = DATE_VALUE_RE.exec(raw.trim())
  if (!m) return null
  const time = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0)
  ).getTime()
  return Number.isFinite(time) ? time : null
}

/** Numeric when BOTH sides are numbers, case-insensitive text otherwise. */
function compareValues(
  left: string | number | undefined,
  right: string | number | undefined
): number {
  const leftNumber = toNumber(left)
  const rightNumber = toNumber(right)
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber
  return compareText(asText(left).toLowerCase(), asText(right).toLowerCase())
}

function matchesOrder(delta: number, op: CompareOp): boolean {
  switch (op) {
    case '=':
      return delta === 0
    case '!=':
      return delta !== 0
    case '>':
      return delta > 0
    case '>=':
      return delta >= 0
    case '<':
      return delta < 0
    case '<=':
      return delta <= 0
    default:
      return false
  }
}

/**
 * Build the predicate for one `where` step, once, before touching any note.
 * Returning null means "this comparison cannot be evaluated": the caller turns
 * that into the empty set, which is the same answer a filter that matches
 * nothing would give, and the safe one for a pipeline that ends in a mutation.
 */
function buildPredicate(
  op: CompareOp,
  raw: string,
  state: RunState,
  line: number
): ((value: string | number | undefined) => boolean) | null {
  if (op === 'matches') {
    // Not `new RegExp`: see `./matches`. A workflow file is something people
    // share, and `matches ^(a+)+$` handed to a backtracker is a way to hang the
    // renderer on the click that selects the workflow.
    const matcher = compileMatcher(raw)
    if (!matcher.ok) {
      diagnose(state, 'error', `\`${raw}\` is not a valid pattern: ${matcher.reason}`, line)
      return null
    }
    return (value) => matcher.matches(asText(value))
  }
  if (op === 'contains') {
    const needle = raw.toLowerCase()
    return (value) => asText(value).toLowerCase().includes(needle)
  }
  // `created` and `updated` are epoch numbers. A hand-typed date must compare
  // as a date; without this bridge it would fall through to text comparison,
  // where every 13-digit epoch sorts before '2026-…' and `updated < <date>`
  // silently matches the entire vault. And when the value is neither a number
  // nor a date, a numeric field never matches at all: an unevaluable step must
  // narrow to nothing, never widen (rule 2 in the module header).
  const rawAsNumber = toNumber(raw)
  const rawAsDate = parseDateValue(raw)
  return (value) => {
    if (typeof value === 'number' && rawAsNumber === null) {
      if (rawAsDate === null) return false
      return matchesOrder(value - rawAsDate, op)
    }
    return matchesOrder(compareValues(value, raw), op)
  }
}

/* -------------------------------------------------------------------------- */
/*  Folders, tags, globs, durations                                           */
/* -------------------------------------------------------------------------- */

function normalizeFolder(folder: string): string {
  return folder.replace(/^\/+|\/+$/g, '')
}

/**
 * The note as it will exist after a path op, so later steps in the same
 * pipeline follow the note rather than its abandoned address. Without this,
 * `move "archive" | add-tag #x` planned the tag against the pre-move path, and
 * the applier would resurrect a phantom note there while the moved one never
 * got its tag. The applier keeps a forwarding address for the rare case where
 * a collision forces it to land the file somewhere other than promised.
 */
function relocated(note: WorkflowNote, dest: string): WorkflowNote {
  return {
    ...note,
    path: dest,
    folder: relDirname(dest),
    title: stripNoteExtension(relBasename(dest))
  }
}

/** `renameTarget`, except an unusable pattern keeps the note where it is: the
 *  applier is the one that fails the run over it, with the whole-run rollback. */
function safeRenameTarget(rel: string, pattern: string): string {
  try {
    return renameTarget(rel, pattern)
  } catch {
    return rel
  }
}

/**
 * Refuse a destination this layer must never plan a write to, naming the step
 * and the value so the author can see which one it was.
 *
 * Composes with rule 3: the diagnostic withdraws every op the statement
 * planned, so a `move` that escapes the vault for one note does not half-move
 * the rest of them either.
 */
function allowsTarget(state: RunState, step: WorkflowStep, target: string): boolean {
  const problem = notePathProblem(target)
  return problem === null ? true : refuseTarget(state, step, target, problem)
}

/**
 * The same for a `move`, which has two values to answer for: the destination
 * folder as it was written, and the path the note lands on.
 *
 * Both, because `moveTarget` normalises a leading slash away, so `move "/etc"`
 * would otherwise pass the landing check as an ordinary `etc/` inside the vault
 * and file the note somewhere the author never named.
 */
function allowsMove(state: RunState, step: WorkflowStep, folder: string, target: string): boolean {
  const problem = folderPathProblem(folder) ?? notePathProblem(target)
  return problem === null ? true : refuseTarget(state, step, folder, problem)
}

function refuseTarget(state: RunState, step: WorkflowStep, value: string, problem: string): false {
  diagnose(state, 'error', `\`${step.kind}\` cannot write \`${value}\`: ${problem}`, step.line)
  return false
}

/**
 * A create target that no earlier step in this run already claimed.
 *
 * Two notes with the same title in different folders both expand
 * `create-each "reviews/{{title}}"` to one path, and the applier refuses the
 * second create rather than clobbering the first, failing the whole run over
 * what is really a naming clash. Suffixing is what the rest of the app does
 * with a taken name (`X.md`, `X 2.md`), and it is only a warning because the
 * run is fine; but it IS a warning, because the plan the author read said
 * `X.md` and one of these notes will not be there.
 */
function uniqueCreatePath(state: RunState, path: string, line: number): string {
  if (!state.created.has(path)) {
    state.created.add(path)
    return path
  }
  const ext = noteExtensionOf(path)
  const stem = ext ? path.slice(0, path.length - ext.length) : path
  // `created` is finite, so a free suffix exists within one more attempt than
  // it holds entries. No `while (true)` in a planner.
  for (let n = 2; n <= state.created.size + 2; n += 1) {
    const candidate = `${stem} ${n}${ext}`
    if (state.created.has(candidate)) continue
    state.created.add(candidate)
    diagnose(
      state,
      'warning',
      `\`${path}\` is created twice in this run, so one of them becomes \`${candidate}\``,
      line
    )
    return candidate
  }
  return path
}

/** Prefix match, so `folder inbox` also sees `inbox/projects`. */
function inFolder(note: WorkflowNote, folder: string): boolean {
  const target = normalizeFolder(folder).toLowerCase()
  // A nameless folder is not "every folder". `folder ""` matching the whole
  // vault put the Trash and the Archive on the wire, which is wider than any
  // source goes and the exact widening rule 2 forbids. The steps ask
  // `hasFolderName` first and report it; this is the backstop for a caller
  // added later that forgets to.
  if (!target) return false
  const own = normalizeFolder(note.folder).toLowerCase()
  return own === target || own.startsWith(`${target}/`)
}

/** The system folder a `folder`/`in` argument names, or null for a directory. */
function bucketNamed(folder: string): NonNullable<WorkflowNote['system']> | null {
  const name = normalizeFolder(folder).trim().toLowerCase()
  return name === 'inbox' || name === 'quick' || name === 'archive' || name === 'trash'
    ? name
    : null
}

/**
 * `inFolder`, plus the four system names read as THE system folders. `folder
 * trash` means the Trash rather than a directory that happens to carry that
 * name, so on a vault with remapped system folders it matches by the reader's
 * classification too, and `folder inbox` means the primary notes area
 * wherever the vault keeps it. On a vault whose notes live at the root that
 * is the root itself, which no directory name can spell: `folder ""` is
 * refused above, and the root's own directory is that empty string (#840).
 */
function inFolderOrBucket(note: WorkflowNote, folder: string): boolean {
  if (inFolder(note, folder)) return true
  const bucket = bucketNamed(folder)
  return bucket !== null && note.system === bucket
}

/** Whether a `folder`/`in` argument actually names something. */
function hasFolderName(folder: string): boolean {
  return normalizeFolder(folder).trim() !== ''
}

/**
 * Why this `rename` pattern is not a name, or null when it is one.
 *
 * `rename` gives a note a new filename in the folder it already sits in, which
 * is what the node's own description promises, but `renameTarget` keeps the
 * interior slashes of its pattern, so `rename "sub/deep"` quietly RELOCATED the
 * note. Refused rather than obeyed: the step that changes a note's folder is
 * `move`, and a workflow that means to move should have to say so.
 */
function renamePatternProblem(pattern: string): string | null {
  if (!pattern.trim()) return '`rename` needs a name'
  if (/[/\\]/.test(pattern)) {
    return `\`rename\` cannot take a path (\`${pattern}\`): \`move\` is the step that changes folders`
  }
  return null
}

/** Tags are hierarchical in ZenNotes, so `tag project` sees `project/compiler`,
 *  matching what clicking `project` in the tag tree shows. */
function hasTag(note: WorkflowNote, tag: string): boolean {
  const target = tag.replace(/^#/, '').toLowerCase()
  if (!target) return false
  return note.tags.some((raw) => {
    const own = raw.replace(/^#/, '').toLowerCase()
    return own === target || own.startsWith(`${target}/`)
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `*` stops at a path separator, `**` crosses them, and `**\/` also matches
 * zero folders so `**\/*.md` covers a note sitting at the vault root.
 *
 * Compiled by the same automaton as `matches`, and for the same reason: handed
 * to a backtracker, `matching "**\/**\/**\/…"` is a dozen nested `.*` and an
 * ordinary vault path answers it in minutes rather than microseconds. The
 * source below is generated from an escaped glob, so it is always inside the
 * subset `./matches` accepts; it is still returned as a `Matcher` rather than
 * asserted, because a glob feature added later must fail as a diagnostic and
 * not as a throw.
 */
function globMatcher(glob: string): Matcher {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char !== '*') {
      source += escapeRegExp(char)
      continue
    }
    if (glob[index + 1] === '*') {
      index += 1
      if (glob[index + 1] === '/') {
        index += 1
        source += '(?:.*/)?'
      } else {
        source += '.*'
      }
      continue
    }
    source += '[^/]*'
  }
  return compileMatcher(`^${source}$`)
}

const MS_PER_UNIT: Record<string, number> = {
  // `m` is minutes, not months: a workflow that says `since 30m` means half an
  // hour, and months are not a fixed length anyway.
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000
}

function durationMs(duration: string): number | null {
  const match = /^(\d+)([dhwm])$/.exec(duration.trim())
  if (!match) return null
  const unit: number | undefined = MS_PER_UNIT[match[2]]
  if (unit === undefined) return null
  return Number(match[1]) * unit
}

/* -------------------------------------------------------------------------- */
/*  Text templates                                                            */
/* -------------------------------------------------------------------------- */

const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g

/** Unknown placeholders are left verbatim: seeing `{{titel}}` in the planned
 *  path of a dry run is how the author finds the typo. */
function expandPlaceholders(text: string, resolve: (key: string) => string | null): string {
  return text.replace(PLACEHOLDER_RE, (raw: string, key: string) => resolve(key) ?? raw)
}

/** UTC so a plan is the same everywhere, which is what makes it comparable. */
function isoDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function expandForNote(text: string, note: WorkflowNote, now: number): string {
  return expandPlaceholders(text, (key) => {
    if (key === 'date') return isoDate(now)
    const value = fieldValue(note, key)
    return value === undefined ? null : asText(value)
  })
}

/** Wire-level text (a notification), where there is no single note to read. */
function expandForRun(text: string, count: number, now: number): string {
  return expandPlaceholders(text, (key) => {
    if (key === 'date') return isoDate(now)
    if (key === 'count') return String(count)
    return null
  })
}

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

function isRenderStyle(value: string): value is RenderStyle {
  return (RENDER_STYLES as readonly string[]).includes(value)
}

function tableCell(value: string | number | undefined): string {
  return asText(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

/** `columns` is the raw `rest` token from `render table a, b`, hence the split. */
export function renderNotes(notes: NoteSet, style: RenderStyle, columns: string): string {
  switch (style) {
    case 'count':
      return String(notes.length)
    case 'list':
      return notes.map((note) => `- ${note.title}`).join('\n')
    case 'links':
      return notes.map((note) => `- [[${note.title}]]`).join('\n')
    case 'table': {
      const fields = columns
        .split(',')
        .map((column) => column.trim())
        .filter(Boolean)
      const header = fields.length > 0 ? fields : ['title']
      const rows = notes.map(
        (note) => `| ${header.map((field) => tableCell(fieldValue(note, field))).join(' | ')} |`
      )
      return [
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
        ...rows
      ].join('\n')
    }
  }
}

/** What a `consumesText` sink writes when no `render` came before it. */
function sinkText(text: string | null, notes: NoteSet): string {
  return text ?? renderNotes(notes, 'links', '')
}

/* -------------------------------------------------------------------------- */
/*  Steps                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Run one step. Returning null aborts the rest of that pipeline (and only that
 * pipeline): the step could not be evaluated and letting the wire flow onwards
 * could plan a write over the wrong notes.
 */
async function runStep(
  def: NodeDef,
  step: WorkflowStep,
  current: NoteSet,
  text: string | null,
  state: RunState,
  scope: Map<string, NoteSet>,
  depth: number
): Promise<StepResult | null> {
  const keep = (notes: NoteSet): StepResult => ({ notes, text })
  const now = state.ctx.now

  switch (def.kind) {
    /* ----- Sources ----- */
    case 'all':
      return keep(workingNotes(await allNotes(state, step.line)))

    case 'folder': {
      const folder = argString(step, 'folder')
      if (folder === null) return missingArg(state, step, 'folder')
      if (!hasFolderName(folder)) return fail(state, '`folder` needs a name', step.line)
      return keep(
        (await allNotes(state, step.line)).filter((note) => inFolderOrBucket(note, folder))
      )
    }

    case 'tag': {
      const tag = argString(step, 'tag')
      if (tag === null) return missingArg(state, step, 'tag')
      return keep(workingNotes(await allNotes(state, step.line)).filter((note) => hasTag(note, tag)))
    }

    case 'search': {
      const query = argString(step, 'query')
      if (query === null) return missingArg(state, step, 'query')
      const needle = query.toLowerCase()
      const matched: NoteSet = []
      for (const note of workingNotes(await allNotes(state, step.line))) {
        // Title first: a title hit spares a body read, and this is the one
        // source that would otherwise read the entire vault.
        if (note.title.toLowerCase().includes(needle)) {
          matched.push(note)
          continue
        }
        const loaded = await withBody(state, note, step.line)
        if (asText(loaded.body).toLowerCase().includes(needle)) matched.push(loaded)
      }
      return keep(matched)
    }

    case 'current': {
      const read = state.ctx.reader.current
      if (!read) {
        diagnose(state, 'warning', '`current` has no active note in this context', step.line)
        return keep([])
      }
      const note = read()
      return keep(note ? [note] : [])
    }

    case 'selection': {
      const read = state.ctx.reader.selection
      if (!read) {
        diagnose(state, 'warning', '`selection` is not available in this context', step.line)
        return keep([])
      }
      return keep([...read()])
    }

    /* ----- Filters ----- */
    case 'where': {
      const field = argString(step, 'field')
      if (field === null) return missingArg(state, step, 'field')
      const op = argString(step, 'op')
      if (op === null) return missingArg(state, step, 'op')
      const value = argString(step, 'value')
      if (value === null) return missingArg(state, step, 'value')
      if (!isCompareOp(op)) return fail(state, `\`${op}\` is not a comparison`, step.line)
      const predicate = buildPredicate(op, value, state, step.line)
      if (!predicate) return keep([])
      return keep(current.filter((note) => predicate(fieldValue(note, field))))
    }

    case 'tagged': {
      const tag = argString(step, 'tag')
      if (tag === null) return missingArg(state, step, 'tag')
      return keep(current.filter((note) => hasTag(note, tag)))
    }

    case 'not-tagged': {
      const tag = argString(step, 'tag')
      if (tag === null) return missingArg(state, step, 'tag')
      return keep(current.filter((note) => !hasTag(note, tag)))
    }

    case 'in': {
      const folder = argString(step, 'folder')
      if (folder === null) return missingArg(state, step, 'folder')
      if (!hasFolderName(folder)) return fail(state, '`in` needs a folder name', step.line)
      return keep(current.filter((note) => inFolderOrBucket(note, folder)))
    }

    case 'matching': {
      const glob = argString(step, 'glob')
      if (glob === null) return missingArg(state, step, 'glob')
      const matcher = globMatcher(glob)
      if (!matcher.ok) return fail(state, `\`${glob}\` is not a usable glob: ${matcher.reason}`, step.line)
      return keep(current.filter((note) => matcher.matches(note.path)))
    }

    case 'contains': {
      const needle = argString(step, 'text')
      if (needle === null) return missingArg(state, step, 'text')
      const lowered = needle.toLowerCase()
      return keep(current.filter((note) => asText(note.body).toLowerCase().includes(lowered)))
    }

    case 'since': {
      const duration = argString(step, 'duration')
      if (duration === null) return missingArg(state, step, 'duration')
      const span = durationMs(duration)
      if (span === null) return fail(state, `\`${duration}\` is not a duration`, step.line)
      const cutoff = now - span
      return keep(current.filter((note) => note.updatedAt >= cutoff))
    }

    /* ----- Order ----- */
    case 'sort': {
      const field = argString(step, 'field')
      if (field === null) return missingArg(state, step, 'field')
      const direction = (argString(step, 'direction') ?? 'asc').toLowerCase() === 'desc' ? -1 : 1
      // Copy first: the same NoteSet may be sitting on a wire that other
      // statements read, and sorting in place would reorder theirs too.
      const sorted = [...current].sort(
        (left, right) => direction * compareValues(fieldValue(left, field), fieldValue(right, field))
      )
      return keep(sorted)
    }

    case 'limit': {
      const count = argNumber(step, 'count')
      if (count === null) return missingArg(state, step, 'count')
      return keep(current.slice(0, Math.max(0, Math.floor(count))))
    }

    case 'dedupe': {
      const seen = new Set<string>()
      const unique: NoteSet = []
      for (const note of current) {
        if (seen.has(note.path)) continue
        seen.add(note.path)
        unique.push(note)
      }
      return keep(unique)
    }

    /* ----- Shape ----- */
    case 'union': {
      const other = readWire(step, state, scope)
      if (!other) return keep(current)
      const seen = new Set(current.map((note) => note.path))
      const merged = [...current]
      for (const note of other) {
        if (seen.has(note.path)) continue
        seen.add(note.path)
        merged.push(note)
      }
      return keep(merged)
    }

    case 'subtract': {
      const other = readWire(step, state, scope)
      if (!other) return keep(current)
      const remove = new Set(other.map((note) => note.path))
      return keep(current.filter((note) => !remove.has(note.path)))
    }

    /* ----- Mutations: one op per note, and the wire flows on unchanged so
       `good | add-tag #x | archive` applies both. ----- */
    case 'set': {
      const field = argString(step, 'field')
      if (field === null) return missingArg(state, step, 'field')
      const value = argString(step, 'value')
      if (value === null) return missingArg(state, step, 'value')
      for (const note of current) {
        const op: WorkflowOp = {
          kind: 'set-frontmatter',
          path: note.path,
          field,
          value: expandForNote(value, note, now)
        }
        if (!pushOp(state, op, step.line)) break
      }
      return keep(current)
    }

    case 'add-tag':
    case 'remove-tag': {
      const tag = argString(step, 'tag')
      if (tag === null) return missingArg(state, step, 'tag')
      const kind: 'add-tag' | 'remove-tag' = def.kind === 'add-tag' ? 'add-tag' : 'remove-tag'
      const clean = tag.replace(/^#/, '')
      for (const note of current) {
        if (!pushOp(state, { kind, path: note.path, tag: clean }, step.line)) break
      }
      return keep(current)
    }

    case 'move': {
      const folder = argString(step, 'folder')
      if (folder === null) return missingArg(state, step, 'folder')
      const moved: NoteSet = []
      for (const note of current) {
        // `to` is the destination folder. `rename` is the op that changes a
        // name, which is the only reason these are two ops and not one.
        const written = expandForNote(folder, note, now)
        const to = normalizeFolder(written)
        const target = moveTarget(note.path, to)
        if (!allowsMove(state, step, written, target)) {
          moved.push(note)
          continue
        }
        if (!pushOp(state, { kind: 'move', path: note.path, to }, step.line)) return keep(current)
        moved.push(relocated(note, target))
      }
      return keep(moved)
    }

    case 'rename': {
      const pattern = argString(step, 'pattern')
      if (pattern === null) return missingArg(state, step, 'pattern')
      // Checked before the loop as well as inside it: a separator written in the
      // pattern itself is one authoring mistake and deserves one diagnostic,
      // not one per note.
      const wrong = renamePatternProblem(pattern)
      if (wrong) return fail(state, wrong, step.line)
      const renamed: NoteSet = []
      for (const note of current) {
        const to = expandForNote(pattern, note, now)
        const expandedWrong = renamePatternProblem(to)
        if (expandedWrong) return fail(state, expandedWrong, step.line)
        const target = safeRenameTarget(note.path, to)
        if (!allowsTarget(state, step, target)) {
          renamed.push(note)
          continue
        }
        if (!pushOp(state, { kind: 'rename', path: note.path, to }, step.line)) {
          return keep(current)
        }
        renamed.push(relocated(note, target))
      }
      return keep(renamed)
    }

    case 'append':
    case 'prepend': {
      const raw = argString(step, 'text')
      if (raw === null) return missingArg(state, step, 'text')
      const kind: 'append' | 'prepend' = def.kind === 'append' ? 'append' : 'prepend'
      for (const note of current) {
        const op: WorkflowOp = {
          kind,
          path: note.path,
          text: expandForNote(raw, note, now)
        }
        if (!pushOp(state, op, step.line)) break
      }
      return keep(current)
    }

    case 'apply-template': {
      const template = argString(step, 'template')
      if (template === null) return missingArg(state, step, 'template')
      for (const note of current) {
        if (!pushOp(state, { kind: 'apply-template', path: note.path, template }, step.line)) break
      }
      return keep(current)
    }

    case 'archive':
    case 'trash': {
      const kind: 'archive' | 'trash' = def.kind === 'archive' ? 'archive' : 'trash'
      const filed: NoteSet = []
      for (const note of current) {
        if (!pushOp(state, { kind, path: note.path }, step.line)) return keep(current)
        filed.push(relocated(note, folderTarget(kind, note.path, state.ctx.systemFolderDirs)))
      }
      return keep(filed)
    }

    /* ----- Render: text for the sink, notes untouched ----- */
    case 'render': {
      const style = argString(step, 'style')
      if (style === null) return missingArg(state, step, 'style')
      if (!isRenderStyle(style)) return fail(state, `\`${style}\` is not a render style`, step.line)
      const columns = argString(step, 'columns') ?? ''
      return { notes: current, text: renderNotes(current, style, columns) }
    }

    /* ----- Sinks ----- */
    case 'write': {
      const path = argString(step, 'path')
      if (path === null) return missingArg(state, step, 'path')
      if (!allowsTarget(state, step, path)) return keep(current)
      pushOp(state, { kind: 'write-note', path, text: sinkText(text, current) }, step.line)
      return keep(current)
    }

    case 'write-section': {
      const path = argString(step, 'path')
      if (path === null) return missingArg(state, step, 'path')
      const heading = argString(step, 'heading')
      if (heading === null) return missingArg(state, step, 'heading')
      if (!allowsTarget(state, step, path)) return keep(current)
      const op: WorkflowOp = {
        kind: 'write-section',
        path,
        heading,
        text: sinkText(text, current)
      }
      pushOp(state, op, step.line)
      return keep(current)
    }

    case 'create-each': {
      const pattern = argString(step, 'pattern')
      if (pattern === null) return missingArg(state, step, 'pattern')
      for (const note of current) {
        // Bodies stay empty on purpose: `create-each` does not consume rendered
        // text, and copying one rendering into every created note is never what
        // the author meant.
        const target = ensureNotePath(expandForNote(pattern, note, now))
        if (!allowsTarget(state, step, target)) continue
        const path = uniqueCreatePath(state, target, step.line)
        if (!pushOp(state, { kind: 'create-note', path, body: '' }, step.line)) break
      }
      return keep(current)
    }

    case 'notify': {
      const message = argString(step, 'message')
      const body =
        message === null
          ? sinkText(text, current)
          : expandForRun(message, current.length, now)
      pushOp(state, { kind: 'notify', message: body }, step.line)
      return keep(current)
    }

    case 'clipboard': {
      pushOp(state, { kind: 'clipboard', text: sinkText(text, current) }, step.line)
      return keep(current)
    }

    /* ----- Compose ----- */
    case 'call': {
      // Whatever went wrong inside the call is the child's, and the child's own
      // statements already withdrew whatever they planned. `call` is the one
      // step that cannot change the wire (look at the `keep(current)` below), so
      // a failure in it can never have made the ops around it wrong, and rule 3
      // leaves them alone. A limit that stopped the run is the exception: it
      // cuts every caller short, which is the case rule 3 exists for.
      const errorsBefore = state.errors
      await runCall(step, state, depth)
      if (!state.stopped) state.errors = errorsBefore
      return keep(current)
    }

    default:
      return fail(state, `\`${def.kind}\` is not implemented`, step.line)
  }
}

function readWire(
  step: WorkflowStep,
  state: RunState,
  scope: Map<string, NoteSet>
): NoteSet | null {
  const name = argString(step, 'wire')
  if (name === null) {
    missingArg(state, step, 'wire')
    return null
  }
  const wire = scope.get(name)
  if (!wire) {
    diagnose(state, 'error', `unknown wire \`${name}\``, step.line)
    return null
  }
  return wire
}

/** A pattern that already names a note type keeps it, so `create-each` can make
 *  a drawing; anything else is a markdown note. */
function ensureNotePath(path: string): string {
  return noteExtensionOf(path) ? path : `${path}${NOTE_EXTENSIONS[0]}`
}

/**
 * Run a called workflow inline: its ops land in the parent's list in order and
 * its wires land under `<child id>.<wire>`, so a run ledger and the canvas can
 * both attribute every op and every count to the workflow that produced it.
 */
async function runCall(step: WorkflowStep, state: RunState, depth: number): Promise<void> {
  const id = argString(step, 'workflow')
  if (id === null) {
    missingArg(state, step, 'workflow')
    return
  }
  const resolve = state.ctx.resolve
  if (!resolve) {
    diagnose(state, 'error', `\`call ${id}\` needs a workflow resolver`, step.line)
    return
  }
  const child = resolve(id)
  if (!child) {
    diagnose(state, 'error', `unknown workflow \`${id}\``, step.line)
    return
  }
  // The caller enforces the draft rule for the workflow it runs; a called child
  // never passes through that check, so the rule has to be asked again here.
  // Without this, an active parent is a back door through which a half-edited
  // draft acts on the vault, which is the exact thing a draft exists to prevent.
  if (!isRunnable(child)) {
    diagnose(state, 'error', `\`call ${id}\` was skipped: that workflow is a draft`, step.line)
    return
  }
  if (depth + 1 > state.maxDepth) {
    state.stopped = true
    diagnose(state, 'error', `run stopped at call depth ${state.maxDepth} (maxDepth)`, step.line)
    return
  }

  const outerPrefix = state.prefix
  state.prefix = `${outerPrefix}${child.id}.`
  await runWorkflow(child, state, depth + 1)
  state.prefix = outerPrefix
}
