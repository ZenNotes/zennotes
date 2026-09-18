import { constants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const exec = promisify(execFile)
const LAUNCHER_MARKER = '# ZenNotes managed terminal launcher v1'
export interface TerminalRuntime {
  launcherPath: string
  binaryPath: string
  version: string
  sha256: string
}
export interface TerminalRuntimeOptions {
  bundleDir: string
  userData: string
  platform: string
  arch: string
  legacyCommand: string[]
  appPath?: string
}
interface Manifest {
  schemaVersion: number
  protocol: number
  version: string
  platform: string
  arch: string
}
const pending = new Map<string, Promise<TerminalRuntime | null>>()
const digest = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex')
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

async function atomicWrite(
  target: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, { mode, flag: 'wx' })
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

function launcher(options: TerminalRuntimeOptions, current: string): string {
  return [
    '#!/bin/sh',
    LAUNCHER_MARKER,
    'case "${ZENNOTES_CLI_ENGINE:-go}" in',
    `  legacy) ELECTRON_RUN_AS_NODE=1 exec ${options.legacyCommand.map(quote).join(' ')} "$@" ;;`,
    '  go) ;;',
    '  *) echo "zn: ZENNOTES_CLI_ENGINE must be go or legacy." >&2; exit 2 ;;',
    'esac',
    ': "${ZENNOTES_WORKSPACE_SOURCE:=app}"',
    'export ZENNOTES_WORKSPACE_SOURCE',
    ...(options.appPath
      ? [
          `if [ -z "\${ZENNOTES_APP_PATH:-}" ]; then ZENNOTES_APP_PATH=${quote(options.appPath)}; export ZENNOTES_APP_PATH; fi`,
        ]
      : []),
    `exec ${quote(path.join(current, 'zn'))} "$@"`,
    '',
  ].join('\n')
}

/** A failed stage never replaces the active runtime or retries a command. */
export function prepareTerminalRuntime(
  options: TerminalRuntimeOptions,
): Promise<TerminalRuntime | null> {
  const key = `${options.bundleDir}\0${options.userData}`
  const existing = pending.get(key)
  if (existing) return existing
  const operation = prepare(options).finally(() => {
    pending.delete(key)
  })
  pending.set(key, operation)
  return operation
}

async function prepare(
  options: TerminalRuntimeOptions,
): Promise<TerminalRuntime | null> {
  let manifest: Manifest
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(options.bundleDir, 'manifest.json'), 'utf8'),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('The bundled terminal manifest is invalid.', {
      cause: error,
    })
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocol !== 1 ||
    typeof manifest.version !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,99}$/.test(manifest.version)
  ) {
    throw new Error('The bundled terminal integration manifest is unsupported.')
  }
  if (
    manifest.platform !== options.platform ||
    manifest.arch !== options.arch ||
    !['darwin', 'linux'].includes(options.platform) ||
    !['x64', 'arm64'].includes(options.arch)
  ) {
    throw new Error(
      'The bundled terminal platform or architecture does not match this app.',
    )
  }
  const base = path.join(options.userData, 'cli')
  const runtimeRoot = path.join(base, 'terminal')
  const versions = path.join(runtimeRoot, 'versions')
  const current = path.join(runtimeRoot, 'current')
  const launcherPath = path.join(base, 'zn')
  await fs.mkdir(versions, { recursive: true, mode: 0o700 })
  await readManagedLauncher(launcherPath)
  try {
    if (!(await fs.lstat(current)).isSymbolicLink())
      throw new Error('The active terminal path is not a managed link.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  // Signing can change upstream bytes. Compare with this bundle's executable;
  // the release archive checksum is verified before packaging.
  const bytes = await fs.readFile(path.join(options.bundleDir, 'zn'))
  const sha256 = digest(bytes)
  try {
    const installed = JSON.parse(
      await fs.readFile(path.join(current, 'installed.json'), 'utf8'),
    )
    if (
      installed.sha256 === sha256 &&
      installed.version === manifest.version &&
      digest(await fs.readFile(path.join(current, 'zn'))) === sha256 &&
      ((await fs.stat(path.join(current, 'zn'))).mode & 0o111) !== 0
    ) {
      await atomicWrite(launcherPath, launcher(options, current), 0o755)
      return {
        launcherPath,
        binaryPath: path.join(current, 'zn'),
        version: manifest.version,
        sha256,
      }
    }
  } catch {
    /* Missing or damaged copy is replaced through a fresh stage. */
  }

  const stage = await fs.mkdtemp(path.join(versions, `${manifest.version}-`))
  const binaryPath = path.join(stage, 'zn')
  let activated = false
  const next = path.join(runtimeRoot, `current.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(binaryPath, bytes, { mode: 0o755, flag: 'wx' })
    if (digest(await fs.readFile(binaryPath)) !== sha256)
      throw new Error('Terminal copy verification failed.')
    let integration: { protocol?: number; version?: string }
    try {
      const result = await exec(binaryPath, ['--desktop-integration'], {
        timeout: 10000,
        maxBuffer: 65536,
      })
      integration = JSON.parse(result.stdout)
    } catch (error) {
      throw new Error('Terminal integration probe failed.', { cause: error })
    }
    if (
      integration.protocol !== 1 ||
      integration.version !== manifest.version
    ) {
      throw new Error(
        'Terminal integration version does not match the bundled manifest.',
      )
    }
    await atomicWrite(
      path.join(stage, 'installed.json'),
      JSON.stringify({ ...manifest, sha256 }) + '\n',
    )
    await atomicWrite(launcherPath, launcher(options, current), 0o755)
    await fs.symlink(path.relative(runtimeRoot, stage), next)
    await fs.rename(next, current)
    activated = true
    return { launcherPath, binaryPath, version: manifest.version, sha256 }
  } finally {
    await fs.rm(next, { force: true })
    if (!activated) await fs.rm(stage, { recursive: true, force: true })
  }
}

/**
 * Reads a launcher this app may replace. One handle, opened without following
 * links, serves both the type check and the content check, so nothing can be
 * swapped in between: the result is a regular file carrying our marker, or
 * null when there is no launcher at all. Anything else is refused.
 */
async function readManagedLauncher(launcherPath: string): Promise<string | null> {
  const refuse = () =>
    new Error(`${launcherPath} is not a managed ZenNotes launcher.`)
  let handle: FileHandle
  try {
    handle = await fs.open(launcherPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP') throw refuse()
    throw error
  }
  try {
    if (!(await handle.stat()).isFile()) throw refuse()
    const content = await handle.readFile('utf8')
    if (!content.startsWith(`#!/bin/sh\n${LAUNCHER_MARKER}\n`)) throw refuse()
    return content
  } finally {
    await handle.close()
  }
}

/** Retain a verified installed version when a new bundle cannot be activated. */
export async function readActiveTerminalRuntime(
  userData: string,
): Promise<TerminalRuntime | null> {
  const launcherPath = path.join(userData, 'cli', 'zn')
  const current = path.join(userData, 'cli', 'terminal', 'current')
  const binaryPath = path.join(current, 'zn')
  try {
    const installed = JSON.parse(
      await fs.readFile(path.join(current, 'installed.json'), 'utf8'),
    )
    // The mode check and the digest come from one open handle, so the bytes
    // that are hashed are the bytes whose mode was checked.
    const binary = await fs.open(binaryPath, 'r')
    let executable = false
    let bytes: Buffer
    try {
      executable = Boolean((await binary.stat()).mode & 0o111)
      bytes = await binary.readFile()
    } finally {
      await binary.close()
    }
    if (
      installed.protocol !== 1 ||
      typeof installed.version !== 'string' ||
      !executable ||
      digest(bytes) !== installed.sha256 ||
      (await readManagedLauncher(launcherPath)) === null
    )
      return null
    return {
      launcherPath,
      binaryPath,
      version: installed.version,
      sha256: installed.sha256,
    }
  } catch {
    return null
  }
}
