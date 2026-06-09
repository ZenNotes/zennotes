import { execFile } from 'node:child_process'
import { promises as fsp, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// A login shell can be slow if the user's profile is heavy; cap it so a stuck
// shell never blocks search. Resolution is memoized, so this runs rarely.
const LOGIN_SHELL_TIMEOUT_MS = 5_000
// Memoize resolved locations so we don't spawn a shell on every capability
// check / search. Short enough to self-heal after a tool is installed mid-run.
const RESOLUTION_TTL_MS = 60_000

// Binary names are interpolated into a shell `command -v` invocation, so only
// ever accept bare tokens — never anything that could break out of the word.
const SAFE_COMMAND = /^[A-Za-z0-9._-]+$/

const cache = new Map<string, { at: number; value: string | null }>()

/**
 * Resolve a command to an absolute path using the user's login shell.
 *
 * GUI apps launched from Finder/Dock on macOS (and similar elsewhere) inherit
 * only a minimal PATH (e.g. `/usr/bin:/bin:/usr/sbin:/sbin`), so tools
 * installed by Homebrew, cargo, npm, nix, etc. aren't resolvable by their bare
 * name. Spawning a *login* shell (`$SHELL -lc 'command -v <cmd>'`) queries the
 * PATH the user actually has configured — the same approach the CLI-install and
 * Raycast integrations already use to locate their tools.
 *
 * Returns the absolute path, or `null` when the command can't be resolved —
 * including on Windows, where GUI apps already inherit the full PATH and the
 * POSIX login-shell trick doesn't apply (callers should fall back to the bare
 * command name there).
 */
export async function resolveCommandViaLoginShell(command: string): Promise<string | null> {
  if (!SAFE_COMMAND.test(command)) return null
  if (process.platform === 'win32') return null

  const cached = cache.get(command)
  if (cached && Date.now() - cached.at < RESOLUTION_TTL_MS) return cached.value

  const value = await queryLoginShell(command)
  cache.set(command, { at: Date.now(), value })
  return value
}

async function queryLoginShell(command: string): Promise<string | null> {
  // Try the user's own shell first, then the standard POSIX shells. On
  // macOS/Linux those still pick up the login PATH from the system/user
  // profile even when the user's interactive shell is something exotic (fish,
  // nu) whose `command -v` syntax differs from POSIX.
  const shells = Array.from(
    new Set([process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean))
  ) as string[]

  for (const shellPath of shells) {
    try {
      await fsp.access(shellPath, fsConstants.X_OK)
      const { stdout } = await execFileAsync(shellPath, ['-lc', `command -v ${command}`], {
        encoding: 'utf8',
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      })
      const resolved = String(stdout).trim().split(/\r?\n/)[0]?.trim()
      if (resolved && path.isAbsolute(resolved)) return resolved
    } catch {
      /* shell missing here, or command not found in it — try the next one */
    }
  }
  return null
}
