/**
 * `zen` CLI install / uninstall logic for the desktop main process.
 *
 * The wrapper script `build/zen` ships in the packaged app at
 * Contents/Resources/zen (macOS) or resources/zen (Linux). Installing
 * the CLI means creating a symlink to that wrapper somewhere on the
 * user's $PATH.
 *
 * We deliberately avoid a sudo / admin prompt by default. Most macOS
 * and Linux setups already have at least one user-writable directory
 * on PATH (Homebrew's /opt/homebrew/bin on Apple Silicon, ~/.local/bin
 * for users who follow XDG conventions, etc.). We pick the best one
 * we can find. Only when no user-writable directory is on PATH do we
 * fall back to osascript / pkexec for /usr/local/bin.
 */

import { app } from 'electron'
import { execFile } from 'node:child_process'
import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import os from 'node:os'
import type { CliInstallStatus } from '@shared/ipc'

const execFileAsync = promisify(execFile)

const SUDO_FALLBACK_DIR = '/usr/local/bin'
const CLI_SKILL_NAME = 'zennotes-cli'

/* ---------- Wrapper resolution ---------------------------------------- */

interface WrapperLocation {
  wrapperPath: string
  cliJsPath: string
}

async function locateWrapper(): Promise<WrapperLocation | null> {
  const candidates: WrapperLocation[] = []

  if (app.isPackaged) {
    candidates.push({
      wrapperPath: path.join(process.resourcesPath, 'zen'),
      cliJsPath: path.join(process.resourcesPath, 'cli.js')
    })
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  const devCliJs = path.join(here, 'cli.js')
  candidates.push({
    wrapperPath: await ensureDevWrapper(devCliJs),
    cliJsPath: devCliJs
  })

  for (const c of candidates) {
    try {
      const [wrapperStat, cliStat] = await Promise.all([
        fsp.stat(c.wrapperPath),
        fsp.stat(c.cliJsPath)
      ])
      if (wrapperStat.isFile() && cliStat.isFile()) return c
    } catch {
      /* keep trying */
    }
  }
  return null
}

async function locateBundledCliSkill(): Promise<string | null> {
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'skills', CLI_SKILL_NAME))
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  candidates.push(
    path.resolve(here, '../../../../integrations/skills', CLI_SKILL_NAME),
    path.resolve(process.cwd(), 'integrations/skills', CLI_SKILL_NAME)
  )

  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(path.join(candidate, 'SKILL.md'))
      if (stat.isFile()) return candidate
    } catch {
      /* keep trying */
    }
  }
  return null
}

async function ensureDevWrapper(cliJsPath: string): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'cli')
  const target = path.join(dir, 'zen')
  await fsp.mkdir(dir, { recursive: true })
  const electronBinary = process.execPath
  const script = [
    '#!/bin/sh',
    '# Auto-generated dev wrapper for the ZenNotes CLI.',
    `ELECTRON_RUN_AS_NODE=1 exec "${electronBinary}" "${cliJsPath}" "$@"`,
    ''
  ].join('\n')
  await fsp.writeFile(target, script, { mode: 0o755 })
  return target
}

/* ---------- PATH discovery -------------------------------------------- */

/**
 * Candidate install directories in priority order. The "user-friendly"
 * dirs come first so we never reach for sudo when something nearby
 * already works.
 */
function candidateDirs(): string[] {
  const home = os.homedir()
  const seen = new Set<string>()
  const out: string[] = []
  const push = (p: string): void => {
    const resolved = path.resolve(p)
    if (seen.has(resolved)) return
    seen.add(resolved)
    out.push(resolved)
  }
  push(path.join(home, '.local', 'bin'))
  push(path.join(home, 'bin'))
  push('/opt/homebrew/bin')
  push(SUDO_FALLBACK_DIR)
  // Anything else on PATH the user owns counts — in particular
  // language toolchains (~/.cargo/bin, ~/go/bin, ~/.nvm/.../bin) are
  // common. Add them at the end so they're considered after the
  // conventional homes.
  const pathDirs = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
  for (const dir of pathDirs) push(dir)
  return out
}

function pathDirsOnPath(): Set<string> {
  const out = new Set<string>()
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const trimmed = dir.trim()
    if (!trimmed) continue
    try {
      out.add(path.resolve(trimmed))
    } catch {
      /* skip malformed PATH entries */
    }
  }
  return out
}

async function isWritableDir(dir: string): Promise<boolean> {
  try {
    const st = await fsp.stat(dir)
    if (!st.isDirectory()) return false
    await fsp.access(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

interface InstallTarget {
  /** Absolute path to <dir>/zen — where the symlink would land. */
  linkPath: string
  /** Whether <dir> is already on the user's $PATH. */
  onPath: boolean
  /** True when symlinking into <dir> needs sudo / pkexec. */
  requiresSudo: boolean
  /** Shell snippet the user should add to their rc file when onPath
   *  is false. Null when onPath is true. */
  pathHint: string | null
}

async function pickInstallTarget(): Promise<InstallTarget> {
  const onPath = pathDirsOnPath()
  const home = os.homedir()
  const candidates = candidateDirs()

  // Pass 1: a candidate that is BOTH on PATH AND user-writable.
  // This is the no-sudo, no-shell-edit happy path.
  for (const dir of candidates) {
    if (!onPath.has(dir)) continue
    if (await isWritableDir(dir)) {
      return {
        linkPath: path.join(dir, 'zen'),
        onPath: true,
        requiresSudo: false,
        pathHint: null
      }
    }
  }

  // Pass 2: a user-writable candidate even if it's not on PATH yet.
  // We can usually create ~/.local/bin or ~/bin on the fly. Tell the
  // user how to put it on PATH after install.
  const userLocal = path.join(home, '.local', 'bin')
  const userHomeBin = path.join(home, 'bin')
  for (const dir of [userLocal, userHomeBin]) {
    try {
      await fsp.mkdir(dir, { recursive: true })
    } catch {
      continue
    }
    if (await isWritableDir(dir)) {
      return {
        linkPath: path.join(dir, 'zen'),
        onPath: false,
        requiresSudo: false,
        pathHint: pathExportSnippet(dir)
      }
    }
  }

  // Pass 3: fall back to /usr/local/bin with a sudo prompt. This is
  // the historical install location and still on PATH almost
  // everywhere, so the binary will be callable immediately.
  const target = path.join(SUDO_FALLBACK_DIR, 'zen')
  return {
    linkPath: target,
    onPath: onPath.has(SUDO_FALLBACK_DIR),
    requiresSudo: true,
    pathHint: onPath.has(SUDO_FALLBACK_DIR) ? null : pathExportSnippet(SUDO_FALLBACK_DIR)
  }
}

function pathExportSnippet(dir: string): string {
  return `echo 'export PATH="${dir}:$PATH"' >> ~/.zshrc && source ~/.zshrc`
}

/* ---------- Existing-install discovery --------------------------------- */

function looksLikeOurInstall(linkTarget: string): boolean {
  const userDataCli = path.join(app.getPath('userData'), 'cli')
  return (
    linkTarget.startsWith(userDataCli) ||
    (process.resourcesPath && linkTarget.startsWith(process.resourcesPath)) ||
    linkTarget.includes('/ZenNotes.app/') ||
    linkTarget.includes('/zennotes/apps/desktop/')
  )
}

interface ExistingInstall {
  linkPath: string
  /** True when the symlink resolves to our wrapper for this build. */
  installedByThisApp: boolean
}

async function findExistingInstall(
  wrapper: WrapperLocation | null
): Promise<ExistingInstall | null> {
  for (const dir of candidateDirs()) {
    const candidate = path.join(dir, 'zen')
    try {
      const linkTarget = await fsp.readlink(candidate)
      const resolved = path.isAbsolute(linkTarget)
        ? linkTarget
        : path.resolve(dir, linkTarget)
      const byUs = wrapper ? sameFile(resolved, wrapper.wrapperPath) : looksLikeOurInstall(resolved)
      return { linkPath: candidate, installedByThisApp: byUs }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EINVAL') {
        // Real file, not a symlink. Treat as a foreign install we
        // refuse to manage.
        try {
          await fsp.access(candidate)
          return { linkPath: candidate, installedByThisApp: false }
        } catch {
          /* fall through */
        }
      }
      // ENOENT or permission errors — keep searching.
    }
  }
  return null
}

function sameFile(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b)
  } catch {
    return false
  }
}

/* ---------- Status read ----------------------------------------------- */

export async function getCliInstallStatus(): Promise<CliInstallStatus> {
  const supportedPlatform = process.platform === 'darwin' || process.platform === 'linux'
  if (!supportedPlatform) {
    return {
      available: false,
      reason: 'CLI install is currently macOS- and Linux-only. Windows support is on the way.',
      defaultTarget: '',
      requiresSudo: false,
      targetOnPath: false,
      pathHint: null,
      installedAt: null,
      installedByThisApp: false,
      supportedPlatform: false
    }
  }

  const wrapper = await locateWrapper()
  const target = await pickInstallTarget()
  const existing = await findExistingInstall(wrapper)

  return {
    available: wrapper != null,
    reason: wrapper
      ? null
      : 'The CLI has not been built yet. Run `npm run build` (or use a packaged build) so Settings has a wrapper to install.',
    defaultTarget: target.linkPath,
    requiresSudo: target.requiresSudo,
    targetOnPath: target.onPath,
    pathHint: target.pathHint,
    installedAt: existing?.linkPath ?? null,
    installedByThisApp: existing?.installedByThisApp ?? false,
    supportedPlatform: true
  }
}

/* ---------- Install --------------------------------------------------- */

export async function installCli(): Promise<CliInstallStatus> {
  if (process.platform === 'win32') {
    throw new Error('CLI install is not yet supported on Windows.')
  }
  const wrapper = await locateWrapper()
  if (!wrapper) {
    throw new Error(
      'The CLI wrapper is not bundled with this build. Run `npm run build` (or launch from a packaged build) and try again.'
    )
  }

  // If something is already installed at one of our candidates, prefer
  // overwriting it in place rather than creating a second copy on PATH.
  const existing = await findExistingInstall(wrapper)
  let target: InstallTarget
  if (existing && existing.installedByThisApp) {
    target = {
      linkPath: existing.linkPath,
      onPath: pathDirsOnPath().has(path.dirname(existing.linkPath)),
      requiresSudo: !(await isWritableDir(path.dirname(existing.linkPath))),
      pathHint: null
    }
  } else if (existing && !existing.installedByThisApp) {
    throw new Error(
      `${existing.linkPath} already exists and is not managed by ZenNotes. Remove it manually if you want ZenNotes to take over.`
    )
  } else {
    target = await pickInstallTarget()
  }

  const linkDir = path.dirname(target.linkPath)
  await fsp.mkdir(linkDir, { recursive: true }).catch(() => undefined)

  if (!target.requiresSudo) {
    await writeSymlink(wrapper.wrapperPath, target.linkPath)
  } else {
    try {
      await writeSymlink(wrapper.wrapperPath, target.linkPath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        await elevateAndSymlink(wrapper.wrapperPath, target.linkPath)
      } else {
        throw err
      }
    }
  }

  await installCliSkillBestEffort()

  return await getCliInstallStatus()
}

async function installCliSkillBestEffort(): Promise<void> {
  try {
    const source = await locateBundledCliSkill()
    if (!source) {
      console.warn('ZenNotes CLI skill source is not bundled with this build.')
      return
    }
    const installed = await installCliSkillToAgentDirs(source)
    if (installed.length === 0) {
      console.warn('No Codex or Claude skill directory found for ZenNotes CLI skill install.')
    }
  } catch (err) {
    console.warn('Failed to install ZenNotes CLI skill', err)
  }
}

async function installCliSkillToAgentDirs(source: string): Promise<string[]> {
  const home = os.homedir()
  const agentRoots = [path.join(home, '.codex'), path.join(home, '.claude')]
  const installed: string[] = []

  for (const root of agentRoots) {
    let stat
    try {
      stat = await fsp.stat(root)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue

    const target = path.join(root, 'skills', CLI_SKILL_NAME)
    try {
      await fsp.rm(target, { recursive: true, force: true })
      await fsp.mkdir(target, { recursive: true })
      await fsp.copyFile(path.join(source, 'SKILL.md'), path.join(target, 'SKILL.md'))
      installed.push(target)
    } catch (err) {
      console.warn(`Failed to install ZenNotes CLI skill to ${target}`, err)
    }
  }

  return installed
}

async function writeSymlink(source: string, target: string): Promise<void> {
  try {
    await fsp.symlink(source, target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      await fsp.rm(target, { force: true })
      await fsp.symlink(source, target)
      return
    }
    throw err
  }
}

async function elevateAndSymlink(source: string, target: string): Promise<void> {
  if (process.platform === 'darwin') {
    const shellCmd =
      `mkdir -p ${shellQuote(path.dirname(target))} && ` +
      `ln -sf ${shellQuote(source)} ${shellQuote(target)}`
    const appleScript = `do shell script "${appleScriptEscape(shellCmd)}" with administrator privileges`
    try {
      await execFileAsync('osascript', ['-e', appleScript])
      return
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? ''
      if (stderr.includes('User canceled') || stderr.includes('-128')) {
        throw new Error('Install canceled.')
      }
      throw new Error(
        `Could not install zen to ${target}. Tried osascript with admin privileges and failed: ${stderr || (err as Error).message}`
      )
    }
  }
  if (process.platform === 'linux') {
    try {
      await execFileAsync('pkexec', [
        'sh',
        '-c',
        `mkdir -p ${shellQuote(path.dirname(target))} && ln -sf ${shellQuote(source)} ${shellQuote(target)}`
      ])
      return
    } catch {
      throw new Error(
        `${target} is not writable and pkexec is unavailable. Run this manually:\n  sudo ln -sf "${source}" "${target}"`
      )
    }
  }
  throw new Error(`Unsupported platform: ${process.platform}`)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function appleScriptEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/* ---------- Uninstall ------------------------------------------------- */

export async function uninstallCli(): Promise<CliInstallStatus> {
  if (process.platform === 'win32') {
    throw new Error('CLI install is not yet supported on Windows.')
  }
  const wrapper = await locateWrapper()
  const existing = await findExistingInstall(wrapper)
  if (!existing) {
    return await getCliInstallStatus()
  }
  if (!existing.installedByThisApp) {
    throw new Error(
      `${existing.linkPath} is not managed by ZenNotes. Remove it manually if you really want it gone.`
    )
  }

  try {
    await fsp.unlink(existing.linkPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      if (process.platform === 'darwin') {
        const shellCmd = `rm -f ${shellQuote(existing.linkPath)}`
        const appleScript = `do shell script "${appleScriptEscape(shellCmd)}" with administrator privileges`
        await execFileAsync('osascript', ['-e', appleScript]).catch((e) => {
          const stderr = (e as { stderr?: string }).stderr ?? ''
          throw new Error(
            stderr.includes('User canceled') || stderr.includes('-128')
              ? 'Uninstall canceled.'
              : `Could not remove ${existing.linkPath}: ${stderr || (e as Error).message}`
          )
        })
      } else {
        await execFileAsync('pkexec', ['rm', '-f', existing.linkPath]).catch((e) => {
          throw new Error(
            `Could not remove ${existing.linkPath}. Run this manually:\n  sudo rm "${existing.linkPath}"\n(${(e as Error).message})`
          )
        })
      }
    } else if (code !== 'ENOENT') {
      throw err
    }
  }
  return await getCliInstallStatus()
}

/* ---------- Used by mcp-integrations.ts to prefer `zen mcp` ----------- */

export async function findManagedCliBinary(): Promise<string | null> {
  if (process.platform === 'win32') return null
  const status = await getCliInstallStatus()
  if (!status.installedByThisApp || !status.installedAt) return null
  return status.installedAt
}

void os
