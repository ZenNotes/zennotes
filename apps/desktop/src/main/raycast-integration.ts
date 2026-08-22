import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { RaycastExtensionStatus } from '@shared/ipc'
import { resolveCommandViaLoginShell } from './login-shell-path'

const execFileAsync = promisify(execFile)

const EXTENSION_NAME = 'zennotes'
const INSTALL_MARKER = '.zennotes-install.json'
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000
const RAYCAST_IMPORT_TIMEOUT_MS = 15 * 1000
const MIN_NODE_VERSION = [22, 14, 0] as const
const MIN_NPM_VERSION = [7, 0, 0] as const

interface Toolchain {
  nodePath: string | null
  npmPath: string | null
  nodeVersion: string | null
  npmVersion: string | null
  nodeMeetsMinimum: boolean
  npmMeetsMinimum: boolean
}

interface InstallMarker {
  version: string | null
  installedAt: string | null
}

export function raycastExtensionInstallPath(): string {
  return path.join(app.getPath('userData'), 'integrations', 'raycast', EXTENSION_NAME)
}

async function locateBundledRaycastSource(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'raycast', EXTENSION_NAME) : null,
    path.resolve(here, '../../../../integrations/raycast'),
    path.resolve(process.cwd(), 'integrations/raycast')
  ].filter((candidate): candidate is string => candidate != null)

  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(path.join(candidate, 'package.json'))
      if (stat.isFile()) return candidate
    } catch {
      /* keep trying */
    }
  }

  return null
}

async function readInstallMarker(extensionPath: string): Promise<InstallMarker> {
  try {
    const raw = await fsp.readFile(path.join(extensionPath, INSTALL_MARKER), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return { version: null, installedAt: null }
    return {
      version: typeof parsed.version === 'string' ? parsed.version : null,
      installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : null
    }
  } catch {
    return { version: null, installedAt: null }
  }
}

async function localExtensionExists(extensionPath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(path.join(extensionPath, 'package.json'))
    return stat.isFile()
  } catch {
    return false
  }
}

async function raycastAppInstalled(): Promise<boolean> {
  if (process.platform !== 'darwin') return false

  const candidates = [
    '/Applications/Raycast.app',
    path.join(os.homedir(), 'Applications', 'Raycast.app')
  ]
  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate)
      if (stat.isDirectory()) return true
    } catch {
      /* keep trying */
    }
  }

  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/mdfind',
      ['kMDItemCFBundleIdentifier == "com.raycast.macos"'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }
    )
    return String(stdout).trim().length > 0
  } catch {
    return false
  }
}

async function resolveToolchain(): Promise<Toolchain> {
  // The shared resolver, not a private login-shell query: it reads the
  // interactive shell's PATH (where nvm and friends initialize, #634) and
  // falls back to probing nvm's install directory directly.
  const nodePath = await resolveCommandViaLoginShell('node')
  const npmPath = await resolveCommandViaLoginShell('npm')
  const env = buildCommandEnv({ nodePath, npmPath })
  const nodeVersion = nodePath ? await readVersion(nodePath, env) : null
  const npmVersion = npmPath ? await readVersion(npmPath, env) : null

  return {
    nodePath,
    npmPath,
    nodeVersion,
    npmVersion,
    nodeMeetsMinimum: versionAtLeast(nodeVersion, MIN_NODE_VERSION),
    npmMeetsMinimum: versionAtLeast(npmVersion, MIN_NPM_VERSION)
  }
}

async function readVersion(commandPath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(commandPath, ['--version'], {
      encoding: 'utf8',
      env,
      timeout: 10000,
      maxBuffer: 1024 * 1024
    })
    return String(stdout).trim() || null
  } catch {
    return null
  }
}

function versionAtLeast(
  version: string | null,
  minimum: readonly [number, number, number]
): boolean {
  if (!version) return false
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return false
  if (major !== minimum[0]) return major > minimum[0]
  if (minor !== minimum[1]) return minor > minimum[1]
  return patch >= minimum[2]
}

function buildCommandEnv(toolchain: Pick<Toolchain, 'nodePath' | 'npmPath'>): NodeJS.ProcessEnv {
  const prepend = [toolchain.nodePath, toolchain.npmPath]
    .filter((toolPath): toolPath is string => Boolean(toolPath))
    .map((toolPath) => path.dirname(toolPath))
  return {
    ...process.env,
    PATH: Array.from(new Set([...prepend, process.env.PATH ?? '']))
      .filter(Boolean)
      .join(path.delimiter),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false'
  }
}

function unavailableReason(input: {
  supportedPlatform: boolean
  sourcePath: string | null
  raycastInstalled: boolean
  toolchain: Toolchain
}): string | null {
  if (!input.supportedPlatform) {
    return 'Raycast extension installation is only available on macOS.'
  }
  if (!input.sourcePath) {
    return 'The Raycast extension source is not bundled with this build.'
  }
  if (!input.raycastInstalled) {
    return 'Raycast is not installed on this Mac.'
  }
  if (!input.toolchain.nodePath) {
    return 'Node.js 22.14 or newer is required to install a local Raycast extension. ZenNotes looks for it on your shell PATH and in nvm installs.'
  }
  if (!input.toolchain.nodeMeetsMinimum) {
    return `Raycast extension tooling requires Node.js 22.14 or newer. Found ${input.toolchain.nodeVersion ?? 'an unknown version'}.`
  }
  if (!input.toolchain.npmPath) {
    return 'npm 7 or newer is required to install a local Raycast extension.'
  }
  if (!input.toolchain.npmMeetsMinimum) {
    return `Raycast extension tooling requires npm 7 or newer. Found ${input.toolchain.npmVersion ?? 'an unknown version'}.`
  }
  return null
}

export async function getRaycastExtensionStatus(): Promise<RaycastExtensionStatus> {
  const supportedPlatform = process.platform === 'darwin'
  const extensionPath = raycastExtensionInstallPath()
  const bundledVersion = app.getVersion()
  const [sourcePath, raycastInstalled, toolchain, marker, installed] = await Promise.all([
    locateBundledRaycastSource(),
    raycastAppInstalled(),
    resolveToolchain(),
    readInstallMarker(extensionPath),
    localExtensionExists(extensionPath)
  ])
  const reason = unavailableReason({
    supportedPlatform,
    sourcePath,
    raycastInstalled,
    toolchain
  })

  return {
    available: reason == null,
    reason,
    supportedPlatform,
    installed,
    upToDate: installed && marker.version === bundledVersion,
    extensionPath,
    sourcePath,
    raycastInstalled,
    nodeAvailable: toolchain.nodePath != null,
    npmAvailable: toolchain.npmPath != null,
    nodePath: toolchain.nodePath,
    npmPath: toolchain.npmPath,
    nodeVersion: toolchain.nodeVersion,
    npmVersion: toolchain.npmVersion,
    nodeMeetsMinimum: toolchain.nodeMeetsMinimum,
    npmMeetsMinimum: toolchain.npmMeetsMinimum,
    installedVersion: installed ? marker.version : null,
    bundledVersion,
    lastInstalledAt: installed ? marker.installedAt : null
  }
}

export async function installRaycastExtension(): Promise<RaycastExtensionStatus> {
  const status = await getRaycastExtensionStatus()
  if (!status.available) {
    throw new Error(status.reason ?? 'Raycast extension installation is unavailable.')
  }
  if (!status.sourcePath || !status.nodePath || !status.npmPath) {
    throw new Error('Raycast extension installation is missing its source or toolchain.')
  }

  const env = buildCommandEnv({ nodePath: status.nodePath, npmPath: status.npmPath })
  await copyRaycastExtensionSource(status.sourcePath, status.extensionPath)
  await runCommand(
    status.npmPath,
    ['ci', '--include=dev'],
    status.extensionPath,
    env,
    'Installing Raycast extension dependencies'
  )
  await runCommand(
    status.npmPath,
    ['run', 'build', '--', '--non-interactive'],
    status.extensionPath,
    env,
    'Building the Raycast extension'
  )
  await runRaycastDevelopmentImport(status.npmPath, status.extensionPath, env)
  await writeInstallMarker(status.extensionPath, status.bundledVersion)
  await shell.openExternal('raycast://extensions').catch(() => undefined)

  return await getRaycastExtensionStatus()
}

async function copyRaycastExtensionSource(sourcePath: string, extensionPath: string): Promise<void> {
  await fsp.rm(extensionPath, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(extensionPath), { recursive: true })
  await fsp.cp(sourcePath, extensionPath, {
    recursive: true,
    filter: (source) => shouldCopyRaycastSource(sourcePath, source)
  })
}

export function shouldCopyRaycastSource(sourceRoot: string, candidate: string): boolean {
  const rel = path.relative(sourceRoot, candidate)
  if (!rel) return true
  const segments = rel.split(path.sep)
  if (
    segments.some((segment) =>
      ['node_modules', 'dist', '.git', '.raycast', 'coverage'].includes(segment)
    )
  ) {
    return false
  }
  const base = path.basename(candidate)
  if (base === '.DS_Store' || base === INSTALL_MARKER) return false
  if (base.endsWith('.log')) return false
  return true
}

async function writeInstallMarker(extensionPath: string, version: string): Promise<void> {
  await fsp.writeFile(
    path.join(extensionPath, INSTALL_MARKER),
    JSON.stringify(
      {
        version,
        installedAt: new Date().toISOString()
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string
): Promise<void> {
  try {
    await execFileAsync(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024
    })
  } catch (err) {
    throw new Error(`${label} failed.${formatProcessError(err)}`)
  }
}

async function runRaycastDevelopmentImport(
  npmPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmPath, ['run', 'dev'], {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const append = (chunk: unknown): void => {
      output = truncateOutput(output + String(chunk))
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn()
    }

    timer = setTimeout(() => {
      finish(() => {
        terminateProcessTree(child.pid, 'SIGTERM')
        setTimeout(() => terminateProcessTree(child.pid, 'SIGKILL'), 2000).unref()
        resolve()
      })
    }, RAYCAST_IMPORT_TIMEOUT_MS)

    child.once('error', (err) => {
      finish(() => reject(new Error(`Could not start Raycast local import.${formatProcessError(err)}`)))
    })
    child.once('exit', (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve()
          return
        }
        reject(
          new Error(
            `Raycast local import failed with ${signal ?? `exit code ${code ?? 'unknown'}`}.${formatOutput(output)}`
          )
        )
      })
    })
  })
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, signal)
      return
    }
  } catch {
    /* fall back to direct child kill */
  }
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

function formatProcessError(err: unknown): string {
  if (!isRecord(err)) return ` ${err instanceof Error ? err.message : String(err)}`
  const message = err instanceof Error ? err.message : String(err)
  const stderr = typeof err.stderr === 'string' ? err.stderr : ''
  const stdout = typeof err.stdout === 'string' ? err.stdout : ''
  return `${message ? ` ${message}` : ''}${formatOutput(stderr || stdout)}`
}

function formatOutput(output: string): string {
  const trimmed = truncateOutput(output.trim())
  return trimmed ? `\n\n${trimmed}` : ''
}

function truncateOutput(output: string): string {
  const limit = 4000
  if (output.length <= limit) return output
  return `${output.slice(0, 1800)}\n…\n${output.slice(-1800)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
