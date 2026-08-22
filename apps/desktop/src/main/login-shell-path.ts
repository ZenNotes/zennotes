import { execFile } from 'node:child_process'
import { promises as fsp, constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// A login shell can be slow if the user's profile is heavy; cap it so a stuck
// shell never blocks search. Resolution is memoized, so this runs rarely.
const LOGIN_SHELL_TIMEOUT_MS = 5_000
// Memoize resolved locations so we don't spawn a shell on every capability
// check / search. Short enough to self-heal after a tool is installed mid-run.
const RESOLUTION_TTL_MS = 60_000

// Binary names become file-path segments during PATH scanning, so only ever
// accept bare tokens — never separators or anything shell-special.
const SAFE_COMMAND = /^[A-Za-z0-9._-]+$/

// Interactive shells are free to print from their rc files (banners, plugin
// warnings, instant-prompt chatter), so the probe wraps its one real answer in
// a marker and parsing reads the last marked line instead of trusting stdout.
const OUTPUT_MARKER = '__ZENNOTES_LOGIN_SHELL__'

// Interactive login (`-lic`) before plain login (`-lc`): the interactive PATH
// is the one the user's terminal really has. zsh, the macOS default, reads
// ~/.zshrc only when interactive, and that is where nvm and friends put their
// init lines, so a plain login shell cannot see an nvm-managed node at all
// (#634). `-lc` stays as the fallback for rc files that misbehave without a
// tty; both run under the same timeout.
const SHELL_MODES = ['-lic', '-lc'] as const

const cache = new Map<string, { at: number; value: string | null }>()
let pathDirsCache: { at: number; value: string[] } | null = null

/**
 * Resolve a command to an absolute path using the user's login shell.
 *
 * GUI apps launched from Finder/Dock on macOS (and similar elsewhere) inherit
 * only a minimal PATH (e.g. `/usr/bin:/bin:/usr/sbin:/sbin`), so tools
 * installed by Homebrew, cargo, npm, nix, etc. aren't resolvable by their bare
 * name. This asks the user's login shell for its PATH and scans those
 * directories itself, which also sidesteps interactive-shell hazards like
 * `command -v` answering with an alias definition or a lazy-loader function
 * instead of a path. For the node toolchain there is one more fallback: nvm
 * installs live in a well-known place but only enter PATH when the rc file
 * runs, so `~/.nvm/versions/node` is probed directly (#634).
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

  const value = (await scanLoginShellPath(command)) ?? (await probeNvmInstall(command))
  cache.set(command, { at: Date.now(), value })
  return value
}

/**
 * The PATH directories the user's login shell actually has, which on macOS is
 * not the PATH this process was given.
 *
 * Anything asking "will the user be able to type this command in a terminal?"
 * has to ask the login shell, not `process.env.PATH`. A Finder or Dock launch
 * inherits launchd's `/usr/bin:/bin:/usr/sbin:/sbin` and never reads the
 * profile, so the CLI installer told people `~/.local/bin` was missing from
 * their PATH while their shell had it all along (#528). A terminal launch DOES
 * inherit the real PATH, which is why this never shows up in development.
 * A terminal is interactive, so the interactive PATH is queried first: rc-only
 * additions (nvm, fnm, mise, …) count as "on the user's PATH" too (#634).
 *
 * Entries are returned as the shell reports them, existing or not: callers
 * like the CLI installer ask about directories they are about to create.
 *
 * Empty on Windows (GUI apps there already have the full PATH) and whenever no
 * shell answers; callers fall back to `process.env.PATH`.
 */
export async function resolveLoginShellPathDirs(): Promise<string[]> {
  if (process.platform === 'win32') return []

  const cached = pathDirsCache
  if (cached && Date.now() - cached.at < RESOLUTION_TTL_MS) return cached.value

  const value = await queryLoginShellPathDirs()
  pathDirsCache = { at: Date.now(), value }
  return value
}

/** Resolution is memoized; tests that vary HOME/SHELL/NVM_DIR reset it between cases. */
export function resetLoginShellResolutionForTests(): void {
  cache.clear()
  pathDirsCache = null
}

async function scanLoginShellPath(command: string): Promise<string | null> {
  for (const dir of await resolveLoginShellPathDirs()) {
    if (!path.isAbsolute(dir)) continue
    const candidate = path.join(dir, command)
    try {
      await fsp.access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      /* not in this dir — keep walking the PATH */
    }
  }
  return null
}

async function queryLoginShellPathDirs(): Promise<string[]> {
  for (const mode of SHELL_MODES) {
    for (const shellPath of loginShells()) {
      try {
        await fsp.access(shellPath, fsConstants.X_OK)
        // printf interprets the leading \n itself, forcing our marker onto its
        // own line no matter what the rc files printed before it.
        const { stdout } = await execFileAsync(
          shellPath,
          [mode, `printf '\\n${OUTPUT_MARKER}%s' "$PATH"`],
          {
            encoding: 'utf8',
            timeout: LOGIN_SHELL_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            windowsHide: true
          }
        )
        const dirs = (extractMarkedLine(String(stdout)) ?? '')
          .split(path.delimiter)
          .map((entry) => entry.trim())
          .filter(Boolean)
        // Sanity gate before trusting the answer: fish expands "$PATH" as
        // space-joined list elements, which colon-splitting turns into one
        // garbage entry. A believable POSIX PATH names at least one existing
        // absolute directory; anything else means try the next shell.
        if (dirs.length > 0 && (await anyExistingDirectory(dirs))) return dirs
      } catch {
        /* shell missing here, or it refused these flags — try the next one */
      }
    }
  }
  return []
}

async function anyExistingDirectory(dirs: string[]): Promise<boolean> {
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue
    try {
      if ((await fsp.stat(dir)).isDirectory()) return true
    } catch {
      /* keep looking */
    }
  }
  return false
}

function extractMarkedLine(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const at = lines[i].lastIndexOf(OUTPUT_MARKER)
    if (at >= 0) return lines[i].slice(at + OUTPUT_MARKER.length).trim()
  }
  return null
}

/** The user's own shell first, then the standard POSIX ones. Those still pick
 *  up the login PATH from the system/user profile even when the user's
 *  interactive shell is something exotic (fish, nu) whose syntax differs. */
function loginShells(): string[] {
  return Array.from(
    new Set([process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean))
  ) as string[]
}

/**
 * nvm keeps every install under `$NVM_DIR/versions/node/<version>/bin` and
 * only prepends the active one to PATH from an rc file, so a setup that
 * lazy-loads nvm (a common startup-time tweak) is invisible even to an
 * interactive shell. The layout itself is stable, so when the shells come up
 * empty for the node toolchain, read it directly: the `default` alias wins
 * when it names a concrete version, newest install otherwise.
 *
 * Exported for tests; production goes through resolveCommandViaLoginShell.
 */
export async function probeNvmInstall(command: string): Promise<string | null> {
  if (command !== 'node' && command !== 'npm' && command !== 'npx') return null

  const nvmDir = process.env.NVM_DIR?.trim() || path.join(os.homedir(), '.nvm')
  const versionsDir = path.join(nvmDir, 'versions', 'node')
  let entries: string[]
  try {
    entries = await fsp.readdir(versionsDir)
  } catch {
    return null
  }

  const versions = entries
    .filter((entry) => /^v\d+\.\d+\.\d+$/.test(entry))
    .sort(compareVersionsDescending)
  const preferred = await nvmDefaultAliasVersion(nvmDir)
  const ordered =
    preferred && versions.includes(preferred)
      ? [preferred, ...versions.filter((version) => version !== preferred)]
      : versions

  for (const version of ordered) {
    const candidate = path.join(versionsDir, version, 'bin', command)
    try {
      await fsp.access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      /* this install lacks the binary — try the next version */
    }
  }
  return null
}

async function nvmDefaultAliasVersion(nvmDir: string): Promise<string | null> {
  try {
    const raw = (await fsp.readFile(path.join(nvmDir, 'alias', 'default'), 'utf8')).trim()
    const normalized = raw.startsWith('v') ? raw : `v${raw}`
    // Aliases may also name chains like `lts/*` or `node`; resolving those
    // means reimplementing nvm, so anything but a concrete version falls back
    // to newest-install ordering.
    return /^v\d+\.\d+\.\d+$/.test(normalized) ? normalized : null
  } catch {
    return null
  }
}

function compareVersionsDescending(a: string, b: string): number {
  const parse = (version: string): number[] =>
    version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10))
  const [aMajor, aMinor, aPatch] = parse(a)
  const [bMajor, bMinor, bPatch] = parse(b)
  if (aMajor !== bMajor) return bMajor - aMajor
  if (aMinor !== bMinor) return bMinor - aMinor
  return bPatch - aPatch
}
