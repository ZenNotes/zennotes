import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { promises as fsPromises } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// cli-install.ts imports electron's `app` at module load; give it a stub, and
// point HOME at a temp dir so candidateDirs() scans our sandbox, not real bins.
let userDataDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userDataDir
      throw new Error(`unexpected app.getPath(${name})`)
    },
    getName: () => 'ZenNotes'
  }
}))

// The installer asks the user's LOGIN shell for its PATH (#528), which would
// otherwise drag this suite back onto the developer's own machine setup, the
// exact dependence the PATH override below exists to remove. Tests drive it
// through `loginShellPathDirs` instead.
const loginShellPathDirs = vi.hoisted(() => ({ value: [] as string[] }))
vi.mock('./login-shell-path', () => ({
  resolveLoginShellPathDirs: async () => loginShellPathDirs.value,
  resolveCommandViaLoginShell: async () => null
}))

import { getCliInstallStatus, migrateLegacyCliLink, removeManagedLinks } from './cli-install'

let home = ''
const tempDirs: string[] = []

/** Existence of the link/file itself (does not follow symlinks). */
const linkExists = async (p: string): Promise<boolean> => {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

const wrapperLoc = (): { wrapperPath: string; cliJsPath: string } => ({
  wrapperPath: path.join(userDataDir, 'zen'),
  cliJsPath: path.join(userDataDir, 'cli.js')
})

let realPath: string | undefined
const realReadlink = fsPromises.readlink

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(os.tmpdir(), 'zn-cli-ud-'))
  home = await mkdtemp(path.join(os.tmpdir(), 'zn-cli-home-'))
  tempDirs.push(userDataDir, home)
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  // Discovery also scans fixed system bin directories outside PATH. Keep
  // installed commands on the host from affecting these fixture-only tests.
  vi.spyOn(fsPromises, 'readlink').mockImplementation((...args) => {
    const candidate = String(args[0])
    if (!tempDirs.some((dir) => candidate.startsWith(`${dir}${path.sep}`))) {
      return Promise.reject(Object.assign(new Error('Outside test fixture'), { code: 'ENOENT' }))
    }
    return realReadlink(...args)
  })
  // Candidate-directory discovery walks the REAL $PATH as well as the home
  // dirs, so a developer who has actually installed the CLI (which every
  // ZenNotes user now has, since the app heals the link on launch) would see
  // `migrateLegacyCliLink` correctly decline against their own `zn` and this
  // suite fail on their machine but not in CI. Point PATH at the temp home so
  // the discovery can only find what a test put there.
  realPath = process.env.PATH
  process.env.PATH = path.join(home, '.local', 'bin')
  loginShellPathDirs.value = []
  await writeFile(wrapperLoc().wrapperPath, '#!/bin/sh\n')
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (realPath === undefined) delete process.env.PATH
  else process.env.PATH = realPath
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('removeManagedLinks — migrate off `zen`, spare foreign (#126)', () => {
  it('removes our own zen and zn symlinks', async () => {
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zen'))
    await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zn'))

    const removed = await removeManagedLinks(['zen', 'zn'], wrapperLoc())

    expect(await linkExists(path.join(bin, 'zen'))).toBe(false)
    expect(await linkExists(path.join(bin, 'zn'))).toBe(false)
    expect(removed).toEqual(expect.arrayContaining([path.join(bin, 'zen'), path.join(bin, 'zn')]))
  })

  it('never removes a foreign `zen` (e.g. Zen Browser) or a real file', async () => {
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const foreign = path.join(userDataDir, 'zen-browser')
    await writeFile(foreign, '#!/bin/sh\n')
    // A foreign `zen` symlink pointing at something that is NOT our wrapper.
    await symlink(foreign, path.join(bin, 'zen'))
    // A real file (not a symlink) named `zn`.
    await writeFile(path.join(bin, 'zn'), '#!/bin/sh\n')

    const removed = await removeManagedLinks(['zen', 'zn'], wrapperLoc())

    expect(removed).not.toContain(path.join(bin, 'zen'))
    expect(removed).not.toContain(path.join(bin, 'zn'))
    expect(await linkExists(path.join(bin, 'zen'))).toBe(true)
    expect(await readlink(path.join(bin, 'zen'))).toBe(foreign)
    expect(await linkExists(path.join(bin, 'zn'))).toBe(true)
  })
})

describe('migrateLegacyCliLink — heal pre-2.10 installs on launch', () => {
  // The heal is a symlink operation over POSIX bin dirs; `migrateLegacyCliLink`
  // deliberately declines off darwin/linux (a pre-2.10 symlink install never
  // existed on Windows), so the positive path is asserted where it can run and
  // the platform gate is pinned separately below.
  it.skipIf(process.platform === 'win32')(
    'replaces a managed `zen` with `zn` in the same directory',
    async () => {
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zen'))

      const linkPath = await migrateLegacyCliLink(wrapperLoc())

      expect(linkPath).toBe(path.join(bin, 'zn'))
      expect(await readlink(path.join(bin, 'zn'))).toBe(wrapperLoc().wrapperPath)
      // The legacy name is gone, so `zen` stops shadowing anything (#126).
      expect(await linkExists(path.join(bin, 'zen'))).toBe(false)
    }
  )

  it.runIf(process.platform === 'win32')(
    'declines on Windows even with a managed legacy link present',
    async () => {
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zen'))

      expect(await migrateLegacyCliLink(wrapperLoc())).toBeNull()
      expect(await linkExists(path.join(bin, 'zen'))).toBe(true)
    }
  )

  it('does nothing when `zn` already exists', async () => {
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zen'))
    await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zn'))

    expect(await migrateLegacyCliLink(wrapperLoc())).toBeNull()
    // In particular the legacy link is left alone: migration is one atomic
    // pair of steps or nothing, never a delete on its own.
    expect(await linkExists(path.join(bin, 'zen'))).toBe(true)
  })

  it('never touches a foreign `zen` (Zen Browser)', async () => {
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const foreign = path.join(userDataDir, 'zen-browser')
    await writeFile(foreign, '#!/bin/sh\n')
    await symlink(foreign, path.join(bin, 'zen'))

    expect(await migrateLegacyCliLink(wrapperLoc())).toBeNull()
    expect(await readlink(path.join(bin, 'zen'))).toBe(foreign)
    expect(await linkExists(path.join(bin, 'zn'))).toBe(false)
  })

  it('is a no-op on a machine with nothing installed', async () => {
    expect(await migrateLegacyCliLink(wrapperLoc())).toBeNull()
  })
})

describe("PATH detection follows the user's shell, not the app's (#528)", () => {
  // A Finder / Dock launch on macOS inherits launchd's minimal PATH and never
  // reads the user's profile, so `process.env.PATH` says ~/.local/bin is
  // missing while the user's terminal has had it all along. Reading only that
  // produced a warning, and a pointless `export PATH=...` snippet, for a
  // directory that was already set up correctly.
  const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

  it.skipIf(process.platform === 'win32')(
    'reports a dir as on PATH when only the login shell knows about it',
    async () => {
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      process.env.PATH = LAUNCHD_PATH
      loginShellPathDirs.value = ['/opt/homebrew/bin', bin, '/usr/bin', '/bin']

      const status = await getCliInstallStatus()

      expect(status.defaultTarget).toBe(path.join(bin, 'zn'))
      expect(status.targetOnPath).toBe(true)
      // Nothing to tell the user to add: it is already there.
      expect(status.pathHint).toBeNull()
      expect(status.requiresSudo).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'still warns when the dir really is missing from both',
    async () => {
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      process.env.PATH = LAUNCHD_PATH
      // Only root-owned dirs on PATH, so no candidate is both on PATH and
      // writable and the installer has to fall back to creating ~/.local/bin.
      // (/opt/homebrew/bin would be a legitimate pick where it exists, which is
      // the installer working, not the warning path under test.)
      loginShellPathDirs.value = ['/usr/bin', '/bin']

      const status = await getCliInstallStatus()

      expect(status.defaultTarget).toBe(path.join(bin, 'zn'))
      expect(status.targetOnPath).toBe(false)
      expect(status.pathHint).toContain(bin)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'falls back to the process PATH when no shell answers',
    async () => {
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      process.env.PATH = bin
      loginShellPathDirs.value = []

      const status = await getCliInstallStatus()

      expect(status.targetOnPath).toBe(true)
      expect(status.pathHint).toBeNull()
    }
  )
})

describe('existing Node CLI migration', () => {
  it.skipIf(process.platform === 'win32')(
    'repoints the existing owned zn without creating a new PATH entry',
    async () => {
      const { migrateInstalledCli } = await import('./cli-install')
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      const old = wrapperLoc().wrapperPath
      const replacement = path.join(userDataDir, 'cli', 'zn')
      await symlink(old, path.join(bin, 'zn'))
      const migrated = await migrateInstalledCli({
        ...wrapperLoc(),
        wrapperPath: replacement,
        legacyWrapperPaths: [old],
        runtime: 'go',
        version: '1.0.0'
      })
      expect(migrated).toBe(path.join(bin, 'zn'))
      expect(await readlink(path.join(bin, 'zn'))).toBe(replacement)
      expect(await linkExists(path.join(bin, 'zen'))).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'leaves a foreign command and an unrequested installation alone',
    async () => {
      const { migrateInstalledCli } = await import('./cli-install')
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      const wrapper = {
        ...wrapperLoc(),
        runtime: 'go' as const,
        version: '1.0.0'
      }
      expect(await migrateInstalledCli(wrapper)).toBeNull()
      const target = path.join(bin, 'zn')
      await writeFile(target, '#!/bin/sh\necho external\n')
      expect(await migrateInstalledCli(wrapper)).toBeNull()
      expect(await fsPromises.readFile(target, 'utf8')).toContain('external')
    }
  )
})

it.skipIf(process.platform === 'win32')(
  'does not let a foreign executable outside PATH block a new installation',
  async () => {
    const offPath = path.join(home, 'bin')
    await mkdir(offPath, { recursive: true })
    await writeFile(path.join(offPath, 'zn'), '#!/bin/sh\necho foreign\n')
    const status = await getCliInstallStatus()
    expect(status.installedAt).toBeNull()
  }
)

it.skipIf(process.platform === 'win32')(
  'recognizes an owned wrapper through a symlinked app directory',
  async () => {
    const { migrateInstalledCli } = await import('./cli-install')
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const alias = path.join(home, 'App alias')
    await symlink(userDataDir, alias)
    await symlink(path.join(alias, 'zen'), path.join(bin, 'zn'))
    const replacement = path.join(userDataDir, 'cli', 'zn')
    const result = await migrateInstalledCli({
      ...wrapperLoc(),
      wrapperPath: replacement,
      legacyWrapperPaths: [wrapperLoc().wrapperPath],
      runtime: 'go'
    })
    expect(result).toBe(path.join(bin, 'zn'))
    expect(await readlink(path.join(bin, 'zn'))).toBe(replacement)
  }
)

// The desktop CLI shortcut is a POSIX symlink and the repair paths are
// AppImage mounts and macOS bundles; CLI install is not offered on Windows.
describe.skipIf(process.platform === 'win32')('stale desktop CLI shortcuts', () => {
  const goWrapper = () => ({
    ...wrapperLoc(),
    wrapperPath: path.join(userDataDir, 'cli', 'zn'),
    runtime: 'go' as const
  })

  it('offers explicit repair for a missing AppImage mount without migrating it on startup', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const { migrateInstalledCli } = await import('./cli-install')
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const link = path.join(bin, 'zn')
    const old = '/tmp/.mount_ZenNotABC123/resources/zen'
    await symlink(old, link)

    expect(await migrateInstalledCli(goWrapper())).toBeNull()
    expect(await readlink(link)).toBe(old)
    const status = await getCliInstallStatus(goWrapper())
    expect(status.installedByThisApp).toBe(false)
    expect(status.repair).toMatchObject({
      oldTarget: old,
      newTarget: goWrapper().wrapperPath
    })
    expect(status.repair?.token).toBeTruthy()
  })

  it('repairs a reviewed missing macOS app link in place and saves its previous target', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { installCli } = await import('./cli-install')
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const link = path.join(bin, 'zn')
    const old = path.join(home, 'Moved', 'ZenNotes.app', 'Contents', 'Resources', 'zen')
    await symlink(old, link)
    const status = await getCliInstallStatus(goWrapper())

    expect(status.repair).toBeDefined()
    await expect(installCli(undefined, goWrapper())).rejects.toThrow(/not managed/)
    await installCli({ repairToken: status.repair!.token }, goWrapper())
    expect(await readlink(link)).toBe(goWrapper().wrapperPath)
    const backup = JSON.parse(await fsPromises.readFile(status.repair!.backupPath, 'utf8'))
    expect(backup).toMatchObject({ linkPath: link, linkTarget: old })
    const repaired = await getCliInstallStatus(goWrapper())
    expect(repaired.installedByThisApp).toBe(true)
    // Settings shows "Repair shortcut" for an offer and "Repair" for an owned
    // runtime failure; an owned shortcut must never carry an offer as well.
    expect(repaired.repair).toBeUndefined()
  })

  it('never offers repair for a live matching-looking app link or an unrelated dangling link', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const link = path.join(bin, 'zn')
    const foreign = path.join(home, 'Another', 'ZenNotes.app', 'Contents', 'Resources', 'zen')
    await mkdir(path.dirname(foreign), { recursive: true })
    await writeFile(foreign, '#!/bin/sh\necho foreign\n')
    await symlink(foreign, link)
    expect((await getCliInstallStatus(goWrapper())).repair).toBeUndefined()
    await rm(link)
    await symlink(path.join(home, 'some-zennotes-other', 'zen'), link)
    expect((await getCliInstallStatus(goWrapper())).repair).toBeUndefined()
  })

  it('refuses a reviewed repair if another installer changed the shortcut', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const { installCli } = await import('./cli-install')
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const link = path.join(bin, 'zn')
    await symlink('/tmp/.mount_ZenNotABC123/resources/zen', link)
    const status = await getCliInstallStatus(goWrapper())
    expect(status.repair).toBeDefined()
    const foreign = path.join(home, 'foreign')
    await rm(link)
    await symlink(foreign, link)

    await expect(installCli({ repairToken: status.repair!.token }, goWrapper())).rejects.toThrow(
      /changed|refresh/i
    )
    expect(await readlink(link)).toBe(foreign)
  })

  it('refuses repair after the former app location becomes live again', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { installCli } = await import('./cli-install')
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const link = path.join(bin, 'zn')
    const old = path.join(home, 'Moved', 'ZenNotes.app', 'Contents', 'Resources', 'zen')
    await symlink(old, link)
    const status = await getCliInstallStatus(goWrapper())
    expect(status.repair).toBeDefined()
    await mkdir(path.dirname(old), { recursive: true })
    await writeFile(old, '#!/bin/sh\necho installed-again\n')

    await expect(installCli({ repairToken: status.repair!.token }, goWrapper())).rejects.toThrow(
      /changed|refresh/i
    )
    expect(await readlink(link)).toBe(old)
  })

  it('rechecks that the previous app target is missing immediately before replacing the link', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { installCli } = await import('./cli-install')
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const link = path.join(bin, 'zn')
    const old = path.join(home, 'Moved', 'ZenNotes.app', 'Contents', 'Resources', 'zen')
    await symlink(old, link)
    const status = await getCliInstallStatus(goWrapper())
    const realWriteFile = fsPromises.writeFile
    vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args) => {
      await realWriteFile(...args)
      if (String(args[0]) === status.repair!.backupPath) {
        await mkdir(path.dirname(old), { recursive: true })
        await realWriteFile(old, '#!/bin/sh\necho returned-during-repair\n')
      }
    })

    await expect(installCli({ repairToken: status.repair!.token }, goWrapper())).rejects.toThrow(
      /changed|missing/i
    )
    expect(await readlink(link)).toBe(old)
  })

  it('rejects arbitrary renderer replacement paths and invented repair tokens', async () => {
    const { installCli } = await import('./cli-install')
    await expect(
      installCli(
        {
          repairToken: '00000000-0000-0000-0000-000000000000',
          target: '/tmp/foreign'
        },
        goWrapper()
      )
    ).rejects.toThrow(/invalid/i)
    await expect(
      installCli({ repairToken: '00000000-0000-0000-0000-000000000000' }, goWrapper())
    ).rejects.toThrow(/expired|refresh/i)
  })

  it('removes a recorded historical shortcut on uninstall and retires its ownership', async () => {
    const { installCli, uninstallCli, migrateInstalledCli } = await import('./cli-install')
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const old = { ...wrapperLoc(), runtime: 'node' as const }
    await installCli(undefined, old)
    const link = path.join(bin, 'zn')
    await rm(old.wrapperPath)

    await uninstallCli(goWrapper())
    expect(await linkExists(link)).toBe(false)
    await symlink(old.wrapperPath, link)
    expect(await migrateInstalledCli(goWrapper())).toBeNull()
    expect(await readlink(link)).toBe(old.wrapperPath)
  })

  it('records exact ownership on installation and uses it after the app moves', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const { installCli, migrateInstalledCli } = await import('./cli-install')
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const old = { ...wrapperLoc(), runtime: 'node' as const }
    await installCli(undefined, old)
    const link = path.join(bin, 'zn')
    expect(await readlink(link)).toBe(old.wrapperPath)
    await rm(old.wrapperPath)
    const replacement = goWrapper()
    expect(await migrateInstalledCli(replacement)).toBe(link)
    expect(await readlink(link)).toBe(replacement.wrapperPath)

    await rm(link)
    await symlink(path.join(home, 'foreign'), link)
    expect(await migrateInstalledCli(replacement)).toBeNull()
    expect(await readlink(link)).toBe(path.join(home, 'foreign'))
  })
})
