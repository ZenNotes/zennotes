/**
 * `zn` CLI install / uninstall logic for the desktop main process (#126: the
 * command was renamed from `zen` to avoid clashing with Zen Browser on PATH).
 *
 * The wrapper script `build/zen` ships in the packaged app at
 * Contents/Resources/zen (macOS) or resources/zen (Linux). Installing
 * the CLI uses a verified persistent Go runtime when the app includes one,
 * retaining that resource path and the Node CLI for transition compatibility.
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
import { randomUUID } from 'node:crypto'
import { prepareTerminalRuntime, readActiveTerminalRuntime } from './terminal-runtime'
import type { CliInstallStatus } from '@shared/ipc'
import { resolveLoginShellPathDirs } from './login-shell-path'

const execFileAsync = promisify(execFile)

const SUDO_FALLBACK_DIR = '/usr/local/bin'

// #126: the installed command is `zn` (renamed from `zen`, which collides with
// Zen Browser on PATH — Linux and macOS/Homebrew). WRAPPER_NAME is the bundled
// wrapper file (an internal resource, never on PATH) that the `zn` symlink points
// at. LEGACY_CLI_NAMES are old symlink names we migrate away from and clean up.
const CLI_NAME = 'zn'
const WRAPPER_NAME = 'zen'
const LEGACY_CLI_NAMES = ['zen']

/* ---------- Wrapper resolution ---------------------------------------- */

interface WrapperLocation {
  wrapperPath: string
  cliJsPath: string
  legacyWrapperPaths?: string[]
  runtime?: 'go' | 'node'
  version?: string
  runtimeError?: string
}

let migrationError: string | undefined

interface InstallReceipt {
  linkPath: string
  linkTarget: string
}

interface RepairOffer {
  token: string
  linkPath: string
  oldTarget: string
  newTarget: string
  backupPath: string
  expiresAt: number
}

let repairOffer: RepairOffer | undefined

function receiptPath(): string {
  return path.join(app.getPath('userData'), 'cli', 'install-receipts.json')
}

async function readInstallReceipts(): Promise<InstallReceipt[]> {
  try {
    const data = JSON.parse(await fsp.readFile(receiptPath(), 'utf8'))
    if (data?.schemaVersion !== 1 || !Array.isArray(data.links) || data.links.length > 128)
      return []
    return data.links.filter((item: unknown): item is InstallReceipt => {
      if (!item || typeof item !== 'object') return false
      const value = item as InstallReceipt
      return (
        typeof value.linkPath === 'string' &&
        path.isAbsolute(value.linkPath) &&
        [CLI_NAME, ...LEGACY_CLI_NAMES].includes(path.basename(value.linkPath)) &&
        typeof value.linkTarget === 'string' &&
        value.linkTarget.length > 0 &&
        !value.linkTarget.includes('\0')
      )
    })
  } catch {
    return []
  }
}

async function writeInstallReceipts(entries: InstallReceipt[]): Promise<void> {
  const target = receiptPath()
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await fsp.writeFile(
      temporary,
      JSON.stringify({ schemaVersion: 1, links: entries.slice(-128) }),
      { mode: 0o600 }
    )
    await fsp.rename(temporary, target)
  } finally {
    await fsp.rm(temporary, { force: true })
  }
}

async function recordInstall(linkPath: string, linkTarget: string): Promise<void> {
  if ((await fsp.readlink(linkPath)) !== linkTarget)
    throw new Error(`${linkPath} changed during installation.`)
  const entries = (await readInstallReceipts()).filter((entry) => entry.linkPath !== linkPath)
  entries.push({ linkPath, linkTarget })
  await writeInstallReceipts(entries)
}

async function forgetInstall(linkPath: string, linkTarget: string): Promise<void> {
  const entries = await readInstallReceipts()
  const retained = entries.filter(
    (entry) => entry.linkPath !== linkPath || entry.linkTarget !== linkTarget
  )
  if (retained.length !== entries.length) await writeInstallReceipts(retained)
}

async function ownedInstall(
  linkPath: string,
  linkTarget: string,
  wrapper: WrapperLocation | null,
  receipts: InstallReceipt[]
): Promise<boolean> {
  const resolved = path.resolve(path.dirname(linkPath), linkTarget)
  return (
    (wrapper ? matchesWrapper(resolved, wrapper) : looksLikeOurInstall(resolved)) ||
    receipts.some((entry) => entry.linkPath === linkPath && entry.linkTarget === linkTarget)
  )
}

async function isMissingHistoricalTarget(linkPath: string, linkTarget: string): Promise<boolean> {
  const resolved = path.resolve(path.dirname(linkPath), linkTarget)
  // A recognizable name only permits a reviewed repair offer, never ownership.
  const historical =
    process.platform === 'linux'
      ? /^\/(?:tmp|var\/tmp|run\/user\/\d+)\/\.mount_ZenNot[A-Za-z0-9]+\/resources\/zen$/i.test(
          resolved
        )
      : process.platform === 'darwin' && /\/ZenNotes\.app\/Contents\/Resources\/zen$/.test(resolved)
  if (!historical) return false
  try {
    await fsp.stat(linkPath)
    return false
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
  }
}

async function offerRepair(
  existing: ExistingInstall | null,
  wrapper: WrapperLocation | null
): Promise<CliInstallStatus['repair']> {
  if (
    !wrapper ||
    wrapper.runtime !== 'go' ||
    !existing?.linkTarget ||
    existing.installedByThisApp ||
    path.basename(existing.linkPath) !== CLI_NAME ||
    !(await isMissingHistoricalTarget(existing.linkPath, existing.linkTarget))
  )
    return undefined
  if (
    !repairOffer ||
    repairOffer.expiresAt < Date.now() ||
    repairOffer.linkPath !== existing.linkPath ||
    repairOffer.oldTarget !== existing.linkTarget ||
    repairOffer.newTarget !== wrapper.wrapperPath
  ) {
    const token = randomUUID()
    repairOffer = {
      token,
      linkPath: existing.linkPath,
      oldTarget: existing.linkTarget,
      newTarget: wrapper.wrapperPath,
      expiresAt: Date.now() + 5 * 60_000,
      backupPath: path.join(app.getPath('userData'), 'cli', 'link-backups', `${token}.json`)
    }
  }
  const { token, oldTarget, newTarget, backupPath } = repairOffer
  return { token, oldTarget, newTarget, backupPath }
}

function readRepairToken(request: unknown): string | undefined {
  if (request === undefined) return undefined
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Invalid CLI install request.')
  const input = request as Record<string, unknown>
  if (
    Object.keys(input).length !== 1 ||
    typeof input.repairToken !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(input.repairToken)
  )
    throw new Error('Invalid CLI repair request.')
  return input.repairToken
}

async function reviewRepair(
  token: string,
  existing: ExistingInstall | null,
  wrapper: WrapperLocation
): Promise<RepairOffer> {
  const offer = repairOffer
  if (
    !offer ||
    offer.token !== token ||
    offer.expiresAt < Date.now() ||
    !existing ||
    existing.linkPath !== offer.linkPath ||
    existing.linkTarget !== offer.oldTarget ||
    wrapper.wrapperPath !== offer.newTarget ||
    wrapper.runtime !== 'go' ||
    !(await isMissingHistoricalTarget(existing.linkPath, existing.linkTarget))
  ) {
    throw new Error(
      'The CLI shortcut changed or the repair offer expired. Refresh Settings and review it again.'
    )
  }
  repairOffer = undefined
  await fsp.mkdir(path.dirname(offer.backupPath), { recursive: true })
  await fsp.writeFile(
    offer.backupPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        linkPath: offer.linkPath,
        linkTarget: offer.oldTarget,
        savedAt: new Date().toISOString()
      },
      null,
      2
    ),
    { mode: 0o600, flag: 'wx' }
  )
  return offer
}

async function locateWrapper(): Promise<WrapperLocation | null> {
  const candidates: WrapperLocation[] = []

  if (app.isPackaged) {
    candidates.push({
      wrapperPath: path.join(process.resourcesPath, WRAPPER_NAME),
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
      if (wrapperStat.isFile() && cliStat.isFile()) {
        if (process.platform !== 'darwin' && process.platform !== 'linux') return c
        const legacyWrapperPaths = candidates.map((candidate) => candidate.wrapperPath)
        let runtimeError: string | undefined
        let terminal
        try {
          terminal = await prepareTerminalRuntime({
            bundleDir: app.isPackaged
              ? path.join(process.resourcesPath, 'terminal')
              : path.resolve(here, '../../build/terminal', `${process.platform}-${process.arch}`),
            userData: app.getPath('userData'),
            platform: process.platform,
            arch: process.arch,
            legacyCommand: [process.execPath, c.cliJsPath],
            appPath: process.env.APPIMAGE || (app.isPackaged ? process.execPath : undefined)
          })
        } catch (error) {
          runtimeError = (error as Error).message
        }
        terminal ??= await readActiveTerminalRuntime(app.getPath('userData'))
        if (terminal)
          return {
            ...c,
            wrapperPath: terminal.launcherPath,
            legacyWrapperPaths,
            runtime: 'go',
            version: terminal.version,
            runtimeError
          }
        return { ...c, legacyWrapperPaths, runtime: 'node', runtimeError }
      }
    } catch {
      /* keep trying */
    }
  }
  return null
}

async function ensureDevWrapper(cliJsPath: string): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'cli')
  const target = path.join(dir, WRAPPER_NAME)
  await fsp.mkdir(dir, { recursive: true })
  const electronBinary = process.execPath
  const script = [
    '#!/bin/sh',
    '# Auto-generated dev wrapper for the ZenNotes CLI.',
    `if [ "${'${ZENNOTES_CLI_ENGINE:-go}'}" != legacy ] && [ -x ${shellQuote(path.join(dir, 'zn'))} ]; then exec ${shellQuote(path.join(dir, 'zn'))} "$@"; fi`,
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(electronBinary)} ${shellQuote(cliJsPath)} "$@"`,
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
async function candidateDirs(): Promise<string[]> {
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
  for (const dir of await userPathDirs()) push(dir)
  return out
}

/**
 * The PATH entries that matter here, which is the user's, not this process's.
 *
 * Both are used: the login shell's PATH answers "will `zn` be callable in a
 * terminal?", and this process's own PATH is kept as a fallback for the case
 * where no shell answers (and because a terminal-launched app already has the
 * right one). Reading only `process.env.PATH` is what made a Finder-launched
 * app on macOS insist `~/.local/bin` was missing from a PATH that had it (#528):
 * launchd hands GUI apps a minimal PATH and never sources the user's profile.
 */
async function userPathDirs(): Promise<string[]> {
  const fromLoginShell = await resolveLoginShellPathDirs().catch(() => [] as string[])
  const fromProcess = (process.env.PATH ?? '').split(path.delimiter)
  return [...fromLoginShell, ...fromProcess].map((entry) => entry.trim()).filter(Boolean)
}

async function pathDirsOnPath(): Promise<Set<string>> {
  const out = new Set<string>()
  for (const dir of await userPathDirs()) {
    try {
      out.add(path.resolve(dir))
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
  /** Absolute path to <dir>/zn — where the symlink would land. */
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
  const onPath = await pathDirsOnPath()
  const home = os.homedir()
  const candidates = await candidateDirs()

  // Pass 1: a candidate that is BOTH on PATH AND user-writable.
  // This is the no-sudo, no-shell-edit happy path.
  for (const dir of candidates) {
    if (!onPath.has(dir)) continue
    if (await isWritableDir(dir)) {
      return {
        linkPath: path.join(dir, CLI_NAME),
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
        linkPath: path.join(dir, CLI_NAME),
        onPath: false,
        requiresSudo: false,
        pathHint: pathExportSnippet(dir)
      }
    }
  }

  // Pass 3: fall back to /usr/local/bin with a sudo prompt. This is
  // the historical install location and still on PATH almost
  // everywhere, so the binary will be callable immediately.
  const target = path.join(SUDO_FALLBACK_DIR, CLI_NAME)
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
  return [
    path.join(app.getPath('userData'), 'cli', 'zen'),
    path.join(app.getPath('userData'), 'cli', 'zn'),
    ...(process.resourcesPath ? [path.join(process.resourcesPath, WRAPPER_NAME)] : [])
  ].some((candidate) => sameFile(candidate, linkTarget))
}

function matchesWrapper(target: string, wrapper: WrapperLocation): boolean {
  return [wrapper.wrapperPath, ...(wrapper.legacyWrapperPaths ?? [])].some((candidate) =>
    sameFile(target, candidate)
  )
}

interface ExistingInstall {
  linkPath: string
  /** True when the symlink resolves to our wrapper for this build. */
  installedByThisApp: boolean
  linkTarget?: string
}

async function findInstallByName(
  name: string,
  wrapper: WrapperLocation | null
): Promise<ExistingInstall | null> {
  const onPath = await pathDirsOnPath()
  const receipts = await readInstallReceipts()
  const dirs = [
    ...new Set(
      [
        ...onPath,
        ...(await candidateDirs()),
        ...receipts.map((entry) => path.dirname(entry.linkPath))
      ].map((dir) => path.resolve(dir))
    )
  ]
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    try {
      const linkTarget = await fsp.readlink(candidate)
      const byUs = await ownedInstall(candidate, linkTarget, wrapper, receipts)
      if (byUs || onPath.has(dir))
        return { linkPath: candidate, installedByThisApp: byUs, linkTarget }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EINVAL') {
        // Real file, not a symlink. Treat as a foreign install we
        // refuse to manage.
        try {
          await fsp.access(candidate)
          if (onPath.has(dir)) return { linkPath: candidate, installedByThisApp: false }
        } catch {
          /* fall through */
        }
      }
      // ENOENT or permission errors — keep searching.
    }
  }
  return null
}

/**
 * The install the status read reports: `zn` wherever it is, and failing that a
 * ZenNotes-managed legacy `zen` (#126). The legacy pass is managed-only on
 * purpose: a foreign `zen` on PATH is Zen Browser, not an install of ours, and
 * reporting it would tell a browser user their CLI is installed. Without the
 * legacy pass, everyone who installed on ≤2.9.0 reads as "not installed"
 * forever while their old symlink keeps working — the exact state that hid the
 * rename from them.
 */
async function findExistingInstall(
  wrapper: WrapperLocation | null
): Promise<ExistingInstall | null> {
  const current = await findInstallByName(CLI_NAME, wrapper)
  if (current) return current
  for (const legacy of LEGACY_CLI_NAMES) {
    const found = await findInstallByName(legacy, wrapper)
    if (found?.installedByThisApp) return found
  }
  return null
}

/**
 * Heal a pre-2.10 install on launch: users who ran the installer when the
 * command was `zen` and never re-ran it have a working managed `zen` and no
 * `zn` at all, because the rename only ever migrated inside an explicit
 * Install click (#126). Writes `zn` beside the managed legacy link, then
 * removes the legacy name — the same two steps Install performs, minus the
 * click nobody had a reason to make.
 *
 * A cheap no-op in every other state: any `zn` on PATH (ours or foreign) means
 * nothing to do, and a foreign `zen` (Zen Browser) is never touched. Returns
 * the new link path, or null when nothing was migrated.
 */
export async function migrateLegacyCliLink(
  wrapperOverride?: WrapperLocation | null
): Promise<string | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null
  const wrapper = wrapperOverride === undefined ? await locateWrapper() : wrapperOverride
  if (!wrapper) return null
  // Any existing `zn` wins, even a foreign one: creating a second `zn`
  // elsewhere on PATH would shadow-fight it, which is the confusion the
  // rename existed to end.
  if (await findInstallByName(CLI_NAME, wrapper)) return null

  for (const legacy of LEGACY_CLI_NAMES) {
    const found = await findInstallByName(legacy, wrapper)
    if (!found?.installedByThisApp) continue
    const linkPath = path.join(path.dirname(found.linkPath), CLI_NAME)
    try {
      await writeSymlink(wrapper.wrapperPath, linkPath)
      await recordInstall(linkPath, wrapper.wrapperPath)
    } catch {
      // A read-only bin dir at launch is not worth a dialog; the explicit
      // Install path still exists and can elevate.
      return null
    }
    await removeManagedLinks(LEGACY_CLI_NAMES, wrapper)
    return linkPath
  }
  return null
}

/** Update only an existing managed command. Startup never installs a new one. */
export async function migrateInstalledCli(
  wrapperOverride?: WrapperLocation | null
): Promise<string | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null
  const wrapper = wrapperOverride === undefined ? await locateWrapper() : wrapperOverride
  if (!wrapper || wrapper.runtime !== 'go') return null
  const existing = await findInstallByName(CLI_NAME, wrapper)
  if (!existing?.installedByThisApp) return null
  try {
    if (existing.linkTarget === wrapper.wrapperPath) {
      await recordInstall(existing.linkPath, wrapper.wrapperPath)
      return null
    }
    await writeSymlink(wrapper.wrapperPath, existing.linkPath, existing.linkTarget)
    await recordInstall(existing.linkPath, wrapper.wrapperPath)
    migrationError = undefined
    return existing.linkPath
  } catch (error) {
    migrationError = `The terminal upgrade needs repair: ${(error as Error).message}`
    return null
  }
}

function sameFile(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true
  try {
    // macOS aliases /tmp to /private/tmp; app folders can also be symlinked.
    // Compare existing canonical paths without broadening stale-link ownership.
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}

/* ---------- Status read ----------------------------------------------- */

export async function getCliInstallStatus(
  wrapperOverride?: WrapperLocation | null
): Promise<CliInstallStatus> {
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

  const wrapper = wrapperOverride === undefined ? await locateWrapper() : wrapperOverride
  const target = await pickInstallTarget()
  const existing = await findExistingInstall(wrapper)

  return {
    repair: await offerRepair(existing, wrapper),
    available: wrapper != null,
    runtime: wrapper?.runtime,
    runtimeVersion: wrapper?.version,
    runtimeError: wrapper?.runtimeError ?? migrationError,
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

/**
 * Remove ZenNotes-managed symlinks with the given names across candidate dirs —
 * used to migrate off the legacy `zen` name and to clean up on uninstall. Only
 * unlinks symlinks that resolve to OUR wrapper, never a foreign binary such as
 * Zen Browser's `zen`. (#126)
 */
export async function removeManagedLinks(
  names: readonly string[],
  wrapper: WrapperLocation | null
): Promise<string[]> {
  const removed: string[] = []
  const receipts = await readInstallReceipts()
  const dirs = new Set([
    ...(await candidateDirs()),
    ...receipts.map((entry) => path.dirname(entry.linkPath))
  ])
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        const linkTarget = await fsp.readlink(candidate)
        if (await ownedInstall(candidate, linkTarget, wrapper, receipts)) {
          if ((await fsp.readlink(candidate)) !== linkTarget) continue
          await fsp.unlink(candidate)
          await forgetInstall(candidate, linkTarget)
          removed.push(candidate)
        }
      } catch {
        /* not a symlink / missing / unreadable, leave it alone */
      }
    }
  }
  return removed
}

/* ---------- Install --------------------------------------------------- */

export async function installCli(
  request?: unknown,
  wrapperOverride?: WrapperLocation | null
): Promise<CliInstallStatus> {
  const repairToken = readRepairToken(request)
  if (process.platform === 'win32') {
    throw new Error('CLI install is not yet supported on Windows.')
  }
  const wrapper = wrapperOverride === undefined ? await locateWrapper() : wrapperOverride
  if (!wrapper) {
    throw new Error(
      'The CLI wrapper is not bundled with this build. Run `npm run build` (or launch from a packaged build) and try again.'
    )
  }

  // If something is already installed at one of our candidates, prefer
  // overwriting it in place rather than creating a second copy on PATH.
  const existing = await findExistingInstall(wrapper)
  const repair = repairToken ? await reviewRepair(repairToken, existing, wrapper) : undefined
  let target: InstallTarget
  if (existing && (existing.installedByThisApp || repair)) {
    target = {
      linkPath: path.join(path.dirname(existing.linkPath), CLI_NAME),
      onPath: (await pathDirsOnPath()).has(path.dirname(existing.linkPath)),
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
    await writeSymlink(
      wrapper.wrapperPath,
      target.linkPath,
      target.linkPath === existing?.linkPath ? existing.linkTarget : undefined,
      Boolean(repair)
    )
  } else {
    try {
      await writeSymlink(
        wrapper.wrapperPath,
        target.linkPath,
        target.linkPath === existing?.linkPath ? existing.linkTarget : undefined,
        Boolean(repair)
      )
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        await elevateAndSymlink(
          wrapper.wrapperPath,
          target.linkPath,
          target.linkPath === existing?.linkPath ? existing.linkTarget : undefined,
          Boolean(repair)
        )
      } else {
        throw err
      }
    }
  }

  await recordInstall(target.linkPath, wrapper.wrapperPath)

  // #126: migrate off the legacy `zen` name — drop any ZenNotes-managed `zen`
  // symlink now that `zn` is installed.
  await removeManagedLinks(LEGACY_CLI_NAMES, wrapper)

  migrationError = undefined
  return await getCliInstallStatus(wrapperOverride)
}

async function writeSymlink(
  source: string,
  target: string,
  expectedTarget?: string,
  requireMissing = false
): Promise<void> {
  try {
    await fsp.symlink(source, target)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const current = await fsp.readlink(target).catch(() => null)
  if (current === source) return
  if (expectedTarget === undefined || current !== expectedTarget) {
    throw new Error(`${target} changed or is not a managed symlink. It was left untouched.`)
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await fsp.symlink(source, temporary)
    if (requireMissing && !(await isMissingHistoricalTarget(target, expectedTarget))) {
      throw new Error(`${target} changed: the previous app target is no longer missing.`)
    }
    if ((await fsp.readlink(target)) !== expectedTarget)
      throw new Error(`${target} changed during installation.`)
    await fsp.rename(temporary, target)
  } finally {
    await fsp.rm(temporary, { force: true })
  }
}

async function elevateAndSymlink(
  source: string,
  target: string,
  expectedTarget?: string,
  requireMissing = false
): Promise<void> {
  const ownershipGuard =
    expectedTarget === undefined
      ? `[ ! -e ${shellQuote(target)} ] && [ ! -L ${shellQuote(target)} ]`
      : `[ -L ${shellQuote(target)} ] && [ "$(readlink ${shellQuote(target)})" = ${shellQuote(expectedTarget)} ]`

  const guard = requireMissing
    ? `${ownershipGuard} && [ ! -e ${shellQuote(target)} ]`
    : ownershipGuard

  if (process.platform === 'darwin') {
    const shellCmd =
      `mkdir -p ${shellQuote(path.dirname(target))} && ${guard} && ` +
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
        `Could not install ${CLI_NAME} to ${target}. Tried osascript with admin privileges and failed: ${stderr || (err as Error).message}`
      )
    }
  }
  if (process.platform === 'linux') {
    try {
      await execFileAsync('pkexec', [
        'sh',
        '-c',
        `mkdir -p ${shellQuote(path.dirname(target))} && ${guard} && ln -sf ${shellQuote(source)} ${shellQuote(target)}`
      ])
      return
    } catch {
      if (requireMissing) {
        throw new Error(`Could not repair ${target}. Administrator access was declined or the shortcut changed. Refresh Settings and review it again.`)
      }
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

export async function uninstallCli(
  wrapperOverride?: WrapperLocation | null
): Promise<CliInstallStatus> {
  if (process.platform === 'win32') {
    throw new Error('CLI install is not yet supported on Windows.')
  }
  const wrapper = wrapperOverride === undefined ? await locateWrapper() : wrapperOverride
  const existing = await findExistingInstall(wrapper)
  if (!existing) {
    return await getCliInstallStatus(wrapperOverride)
  }
  if (!existing.installedByThisApp) {
    throw new Error(
      `${existing.linkPath} is not managed by ZenNotes. Remove it manually if you really want it gone.`
    )
  }

  const expectedTarget = existing.linkTarget
  if (
    !expectedTarget ||
    (await fsp.readlink(existing.linkPath).catch(() => null)) !== expectedTarget
  ) {
    throw new Error(`${existing.linkPath} changed and was left untouched.`)
  }
  const removalGuard = `[ -L ${shellQuote(existing.linkPath)} ] && [ "$(readlink ${shellQuote(existing.linkPath)})" = ${shellQuote(expectedTarget)} ]`
  try {
    await fsp.unlink(existing.linkPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      if (process.platform === 'darwin') {
        const shellCmd = `${removalGuard} && rm -f ${shellQuote(existing.linkPath)}`
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
        await execFileAsync('pkexec', [
          'sh',
          '-c',
          `${removalGuard} && rm -f ${shellQuote(existing.linkPath)}`
        ]).catch((e) => {
          throw new Error(
            `Could not remove ${existing.linkPath}. Run this manually:\n  sudo rm "${existing.linkPath}"\n(${(e as Error).message})`
          )
        })
      }
    } else if (code !== 'ENOENT') {
      throw err
    }
  }
  await forgetInstall(existing.linkPath, expectedTarget)
  // #126: sweep any strays too — a legacy `zen` in another dir, or a second `zn`
  // — so uninstall fully removes ZenNotes-managed links.
  await removeManagedLinks([CLI_NAME, ...LEGACY_CLI_NAMES], wrapper)
  return await getCliInstallStatus(wrapperOverride)
}

/* ---------- Used by mcp-integrations.ts to prefer `zn mcp` ------------ */

export async function findManagedCliBinary(): Promise<string | null> {
  if (process.platform === 'win32') return null
  const status = await getCliInstallStatus()
  if (!status.installedByThisApp || !status.installedAt) return null
  return status.installedAt
}

void os
