import type { ApplyWorkflowInput } from '@zennotes/bridge-contract/workflows'
import { applyTextOp } from './apply-ops'
import {
  folderTarget,
  joinRel,
  moveTarget,
  normalizeRel,
  noteExtensionOf,
  notePathProblem,
  relBasename,
  relDirname,
  renameTarget,
  stripNoteExtension,
  type SystemFolderDirs
} from './paths'
import { IRREVERSIBLE_OP_KINDS, type WorkflowOp } from './types'

export interface WorkflowRunFileChange {
  path: string
  before: string | null
  after: string | null
}

export interface PreparedWorkflowRun {
  workflowId: string
  ops: WorkflowOp[]
  applied: number
  irreversible: number
  changes: WorkflowRunFileChange[]
}

export interface WorkflowRunSource {
  /** Current bytes, or null when the note does not exist. */
  read(path: string): Promise<string | null>
  systemFolderDirs: SystemFolderDirs
}

const PER_NOTE_TEXT_OPS = new Set<WorkflowOp['kind']>([
  'set-frontmatter',
  'add-tag',
  'remove-tag',
  'append',
  'prepend',
  'apply-template'
])

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

/** Validate one operation that crossed a process or HTTP boundary.
 *  SYNCED COPIES: the same validator exists in apps/desktop/src/main/
 *  workflow-apply.ts, and the Go server keeps a field map in
 *  requiredWorkflowOpFields (apps/server/internal/vault/workflows.go).
 *  A new op kind or field lands in all three or web and desktop disagree
 *  about which runs are valid. */
export function parseWorkflowOp(value: unknown): WorkflowOp | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const kind = stringField(record, 'kind')
  const path = stringField(record, 'path')
  switch (kind) {
    case 'set-frontmatter': {
      const field = stringField(record, 'field')
      const fieldValue = stringField(record, 'value')
      return path === null || field === null || fieldValue === null
        ? null
        : { kind, path, field, value: fieldValue }
    }
    case 'add-tag':
    case 'remove-tag': {
      const tag = stringField(record, 'tag')
      return path === null || tag === null ? null : { kind, path, tag }
    }
    case 'move':
    case 'rename': {
      const to = stringField(record, 'to')
      return path === null || to === null ? null : { kind, path, to }
    }
    case 'append':
    case 'prepend': {
      const text = stringField(record, 'text')
      return path === null || text === null ? null : { kind, path, text }
    }
    case 'write-section': {
      const heading = stringField(record, 'heading')
      const text = stringField(record, 'text')
      return path === null || heading === null || text === null
        ? null
        : { kind, path, heading, text }
    }
    case 'write-note': {
      const text = stringField(record, 'text')
      return path === null || text === null ? null : { kind, path, text }
    }
    case 'create-note': {
      const body = stringField(record, 'body')
      return path === null || body === null ? null : { kind, path, body }
    }
    case 'apply-template': {
      const template = stringField(record, 'template')
      return path === null || template === null ? null : { kind, path, template }
    }
    case 'archive':
    case 'trash':
      return path === null ? null : { kind, path }
    case 'notify': {
      const message = stringField(record, 'message')
      return message === null ? null : { kind, message }
    }
    case 'clipboard': {
      const text = stringField(record, 'text')
      return text === null ? null : { kind, text }
    }
    default:
      return null
  }
}

function parseWorkflowOps(values: unknown[]): WorkflowOp[] {
  return values.map((value, index) => {
    const op = parseWorkflowOp(value)
    if (!op) throw new Error(`Workflow op ${index} is not a valid operation`)
    return op
  })
}

function opTargets(op: WorkflowOp, dirs: SystemFolderDirs): string[] {
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

function assertNotePath(path: string): void {
  const problem = notePathProblem(path)
  if (problem) throw new Error(`Workflow op path is invalid (${problem}): ${path}`)
}

/**
 * Resolve a browser-planned run into one optimistic server transaction.
 *
 * All transformations happen against an in-memory view first. Nothing is
 * written until the server has received every pre-run and post-run byte, so it
 * can verify that the vault did not change underneath the dry run, journal the
 * originals, and either keep every change or roll all of them back.
 */
export async function prepareWorkflowRun(
  input: ApplyWorkflowInput,
  source: WorkflowRunSource
): Promise<PreparedWorkflowRun> {
  const workflowId = input.workflowId.trim() || 'unknown'
  const ops = parseWorkflowOps(input.ops)

  for (const op of ops) {
    for (const target of opTargets(op, source.systemFolderDirs)) assertNotePath(target)
  }

  const live = new Map<string, string | null>()
  const journal = new Map<string, { path: string; before: string | null }>()
  const redirects = new Map<string, string>()

  const read = async (path: string): Promise<string | null> => {
    const normalized = normalizeRel(path)
    if (live.has(normalized)) return live.get(normalized) ?? null
    const value = await source.read(normalized)
    live.set(normalized, value)
    return value
  }

  const touch = async (path: string): Promise<void> => {
    const normalized = normalizeRel(path)
    if (journal.has(normalized)) return
    journal.set(normalized, { path: normalized, before: await read(normalized) })
  }

  const resolveLivePath = async (path: string): Promise<string> => {
    const normalized = normalizeRel(path)
    const redirected = redirects.get(normalized)
    if (redirected === undefined || (await read(normalized)) !== null) return normalized
    return redirected
  }

  const uniquePath = async (path: string): Promise<string> => {
    const ext = noteExtensionOf(path)
    const stem = joinRel(relDirname(path), stripNoteExtension(relBasename(path)))
    let candidate = normalizeRel(path)
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      if ((await read(candidate)) === null) return candidate
      candidate = `${stem} ${suffix}${ext}`
    }
    throw new Error(`Cannot find a free destination for ${path}`)
  }

  const applyText = async (op: Exclude<WorkflowOp, { kind: 'notify' | 'clipboard' | 'move' | 'rename' | 'archive' | 'trash' }>): Promise<void> => {
    const path = await resolveLivePath(op.path)
    const before = await read(path)
    if (op.kind === 'create-note' && before !== null) {
      throw new Error(
        `create-note would replace the existing note ${path}. Use write to replace a note on purpose.`
      )
    }
    if (before === null && PER_NOTE_TEXT_OPS.has(op.kind)) {
      throw new Error(
        `Cannot ${op.kind} ${path}: the note is missing (moved or removed earlier in this run?)`
      )
    }
    const after = applyTextOp(before ?? '', op)
    if (after === null) throw new Error(`Workflow op ${op.kind} is not a text op`)
    if (before !== null && after === before) return
    await touch(path)
    live.set(path, after)
  }

  const move = async (
    kind: 'move' | 'rename' | 'archive' | 'trash',
    fromPath: string,
    nominalPath: string,
    promisedPath: string
  ): Promise<void> => {
    const from = normalizeRel(fromPath)
    const body = await read(from)
    if (body === null) throw new Error(`Cannot ${kind} ${from}: the note is missing`)
    const nominal = normalizeRel(nominalPath)
    if (nominal === from) return
    const destination = await uniquePath(nominal)
    await touch(from)
    await touch(destination)
    live.set(from, null)
    live.set(destination, body)
    const promised = normalizeRel(promisedPath)
    if (destination !== promised) redirects.set(promised, destination)
  }

  let applied = 0
  for (const op of ops) {
    switch (op.kind) {
      case 'notify':
      case 'clipboard':
        continue
      case 'move': {
        const from = await resolveLivePath(op.path)
        await move('move', from, moveTarget(from, op.to), moveTarget(normalizeRel(op.path), op.to))
        break
      }
      case 'rename': {
        const from = await resolveLivePath(op.path)
        await move(
          'rename',
          from,
          renameTarget(from, op.to),
          renameTarget(normalizeRel(op.path), op.to)
        )
        break
      }
      case 'archive': {
        const from = await resolveLivePath(op.path)
        await move(
          'archive',
          from,
          folderTarget('archive', from, source.systemFolderDirs),
          folderTarget('archive', normalizeRel(op.path), source.systemFolderDirs)
        )
        break
      }
      case 'trash': {
        const from = await resolveLivePath(op.path)
        await move(
          'trash',
          from,
          folderTarget('trash', from, source.systemFolderDirs),
          folderTarget('trash', normalizeRel(op.path), source.systemFolderDirs)
        )
        break
      }
      default:
        await applyText(op)
    }
    applied += 1
  }

  const changes: WorkflowRunFileChange[] = []
  for (const entry of journal.values()) {
    changes.push({ ...entry, after: await read(entry.path) })
  }

  return {
    workflowId,
    ops,
    applied,
    irreversible: ops.filter((op) => IRREVERSIBLE_OP_KINDS.has(op.kind)).length,
    changes
  }
}
