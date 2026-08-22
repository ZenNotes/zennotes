import { accessSync, constants as fsConstants } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  probeNvmInstall,
  resetLoginShellResolutionForTests,
  resolveCommandViaLoginShell
} from './login-shell-path'

const onPosix = process.platform !== 'win32'

function shellExists(shellPath: string): boolean {
  try {
    accessSync(shellPath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

// The interactive-shell test needs a real zsh or bash to source rc files.
const interactiveShell = ['/bin/zsh', '/bin/bash'].find(shellExists) ?? null

async function makeExecutable(filePath: string, body = '#!/bin/sh\nexit 0\n'): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, body)
  await chmod(filePath, 0o755)
}

describe('resolveCommandViaLoginShell', () => {
  // The core of issue #73: GUI apps inherit a minimal PATH, so a bare command
  // name can't be resolved. A login shell sources the user's profile and
  // returns an absolute path. `sh` is guaranteed present on POSIX systems.
  it.skipIf(!onPosix)('resolves a ubiquitous command to an absolute path', async () => {
    const resolved = await resolveCommandViaLoginShell('sh')
    expect(resolved).toBeTruthy()
    expect(path.isAbsolute(resolved as string)).toBe(true)
    expect(path.basename(resolved as string)).toBe('sh')
  })

  it('returns null for a command that does not exist', async () => {
    expect(await resolveCommandViaLoginShell('zen-not-a-real-binary-9f3a2b')).toBeNull()
  })

  it('rejects unsafe command names without spawning a shell', async () => {
    expect(await resolveCommandViaLoginShell('rg; rm -rf /')).toBeNull()
    expect(await resolveCommandViaLoginShell('$(touch /tmp/zen-pwned)')).toBeNull()
    expect(await resolveCommandViaLoginShell('rg fzf')).toBeNull()
    expect(await resolveCommandViaLoginShell('')).toBeNull()
  })
})

describe('rc-file-only PATH entries (#634)', () => {
  const savedEnv: Record<string, string | undefined> = {}
  let tempHome: string | null = null

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetLoginShellResolutionForTests()
    if (tempHome) await rm(tempHome, { recursive: true, force: true })
    tempHome = null
  })

  function overrideEnv(overrides: Record<string, string>): void {
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in savedEnv)) savedEnv[key] = process.env[key]
      process.env[key] = value
    }
  }

  // The reported shape: node is only on PATH because ~/.zshrc (an
  // interactive-only file for zsh) prepends nvm's bin directory. A plain
  // login shell never reads it; the interactive pass must. The rc files also
  // print a banner to prove marker parsing survives rc noise.
  it.skipIf(!onPosix || !interactiveShell)(
    'finds a command whose PATH entry only exists in interactive rc files',
    async () => {
      tempHome = await mkdtemp(path.join(os.tmpdir(), 'zen-login-shell-'))
      const binDir = path.join(tempHome, 'rc-managed', 'bin')
      const tool = 'zen-rc-only-tool'
      await makeExecutable(path.join(binDir, tool))

      const pathLine = `export PATH="${binDir}:$PATH"`
      await writeFile(path.join(tempHome, '.zshrc'), `echo "welcome banner"\n${pathLine}\n`)
      await writeFile(path.join(tempHome, '.bashrc'), `echo "welcome banner"\n${pathLine}\n`)
      await writeFile(path.join(tempHome, '.bash_profile'), `. "$HOME/.bashrc"\n`)

      overrideEnv({ HOME: tempHome, SHELL: interactiveShell as string })
      resetLoginShellResolutionForTests()

      expect(await resolveCommandViaLoginShell(tool)).toBe(path.join(binDir, tool))
    }
  )
})

describe('probeNvmInstall', () => {
  const savedNvmDir = process.env.NVM_DIR
  let nvmDir: string | null = null

  afterEach(async () => {
    if (savedNvmDir === undefined) delete process.env.NVM_DIR
    else process.env.NVM_DIR = savedNvmDir
    resetLoginShellResolutionForTests()
    if (nvmDir) await rm(nvmDir, { recursive: true, force: true })
    nvmDir = null
  })

  async function seedNvm(versions: string[], defaultAlias?: string): Promise<void> {
    nvmDir = await mkdtemp(path.join(os.tmpdir(), 'zen-nvm-'))
    for (const version of versions) {
      await makeExecutable(path.join(nvmDir, 'versions', 'node', version, 'bin', 'node'))
      await makeExecutable(path.join(nvmDir, 'versions', 'node', version, 'bin', 'npm'))
    }
    if (defaultAlias) {
      await mkdir(path.join(nvmDir, 'alias'), { recursive: true })
      await writeFile(path.join(nvmDir, 'alias', 'default'), `${defaultAlias}\n`)
    }
    process.env.NVM_DIR = nvmDir
  }

  it.skipIf(!onPosix)('prefers the default alias when it names a concrete version', async () => {
    await seedNvm(['v22.14.0', 'v24.1.0'], 'v22.14.0')
    expect(await probeNvmInstall('node')).toBe(
      path.join(nvmDir as string, 'versions', 'node', 'v22.14.0', 'bin', 'node')
    )
  })

  it.skipIf(!onPosix)('falls back to the newest install without a concrete default', async () => {
    await seedNvm(['v22.14.0', 'v24.1.0'], 'lts/*')
    expect(await probeNvmInstall('npm')).toBe(
      path.join(nvmDir as string, 'versions', 'node', 'v24.1.0', 'bin', 'npm')
    )
  })

  it.skipIf(!onPosix)('only answers for the node toolchain', async () => {
    await seedNvm(['v24.1.0'])
    expect(await probeNvmInstall('rg')).toBeNull()
  })
})
