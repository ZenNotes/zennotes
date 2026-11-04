// Keeping what a note said before an assistant changed it, so the user can
// review the change in the app (docs/ideas/agent-edit-review.md). Every tool
// that rewrites a note's text runs through `runRecordingAgentEdit`: it writes
// the record BEFORE the edit (the workflow journal's rule, so a process that
// dies mid-edit still leaves the bytes to compare against), lets the tool do
// its work, and then notes how the note looks now.
//
// The Go `zn` (ZenNotes/tui internal/mcp), which a managed install runs,
// mirrors this file: same tools, same order, same record (see
// @shared/agent-edits for why the writing side is kept to string comparisons).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { agentEditRecordable, beginAgentEdit, finishAgentEdit } from '@shared/agent-edits'
import { readAgentEditRecord, writeAgentEditRecord } from '../main/agent-edit-files'
import type { VaultBackend } from '../cli/backend'
import { noteTurn } from './note-turns'
import { portableConfigDir, splitTaskId } from './vault-ops'

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value : null
}

/** The tools that change a note's text, and where each one names the note.
 *  Creating, moving, renaming and deleting notes are not recorded: a new
 *  note has nothing to compare against, and Trash already keeps the rest. */
const RECORDED_TOOLS: Record<string, (args: Record<string, unknown>) => string | null> = {
  write_note: (args) => stringArg(args, 'path'),
  append_to_note: (args) => stringArg(args, 'path'),
  prepend_to_note: (args) => stringArg(args, 'path'),
  insert_at_line: (args) => stringArg(args, 'path'),
  replace_in_note: (args) => stringArg(args, 'path'),
  edit_section: (args) => stringArg(args, 'path'),
  toggle_task: taskNoteArg,
  update_task: taskNoteArg
}

function taskNoteArg(args: Record<string, unknown>): string | null {
  const id = stringArg(args, 'id')
  if (!id) return null
  try {
    return splitTaskId(id).rel
  } catch {
    return null
  }
}

export function isRecordedTool(name: string): boolean {
  return name in RECORDED_TOOLS
}

/**
 * Settings → MCP → "Review agent edits", from the portable config file the
 * app writes (`[mcp] review_agent_edits`). On when the file or the key is
 * missing, matching the app's default; off stops recording, and records
 * already written stay reviewable.
 */
export async function reviewAgentEditsEnabled(): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(portableConfigDir(), 'config.toml'), 'utf8')
    const parsed = parseToml(raw) as { mcp?: { review_agent_edits?: unknown } }
    const value = parsed.mcp?.review_agent_edits
    return typeof value === 'boolean' ? value : true
  } catch {
    return true
  }
}

async function noteText(backend: VaultBackend, rel: string): Promise<string | null> {
  try {
    return (await backend.readNote(rel)).body
  } catch {
    return null
  }
}

/**
 * Run a tool, recording its edit when it rewrites a note of a local vault.
 * Recording never stands in the way of the edit the user asked for: if the
 * record cannot be written, the tool still runs and the change is simply not
 * offered for review.
 */
export async function runRecordingAgentEdit<T>(
  toolName: string,
  args: Record<string, unknown>,
  backend: VaultBackend,
  agent: string,
  run: () => Promise<T>
): Promise<T> {
  const noteOf = RECORDED_TOOLS[toolName]
  // A remote vault's notes are written by its server; recording there needs
  // the server's own change (see the design doc).
  if (!noteOf || backend.kind !== 'local') return await run()
  const named = noteOf(args)
  if (!named) return await run()
  // The record belongs to the note, however the client spelled its path.
  const rel = await backend.readNote(named).then(
    (note) => note.path,
    () => named
  )

  return await noteTurn(backend.root, rel, async () => {
    if (!(await reviewAgentEditsEnabled())) return await run()
    const before = await noteText(backend, rel)
    // Not a note we can read (the tool reports its own error), or one too
    // large to keep copies of.
    if (before === null || !agentEditRecordable(before)) return await run()

    const existing = await readAgentEditRecord(backend.root, rel)
    const started = beginAgentEdit(existing, before)
    try {
      await writeAgentEditRecord(backend.root, rel, started)
    } catch (error) {
      console.error(`zennotes mcp: could not record the edit to ${rel}:`, error)
      return await run()
    }

    let result: T
    let failure: unknown = null
    try {
      result = await run()
    } catch (error) {
      failure = error
    }

    const after = await noteText(backend, rel)
    try {
      if (after === null || after === before) {
        // Nothing changed (no match, a task that moved, a failed write):
        // the record goes back to what it was.
        await writeAgentEditRecord(backend.root, rel, existing)
      } else {
        await writeAgentEditRecord(
          backend.root,
          rel,
          finishAgentEdit(started, after, { at: Date.now(), agent, tool: toolName })
        )
      }
    } catch (error) {
      console.error(`zennotes mcp: could not finish the record for ${rel}:`, error)
    }

    if (failure !== null) throw failure
    return result!
  })
}
