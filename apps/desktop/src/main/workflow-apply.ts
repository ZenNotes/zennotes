// Applying a workflow run, and taking it back.
//
// The engine plans and never writes (see `@shared/workflows/engine`); this
// module is the only place a planned run reaches disk. Everything below exists
// to keep one promise: after a run, the vault is either exactly what the plan
// said it would be, or exactly what it was before. Never half of each. A run
// the process did not survive is the one case where the vault can be found
// holding half of each, and even then the bytes to put it back are on disk and
// the run is offered as an undo (decision 5).
//
// Five decisions carry that promise:
//
//   1. Undo restores RECORDED BYTES, it never replays a computed inverse. The
//      journal holds `{ path, before }` for every file the run touched, where
//      `before: null` means the path did not exist. Undo writes every `before`
//      back and deletes where null. Per-op inverses would be fifteen separate
//      chances to corrupt a vault; this is one mechanism that is right by
//      construction, and a `move` needs no special case because recording both
//      of its paths already describes how to put it back.
//   2. The journal records the PRE-RUN state, so the first touch of a path
//      wins. A later op editing the same file must not overwrite the entry
//      with a value this very run produced, or undo would restore a half-run.
//   3. A partial failure rolls the WHOLE run back, including the steps that
//      already succeeded. A half-applied workflow is worse than none, because
//      the author cannot tell which half landed. If the rollback itself cannot
//      finish, the receipt says so loudly and names the files: never report
//      success over a vault we could not put back.
//   4. Containment is checked for every path in the plan BEFORE the first byte
//      is written, so one traversal attempt aborts the run untouched rather
//      than leaving a rolled-back mess behind.
//   5. The journal reaches DISK before the write it protects, as a `.jsonl`
//      beside the ledger. In memory it only survives a failure this module can
//      catch; a killed process, a power cut or an OOM would otherwise leave a
//      half-applied vault with no record of what it had been. The next run (or
//      the next look at the history) finds that file, turns it into a ledger
//      marked `interrupted` and offers it as an undo. It does NOT roll back on
//      its own: minutes or days may have passed and the user may have edited
//      since, so putting the vault back is their call, not a surprise on
//      startup. Until they make it, the vault holds whatever the dead run got
//      as far as, which is the one gap in the promise above.
//
// A note's comments and creation date live in `.zennotes`, keyed by the note's
// path (see note-sidecars.ts), so a path op that moved only the Markdown would
// detach the discussion, lose the date, and leave both behind to block or
// pollute the next note given the old name (#839). Path ops carry them, under
// the same five decisions: each is journalled as `{ note, sidecar, before }`
// before it moves, undo restores those bytes, and the file itself is derived
// from the note's path at restore time rather than stored, so a ledger can
// never name an arbitrary file inside `.zennotes`.
//
// A symlinked note is the one path its bytes do not describe: a move renames
// the LINK, so the file it points at, which may live outside the vault, never
// moves at all. The journal records the link's text beside its bytes, and undo
// moves that same link back from wherever the run left it, found by its text
// and never made from what a ledger says, and removes what the run put down as
// itself, never through a link. See `restoreEntries`.
//
// `notify` and `clipboard` are not applied here (the main process is not where
// the user's clipboard and toasts live) and are not journalled. They are
// counted into `receipt.irreversible` so the promise the UI makes about undo
// stays true.
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type {
  ApplyWorkflowInput,
  WorkflowJournalEntry,
  WorkflowRunReceipt,
  WorkflowRunSummary,
  WorkflowUndoResult
} from '@zennotes/bridge-contract/workflows'
import { IRREVERSIBLE_OP_KINDS } from '@shared/workflows/types'
import type { WorkflowOp } from '@shared/workflows/types'
// Every content transform lives in `@shared/workflows/apply-ops`, because the
// renderer previews it, the desktop applies it and Go will mirror it: the same
// split the parser uses. Importing `TextOp` rather than restating the list is
// what makes an op moved across that line a compile error here instead of a
// write that silently stops happening.
import { applyTextOp } from '@shared/workflows/apply-ops'
import type { TextOp } from '@shared/workflows/apply-ops'
// The path-target arithmetic is shared with the engine for the same reason the
// content transforms are: the engine PROMISES downstream steps a destination,
// and the applier must land the file exactly there. Two copies would let those
// promises drift apart, which is how phantom notes happen.
import {
  NOTE_EXTENSIONS,
  folderTarget,
  joinRel,
  moveTarget,
  normalizeRel,
  noteExtensionOf,
  relBasename,
  relDirname,
  renameTarget,
  stripNoteExtension,
  type SystemFolderDirs
} from '@shared/workflows/paths'
import { WORKFLOWS_REL_DIR } from '@shared/workflows-view'
import { isEphemeralRoot } from './ephemeral-vaults'
import { noteMetadataPath, noteMetadataRoot, prepareNoteCreation } from './note-creation-metadata'
import {
  leftoverCommentsMessage,
  noteCommentsPath,
  noteCommentsRoot,
  rebaseMovedLink
} from './note-sidecars'
import { getVaultSettings, writeFileAtomic } from './vault'

/* -------------------------------------------------------------------------- */
/*  Where a run is recorded                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run ledgers live beside the workflows that produced them, in a dot directory
 * so `listWorkflowFiles` (which skips dot entries) never mistakes one for a
 * workflow.
 */
export const RUNS_REL_DIR = `${WORKFLOWS_REL_DIR}/.runs`

/** Bumped when the on-disk ledger shape changes; older files are then ignored. */
const LEDGER_VERSION = 1

/**
 * A ledger carries a full copy of every touched file's previous bytes, so the
 * history is bounded rather than growing with every scheduled run forever. A
 * hundred runs is far more undo than anyone reaches back through, and pruning
 * only ever forgets an undo option, it never changes a note.
 */
export const MAX_RETAINED_RUNS = 100

/**
 * How much disk the retained ledgers may take, all together.
 *
 * The count cap alone is not a size cap: one run over a whole vault stores a
 * pre-image of every note it touched, so a hundred of those is a hundred copies
 * of the vault sitting inside it. Fifty megabytes is far more history than the
 * undo list reaches back through and small enough that nobody notices it in
 * their sync client, which is the only place this would otherwise show up.
 */
export const MAX_RETAINED_RUN_BYTES = 50 * 1024 * 1024

/** The internal directory a workflow must never write into. */
const INTERNAL_DIR = '.zennotes'

/**
 * Suffix of the crash journal a run keeps while it is applying.
 *
 * Not `.json`, so the history readers (which take every `.json` in the runs
 * directory for a ledger) cannot mistake one for a finished run.
 */
const RUN_JOURNAL_SUFFIX = '.journal.jsonl'

/**
 * One applied run, exactly as it is persisted.
 *
 * `hashes` is the content hash of what the run LEFT at each path (null where it
 * removed the file). A future event-triggered run needs to recognise its own
 * writes coming back at it through the watcher, and across sync that recognition
 * cannot be identity of a write handle, only of content. Recording it now is
 * what makes that loop guard possible later without a second migration.
 */
export interface WorkflowRunLedger {
  version: number
  runId: string
  workflowId: string
  startedAt: number
  finishedAt: number
  applied: number
  irreversible: number
  paths: string[]
  ops: WorkflowOp[]
  journal: NoteJournalEntry[]
  hashes: Record<string, string | null>
  /**
   * The sidecars the run moved with its notes. Beside `journal` rather than in
   * it, and absent when there were none, because every other reader of a
   * ledger (an older ZenNotes, the Go server) resolves each journal entry as a
   * note path and would refuse a `.zennotes` one, which would leave the run's
   * undo failing forever. Kept apart, they skip the sidecars and still undo the
   * notes.
   */
  sidecars?: LedgerSidecarEntry[]
  /** Set once undone, so the same run cannot be taken back twice. */
  undone: boolean
  undoneAt?: number
  /** Present only for a run whose rollback could not finish. */
  rolledBack?: { reason: string }
  /**
   * Present only for a run rebuilt from a crash journal, which is the one kind
   * of ledger that was written by a later process than the run it describes.
   * Its `applied` count and `hashes` are unknowable, so they are not guessed:
   * what it does carry is the journal, which is all undo needs.
   */
  interrupted?: { reason: string }
}

/**
 * A note's journal entry. `link` is the text of the symlink the path was
 * before the run, when it was one: its bytes cannot say that, and a move
 * renames the link itself, so undo needs the text to find that link again
 * (see `restoreEntries`). Absent in ledgers from before it was recorded, which
 * still undo, just without putting links back.
 */
interface NoteJournalEntry extends WorkflowJournalEntry {
  link?: string
}

/** The two files `.zennotes` keeps for a note. */
type SidecarKind = 'comments' | 'metadata'

const SIDECAR_KINDS: readonly SidecarKind[] = ['comments', 'metadata']

/** How a failure names a sidecar, since the user knows it by what it holds. */
const SIDECAR_LABELS: Record<SidecarKind, string> = {
  comments: 'comments',
  metadata: 'creation date'
}

/**
 * A sidecar's pre-run bytes: `before: null` means the note had none. It names
 * the NOTE, as the run spelled it, and never the sidecar's own path.
 *
 * On a crash journal line the missing `path` is deliberate: an older ZenNotes
 * takes every line with a `path` for a note's entry, and would fail the whole
 * undo on one inside `.zennotes`. Without it those lines are skipped, and the
 * notes still undo.
 */
interface SidecarJournalEntry {
  note: string
  sidecar: SidecarKind
  before: string | null
}

/**
 * As a finished ledger keeps it: plus the hash of what the run left there
 * (null where it moved the sidecar away), which is what undo's drift report
 * compares. Absent where the run cannot know, as in a ledger rebuilt from a
 * crash journal, the same way `hashes` is empty there.
 */
interface LedgerSidecarEntry extends SidecarJournalEntry {
  after?: string | null
}

/* -------------------------------------------------------------------------- */
/*  Paths                                                                     */
/* -------------------------------------------------------------------------- */

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/')
}

/** Derived from `RUNS_REL_DIR` so the exported name and the real directory
 *  cannot drift apart. */
function runsDir(root: string): string {
  return path.join(root, ...RUNS_REL_DIR.split('/'))
}

/**
 * Resolve a vault-relative path a workflow wants to write, refusing anything
 * outside the vault, inside `.zennotes`, or that is not a note.
 *
 * Three separate refusals for three separate reasons:
 *
 *   - Escaping the vault is the obvious one, and it is checked on every path
 *     this module resolves (op targets, computed destinations, and again on
 *     every journal entry at undo time) because a ledger read back from disk
 *     must never become a write primitive pointed anywhere on the filesystem.
 *     The check is TEXTUAL: `path.resolve` normalises `..` away and the result
 *     is required to sit under the root, with no `realpath`. A symlinked
 *     directory (or note) inside the vault therefore still leads a write to
 *     wherever it points. That is deliberate: the rest of the app follows those
 *     links too (`writeNote` is a plain `fs.writeFile`), a vault made of
 *     symlinked folders is a supported setup, and resolving here would make
 *     workflows the one feature that refuses to write notes the user can edit
 *     by hand. What this boundary rules out is a path that NAMES somewhere
 *     else, which is the part an op author or a synced ledger controls.
 *   - `.zennotes` holds this feature's own run ledgers, plus workflows,
 *     templates and settings. A workflow that could write there could rewrite
 *     the record of what it did.
 *   - The extension check keeps a mistyped `write reports/weekly` from either
 *     creating a file the app cannot show, or truncating a binary asset that
 *     this module would then "restore" as mangled UTF-8. Rejecting is the honest
 *     answer: silently appending `.md` would apply something other than the path
 *     the user saw in the dry run.
 */
export function resolveVaultPath(root: string, rel: string): string {
  // Before normalising, because normalising would quietly turn `/tmp/evil.md`
  // into `tmp/evil.md` inside the vault: a write to a path the user never saw
  // in the dry run, which is the one thing this feature must never do. Drive
  // letters are checked too, so a workflow authored on Windows and synced to a
  // Mac is refused rather than reinterpreted.
  if (path.isAbsolute(rel) || /^[/\\]/.test(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`Workflow op path escapes the vault: ${rel}`)
  }
  const clean = normalizeRel(rel)
  if (!clean) throw new Error('Workflow op has an empty path')
  const abs = path.resolve(root, clean)
  const rootAbs = path.resolve(root)
  if (abs === rootAbs || !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`Workflow op path escapes the vault: ${rel}`)
  }
  const inside = toPosix(path.relative(rootAbs, abs))
  const first = inside.split('/')[0] ?? ''
  if (first.toLowerCase() === INTERNAL_DIR) {
    throw new Error(`Workflow op path is inside ${INTERNAL_DIR}: ${rel}`)
  }
  if (!noteExtensionOf(inside)) {
    throw new Error(`Workflow op path is not a note (${NOTE_EXTENSIONS.join(' or ')}): ${rel}`)
  }
  return abs
}

/**
 * Where a note's sidecar lives, derived from the note's path every time.
 *
 * The note's path is checked by `resolveVaultPath` first, exactly as a journal
 * entry is, because at undo time it came off disk. Deriving the rest is what
 * keeps the `.zennotes` refusal above meaningful: a ledger can only ever aim a
 * restore at some note's own comments or creation date, never at a workflow,
 * a template or another run's record.
 */
async function sidecarPathOf(root: string, note: string, sidecar: SidecarKind): Promise<string> {
  const rel = toPosix(path.relative(path.resolve(root), resolveVaultPath(root, note)))
  return sidecar === 'comments' ? noteCommentsPath(root, rel) : await noteMetadataPath(root, rel)
}

function sidecarRootOf(root: string, sidecar: SidecarKind): string {
  return sidecar === 'comments' ? noteCommentsRoot(root) : noteMetadataRoot(root)
}

/** Every vault path an op could touch, for the pre-flight containment check. */
function opTargets(op: WorkflowOp, dirs?: SystemFolderDirs): string[] {
  switch (op.kind) {
    case 'notify':
    case 'clipboard':
      return []
    case 'move':
      return [op.path, moveTarget(op.path, op.to)]
    case 'rename':
      return [op.path, renameTarget(op.path, op.to)]
    case 'archive':
      return [op.path, folderTarget('archive', op.path, dirs)]
    case 'trash':
      return [op.path, folderTarget('trash', op.path, dirs)]
    default:
      return [op.path]
  }
}

async function readIfExists(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8')
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

/**
 * Whether anything at all sits at `abs`, a symlink that points at nothing
 * included. `exists` follows links, so it calls such a link free, and a rename
 * onto it replaces the link without a trace.
 */
async function pathTaken(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs)
    return true
  } catch (err) {
    if (isMissing(err)) return false
    throw err
  }
}

/**
 * Give the symlink at `abs` the text `text`, which the caller has checked
 * names the same file the link already names: a spelling, not a new target.
 */
async function respellLink(abs: string, text: string): Promise<void> {
  const temporary = `${abs}_relink_tmp_${process.pid}_${Date.now()}`
  await fs.symlink(text, temporary)
  try {
    await fs.rename(temporary, abs)
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw err
  }
}

/** The text of the symlink at `abs`, or undefined when `abs` is not one. */
async function linkTextOf(abs: string): Promise<string | undefined> {
  try {
    if (!(await fs.lstat(abs)).isSymbolicLink()) return undefined
  } catch (err) {
    if (isMissing(err)) return undefined
    throw err
  }
  return await fs.readlink(abs)
}

/**
 * The path a symlink finally names, or null when `abs` is not a symlink.
 *
 * A dangling link answers with the path its text names rather than failing:
 * writing through such a link creates that target, which is what the rest of
 * the app does, and undo has to be able to put a file back the same way the run
 * took it away.
 */
async function linkTargetOf(abs: string): Promise<string | null> {
  try {
    if (!(await fs.lstat(abs)).isSymbolicLink()) return null
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
  try {
    return await fs.realpath(abs)
  } catch (err) {
    if (!isMissing(err)) throw err
    return path.resolve(path.dirname(abs), await fs.readlink(abs))
  }
}

/**
 * Write a note the way saving one does: through a symlink, not over it.
 *
 * `writeFileAtomic` is temp file plus rename, and a rename replaces the
 * DIRECTORY ENTRY. Pointed straight at a symlinked note it would leave a
 * regular file where the link was and detach the link from its target for good,
 * so the note the user sees in two places would silently become two files, and
 * an undo afterwards would write a plain file over the link as well. `vault.ts`
 * saves through the link, so a workflow editing a note must do the same.
 * Resolving the link and doing the atomic dance at the target keeps both
 * properties: the link survives and no reader ever sees a half-written file.
 * `writeFileAtomic` resolves links itself now, so this is belt and braces; the
 * resolved path is still wanted here, because through a link that points at
 * nothing the file a write creates is the one the link's text names, and that
 * is the file undo removes again, never the link.
 *
 * The target may sit outside the vault. That is what following a link means,
 * and it is the same reach every other save in the app has; see
 * `resolveVaultPath` for why containment is textual.
 */
async function writeNoteThroughLinks(abs: string, data: string): Promise<void> {
  await writeFileAtomic((await linkTargetOf(abs)) ?? abs, data)
}

/**
 * A destination that is not already taken, matching `uniqueTitle` in `vault.ts`
 * (`X.md`, `X 2.md`, `X 3.md`).
 *
 * A move that clobbered an existing note would still be undoable, but a second
 * run without an undo would silently merge two notes into one, and nothing in
 * the dry run warned about it. Suffixing is what the rest of the app does.
 * "Taken" includes a symlink that points at nothing: the rename would replace
 * it, and nothing could put it back.
 */
async function uniqueRel(root: string, rel: string): Promise<string> {
  const ext = noteExtensionOf(rel)
  const stem = joinRel(relDirname(rel), stripNoteExtension(relBasename(rel)))
  let candidate = rel
  // A ceiling rather than `while (true)`: a directory that answers "exists" to
  // everything (a permissions oddity, a broken network mount) must fail loudly
  // instead of spinning forever inside a run that holds a half-written journal.
  for (let n = 2; n < 1000; n += 1) {
    if (!(await pathTaken(path.resolve(root, candidate)))) return candidate
    candidate = `${stem} ${n}${ext}`
  }
  throw new Error(`Cannot find a free destination for ${rel}`)
}

/* -------------------------------------------------------------------------- */
/*  Op validation                                                             */
/* -------------------------------------------------------------------------- */

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

/**
 * Narrow one op that arrived over IPC. Returns null for anything malformed.
 *
 * Rebuilt field by field rather than cast, which is not ceremony: the result is
 * what gets persisted into the ledger, so anything extra that rode in on the
 * wire is dropped here instead of being kept forever in the run history.
 *
 * SYNCED COPIES: the same validator exists in @shared/workflows/prepare-run
 * (the web client's), and the Go server mirrors the field list in
 * requiredWorkflowOpFields (internal/vault/workflows.go in ZenNotes/znserver). A new
 * op kind or field lands in all three.
 */
export function parseWorkflowOp(value: unknown): WorkflowOp | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const kind = stringField(record, 'kind')
  const notePath = stringField(record, 'path')
  switch (kind) {
    case 'set-frontmatter': {
      const field = stringField(record, 'field')
      const fieldValue = stringField(record, 'value')
      if (notePath === null || field === null || fieldValue === null) return null
      return { kind, path: notePath, field, value: fieldValue }
    }
    case 'add-tag':
    case 'remove-tag': {
      const tag = stringField(record, 'tag')
      if (notePath === null || tag === null) return null
      return { kind, path: notePath, tag }
    }
    case 'move':
    case 'rename': {
      const to = stringField(record, 'to')
      if (notePath === null || to === null) return null
      return { kind, path: notePath, to }
    }
    case 'append':
    case 'prepend': {
      const text = stringField(record, 'text')
      if (notePath === null || text === null) return null
      return { kind, path: notePath, text }
    }
    case 'write-section': {
      const heading = stringField(record, 'heading')
      const text = stringField(record, 'text')
      if (notePath === null || heading === null || text === null) return null
      return { kind, path: notePath, heading, text }
    }
    case 'write-note': {
      const text = stringField(record, 'text')
      if (notePath === null || text === null) return null
      return { kind, path: notePath, text }
    }
    case 'create-note': {
      const body = stringField(record, 'body')
      if (notePath === null || body === null) return null
      return { kind, path: notePath, body }
    }
    case 'apply-template': {
      const template = stringField(record, 'template')
      if (notePath === null || template === null) return null
      return { kind, path: notePath, template }
    }
    case 'archive':
    case 'trash': {
      if (notePath === null) return null
      return { kind, path: notePath }
    }
    case 'notify': {
      const message = stringField(record, 'message')
      if (message === null) return null
      return { kind, message }
    }
    case 'clipboard': {
      const text = stringField(record, 'text')
      if (text === null) return null
      return { kind, text }
    }
    default:
      return null
  }
}

/** Every op, or an error naming the first bad one. Nothing is applied part-way. */
function parseWorkflowOps(values: unknown[]): WorkflowOp[] {
  const ops: WorkflowOp[] = []
  values.forEach((value, index) => {
    const op = parseWorkflowOp(value)
    if (!op) throw new Error(`Workflow op ${index} is not a valid operation`)
    ops.push(op)
  })
  return ops
}

/* -------------------------------------------------------------------------- */
/*  Run identity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Distinguishes two runs started in the same millisecond. Deliberately not
 * `Math.random`: a run id names a file that undo has to find again, and a value
 * nobody can reason about is a bad name for a durable record.
 */
let runSequence = 0

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * `<startedAt>-<sequence>-<ops hash>`.
 *
 * The 13-digit millisecond timestamp leads, so ledger filenames sort
 * lexicographically in the same order they ran (through the year 2286, when the
 * digit count changes). The ops hash makes the id a fingerprint of what the run
 * intended, which is what lets two ids from separate processes in the same
 * millisecond differ, and makes a duplicate submission recognisable.
 */
function makeRunId(startedAt: number, workflowId: string, ops: WorkflowOp[]): string {
  runSequence = (runSequence + 1) % 1000
  const seq = String(runSequence).padStart(3, '0')
  const digest = hashText(`${workflowId}\n${JSON.stringify(ops)}`).slice(0, 8)
  return `${startedAt}-${seq}-${digest}`
}

/** A run id that no ledger has taken, so a run can never overwrite another's. */
async function allocateRunId(
  root: string,
  startedAt: number,
  workflowId: string,
  ops: WorkflowOp[]
): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const runId = makeRunId(startedAt, workflowId, ops)
    if (!(await exists(ledgerPathFor(root, runId)))) return runId
  }
  throw new Error('Cannot allocate a workflow run id')
}

function ledgerPathFor(root: string, runId: string): string {
  return path.join(runsDir(root), `${runId}.json`)
}

/**
 * Resolve a ledger file for a run id that came from the renderer. The id names
 * a file, so it is checked as one: charset first, then the resolved path is
 * required to sit directly in the runs directory.
 */
function resolveLedgerPath(root: string, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.includes('..')) {
    throw new Error(`Invalid workflow run id: ${runId}`)
  }
  const abs = ledgerPathFor(root, runId)
  if (path.dirname(abs) !== runsDir(root)) {
    throw new Error(`Invalid workflow run id: ${runId}`)
  }
  return abs
}

/* -------------------------------------------------------------------------- */
/*  The crash journal                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The run's journal as it is being written, one line at a time.
 *
 * A `.jsonl` rather than a rewritten `.json`: an append is a single write the
 * kernel either has or has not taken, so a process that dies mid-append loses
 * at most its last line, while rewriting a whole document per entry would put
 * every earlier entry at risk on every op. The first line is the run's header
 * (what the finished ledger would call `runId`, `workflowId`, `startedAt`,
 * `irreversible` and `ops`); every line after it is one `NoteJournalEntry`
 * or, for a sidecar a path op carries, one `SidecarJournalEntry`, in the order
 * the run touched them.
 */
interface RunJournalFile {
  abs: string
  header: string
  handle: FileHandle | null
  /** Whether the file was ever opened, so a run that journalled nothing does
   *  not go looking for a file it never made. */
  created: boolean
}

function journalPathFor(root: string, runId: string): string {
  return path.join(runsDir(root), `${runId}${RUN_JOURNAL_SUFFIX}`)
}

function newRunJournalFile(root: string, run: RunIdentity): RunJournalFile {
  return {
    abs: journalPathFor(root, run.runId),
    header: JSON.stringify({
      version: LEDGER_VERSION,
      runId: run.runId,
      workflowId: run.workflowId,
      startedAt: run.startedAt,
      irreversible: run.irreversible,
      ops: run.ops
    }),
    handle: null,
    created: false
  }
}

/**
 * Append one line and put it on the device.
 *
 * The `sync` is the entire point of this file: bytes sitting in a page cache
 * are exactly as lost as bytes never written when the process is killed, and
 * this line has to outlive the write it is about to authorise.
 */
async function writeJournalLine(handle: FileHandle, line: string): Promise<void> {
  await handle.write(`${line}\n`, null, 'utf8')
  await handle.sync()
}

/**
 * Record journal entries on disk, opening the file on first use.
 *
 * Opened lazily so a run that touches nothing (a notify-only workflow, or one
 * whose ops all turn out to be no-ops) leaves no file to recover. What matters
 * is the ordering, and it holds either way: this returns only once the entries
 * are durable, and the caller only then performs the writes they describe.
 */
async function appendJournalEntries(
  file: RunJournalFile,
  entries: ReadonlyArray<NoteJournalEntry | SidecarJournalEntry>
): Promise<void> {
  if (entries.length === 0) return
  try {
    if (!file.handle) {
      await fs.mkdir(path.dirname(file.abs), { recursive: true })
      file.handle = await fs.open(file.abs, 'a')
      file.created = true
      await writeJournalLine(file.handle, file.header)
    }
    // Several entries share one write and one sync. A process killed inside
    // that write leaves a prefix of the lines, the tail of which the reader
    // skips as a fragment, and the writes those lines protect have not begun.
    await writeJournalLine(file.handle, entries.map((entry) => JSON.stringify(entry)).join('\n'))
  } catch (err) {
    // Same reasoning as a ledger that cannot be written: a change nothing can
    // record is a change nothing can take back, so the run stops here and the
    // rollback puts the vault back rather than proceeding uninsured.
    throw new Error(`The run could not be recorded, so it was stopped (${messageOf(err)})`)
  }
}

async function closeRunJournal(file: RunJournalFile): Promise<void> {
  const handle = file.handle
  file.handle = null
  if (!handle) return
  try {
    await handle.close()
  } catch (err) {
    console.warn('[workflows] could not close the run journal:', err)
  }
}

/**
 * Drop the journal, for a run whose outcome is now recorded elsewhere (a
 * ledger, or a vault the rollback put back). Anything left behind is by
 * definition a run nobody wrote an ending for, which is what recovery looks
 * for.
 */
async function discardRunJournal(file: RunJournalFile): Promise<void> {
  await closeRunJournal(file)
  if (!file.created) return
  try {
    await fs.rm(file.abs, { force: true })
  } catch (err) {
    console.warn('[workflows] could not remove the run journal:', err)
  }
}

interface ParsedRunJournal {
  workflowId: string
  startedAt: number
  irreversible: number
  ops: WorkflowOp[]
  journal: NoteJournalEntry[]
  sidecars: SidecarJournalEntry[]
}

/**
 * Read a journal back, skipping anything unparseable.
 *
 * The last line of a file a process died inside can be a fragment, and a
 * fragment is not a reason to abandon the entries before it: those name real
 * files holding real pre-run bytes. Tolerating it here is what makes the
 * durability claim worth anything.
 */
async function readRunJournalFile(abs: string): Promise<ParsedRunJournal | null> {
  const raw = await fs.readFile(abs, 'utf8')
  const lines = raw.split('\n').filter((line) => line.trim().length > 0)
  let header: Record<string, unknown> | null = null
  const journal: NoteJournalEntry[] = []
  const sidecars: SidecarJournalEntry[] = []
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    if (!header) {
      header = parsed
      continue
    }
    const sidecar = parseSidecarEntry(parsed)
    if (sidecar) {
      // Never with `after`: a crash journal cannot know how the run left things.
      sidecars.push({ note: sidecar.note, sidecar: sidecar.sidecar, before: sidecar.before })
      continue
    }
    const entry = parseNoteEntry(parsed)
    if (entry) journal.push(entry)
  }
  if (!header) return null
  const ops = Array.isArray(header.ops)
    ? header.ops.map((op) => parseWorkflowOp(op)).filter((op): op is WorkflowOp => op !== null)
    : []
  return {
    workflowId: typeof header.workflowId === 'string' ? header.workflowId : 'unknown',
    startedAt: parseNumber(header.startedAt, 0),
    irreversible: parseNumber(header.irreversible, 0),
    ops,
    journal,
    sidecars
  }
}

/**
 * Turn every abandoned crash journal into a ledger the user can undo.
 *
 * Deliberately does NOT put the vault back on its own. The run may have died
 * days ago; the notes it half-changed may have been read, edited and synced
 * since, and silently reverting them on the next launch would be a bigger
 * surprise than the interruption was. Surfacing the run in the history, marked
 * and undoable, leaves the decision where it belongs.
 *
 * Serialized on the per-vault queue like everything else here, so it can never
 * mistake a journal a live run is still appending to for an abandoned one.
 */
export async function recoverInterruptedRuns(root: string): Promise<string[]> {
  return withVaultRunLock(root, () => recoverInterruptedRunsNow(root))
}

async function recoverInterruptedRunsNow(root: string): Promise<string[]> {
  const dir = runsDir(root)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return [] // no runs directory: nothing has ever run here
  }
  const recovered: string[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith(RUN_JOURNAL_SUFFIX)) continue
    const abs = path.join(dir, name)
    const runId = name.slice(0, name.length - RUN_JOURNAL_SUFFIX.length)
    try {
      // A ledger means the run reached its own ending and said what happened;
      // the journal simply outlived the delete that should have followed it,
      // and re-recovering from it would fight the record that already exists.
      if (await exists(ledgerPathFor(root, runId))) {
        await fs.rm(abs, { force: true })
        continue
      }
      const parsed = await readRunJournalFile(abs)
      // Nothing journalled means the run died before its first write, so the
      // vault is untouched and there is nothing to offer.
      if (!parsed || parsed.journal.length === 0) {
        await fs.rm(abs, { force: true })
        continue
      }
      await writeLedger(root, {
        version: LEDGER_VERSION,
        runId,
        workflowId: parsed.workflowId,
        startedAt: parsed.startedAt,
        finishedAt: Date.now(),
        // Unknowable from here: the journal says which paths were AT RISK, not
        // which writes landed. Zero and the empty hash map are the honest
        // answers, and `interrupted` is what tells the reader why.
        applied: 0,
        irreversible: parsed.irreversible,
        paths: parsed.journal.map((entry) => entry.path),
        ops: parsed.ops,
        journal: parsed.journal,
        hashes: {},
        // Without `after`, for the reason `hashes` is empty.
        ...(parsed.sidecars.length > 0 ? { sidecars: parsed.sidecars } : {}),
        undone: false,
        interrupted: {
          reason:
            'ZenNotes stopped while this run was still applying, so part of it may have landed. ' +
            'Undo restores every file it had recorded.'
        }
      })
      await fs.rm(abs, { force: true })
      recovered.push(runId)
    } catch (err) {
      // Left in place on purpose: an unreadable or unwritable recovery is worth
      // retrying next time, and deleting it would throw away the only copy of
      // those pre-run bytes.
      console.warn(`[workflows] could not recover interrupted run ${runId}:`, err)
    }
  }
  return recovered
}

/* -------------------------------------------------------------------------- */
/*  Applying                                                                  */
/* -------------------------------------------------------------------------- */

interface RunState {
  root: string
  /** Resolved on-disk names for remapped system folders (vault.json
   *  `systemFolderPaths`), so `archive`/`trash` ops file into the directory
   *  the app actually treats as Archive/Trash. Empty on default vaults. */
  systemFolderDirs: SystemFolderDirs
  /**
   * Journal key (see `journalKey`) to the entry, in the order the run touched
   * the paths. Insertion-ordered and written only when absent, which is the
   * first-touch-wins rule: the entry must describe the state before the run,
   * not before the latest op.
   */
  journal: Map<string, NoteJournalEntry>
  /** The same entries on disk, so a killed process leaves them behind. */
  journalFile: RunJournalFile
  /**
   * Journal key to the path as the run named it and the hash of what it left
   * there (null where it removed the file). Keyed like the journal so the two
   * agree about what counts as one file, which is what lets undo compare a
   * journal entry against the hash recorded for it.
   */
  written: Map<string, { path: string; hash: string | null }>
  /**
   * The sidecars path ops carried, keyed by `sidecarKey`, first touch wins for
   * the reason `journal` does: a note moved twice in one run leaves comments at
   * the middle path only in between, and undo must remove them there rather
   * than restore what the first move put down.
   */
  sidecars: Map<string, SidecarJournalEntry>
  /** Sidecar key to the hash of what the run left there (null: moved away). */
  sidecarsWritten: Map<string, string | null>
  /**
   * Destination the plan promised to where the file actually landed, for the
   * one case where they differ: `uniqueRel` had to suffix around a collision.
   * Later ops in the same run name the promised path; this is the forwarding
   * address that keeps them on the note. See `resolveLiveRel` for why an op
   * whose stated path still exists never follows a redirect.
   */
  redirects: Map<string, string>
}

/**
 * How the journal recognises two paths as the same file.
 *
 * On a case-insensitive filesystem `Inbox/A.md` and `inbox/a.md` ARE one file,
 * and journalling them separately would break first-touch-wins: the second
 * entry would record what the first op had just written, and undoing the run
 * would restore that half-applied state as if it were the original. Folding the
 * key (never the stored path, which stays exactly as the op named it) keeps one
 * file to one entry. Linux is left alone, where those really are two files.
 */
function journalKey(rel: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? rel.toLowerCase() : rel
}

/**
 * The entry, plus the text of the symlink its path is, when it is one. Read at
 * the first touch, like the bytes, so it describes the path before the run.
 */
async function withLinkText(root: string, entry: WorkflowJournalEntry): Promise<NoteJournalEntry> {
  const link = await linkTextOf(resolveVaultPath(root, entry.path))
  return link === undefined ? entry : { ...entry, link }
}

/** Note what the run left at a path. The spelling of the first touch wins, so
 *  the receipt and the hashes name the path the way the journal does. */
function recordWritten(state: RunState, rel: string, hash: string | null): void {
  const key = journalKey(rel)
  const seen = state.written.get(key)
  if (seen) seen.hash = hash
  else state.written.set(key, { path: rel, hash })
}

/** One key per note and sidecar, folded like the note's own journal key. */
function sidecarKey(note: string, sidecar: SidecarKind): string {
  return `${sidecar}:${journalKey(note)}`
}

/**
 * Record the pre-run state of everything one op is about to change, on disk
 * before it is recorded in memory: the note (both ends of it, for a path op)
 * and each sidecar the op touches, first touch winning throughout.
 *
 * The order is the durability guarantee: every caller awaits this before the
 * write it describes, so a process killed at any point leaves a journal that
 * covers at least every file it had begun to change. It is ONE append and ONE
 * sync for all of them: a sync per line made a bulk move several times slower
 * for no extra safety, since the op writes none of these files until all of
 * them are durable either way.
 */
async function journalOp(
  state: RunState,
  notes: WorkflowJournalEntry[],
  sidecars: SidecarJournalEntry[]
): Promise<void> {
  const newNotes = new Map<string, NoteJournalEntry>()
  for (const entry of notes) {
    const key = journalKey(entry.path)
    if (!state.journal.has(key) && !newNotes.has(key)) {
      newNotes.set(key, await withLinkText(state.root, entry))
    }
  }
  const newSidecars = new Map<string, SidecarJournalEntry>()
  for (const entry of sidecars) {
    const key = sidecarKey(entry.note, entry.sidecar)
    if (!state.sidecars.has(key) && !newSidecars.has(key)) newSidecars.set(key, entry)
  }
  await appendJournalEntries(state.journalFile, [...newNotes.values(), ...newSidecars.values()])
  for (const [key, entry] of newNotes) state.journal.set(key, entry)
  for (const [key, entry] of newSidecars) state.sidecars.set(key, entry)
}

/**
 * Where an op's stated path actually lives right now.
 *
 * The stated path wins whenever the file is still there, so a redirect can
 * never hijack an op aimed at a real note (a pre-existing note at the promised
 * destination keeps receiving the ops that name it). The redirect is followed
 * only into the gap this run itself created: the promised destination is gone
 * or was never free, and the run knows where the file actually went.
 */
async function resolveLiveRel(state: RunState, rel: string): Promise<string> {
  const stated = normalizeRel(rel)
  const via = state.redirects.get(stated)
  if (via === undefined) return stated
  if (await exists(resolveVaultPath(state.root, stated))) return stated
  return via
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Text ops that act on a note the plan saw on a wire, rather than on a path
 *  the author typed. Only these demand that their target still exists. */
const PER_NOTE_TEXT_OPS = new Set([
  'set-frontmatter',
  'add-tag',
  'remove-tag',
  'append',
  'prepend',
  'apply-template'
])

/** One content transform: read, journal, write. Identical output writes nothing. */
async function applyTextOpToVault(state: RunState, op: TextOp): Promise<void> {
  const rel = await resolveLiveRel(state, op.path)
  const abs = resolveVaultPath(state.root, rel)
  const live = await readIfExists(abs)
  // `create-note` MEANS create. Its transform is a whole-file write that ignores
  // the previous bytes, so letting it land on an existing note silently replaces
  // that note (an empty body blanks it outright). `create-each` generates one of
  // these per item, so a pattern that collides on a second run would quietly eat
  // real notes. Refusing here fails the run, which rolls the whole thing back and
  // leaves the vault untouched. Replacing a note on purpose is `write`.
  if (op.kind === 'create-note' && live !== null) {
    throw new Error(
      `create-note would replace the existing note ${rel}. Use write to replace a note on purpose.`
    )
  }
  // The mirror image, for the ops that act on a wire note: a target that has
  // vanished means the plan is describing a vault that no longer exists (the
  // note was moved or removed, by an earlier step reading a stale wire or by
  // someone else mid-run). Applying the transform to '' would materialize a
  // phantom note at the abandoned path, which is strictly worse than failing:
  // the run rolls back and the receipt names the step that lied.
  if (live === null && PER_NOTE_TEXT_OPS.has(op.kind)) {
    throw new Error(
      `Cannot ${op.kind} ${rel}: the note is missing (moved or removed earlier in this run?)`
    )
  }
  // `applyTextOp` takes '' for a file that does not exist yet, and answers null
  // only for an op that is not a text op. Reaching that here would mean this
  // module and the shared one disagree about which side of the line an op sits
  // on, and a silently skipped write is exactly the failure this feature exists
  // to make impossible, so it throws and the run rolls back.
  const next = applyTextOp(live ?? '', op)
  if (next === null) throw new Error(`Workflow op ${op.kind} is not a text op`)
  // An op that changes nothing (adding a tag the note already carries) should
  // not touch the file: an mtime bump is a sync round trip and a watcher event
  // for a change that did not happen. Only for a file that already exists;
  // creating an empty note is a real change even though '' equals ''.
  if (live !== null && next === live) return
  const metadata = await sidecarPathOf(state.root, rel, 'metadata')
  // Creating a note where a date file waits with no note beside it: that date
  // belongs to nobody (#839), and `createNote` discards it too. Journalled,
  // so undo puts it back; the new note's date is its own birth time.
  const leftover = live === null ? await readIfExists(metadata) : null
  if (live !== null) await keepCreationDate(state, rel)
  await journalOp(
    state,
    [{ path: rel, before: live }],
    leftover === null ? [] : [{ note: rel, sidecar: 'metadata', before: leftover }]
  )
  if (leftover !== null) {
    await fs.rm(metadata, { force: true })
    state.sidecarsWritten.set(sidecarKey(rel, 'metadata'), null)
  }
  await writeNoteThroughLinks(abs, next)
  recordWritten(state, rel, hashText(next))
}

/**
 * Write a note's creation date down before its file is replaced.
 *
 * A note ZenNotes has never saved (one from before 2.51, or from git, sync or
 * a file manager) has no date file: its date is the file's own birth time,
 * and an atomic write, temp file plus rename, replaces that file with one
 * born now. Saving from the editor writes the date down first (`writeNote`),
 * and so must every write here, and every move: the rename keeps the file,
 * but undo writes it back as a new one. A date file already there is left
 * alone, valid or not, so a corrupt one cannot fail a run the way it fails a
 * save. This is the one write that is not journalled first, safely: it
 * records a date the note already had, where the app already looks for it, so
 * nothing anyone can see changes, even if the run dies right after it. Not in
 * a temporary folder session, which `writeNote` never writes app state into
 * either.
 */
async function keepCreationDate(state: RunState, rel: string): Promise<void> {
  if (isEphemeralRoot(state.root)) return
  if ((await readIfExists(await sidecarPathOf(state.root, rel, 'metadata'))) !== null) return
  await prepareNoteCreation(state.root, rel)
}

/** A sidecar a path op is about to carry. */
interface SidecarMove {
  kind: SidecarKind
  fromAbs: string
  toAbs: string
  /** The note's own, or null when it has none. */
  fromBytes: string | null
  /** Whatever already sits at the destination's name. With no note there, it
   *  belongs to nobody. */
  toBytes: string | null
}

/**
 * The sidecars a path op carries, read before anything is journalled.
 *
 * `to` is free (`uniqueRel`), so anything already at its sidecar paths was left
 * by a note moved or deleted without them: outside ZenNotes, or by an older
 * version of this very function. The policy is the one every other writer
 * follows (`relocateNote` in note-sidecars.ts): a leftover
 * creation date is replaced, or removed, since it would stamp another note's
 * date on this one; leftover comments refuse, because taking over another
 * note's discussion and deleting it are both wrong. The refusal fails the run,
 * which rolls it back, and the message names the file to move aside.
 */
async function sidecarsToCarry(
  state: RunState,
  from: string,
  to: string,
  toAbs: string
): Promise<SidecarMove[]> {
  const moves: SidecarMove[] = []
  // Refused before anything is written down, so a refusal leaves no trace.
  const toComments = await sidecarPathOf(state.root, to, 'comments')
  if ((await readIfExists(toComments)) !== null) {
    throw new Error(leftoverCommentsMessage(state.root, toAbs))
  }
  // The rename keeps the file's birth time, but undo cannot: it writes the
  // note back as a new file. Written down now, the date travels and comes back
  // like any other sidecar.
  await keepCreationDate(state, from)
  for (const kind of SIDECAR_KINDS) {
    const fromAbs = await sidecarPathOf(state.root, from, kind)
    const toSidecar = await sidecarPathOf(state.root, to, kind)
    const toBytes = await readIfExists(toSidecar)
    const fromBytes = await readIfExists(fromAbs)
    if (fromBytes === null && toBytes === null) continue
    moves.push({ kind, fromAbs, toAbs: toSidecar, fromBytes, toBytes })
  }
  return moves
}

/** One path change. Journals both ends, which is what makes undo need no inverse. */
async function movePathInVault(
  state: RunState,
  kind: WorkflowOp['kind'],
  fromRel: string,
  nominalRel: string,
  promisedRel: string
): Promise<void> {
  const from = normalizeRel(fromRel)
  const fromAbs = resolveVaultPath(state.root, from)
  const live = await readIfExists(fromAbs)
  // The plan was made from a snapshot; if the note has since gone, the rest of
  // the plan is describing a vault that no longer exists. Failing here rolls the
  // whole run back, which is the honest outcome.
  if (live === null) throw new Error(`Cannot ${kind} ${from}: the note is missing`)
  const nominal = normalizeRel(nominalRel)
  // Already where the op wants it (trashing something in the trash). Not an
  // error, and nothing to journal.
  if (nominal === from) return

  const to = await uniqueRel(state.root, nominal)
  const toAbs = resolveVaultPath(state.root, to)
  // Before the first journal line, so an op refused over its sidecars leaves
  // nothing of itself to take back.
  const sidecars = await sidecarsToCarry(state, from, to, toAbs)
  await journalOp(
    state,
    [
      { path: from, before: live },
      // `uniqueRel` just said this path is free, but it is read rather than
      // assumed null: another process can create a file inside that window, and
      // journalling it as "did not exist" would turn undo into a delete of
      // somebody's note.
      { path: to, before: await readIfExists(toAbs) }
    ],
    sidecars.flatMap((sidecar) => [
      ...(sidecar.fromBytes === null
        ? []
        : [{ note: from, sidecar: sidecar.kind, before: sidecar.fromBytes }]),
      { note: to, sidecar: sidecar.kind, before: sidecar.toBytes }
    ])
  )
  await fs.mkdir(path.dirname(toAbs), { recursive: true })
  await fs.rename(fromAbs, toAbs)
  // A symlinked note keeps pointing where it did, as the app's own move keeps
  // it (see `rebaseMovedLink`).
  await rebaseMovedLink(fromAbs, toAbs)
  recordWritten(state, from, null)
  recordWritten(state, to, hashText(live))
  for (const sidecar of sidecars) {
    if (sidecar.fromBytes === null) {
      // Only a leftover date was waiting there, and this note has none of its
      // own to put in its place.
      await fs.rm(sidecar.toAbs, { force: true })
      state.sidecarsWritten.set(sidecarKey(to, sidecar.kind), null)
      continue
    }
    await fs.mkdir(path.dirname(sidecar.toAbs), { recursive: true })
    // Replaces a leftover date, when one was waiting there.
    await fs.rename(sidecar.fromAbs, sidecar.toAbs)
    state.sidecarsWritten.set(sidecarKey(from, sidecar.kind), null)
    state.sidecarsWritten.set(sidecarKey(to, sidecar.kind), hashText(sidecar.fromBytes))
  }
  // Later ops in this plan name the destination the engine promised; when the
  // vault forced a different one, leave a forwarding address.
  const promised = normalizeRel(promisedRel)
  if (to !== promised) state.redirects.set(promised, to)
}

async function applyOp(state: RunState, op: WorkflowOp): Promise<void> {
  switch (op.kind) {
    // Neither reaches the filesystem, so neither is journalled. They are counted
    // as irreversible on the receipt and performed by the renderer, which is
    // where a clipboard and a notification actually exist.
    case 'notify':
    case 'clipboard':
      return
    // Path ops resolve their source through the run's forwarding addresses,
    // then aim where the ACTUAL file's name says (an earlier collision suffix
    // must survive a later move), while the redirect they record is keyed by
    // the destination the ENGINE promised, because that is the name later ops
    // will use.
    case 'move': {
      const from = await resolveLiveRel(state, op.path)
      return await movePathInVault(
        state,
        op.kind,
        from,
        moveTarget(from, op.to),
        moveTarget(normalizeRel(op.path), op.to)
      )
    }
    case 'rename': {
      const from = await resolveLiveRel(state, op.path)
      return await movePathInVault(
        state,
        op.kind,
        from,
        renameTarget(from, op.to),
        renameTarget(normalizeRel(op.path), op.to)
      )
    }
    case 'archive': {
      const from = await resolveLiveRel(state, op.path)
      return await movePathInVault(
        state,
        op.kind,
        from,
        folderTarget('archive', from, state.systemFolderDirs),
        folderTarget('archive', normalizeRel(op.path), state.systemFolderDirs)
      )
    }
    case 'trash': {
      const from = await resolveLiveRel(state, op.path)
      return await movePathInVault(
        state,
        op.kind,
        from,
        folderTarget('trash', from, state.systemFolderDirs),
        folderTarget('trash', normalizeRel(op.path), state.systemFolderDirs)
      )
    }
    default:
      return await applyTextOpToVault(state, op)
  }
}

/**
 * Put every journalled path back the way the run found it.
 *
 * Returns the entries it could not restore rather than throwing, because the
 * caller is already handling a failure and needs the full list to report: a
 * rollback that stops at the first problem leaves more of the vault wrong than
 * one that carries on.
 *
 * A symlinked note needs more than its bytes. A move renames the link itself,
 * so the destination holds the link while the file it points at, which may
 * live outside the vault, never moved. Putting the vault back means moving
 * that same link back, and a path the run filled is emptied by removing what
 * sits there as itself, never through a link: the file a link points at is not
 * the run's to delete. The one exception is a link that pointed at nothing
 * before the run, whose target the run created by writing through it. Its
 * entry records the link's text, and only while that same link is there is
 * its target removed.
 *
 * A link is only ever moved back, never made: it is found by its recorded text
 * among the paths the run filled. Creating one from what a ledger says would
 * let an edited or synced ledger plant a link to anywhere and then write
 * through it, the very thing `resolveVaultPath` is here to rule out. With no
 * link to move back (a ledger from before the text was recorded, or a link
 * removed since), the bytes come back as a plain file, as they always did.
 */
async function restoreEntries(
  root: string,
  entries: Iterable<NoteJournalEntry>
): Promise<{ restored: number; failures: RestoreFailure[] }> {
  const failures: RestoreFailure[] = []
  let restored = 0
  const list = [...entries]
  // Where the run left the links it moved, by the file each names: a path
  // the run found empty that now holds a link it did not have before. By the
  // file rather than the text, because a relative text was re-based when the
  // link moved (`rebaseMovedLink`), and is again on the way back.
  const movedLinks = new Map<string, string[]>()
  for (const entry of list) {
    if (entry.before !== null) continue
    try {
      const abs = resolveVaultPath(root, entry.path)
      const text = await linkTextOf(abs)
      if (text === undefined || text === entry.link) continue
      const names = path.resolve(path.dirname(abs), text)
      const same = movedLinks.get(names)
      if (same) same.push(abs)
      else movedLinks.set(names, [abs])
    } catch {
      // The loop below meets the same entry and reports it.
    }
  }
  for (const { path: rel, before, link } of list) {
    try {
      // Re-validated on the way back out. At rollback time these paths came
      // from this run, but undo replays the same code over a file read off
      // disk, and that file must never be able to point a write anywhere.
      const abs = resolveVaultPath(root, rel)
      if (link !== undefined && !(await pathTaken(abs))) {
        const names = path.resolve(path.dirname(abs), link)
        const moved = movedLinks.get(names)?.pop()
        const text = moved === undefined ? undefined : await linkTextOf(moved)
        if (moved !== undefined && text !== undefined && path.resolve(path.dirname(moved), text) === names) {
          await fs.mkdir(path.dirname(abs), { recursive: true })
          await fs.rename(moved, abs)
          await rebaseMovedLink(moved, abs)
          await pruneEmptyDirs(root, path.dirname(moved))
          // The recorded text, when it names the very file the link now names
          // from here: the same reach, spelled the way it was.
          if ((await linkTextOf(abs)) !== link) await respellLink(abs, link)
        }
      }
      if (before === null) {
        // Empty before the run, so whatever sits there now goes, as itself.
        // Behind the link the path had before the run, pointing at nothing
        // then, it is the file the run created by writing through that link.
        const text = await linkTextOf(abs)
        const gone = (text !== undefined && text === link ? await linkTargetOf(abs) : null) ?? abs
        if (await pathTaken(gone)) {
          await fs.rm(gone, { force: true })
          await pruneEmptyDirs(root, path.dirname(gone))
        }
        restored += 1
        continue
      }
      // A path is journalled BEFORE its write is attempted, so a run that failed
      // mid-way has journalled paths it never actually changed. Restoring those
      // is pointless at best, and actively harmful here: whatever failed the
      // write (a read-only directory, a vanished volume) fails the restore too,
      // and the rollback then reports ROLLBACK INCOMPLETE over a file that was
      // never touched. That contradicts the headline the user is reading and is
      // the fastest way to lose their trust in undo. Comparing first turns that
      // false alarm into the clean rollback it actually was.
      if ((await readIfExists(abs)) === before) {
        restored += 1
        continue
      }
      await writeNoteThroughLinks(abs, before)
      restored += 1
    } catch (err) {
      failures.push({ path: rel, message: messageOf(err) })
    }
  }
  return { restored, failures }
}

/**
 * Put every journalled sidecar back, the way `restoreEntries` does notes.
 *
 * A failure is reported under its NOTE's path, which is the name the user
 * knows and the one a receipt lists; the message says which sidecar it was.
 */
async function restoreSidecars(
  root: string,
  entries: Iterable<SidecarJournalEntry>
): Promise<RestoreFailure[]> {
  const failures: RestoreFailure[] = []
  const list = [...entries]
  // Files this run put where none had been, by what they hold now. When one
  // still holds exactly the bytes another entry must get back (a sidecar the
  // run moved and nobody touched since), renaming it there restores those
  // bytes and removes it from where the run put it, which is what writing the
  // one and deleting the other would do, minus a synced write per sidecar:
  // without it, undoing a 400-note move took three times as long as it did
  // before sidecars moved at all. Only ever after comparing the bytes, so this
  // is the same restore, not an inverse.
  const moved = new Map<string, string[]>()
  for (const entry of list) {
    if (entry.before !== null) continue
    try {
      const abs = await sidecarPathOf(root, entry.note, entry.sidecar)
      const live = await readIfExists(abs)
      if (live === null) continue
      const key = `${entry.sidecar}\n${live}`
      const same = moved.get(key)
      if (same) same.push(abs)
      else moved.set(key, [abs])
    } catch {
      // The loop below meets the same entry and reports it.
    }
  }
  for (const entry of list) {
    try {
      const abs = await sidecarPathOf(root, entry.note, entry.sidecar)
      const live = await readIfExists(abs)
      // Unchanged since the run journalled it, for the reason given in
      // `restoreEntries`: a failed run journals sidecars it never moved.
      if (live === entry.before) continue
      if (entry.before === null) {
        await fs.rm(abs, { force: true })
        await pruneEmptySidecarDirs(sidecarRootOf(root, entry.sidecar), path.dirname(abs))
        continue
      }
      const source = live === null ? moved.get(`${entry.sidecar}\n${entry.before}`)?.pop() : undefined
      // Read again right before the rename, so nothing written in between
      // rides along with it.
      if (source !== undefined && (await readIfExists(source)) === entry.before) {
        try {
          await fs.mkdir(path.dirname(abs), { recursive: true })
          await fs.rename(source, abs)
          await pruneEmptySidecarDirs(sidecarRootOf(root, entry.sidecar), path.dirname(source))
          continue
        } catch {
          // Writing the bytes is the restore; the rename was only quicker.
        }
      }
      await writeFileAtomic(abs, entry.before)
    } catch (err) {
      failures.push({
        path: entry.note,
        message: `its ${SIDECAR_LABELS[entry.sidecar]}: ${messageOf(err)}`
      })
    }
  }
  return failures
}

/**
 * A run's notes and their sidecars, put back together.
 *
 * `restored` counts notes only: it is what the undo toast reports, and a note
 * whose comments came back with it is still one note.
 */
async function restoreRun(
  root: string,
  journal: Iterable<NoteJournalEntry>,
  sidecars: Iterable<SidecarJournalEntry>
): Promise<{ restored: number; failures: RestoreFailure[] }> {
  const notes = await restoreEntries(root, journal)
  const sidecarFailures = await restoreSidecars(root, sidecars)
  return { restored: notes.restored, failures: [...notes.failures, ...sidecarFailures] }
}

/** A path a restore could not put back, kept structured so both the receipt's
 *  `paths` and its human-readable reason can be built from the same fact. */
interface RestoreFailure {
  path: string
  message: string
}

function describeFailures(failures: RestoreFailure[]): string {
  return failures.map((failure) => `${failure.path} (${failure.message})`).join('; ')
}

/**
 * Remove directories the run emptied, walking up while each is empty.
 *
 * Stops before the vault's top-level folders: `inbox/2026` left behind by an
 * undone create is clutter, but `inbox` itself is furniture, and a vault whose
 * folders quietly disappear is a vault nobody trusts. Best effort throughout,
 * since a leftover empty directory is not a reason to fail an undo.
 */
async function pruneEmptyDirs(root: string, startDir: string): Promise<void> {
  const rootAbs = path.resolve(root)
  let dir = startDir
  while (dir.startsWith(rootAbs + path.sep)) {
    const parent = path.dirname(dir)
    // Only strictly below a top-level folder, so `inbox` survives.
    if (parent === rootAbs) return
    try {
      const entries = await fs.readdir(dir)
      if (entries.length > 0) return
      await fs.rmdir(dir)
    } catch {
      return
    }
    dir = parent
  }
}

/**
 * The same for the sidecar trees, where nothing below the tree's own root is
 * furniture, and where an empty leftover is not harmless clutter either: a
 * folder rename refuses a destination whose comments or metadata directory
 * already exists (`relocateFolderTrees`), so one left behind by an undo would
 * block that folder name for good, with nothing visible to explain why.
 */
async function pruneEmptySidecarDirs(base: string, startDir: string): Promise<void> {
  const baseAbs = path.resolve(base)
  let dir = startDir
  while (dir.startsWith(baseAbs + path.sep)) {
    try {
      if ((await fs.readdir(dir)).length > 0) return
      await fs.rmdir(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

async function writeLedger(root: string, ledger: WorkflowRunLedger): Promise<void> {
  await fs.mkdir(runsDir(root), { recursive: true })
  await writeFileAtomic(ledgerPathFor(root, ledger.runId), `${JSON.stringify(ledger, null, 2)}\n`)
}

async function fileSize(abs: string): Promise<number> {
  try {
    return (await fs.stat(abs)).size
  } catch {
    return 0
  }
}

/**
 * Drop the oldest ledgers past either cap. Filenames sort chronologically.
 *
 * Two caps, because a ledger's weight has nothing to do with its age: a run
 * over a whole vault stores a pre-image of every note it touched, so a handful
 * of those outweigh a hundred single-note runs. Counting alone would let the
 * run history quietly become the largest thing in `.zennotes`.
 *
 * The caps are parameters with the exported defaults so a test can drive this
 * exact code at a size it can write, rather than proving something adjacent
 * about a stand-in.
 */
export async function pruneRunLedgers(
  root: string,
  maxRuns = MAX_RETAINED_RUNS,
  maxBytes = MAX_RETAINED_RUN_BYTES
): Promise<void> {
  try {
    const dir = runsDir(root)
    const names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.json')).sort()
    const excess = new Set(names.slice(0, Math.max(0, names.length - maxRuns)))
    const survivors = names.filter((name) => !excess.has(name))
    // Newest backwards, keeping runs while they fit. The most recent is kept
    // whatever it weighs: one whole-vault run can exceed the budget on its own,
    // and deleting the ledger just written would take the undo away from the
    // very run the user is being shown.
    let used = 0
    for (let i = survivors.length - 1; i >= 0; i -= 1) {
      const name = survivors[i] as string
      used += await fileSize(path.join(dir, name))
      if (used > maxBytes && i < survivors.length - 1) {
        for (let older = i; older >= 0; older -= 1) excess.add(survivors[older] as string)
        break
      }
    }
    for (const name of excess) await fs.rm(path.join(dir, name), { force: true })
  } catch (err) {
    // Losing the prune is harmless; failing a completed run over it is not.
    console.warn('[workflows] could not prune old run ledgers:', err)
  }
}

/* -------------------------------------------------------------------------- */
/*  One run at a time per vault                                               */
/* -------------------------------------------------------------------------- */

/**
 * Apply and undo are serialized per vault root. Two windows on one vault, or
 * the Undo toast racing a second run, would otherwise interleave their
 * read-journal-write sequences: one run journals bytes another run is about to
 * replace, and a rollback then restores pre-run bytes over committed writes
 * while both receipts report success. A promise chain per key (the shape
 * `configWriteQueue` uses in vault.ts) closes the whole class.
 */
const vaultRunQueues = new Map<string, Promise<unknown>>()

async function withVaultRunLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(root)
  const prev = vaultRunQueues.get(key) ?? Promise.resolve()
  // The stored link is settled-only, so one failed run cannot wedge the chain
  // or resurface its error in the next caller; `next` still carries the real
  // rejection to its own caller.
  const next = prev.then(task)
  const tracked: Promise<unknown> = next
    .then(
      () => undefined,
      () => undefined
    )
    .finally(() => {
      if (vaultRunQueues.get(key) === tracked) vaultRunQueues.delete(key)
    })
  vaultRunQueues.set(key, tracked)
  return next
}

/**
 * Apply a planned run, journalling as it goes.
 *
 * The receipt is the whole truth about what happened: how many ops ran, which
 * paths changed, how many effects had no undo, and whether the run was taken
 * back. A rolled-back run reports `applied: 0` and no paths, because that is
 * the state the vault is in.
 */
export async function applyWorkflowOps(
  root: string,
  input: ApplyWorkflowInput
): Promise<WorkflowRunReceipt> {
  return withVaultRunLock(root, () => applyWorkflowOpsNow(root, input))
}

async function applyWorkflowOpsNow(
  root: string,
  input: ApplyWorkflowInput
): Promise<WorkflowRunReceipt> {
  const startedAt = Date.now()
  const workflowId = input.workflowId.trim() || 'unknown'
  const ops = parseWorkflowOps(input.ops)
  const irreversible = ops.filter((op) => IRREVERSIBLE_OP_KINDS.has(op.kind)).length

  // Containment first, for every path in the plan including the destinations
  // this module computes. One traversal attempt aborts the run before a single
  // byte is written, so there is nothing to roll back.
  const systemFolderDirs: SystemFolderDirs = (await getVaultSettings(root)).systemFolderPaths ?? {}
  for (const op of ops) {
    for (const target of opTargets(op, systemFolderDirs)) resolveVaultPath(root, target)
  }

  // Before this run adds a journal of its own, so a run a previous process did
  // not survive is in the history (and undoable) rather than being taken for
  // this one's leftovers.
  await recoverInterruptedRunsNow(root)

  const runId = await allocateRunId(root, startedAt, workflowId, ops)
  const run: RunIdentity = { runId, workflowId, startedAt, irreversible, ops }
  const state: RunState = {
    root,
    systemFolderDirs,
    journal: new Map(),
    journalFile: newRunJournalFile(root, run),
    written: new Map(),
    sidecars: new Map(),
    sidecarsWritten: new Map(),
    redirects: new Map()
  }
  let applied = 0

  try {
    try {
      for (const op of ops) {
        await applyOp(state, op)
        // `notify` and `clipboard` did not run here, so they are not counted as
        // applied; they are already declared in `irreversible`.
        if (!IRREVERSIBLE_OP_KINDS.has(op.kind)) applied += 1
      }
    } catch (err) {
      return await rollBackRun(root, run, state, messageOf(err))
    }

    const paths = [...state.written.values()].map((entry) => entry.path)
    // A run with no ops at all left no record worth keeping; anything that ran
    // gets a ledger, even one whose journal is empty (a notify-only run), so the
    // history shows it happened and shows it cannot be undone.
    if (ops.length > 0) {
      try {
        await writeLedger(root, {
          ...ledgerBase(run, state),
          finishedAt: Date.now(),
          applied,
          paths,
          undone: false
        })
      } catch (err) {
        // A run that cannot be recorded is a run that cannot be undone, and every
        // promise this feature makes rests on undo. So the journal, still in
        // memory and still correct, is spent putting the vault back rather than
        // left as the only copy of a guarantee nothing on disk can keep.
        return await rollBackRun(
          root,
          run,
          state,
          `The run could not be recorded, so it was not kept (${messageOf(err)})`
        )
      }
      // The ledger now holds the same journal, so the crash copy has nothing
      // left to protect.
      await discardRunJournal(state.journalFile)
      await pruneRunLedgers(root)
    } else {
      await discardRunJournal(state.journalFile)
    }

    return { runId, workflowId, startedAt, applied, paths, irreversible }
  } finally {
    // A handle left open would keep the file alive for the life of the process,
    // and recovery would find a journal nobody is writing to.
    await closeRunJournal(state.journalFile)
  }
}

/** The parts of a run that are fixed before the first op executes. */
interface RunIdentity {
  runId: string
  workflowId: string
  startedAt: number
  irreversible: number
  ops: WorkflowOp[]
}

function ledgerBase(
  run: RunIdentity,
  state: RunState
): Omit<WorkflowRunLedger, 'finishedAt' | 'applied' | 'paths' | 'undone'> {
  return {
    version: LEDGER_VERSION,
    runId: run.runId,
    workflowId: run.workflowId,
    startedAt: run.startedAt,
    irreversible: run.irreversible,
    ops: run.ops,
    journal: journalEntries(state),
    hashes: Object.fromEntries(
      [...state.written.values()].map((entry) => [entry.path, entry.hash] as const)
    ),
    ...(state.sidecars.size > 0 ? { sidecars: sidecarEntries(state) } : {})
  }
}

/** The journalled sidecars, each with what the run left there when it got as
 *  far as moving it (a rolled-back run may not have). */
function sidecarEntries(state: RunState): LedgerSidecarEntry[] {
  return [...state.sidecars.entries()].map(([key, entry]) => {
    const after = state.sidecarsWritten.get(key)
    return after === undefined ? { ...entry } : { ...entry, after }
  })
}

/**
 * Unwind everything the run wrote and report it, whatever went wrong.
 *
 * The clean case leaves no ledger: the vault is exactly as it was found, so
 * there is nothing to undo and a run in the history offering an undo would be
 * describing changes that are not there. The incomplete case is the opposite:
 * the journal is now the only record of files still holding this run's bytes,
 * so it is persisted and the reason says so in as many words.
 */
async function rollBackRun(
  root: string,
  run: RunIdentity,
  state: RunState,
  cause: string
): Promise<WorkflowRunReceipt> {
  const { failures } = await restoreRun(root, state.journal.values(), state.sidecars.values())
  const base = {
    runId: run.runId,
    workflowId: run.workflowId,
    startedAt: run.startedAt,
    applied: 0,
    irreversible: run.irreversible
  }
  // A cause can be a whole sentence already (the create-note refusal, the
  // leftover-comments one shared with the rest of the app), and the reason
  // below adds its own full stop.
  const stated = cause.replace(/\.\s*$/, '')
  if (failures.length === 0) {
    // The vault is back the way it was found, so the crash journal is
    // describing a run there is nothing left to recover from.
    await discardRunJournal(state.journalFile)
    return {
      ...base,
      paths: [],
      rolledBack: { reason: `${stated}. The run was rolled back; your vault is unchanged.` }
    }
  }
  // The paths still differing from their pre-run bytes are exactly the ones the
  // rollback could not reach, which is what `paths` promises to list. Once
  // each: a note and its comments can both have failed.
  const unrestored = [...new Set(failures.map((failure) => failure.path))]
  let reason =
    `${stated}. ROLLBACK INCOMPLETE: ${failures.length} of ${state.journal.size + state.sidecars.size} ` +
    `files could not be restored (${describeFailures(failures)}). ` +
    `Undo run ${run.runId} to try again.`
  try {
    await writeLedger(root, {
      ...ledgerBase(run, state),
      finishedAt: Date.now(),
      applied: 0,
      paths: unrestored,
      undone: false,
      rolledBack: { reason }
    })
    // The ledger carries the journal now, and it says more than a crash file
    // could: which paths the rollback could not reach, and why.
    await discardRunJournal(state.journalFile)
  } catch (err) {
    // Nothing left to fall back on, so the receipt has to carry the whole truth.
    // The crash journal deliberately stays: it is now the only copy of the
    // pre-run bytes for files still holding this run's writes, and the next run
    // turns it into the undoable ledger this one could not write.
    reason =
      `${reason} The run could not be recorded either (${messageOf(err)}), ` +
      `so undo is offered again only once ZenNotes can write to the vault's .zennotes folder.`
  }
  return { ...base, paths: unrestored, rolledBack: { reason } }
}

function journalEntries(state: RunState): NoteJournalEntry[] {
  return [...state.journal.values()]
}

/* -------------------------------------------------------------------------- */
/*  Reading the history back                                                  */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** One note entry, from a ledger or a crash journal line, or null. */
function parseNoteEntry(value: unknown): NoteJournalEntry | null {
  if (!isRecord(value)) return null
  const { path: entryPath, before, link } = value
  if (typeof entryPath !== 'string') return null
  if (typeof before !== 'string' && before !== null) return null
  return typeof link === 'string' ? { path: entryPath, before, link } : { path: entryPath, before }
}

function parseJournal(value: unknown): NoteJournalEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => parseNoteEntry(item))
    .filter((entry): entry is NoteJournalEntry => entry !== null)
}

/** One sidecar entry, from a ledger or a crash journal line, or null. A kind
 *  this version does not know is dropped rather than guessed at. */
function parseSidecarEntry(value: unknown): LedgerSidecarEntry | null {
  if (!isRecord(value)) return null
  const { note, sidecar, before, after } = value
  if (typeof note !== 'string') return null
  if (sidecar !== 'comments' && sidecar !== 'metadata') return null
  if (typeof before !== 'string' && before !== null) return null
  const entry: LedgerSidecarEntry = { note, sidecar, before }
  if (typeof after === 'string' || after === null) entry.after = after
  return entry
}

function parseSidecars(value: unknown): LedgerSidecarEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => parseSidecarEntry(item))
    .filter((entry): entry is LedgerSidecarEntry => entry !== null)
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function parseHashes(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) return {}
  const hashes: Record<string, string | null> = {}
  for (const [key, hash] of Object.entries(value)) {
    if (typeof hash === 'string' || hash === null) hashes[key] = hash
  }
  return hashes
}

function parseNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Read one ledger, tolerating a file a newer version wrote fields into.
 *
 * The journal is validated strictly (it is what undo writes from) while the
 * reporting fields fall back, because a run whose `applied` count is unreadable
 * is still a run the user must be able to undo.
 */
async function readLedger(abs: string): Promise<WorkflowRunLedger> {
  const raw = await fs.readFile(abs, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) throw new Error('Run ledger is not an object')
  const runId = parsed.runId
  if (typeof runId !== 'string' || !runId) throw new Error('Run ledger has no run id')
  const ops = Array.isArray(parsed.ops)
    ? parsed.ops
        .map((op) => parseWorkflowOp(op))
        .filter((op): op is WorkflowOp => op !== null)
    : []
  const ledger: WorkflowRunLedger = {
    version: parseNumber(parsed.version, LEDGER_VERSION),
    runId,
    workflowId: typeof parsed.workflowId === 'string' ? parsed.workflowId : 'unknown',
    startedAt: parseNumber(parsed.startedAt, 0),
    finishedAt: parseNumber(parsed.finishedAt, 0),
    applied: parseNumber(parsed.applied, 0),
    irreversible: parseNumber(parsed.irreversible, 0),
    paths: parseStringArray(parsed.paths),
    ops,
    journal: parseJournal(parsed.journal),
    hashes: parseHashes(parsed.hashes),
    undone: parsed.undone === true
  }
  const sidecars = parseSidecars(parsed.sidecars)
  if (sidecars.length > 0) ledger.sidecars = sidecars
  if (typeof parsed.undoneAt === 'number') ledger.undoneAt = parsed.undoneAt
  const rolledBack = parsed.rolledBack
  if (isRecord(rolledBack) && typeof rolledBack.reason === 'string') {
    ledger.rolledBack = { reason: rolledBack.reason }
  }
  const interrupted = parsed.interrupted
  if (isRecord(interrupted) && typeof interrupted.reason === 'string') {
    ledger.interrupted = { reason: interrupted.reason }
  }
  return ledger
}

/**
 * Paths that are no longer what the run left there.
 *
 * Undo restores recorded bytes over whatever is in the file now, on purpose:
 * that is the only mechanism that is right by construction, and a note the run
 * changed is a note the user may well have kept working in. Those two facts
 * together mean an undo can take an edit with it that the run never made, so
 * the result names those files rather than reverting them in silence. A path
 * the ledger holds no post-run hash for makes no claim about how it was left
 * (its write never landed), so it cannot have drifted.
 */
async function driftedPathsOf(root: string, ledger: WorkflowRunLedger): Promise<string[]> {
  const drifted: string[] = []
  for (const entry of ledger.journal) {
    const after = ledger.hashes[entry.path]
    if (after === undefined) continue
    let live: string | null
    try {
      live = await readIfExists(resolveVaultPath(root, entry.path))
    } catch {
      // A path undo is about to refuse anyway; the failure it reports there is
      // the useful one, not a drift report about a file it cannot read.
      continue
    }
    if ((live === null ? null : hashText(live)) !== after) drifted.push(entry.path)
  }
  // A comment added to a moved note since the run is an edit to that note as
  // far as its author is concerned, and undo takes it away all the same, so
  // it is reported under the note's name.
  for (const entry of ledger.sidecars ?? []) {
    if (entry.after === undefined || drifted.includes(entry.note)) continue
    let live: string | null
    try {
      live = await readIfExists(await sidecarPathOf(root, entry.note, entry.sidecar))
    } catch {
      continue
    }
    if ((live === null ? null : hashText(live)) !== entry.after) drifted.push(entry.note)
  }
  return drifted
}

/**
 * Take a run back by restoring the bytes it recorded.
 *
 * Undoing an unknown or already-undone run is an error, never a silent success:
 * "nothing happened" and "your vault is back" are different answers, and only
 * one of them is safe to show the user.
 *
 * A partial restore throws WITHOUT marking the run undone. Restoring recorded
 * bytes is idempotent, so leaving the run undoable means the honest recovery
 * (try again) is also the correct one.
 *
 * The result names any file that had changed since the run (`driftedPaths`),
 * which is what an undo of an edited note takes with it.
 */
export async function undoWorkflowRun(root: string, runId: string): Promise<WorkflowUndoResult> {
  return withVaultRunLock(root, () => undoWorkflowRunNow(root, runId))
}

async function undoWorkflowRunNow(root: string, runId: string): Promise<WorkflowUndoResult> {
  const abs = resolveLedgerPath(root, runId)
  let ledger: WorkflowRunLedger
  try {
    ledger = await readLedger(abs)
  } catch (err) {
    if (isMissing(err)) throw new Error(`Unknown workflow run: ${runId}`)
    throw new Error(`Cannot read the record of run ${runId}: ${messageOf(err)}`)
  }
  if (ledger.undone) throw new Error(`Workflow run was already undone: ${runId}`)

  // Read before anything is restored, since afterwards every file matches the
  // journal and nothing about the drift is recoverable.
  const driftedPaths = await driftedPathsOf(root, ledger)

  const sidecars = ledger.sidecars ?? []
  const { restored, failures } = await restoreRun(root, ledger.journal, sidecars)
  if (failures.length > 0) {
    throw new Error(
      `Undo of run ${runId} is incomplete: ${failures.length} of ${ledger.journal.length + sidecars.length} ` +
        `files could not be restored (${describeFailures(failures)}). ` +
        `The run is still undoable; try again.`
    )
  }

  await writeLedger(root, { ...ledger, undone: true, undoneAt: Date.now() })
  return { runId, restored, driftedPaths }
}

/**
 * Remove every ledger a workflow's runs left behind, resolving to how many.
 *
 * Exists for the guided tutorial's leave-no-trace cleanup: the practice
 * workflow's ledgers hold copies of the practice notes' bytes, so "the vault
 * ends exactly as it started" includes them. Serialized on the same per-vault
 * queue as apply and undo, so it can never race a run into losing its journal
 * mid-write. An unreadable ledger is left alone: it cannot be proven ours.
 */
export async function deleteWorkflowRuns(root: string, workflowId: string): Promise<number> {
  return withVaultRunLock(root, () => deleteWorkflowRunsNow(root, workflowId))
}

async function deleteWorkflowRunsNow(root: string, workflowId: string): Promise<number> {
  const dir = runsDir(root)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue
    try {
      const ledger = await readLedger(path.join(dir, name))
      if (ledger.workflowId !== workflowId) continue
      await fs.rm(path.join(dir, name), { force: true })
      // Its crash journal too, on the off chance one outlived the run: leaving
      // it would let recovery rebuild the very ledger just deleted, and this
      // exists so a workflow can leave no trace at all.
      await fs.rm(journalPathFor(root, ledger.runId), { force: true })
      removed += 1
    } catch {
      /* unreadable: not provably this workflow's, so it stays */
    }
  }
  return removed
}

/**
 * Every recorded run, newest first, which is the order a history list shows and
 * the order the most recent undo is reached in.
 *
 * A vault with no runs is the normal case, so a missing directory is an empty
 * list rather than an error. One unreadable ledger is skipped with a warning
 * instead of hiding the rest of the history.
 *
 * Recovery runs first, so a run the app was killed in the middle of appears
 * here (marked, and undoable) the moment anyone looks at the history, rather
 * than waiting for the next run to notice it.
 */
export async function listWorkflowRuns(root: string): Promise<WorkflowRunSummary[]> {
  await recoverInterruptedRuns(root)
  const dir = runsDir(root)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const runs: WorkflowRunSummary[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue
    try {
      const ledger = await readLedger(path.join(dir, name))
      runs.push({
        runId: ledger.runId,
        workflowId: ledger.workflowId,
        startedAt: ledger.startedAt,
        applied: ledger.applied,
        paths: ledger.paths,
        // Nothing recorded means nothing to restore, so offering undo would be
        // a promise the journal cannot keep.
        undoable: !ledger.undone && ledger.journal.length > 0,
        // Only when true, so a normal run's summary is exactly the shape it has
        // always been on the wire.
        ...(ledger.interrupted ? { interrupted: true } : {})
      })
    } catch (err) {
      console.warn(`[workflows] skipping unreadable run ledger ${name}:`, err)
    }
  }
  runs.sort((a, b) => b.startedAt - a.startedAt || b.runId.localeCompare(a.runId))
  return runs
}
