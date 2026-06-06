/**
 * `zen open <file.md>` — open one or more markdown files in the ZenNotes
 * desktop app, whether or not they live inside a vault.
 *
 *   zen open ~/Downloads/notes.md
 *   zen open inbox/Today.md other.markdown
 *   zen open inbox/demo/03 — Tables and Task Lists.md   (unquoted is fine)
 *
 * Paths resolve against the current directory first, then the active
 * vault root — so the vault-relative paths `zen list` prints open from
 * anywhere. When the shell has split an unquoted path with spaces into
 * several tokens, we re-join them and try again as a single file.
 *
 * We hand the file paths to the desktop app as launch arguments.
 * Electron's single-instance handling routes them to a running ZenNotes
 * (or starts one), where the open-file logic decides whether each file
 * is a vault note or a standalone file.
 */

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { isMarkdownFilePath } from '../../main/file-open.js'
import { type ParsedArgs } from '../args.js'
import { emitOk } from '../format.js'

/** Resolve one target against cwd, then the vault root. Files only. */
async function resolveTarget(vault: string, target: string): Promise<string | null> {
  const candidates = [path.resolve(target)]
  if (vault) candidates.push(path.resolve(vault, target))

  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      // try the next candidate
    }
  }
  return null
}

function assertMarkdown(abs: string): void {
  if (!isMarkdownFilePath(abs)) {
    throw new Error(`zen open only supports markdown files (.md, .markdown): ${abs}`)
  }
}

export async function cmdOpen(vault: string, args: ParsedArgs): Promise<void> {
  if (args.positionals.length === 0) {
    throw new Error('zen open needs a file path. Usage: zen open <file.md> [more.md ...]')
  }

  let absPaths: string[] = []
  let unresolved: string | null = null

  for (const target of args.positionals) {
    const abs = await resolveTarget(vault, target)
    if (!abs) {
      unresolved = target
      break
    }
    absPaths.push(abs)
  }

  if (unresolved !== null) {
    // An unquoted path with spaces arrives as several tokens — re-join
    // everything and try once more as a single file before giving up.
    const joined = args.positionals.join(' ')
    const abs = args.positionals.length > 1 ? await resolveTarget(vault, joined) : null
    if (abs) {
      absPaths = [abs]
    } else {
      const locations = [path.resolve(unresolved), vault ? path.resolve(vault, unresolved) : null]
        .filter((location): location is string => location !== null)
        .join(' or ')
      const hint =
        args.positionals.length > 1 ? ` (also tried as one path: ${JSON.stringify(joined)})` : ''
      throw new Error(`No such file: ${unresolved} (looked in ${locations})${hint}`)
    }
  }

  for (const abs of absPaths) assertMarkdown(abs)

  // Re-launch our own binary in GUI mode. The CLI wrapper set
  // ELECTRON_RUN_AS_NODE so this process runs as plain Node, so we must
  // drop it for the child or it would start as Node too instead of the app.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, absPaths, {
    detached: true,
    stdio: 'ignore',
    env
  })
  child.unref()

  emitOk(
    absPaths.length === 1
      ? `Opening ${absPaths[0]} in ZenNotes`
      : `Opening ${absPaths.length} files in ZenNotes`
  )
}
