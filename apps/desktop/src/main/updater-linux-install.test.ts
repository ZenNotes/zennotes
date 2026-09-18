import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  execFile: vi.fn(),
  quit: vi.fn(),
  relaunch: vi.fn(),
  reveal: vi.fn(),
  broadcast: vi.fn(),
  updater: null as any
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '2.50.3',
    quit: boundary.quit,
    relaunch: boundary.relaunch
  },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: boundary.broadcast } }]
  },
  Notification: { isSupported: () => false },
  shell: { showItemInFolder: boundary.reveal }
}))

vi.mock('node:child_process', () => ({ execFile: boundary.execFile }))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    existsSync: (file: string) =>
      file === '/opt/ZenNotes/resources/package-type' || real.existsSync(file),
    readFileSync: (file: string, ...args: any[]) =>
      file === '/etc/os-release'
        ? 'ID=arch\n'
        : (real.readFileSync as any)(file, ...args)
  }
})

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  class FixtureUpdater extends EventEmitter {
    autoDownload = true
    autoInstallOnAppQuit = true
    quitAndInstall = vi.fn()
    checkForUpdates = vi.fn(async () => {
      this.emit('update-available', { version: '2.50.4' })
    })
    downloadUpdate = vi.fn(async () => {
      this.emit('update-downloaded', {
        version: '2.50.4',
        downloadedFile: '/home/test/.cache/@zennotesdesktop-updater/pending/ZenNotes-2.50.4-linux-x64.pacman'
      })
    })
    constructor() {
      super()
      boundary.updater = this
    }
  }
  return {
    default: {
      autoUpdater: new FixtureUpdater(),
      AppImageUpdater: FixtureUpdater,
      DebUpdater: FixtureUpdater,
      RpmUpdater: FixtureUpdater,
      PacmanUpdater: FixtureUpdater
    }
  }
})

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
const downloadedPackage =
  '/home/test/.cache/@zennotesdesktop-updater/pending/ZenNotes-2.50.4-linux-x64.pacman'

type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void

function execCallback(args: unknown[]): ExecCallback {
  return args[args.length - 1] as ExecCallback
}

function failure(code: string | number, message: string, stderr = ''): Error {
  return Object.assign(new Error(message), { code, stderr })
}

async function readyUpdate() {
  const updater = await import('./updater')
  expect((await updater.checkForAppUpdates()).phase).toBe('available')
  expect((await updater.downloadAppUpdate()).phase).toBe('downloaded')
  expect(boundary.updater.autoInstallOnAppQuit).toBe(false)
  return updater
}

async function flushInstall(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: '/opt/ZenNotes/resources'
  })
  vi.stubEnv('APPIMAGE', '')
  vi.stubEnv('ZENNOTES_UPDATER_FORMAT', '')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', originalPlatform)
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources)
  else Reflect.deleteProperty(process, 'resourcesPath')
})

// The suite fakes a Linux platform, but its download and pkexec doubles are
// POSIX shell scripts, so it only runs where those can execute.
describe.skipIf(process.platform === 'win32')('downloaded .pacman update installation', () => {
  it('does not leave a hidden terminal authentication prompt waiting in a GUI session', async () => {
    boundary.execFile.mockImplementation((_file: string, args: string[], ...rest: unknown[]) => {
      // pkexec can fall back to a textual agent on the controlling terminal.
      // An app launched from a window-manager binding cannot present it in its UI.
      if (args.includes('--disable-internal-agent')) {
        queueMicrotask(() => execCallback(rest)(failure(127, 'No authentication agent found')))
      }
    })
    const updater = await readyUpdate()
    updater.installAppUpdate()
    await flushInstall()

    expect(updater.getAppUpdateState().phase).toBe('error')
    expect(updater.getAppUpdateState().message).toContain('sudo pacman -U')
    expect(boundary.relaunch).not.toHaveBeenCalled()
    expect(boundary.quit).not.toHaveBeenCalled()
  })

  it('reports failed authorization with a manual installation route instead of saying the user canceled', async () => {
    boundary.execFile.mockImplementation((...args: unknown[]) => {
      queueMicrotask(() => execCallback(args)(failure(127, 'Not authorized', 'No authentication agent found.')))
    })
    const updater = await readyUpdate()
    updater.installAppUpdate()
    await flushInstall()

    expect(updater.getAppUpdateState().phase).toBe('error')
    expect(updater.getAppUpdateState().message).toContain('sudo pacman -U')
    expect(updater.getAppUpdateState().message).not.toMatch(/canceled/i)
    expect(boundary.quit).not.toHaveBeenCalled()
  })

  it('allows only one administrator installation while its prompt is pending', async () => {
    const pending: ExecCallback[] = []
    boundary.execFile.mockImplementation((...args: unknown[]) => {
      pending.push(execCallback(args))
    })
    const updater = await readyUpdate()
    updater.installAppUpdate()
    updater.installAppUpdate()

    expect(updater.getAppUpdateState().phase).toBe('installing')
    expect((await updater.checkForAppUpdates()).phase).toBe('installing')
    expect(pending).toHaveLength(1)
    expect(boundary.quit).not.toHaveBeenCalled()
    pending[0](failure(126, 'Dismissed'))
    await flushInstall()
  })

  it('keeps a dismissed administrator prompt retryable without quitting', async () => {
    boundary.execFile.mockImplementation((...args: unknown[]) => {
      queueMicrotask(() => execCallback(args)(failure(126, 'Dismissed')))
    })
    const updater = await readyUpdate()
    updater.installAppUpdate()
    await flushInstall()

    expect(updater.getAppUpdateState().phase).toBe('downloaded')
    expect(updater.getAppUpdateState().message).toMatch(/canceled|cancelled/i)
    expect(boundary.quit).not.toHaveBeenCalled()
    expect(boundary.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('shows the retained package and install command when pkexec is unavailable', async () => {
    boundary.execFile.mockImplementation((...args: unknown[]) => {
      queueMicrotask(() => execCallback(args)(failure('ENOENT', 'spawn pkexec ENOENT')))
    })
    const updater = await readyUpdate()
    updater.installAppUpdate()
    await flushInstall()

    expect(updater.getAppUpdateState()).toMatchObject({ phase: 'error' })
    expect(updater.getAppUpdateState().message).toContain(downloadedPackage)
    expect(updater.getAppUpdateState().message).toContain('sudo pacman -U')
    expect(boundary.reveal).toHaveBeenCalledWith(downloadedPackage)
    expect(boundary.quit).not.toHaveBeenCalled()
  })

  it('preserves install failure guidance when the startup background check becomes due', async () => {
    vi.useFakeTimers()
    boundary.execFile.mockImplementation((...args: unknown[]) => {
      queueMicrotask(() => execCallback(args)(failure(127, 'No authentication agent found')))
    })
    const updater = await import('./updater')
    updater.scheduleBackgroundAppUpdateCheck(8_000)
    await readyUpdate()
    updater.installAppUpdate()
    await vi.advanceTimersByTimeAsync(1)
    const failureState = updater.getAppUpdateState()
    expect(failureState.phase).toBe('error')
    await vi.advanceTimersByTimeAsync(8_000)
    expect(updater.getAppUpdateState()).toEqual(failureState)
    expect(boundary.updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('keeps the app open and explains package-manager failure', async () => {
    boundary.execFile.mockImplementation((...args: unknown[]) => {
      queueMicrotask(() => execCallback(args)(failure(1, 'pacman: failed to commit transaction')))
    })
    const updater = await readyUpdate()
    updater.installAppUpdate()
    await flushInstall()

    expect(updater.getAppUpdateState().phase).toBe('error')
    expect(updater.getAppUpdateState().message).toMatch(/failed to commit transaction/)
    expect(boundary.quit).not.toHaveBeenCalled()
  })

  it('relaunches only after the system package has been installed successfully', async () => {
    let complete!: ExecCallback
    boundary.execFile.mockImplementation((...args: unknown[]) => {
      complete = execCallback(args)
    })
    const updater = await readyUpdate()
    updater.installAppUpdate()
    expect(boundary.quit).not.toHaveBeenCalled()
    complete(null, '', '')
    await flushInstall()

    expect(boundary.relaunch).toHaveBeenCalledOnce()
    expect(boundary.quit).toHaveBeenCalledOnce()
    expect(boundary.updater.quitAndInstall).not.toHaveBeenCalled()
  })
})
