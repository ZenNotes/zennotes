/**
 * Persistence layer for the MCP server\u2019s system instructions.
 *
 * The *default* instructions are a baked-in constant (instructions.ts).
 * Users can override them from Settings \u2192 MCP; the override is
 * written to <userData>/zennotes.mcp-instructions.md as plain markdown
 * so it\u2019s easy to diff, edit outside the app, or sync in a
 * dotfiles setup.
 *
 * Both the Electron main process (for the Settings editor) and the
 * standalone MCP server binary (spawned by Claude Code / Codex / etc.)
 * import this module. Both must be able to resolve the same on-disk
 * path without pulling in Electron \u2014 the MCP binary runs as a
 * plain Node process.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { MCP_SERVER_INSTRUCTIONS } from './instructions.js'

export const INSTRUCTIONS_FILENAME = 'zennotes.mcp-instructions.md'

/**
 * Replicates Electron\u2019s `app.getPath('userData')` for product
 * name "ZenNotes". Kept in lockstep with vault-ops.ts so both paths
 * agree regardless of which process is asking.
 */
export function userDataDir(): string {
  const home = os.homedir()
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'ZenNotes')
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        'ZenNotes'
      )
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
        'ZenNotes'
      )
  }
}

export function instructionsFilePath(): string {
  return path.join(userDataDir(), INSTRUCTIONS_FILENAME)
}

/** Read the persisted custom instructions, or null if the user hasn't
 *  overridden them yet (or the file is empty). */
export async function readCustomInstructions(): Promise<string | null> {
  try {
    const raw = await fs.readFile(instructionsFilePath(), 'utf8')
    const trimmed = raw.trim()
    return trimmed ? raw : null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Return the effective instructions: user override if present, the
 *  compiled default otherwise. */
export async function resolveInstructions(): Promise<string> {
  const custom = await readCustomInstructions()
  return custom ?? MCP_SERVER_INSTRUCTIONS
}

/** Persist a user-provided instruction string. Pass null or an empty
 *  string to clear the override and fall back to the default. */
export async function writeCustomInstructions(next: string | null): Promise<void> {
  const filePath = instructionsFilePath()
  if (next == null || !next.trim()) {
    try {
      await fs.rm(filePath, { force: true })
    } catch {
      /* ignore */
    }
    return
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, next.endsWith('\n') ? next : next + '\n', 'utf8')
}

export { MCP_SERVER_INSTRUCTIONS }
