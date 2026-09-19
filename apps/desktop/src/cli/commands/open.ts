/**
 * `zn open <path>` — open markdown files, or a folder / vault, in the
 * ZenNotes desktop app.
 *
 *   zn open ~/Downloads/notes.md
 *   zn open inbox/Today.md other.markdown
 *   zn open inbox/demo/03 — Tables and Task Lists.md   (unquoted is fine)
 *   zn open ~/code/myproject/docs        (a folder → focused session)
 *   zn open ~/notes                      (a vault)
 *   zn open -n ~/notes                   (a second window on that vault)
 *
 * A file must be markdown; a folder opens as a focused, non-persisted
 * session rooted at that folder — the app scopes the window to it and
 * shows only its notes, without registering a vault. That's the way to
 * read a repo's `docs/` or zoom in on one folder of a big vault (#466).
 *
 * When a window already shows the vault or folder, the app raises that
 * window. `-n` / `--new-window` asks for a fresh one instead, the way
 * Chrome's flag of the same name does (#815): a second workspace on the
 * same notes, with its own tabs, leaving the first where it was.
 *
 * Paths resolve against the current directory first, then the active
 * vault root — so the vault-relative paths `zn list` prints open from
 * anywhere. When the shell has split an unquoted path with spaces into
 * several tokens, we re-join them and try again as a single path.
 *
 * We hand the paths to the desktop app as launch arguments. Electron's
 * single-instance handling routes them to a running ZenNotes (or starts
 * one), where the open logic decides whether each path is a vault note,
 * a standalone file, or a folder session.
 */

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { isMarkdownFilePath, NEW_WINDOW_SWITCH } from '../../main/file-open.js'
import { getBool, type ParsedArgs } from '../args.js'
import { emitOk } from '../format.js'

export interface ResolvedOpenTarget {
  abs: string
  isDirectory: boolean
}

/** How long a cold start gets to crash before we call the launch good. */
const LAUNCH_GRACE_MS = 500

/** Resolve one target against cwd, then the vault root. A file or a folder. */
export async function resolveTarget(
  vault: string,
  target: string
): Promise<ResolvedOpenTarget | null> {
  const candidates = [path.resolve(target)]
  if (vault) candidates.push(path.resolve(vault, target))

  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate)
      if (stat.isFile() || stat.isDirectory()) {
        return { abs: candidate, isDirectory: stat.isDirectory() }
      }
    } catch {
      // try the next candidate
    }
  }
  return null
}

function assertMarkdown(abs: string): void {
  if (!isMarkdownFilePath(abs)) {
    throw new Error(`zn open only supports markdown files (.md, .markdown): ${abs}`)
  }
}

export async function cmdOpen(vault: string, args: ParsedArgs): Promise<void> {
  if (args.positionals.length === 0) {
    throw new Error('zn open needs a path. Usage: zn open <file.md | folder> [more ...]')
  }

  let resolved: ResolvedOpenTarget[] = []
  let unresolved: string | null = null

  for (const target of args.positionals) {
    const hit = await resolveTarget(vault, target)
    if (!hit) {
      unresolved = target
      break
    }
    resolved.push(hit)
  }

  if (unresolved !== null) {
    // An unquoted path with spaces arrives as several tokens — re-join
    // everything and try once more as a single path before giving up.
    const joined = args.positionals.join(' ')
    const hit = args.positionals.length > 1 ? await resolveTarget(vault, joined) : null
    if (hit) {
      resolved = [hit]
    } else {
      const locations = [path.resolve(unresolved), vault ? path.resolve(vault, unresolved) : null]
        .filter((location): location is string => location !== null)
        .join(' or ')
      const hint =
        args.positionals.length > 1 ? ` (also tried as one path: ${JSON.stringify(joined)})` : ''
      throw new Error(`No such file or folder: ${unresolved} (looked in ${locations})${hint}`)
    }
  }

  // A file must be markdown; a folder opens as a focused folder session.
  for (const { abs, isDirectory } of resolved) {
    if (!isDirectory) assertMarkdown(abs)
  }

  const absPaths = resolved.map((r) => r.abs)
  const newWindow = getBool(args, 'n') || getBool(args, 'new-window')
  // The switch rides in argv ahead of the paths; the app reads it per launch,
  // so it covers every path given here and none of a later `zn open`.
  const launchArgs = newWindow ? [NEW_WINDOW_SWITCH, ...absPaths] : absPaths

  // Re-launch our own binary in GUI mode. The CLI wrapper set
  // ELECTRON_RUN_AS_NODE so this process runs as plain Node, so we must
  // drop it for the child or it would start as Node too instead of the app.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, launchArgs, {
    detached: true,
    stdio: 'ignore',
    env
  })

  // The child is detached and silent, so the only honest success signal is
  // the absence of an immediate failure: a spawn error, or the app dying in
  // its first moments (no display, a broken sandbox). A warm hand-off to a
  // running instance exits 0 almost instantly, which is success. Past the
  // grace window we stop waiting rather than make every cold start feel slow;
  // before this, `zn open` printed success unconditionally, including when
  // the app never started at all.
  const failure = await new Promise<string | null>((settle) => {
    const timer = setTimeout(() => settle(null), LAUNCH_GRACE_MS)
    child.once('error', (err) => {
      clearTimeout(timer)
      settle(`Could not launch ZenNotes: ${err.message}`)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && signal === null) settle(null)
      else settle(`ZenNotes exited before it could open anything (${signal ?? `exit code ${code}`}).`)
    })
  })
  child.unref()
  if (failure) throw new Error(failure)

  const where = newWindow ? 'in a new ZenNotes window' : 'in ZenNotes'
  if (resolved.length === 1) {
    const only = resolved[0]!
    emitOk(`Opening ${only.isDirectory ? 'folder ' : ''}${only.abs} ${where}`)
  } else {
    emitOk(`Opening ${resolved.length} items ${where}`)
  }
}
