import { afterEach, describe, expect, it, vi } from 'vitest'

// What Chromium's network change notifier would answer; tests flip it to
// play a link going down and coming back.
const network = vi.hoisted(() => ({ online: true }))
// Whether the stubbed app is a packaged build, which is what lets the
// installing updaters (NSIS, Squirrel.Mac, AppImage) run at all.
const packaged = vi.hoisted(() => ({ value: false }))

/** electron-updater's autoUpdater, reduced to events and a check. */
const installer = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    handlers,
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
      return this
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of handlers.get(event) ?? []) cb(...args)
    },
    checkForUpdates: async (): Promise<unknown> => null
  }
})

// updater.ts imports electron and electron-updater at module load. Stub both so
// we can unit-test the pure Linux-install helpers without an Electron runtime.
vi.mock('electron', () => ({
  app: {
    getVersion: () => '2.0.2',
    get isPackaged() {
      return packaged.value
    },
    runningUnderARM64Translation: false
  },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
  net: { isOnline: () => network.online },
  shell: {}
}))
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: installer,
    AppImageUpdater: class {},
    DebUpdater: class {},
    RpmUpdater: class {},
    PacmanUpdater: class {}
  }
}))

import FpmTarget from 'app-builder-lib/out/targets/FpmTarget'
import electronUpdater from 'electron-updater'
import {
  elevatedInstallScript,
  installLabel,
  installedLinuxFormat,
  isNetworkUnreachableError,
  isOfficialLinuxSystemPackage,
  linuxFormatFromOsRelease,
  linuxInstallMismatch,
  linuxNeedsRootInstall,
  linuxPackageFormat,
  linuxUpdaterForFormat,
  linuxUpdaterFormat,
  manualInstallHint,
  mismatchedUpdateMessage,
  offlineRetryDelayMs,
  osReleasePrettyName,
  OFFLINE_POLL_MS,
  OFFLINE_RETRY_BASE_MS,
  OFFLINE_RETRY_MAX_MS,
  WINDOWS_ARM64_UPDATE_CHANNEL,
  windowsUpdateChannel
} from './updater'

describe('installLabel (:version, issue #814)', () => {
  const packaged = {
    isPackaged: true,
    mas: false,
    windowsStore: false,
    portableExecutableDir: undefined,
    linuxFormat: (): 'unknown' => 'unknown'
  }

  it('calls an unpackaged checkout a development build on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(installLabel({ ...packaged, platform, isPackaged: false })).toBe('development build')
    }
  })

  it('tells the Mac App Store copy apart from the dmg one', () => {
    expect(installLabel({ ...packaged, platform: 'darwin' })).toBe('macOS app bundle')
    expect(installLabel({ ...packaged, platform: 'darwin', mas: true })).toBe('Mac App Store')
  })

  it('tells the portable exe apart from the NSIS install and the Store', () => {
    expect(installLabel({ ...packaged, platform: 'win32' })).toBe('NSIS installer')
    expect(
      installLabel({ ...packaged, platform: 'win32', portableExecutableDir: 'D:\\apps' })
    ).toBe('portable exe')
    expect(installLabel({ ...packaged, platform: 'win32', windowsStore: true })).toBe(
      'Microsoft Store'
    )
  })

  it('names the Linux format the updater itself detected', () => {
    const linux = (format: ReturnType<typeof linuxUpdaterFormat>) =>
      installLabel({ ...packaged, platform: 'linux', linuxFormat: () => format })
    expect(linux('appimage')).toBe('AppImage')
    expect(linux('deb')).toBe('deb package')
    expect(linux('rpm')).toBe('rpm package')
    expect(linux('pacman')).toBe('pacman package')
    expect(linux('managed')).toBe('package manager or tarball (updates are reported, not installed)')
    expect(linux('unknown')).toBe('Linux package (format unknown)')
  })

  it('does not consult the Linux detector off Linux', () => {
    const linuxFormat = vi.fn((): 'deb' => 'deb')
    installLabel({ ...packaged, platform: 'darwin', linuxFormat })
    installLabel({ ...packaged, platform: 'linux', isPackaged: false, linuxFormat })
    expect(linuxFormat).not.toHaveBeenCalled()
  })
})

describe('windowsUpdateChannel (#928)', () => {
  const channel = (platform: NodeJS.Platform, arch: string, runningUnderARM64Translation = false) =>
    windowsUpdateChannel({ platform, arch, runningUnderARM64Translation })

  it('sends the ARM64 build to the ARM64 feed the release publishes', () => {
    expect(WINDOWS_ARM64_UPDATE_CHANNEL).toBe('latest-arm64')
    expect(channel('win32', 'arm64')).toBe('latest-arm64')
  })

  it('moves an x64 copy under ARM64 emulation to the native build', () => {
    expect(channel('win32', 'x64', true)).toBe('latest-arm64')
  })

  it('leaves x64 Windows, macOS and Linux on their default feeds', () => {
    expect(channel('win32', 'x64')).toBeNull()
    // electron-updater picks the Mac and Linux arm64 files itself.
    expect(channel('darwin', 'arm64')).toBeNull()
    expect(channel('darwin', 'x64', true)).toBeNull()
    expect(channel('linux', 'arm64')).toBeNull()
  })
})

describe('osReleasePrettyName', () => {
  it('reads PRETTY_NAME and strips its quotes', () => {
    expect(
      osReleasePrettyName('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n')
    ).toBe('Ubuntu 24.04.1 LTS')
    expect(osReleasePrettyName("PRETTY_NAME='Arch Linux'")).toBe('Arch Linux')
    expect(osReleasePrettyName('PRETTY_NAME=Fedora Linux 40 (Workstation Edition)')).toBe(
      'Fedora Linux 40 (Workstation Edition)'
    )
  })

  it('ignores NAME and an empty PRETTY_NAME, and answers null without a file', () => {
    expect(osReleasePrettyName('NAME="Debian GNU/Linux"\nVERSION_ID="12"')).toBeNull()
    expect(osReleasePrettyName('PRETTY_NAME=""')).toBeNull()
    expect(osReleasePrettyName(null)).toBeNull()
  })
})

describe('linuxPackageFormat', () => {
  it('detects each packaged Linux format', () => {
    expect(linuxPackageFormat('/tmp/ZenNotes-2.0.5.AppImage')).toBe('appimage')
    expect(linuxPackageFormat('/tmp/zennotes_2.0.5_amd64.deb')).toBe('deb')
    expect(linuxPackageFormat('/tmp/zennotes-2.0.5.x86_64.rpm')).toBe('rpm')
    expect(linuxPackageFormat('/tmp/zennotes-2.0.5.pkg.tar.zst')).toBe('pacman')
  })

  it('is case-insensitive and handles unknown/empty paths', () => {
    expect(linuxPackageFormat('/tmp/ZenNotes.DEB')).toBe('deb')
    expect(linuxPackageFormat('/tmp/whatever.zip')).toBe('unknown')
    expect(linuxPackageFormat(null)).toBe('unknown')
  })
})

describe('linuxNeedsRootInstall', () => {
  it('is true only for system package formats', () => {
    expect(linuxNeedsRootInstall('/tmp/app.deb')).toBe(true)
    expect(linuxNeedsRootInstall('/tmp/app.rpm')).toBe(true)
    expect(linuxNeedsRootInstall('/tmp/app.pkg.tar.zst')).toBe(true)
    // AppImage installs from userspace — must not trigger the elevated path.
    expect(linuxNeedsRootInstall('/tmp/app.AppImage')).toBe(false)
    expect(linuxNeedsRootInstall(null)).toBe(false)
  })
})

describe('elevatedInstallScript', () => {
  it('installs a .deb with an apt dependency-repair fallback', () => {
    expect(elevatedInstallScript('deb', '/tmp/zennotes.deb')).toBe(
      `dpkg -i '/tmp/zennotes.deb' || apt-get install -f -y`
    )
  })

  it('quotes paths so spaces and quotes cannot break out of the shell command', () => {
    const script = elevatedInstallScript('deb', "/tmp/zen notes'; rm -rf ~.deb")
    expect(script).toBe(`dpkg -i '/tmp/zen notes'\\''; rm -rf ~.deb' || apt-get install -f -y`)
  })

  it('returns null for formats that do not need elevation', () => {
    expect(elevatedInstallScript('appimage', '/tmp/app.AppImage')).toBeNull()
    expect(elevatedInstallScript('unknown', '/tmp/app.zip')).toBeNull()
  })
})

describe('manualInstallHint', () => {
  it('gives a copy-pasteable command per format', () => {
    expect(manualInstallHint('deb', '/tmp/a.deb')).toBe('sudo dpkg -i "/tmp/a.deb"')
    expect(manualInstallHint('rpm', '/tmp/a.rpm')).toBe('sudo rpm -U "/tmp/a.rpm"')
  })
})

describe('linuxFormatFromOsRelease', () => {
  it('reads the distro family, derivatives included', () => {
    expect(linuxFormatFromOsRelease('ID=arch\n')).toBe('pacman')
    expect(linuxFormatFromOsRelease('ID=ubuntu\nID_LIKE=debian\n')).toBe('deb')
    expect(linuxFormatFromOsRelease('ID=fedora\nVERSION_ID=42\n')).toBe('rpm')
    // The reporter's distro: unknown by name, but it declares its ancestor.
    expect(linuxFormatFromOsRelease('NAME="CachyOS Linux"\nID=cachyos\nID_LIKE=arch\n')).toBe(
      'pacman'
    )
    expect(linuxFormatFromOsRelease('ID=neon\nID_LIKE="ubuntu debian"\n')).toBe('deb')
  })

  it('tolerates quotes, spacing and files it cannot place', () => {
    expect(linuxFormatFromOsRelease('ID = "manjaro"')).toBe('pacman')
    expect(linuxFormatFromOsRelease('ID=nixos\nID_LIKE=\n')).toBe('unknown')
    expect(linuxFormatFromOsRelease('')).toBe('unknown')
  })

  it('gives ID priority over ID_LIKE regardless of declaration order', () => {
    expect(linuxFormatFromOsRelease('ID_LIKE=debian\nID=arch\n')).toBe('pacman')
  })
})

describe('installedLinuxFormat', () => {
  afterEach(() => {
    delete process.env.APPIMAGE
  })

  it('trusts the AppImage env var before anything on disk', () => {
    process.env.APPIMAGE = '/home/kelv/Apps/ZenNotes.AppImage'
    expect(
      installedLinuxFormat(() => {
        throw new Error('must not be read')
      })
    ).toBe('appimage')
  })

  it('falls back to os-release, and to unknown when it cannot be read', () => {
    expect(installedLinuxFormat(() => 'ID=arch\n')).toBe('pacman')
    expect(
      installedLinuxFormat(() => {
        throw new Error('ENOENT')
      })
    ).toBe('unknown')
  })
})

describe('linuxInstallMismatch', () => {
  it('catches the Arch-gets-a-deb case that shipped', () => {
    expect(linuxInstallMismatch('deb', 'pacman')).toBe(true)
    expect(linuxInstallMismatch('rpm', 'deb')).toBe(true)
  })

  it('never blocks a match, or a system it could not identify', () => {
    expect(linuxInstallMismatch('deb', 'deb')).toBe(false)
    expect(linuxInstallMismatch('pacman', 'pacman')).toBe(false)
    expect(linuxInstallMismatch('deb', 'unknown')).toBe(false)
    expect(linuxInstallMismatch('unknown', 'pacman')).toBe(false)
  })
})

describe('mismatchedUpdateMessage', () => {
  it('names both formats and points at the right download', () => {
    const message = mismatchedUpdateMessage('deb', 'pacman', '2.40.0')
    expect(message).toContain('ZenNotes 2.40.0')
    expect(message).toContain('.deb package')
    expect(message).toContain('https://zennotes.org/download/linux-pacman')
  })
})

describe('linuxUpdaterFormat', () => {
  const arch = 'NAME="CachyOS Linux"\nID=cachyos\nID_LIKE=arch\n'

  it('sends an Arch system package to the pacman updater, whatever the stamp said', () => {
    // The shipped case: the .pacman carried a `deb` stamp, so electron-updater
    // had picked the deb updater. The stamp's value is never consulted here.
    expect(
      linuxUpdaterFormat({ isAppImage: false, isOfficialSystemPackage: true, osRelease: arch })
    ).toBe('pacman')
    expect(
      linuxUpdaterFormat({
        isAppImage: false,
        isOfficialSystemPackage: true,
        osRelease: 'ID=ubuntu\nID_LIKE=debian\n'
      })
    ).toBe('deb')
    expect(
      linuxUpdaterFormat({
        isAppImage: false,
        isOfficialSystemPackage: true,
        osRelease: 'ID=fedora\n'
      })
    ).toBe('rpm')
  })

  it('leaves an AppImage alone even where a stamp leaked into it', () => {
    expect(
      linuxUpdaterFormat({ isAppImage: true, isOfficialSystemPackage: false, osRelease: arch })
    ).toBe('appimage')
  })

  it('marks AUR and tar installs as managed, even if the stamp leaked: report only, never install', () => {
    // These used to get the AppImage updater, which refuses to run without an
    // APPIMAGE marker and never says so; the About page sat on "Checking…".
    expect(
      linuxUpdaterFormat({
        isAppImage: false,
        isOfficialSystemPackage: false,
        osRelease: arch
      })
    ).toBe('managed')
  })

  it('stays with the default updater when the distro cannot be identified', () => {
    expect(
      linuxUpdaterFormat({ isAppImage: false, isOfficialSystemPackage: true, osRelease: null })
    ).toBe('unknown')
    expect(
      linuxUpdaterFormat({
        isAppImage: false,
        isOfficialSystemPackage: true,
        osRelease: 'ID=nixos\n'
      })
    ).toBe('unknown')
  })
})

describe('isOfficialLinuxSystemPackage', () => {
  it('accepts only a stamped electron-builder system-package install', () => {
    expect(isOfficialLinuxSystemPackage('/opt/ZenNotes/resources', true)).toBe(true)
    expect(isOfficialLinuxSystemPackage('/opt/ZenNotes/resources', false)).toBe(false)
  })

  it('rejects AUR and tar installs even if a racing target leaked the stamp', () => {
    expect(isOfficialLinuxSystemPackage('/opt/zennotes-bin/resources', true)).toBe(false)
    expect(
      isOfficialLinuxSystemPackage('/tmp/ZenNotes-2.40.0-linux-x64/resources', true)
    ).toBe(false)
  })
})

describe('linuxUpdaterForFormat', () => {
  it('creates a fresh AppImage updater instead of reusing the stamp-derived singleton', () => {
    const selected = linuxUpdaterForFormat('appimage')
    expect(selected).toBeInstanceOf(electronUpdater.AppImageUpdater)
    expect(selected).not.toBe(electronUpdater.autoUpdater)
  })

  it('keeps the existing updater only when the system package format is unknown', () => {
    expect(linuxUpdaterForFormat('unknown')).toBe(electronUpdater.autoUpdater)
  })
})

describe('Linux updater build support', () => {
  // 25.x omits pacman metadata. The pinned 26.15.7 has the current AppImage
  // security fixes; apps/desktop/patches carries the cycle guard already
  // merged upstream for its module collector. Upgrade only after this
  // assertion and an electron-builder --dir package check pass.
  it('emits pacman packages into latest-linux.yml', () => {
    const supportsAutoUpdate = Reflect.get(FpmTarget.prototype, 'supportsAutoUpdate') as (
      target: string
    ) => boolean
    expect(supportsAutoUpdate.call(Object.create(FpmTarget.prototype), 'pacman')).toBe(true)
  })
})

const FEED = (version: string) =>
  `version: ${version}\nfiles: []\nreleaseDate: '2026-09-02T15:28:11.000Z'\n`

/** What undici's fetch throws with no network: the readable part is in `cause`. */
function fetchFailed(code: string, detail: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(detail), { code })
  })
}

/** A feed body, a thrown error, or an HTTP answer that is not a feed. */
type FeedAnswer = string | Error | { status: number; url: string }

/**
 * A fresh updater module on the package-manager (notify-only) path, its feed
 * served by `feed`: a fixed answer, or a function answering per call so a
 * test can bring the network back partway through.
 */
async function loadManagedUpdater(feed: FeedAnswer | (() => FeedAnswer)) {
  vi.resetModules()
  process.env.ZENNOTES_UPDATER_FORMAT = 'managed'
  process.env.ZENNOTES_UPDATE_FEED_URL = 'http://127.0.0.1:1/latest-linux.yml'
  const fetchMock = vi.fn(async () => {
    const body = typeof feed === 'function' ? feed() : feed
    if (body instanceof Error) throw body
    if (typeof body !== 'string') {
      return { ok: false, status: body.status, url: body.url, text: async () => 'Not Found' }
    }
    return { ok: true, status: 200, text: async () => body }
  })
  vi.stubGlobal('fetch', fetchMock)
  return { mod: await import('./updater'), fetchMock }
}

function restoreUpdaterEnv(original: { format?: string; feed?: string }): void {
  vi.unstubAllGlobals()
  if (original.format === undefined) delete process.env.ZENNOTES_UPDATER_FORMAT
  else process.env.ZENNOTES_UPDATER_FORMAT = original.format
  if (original.feed === undefined) delete process.env.ZENNOTES_UPDATE_FEED_URL
  else process.env.ZENNOTES_UPDATE_FEED_URL = original.feed
}

describe('checkForAppUpdates on a package-manager install', () => {
  const original = { format: process.env.ZENNOTES_UPDATER_FORMAT, feed: process.env.ZENNOTES_UPDATE_FEED_URL }

  afterEach(() => {
    restoreUpdaterEnv(original)
  })

  it('reports a newer version without offering to install it', async () => {
    const { mod } = await loadManagedUpdater(FEED('2.0.3'))
    const state = await mod.checkForAppUpdates()
    expect(state.phase).toBe('available')
    expect(state.availableVersion).toBe('2.0.3')
    expect(state.installable).toBe(false)
    expect(state.message).toMatch(/managed by your package manager/)
    // Nothing to download: the install belongs to the package manager.
    expect((await mod.downloadAppUpdate()).phase).toBe('available')
  })

  it('says so when the running version is the newest', async () => {
    const { mod } = await loadManagedUpdater(FEED('2.0.2'))
    const state = await mod.checkForAppUpdates()
    expect(state.phase).toBe('not-available')
    expect(state.message).toBe("You're already on ZenNotes 2.0.2.")
    expect(state.installable).toBe(false)
  })

  it('surfaces a feed failure instead of staying on checking', async () => {
    const { mod } = await loadManagedUpdater(new Error('The release feed carried no version.'))
    const state = await mod.checkForAppUpdates()
    expect(state.phase).toBe('error')
    expect(state.message).toBe(
      "ZenNotes couldn't check for updates. Try again later, or open the latest release directly."
    )
    expect(state.detail).toBe('The release feed carried no version.')
  })

  it('says the newest release is still being published when its feed answers 404 (#1003)', async () => {
    const { mod, fetchMock } = await loadManagedUpdater({
      status: 404,
      // Where GitHub's redirect from releases/latest/download lands.
      url: 'https://github.com/ZenNotes/zennotes/releases/download/v2.0.3/latest-linux.yml'
    })
    const state = await mod.checkForAppUpdates()
    expect(state.phase).toBe('error')
    expect(state.message).toBe('ZenNotes 2.0.3 is still being published. Try again in a few minutes.')
    expect(state.detail).toMatch(/GitHub answered 404 for the release feed/)
    // Publishing takes minutes: no instant retries.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a server error, then words it without the raw answer', async () => {
    vi.useFakeTimers()
    try {
      const { mod, fetchMock } = await loadManagedUpdater({ status: 503, url: 'http://127.0.0.1:1/latest-linux.yml' })
      const pending = mod.checkForAppUpdates()
      await vi.advanceTimersByTimeAsync(10_000)
      const state = await pending
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(state.phase).toBe('error')
      expect(state.message).toBe(
        'GitHub returned a temporary network or server error while checking for updates. Try again in a moment, or open the latest release directly.'
      )
      expect(state.detail).toMatch(/503/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the details once a later check succeeds', async () => {
    let answer: FeedAnswer = { status: 404, url: 'http://127.0.0.1:1/latest-linux.yml' }
    const { mod } = await loadManagedUpdater(() => answer)
    expect((await mod.checkForAppUpdates()).detail).toBeTruthy()
    answer = FEED('2.0.3')
    const state = await mod.checkForAppUpdates()
    expect(state.phase).toBe('available')
    expect(state.detail).toBeNull()
  })
})

describe('isNetworkUnreachableError', () => {
  it('recognizes no-network failures from both HTTP stacks, cause chain included', () => {
    // undici (the package-manager feed check): the code is two levels down.
    expect(isNetworkUnreachableError(fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND github.com'))).toBe(true)
    expect(isNetworkUnreachableError(fetchFailed('ENETUNREACH', 'connect ENETUNREACH 140.82.121.4:443'))).toBe(true)
    // Electron's net module (electron-updater): Chromium's name in the message.
    expect(isNetworkUnreachableError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true)
    expect(isNetworkUnreachableError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe(true)
    // Plain Node errors, as a message or as a code.
    expect(isNetworkUnreachableError(new Error('getaddrinfo EAI_AGAIN github.com'))).toBe(true)
    expect(isNetworkUnreachableError(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }))).toBe(true)
  })

  it('leaves answers from GitHub, and everything else, to the error path', () => {
    expect(isNetworkUnreachableError(new Error('GitHub answered 404 for the release feed.'))).toBe(false)
    expect(isNetworkUnreachableError(new Error('HttpError: 503 Service Unavailable'))).toBe(false)
    expect(isNetworkUnreachableError(new Error('The release feed carried no version.'))).toBe(false)
    // "connection" in prose is not a connection error code.
    expect(isNetworkUnreachableError(new Error('Could not verify the connection to the signing service'))).toBe(false)
    expect(isNetworkUnreachableError(undefined)).toBe(false)
  })
})

describe('offlineRetryDelayMs', () => {
  it('doubles from the base up to the cap', () => {
    expect(offlineRetryDelayMs(1)).toBe(OFFLINE_RETRY_BASE_MS)
    expect(offlineRetryDelayMs(2)).toBe(OFFLINE_RETRY_BASE_MS * 2)
    expect(offlineRetryDelayMs(3)).toBe(OFFLINE_RETRY_BASE_MS * 4)
    expect(offlineRetryDelayMs(6)).toBe(OFFLINE_RETRY_MAX_MS)
    // Far past the cap, and past where 2 ** n stops being a safe integer.
    expect(offlineRetryDelayMs(60)).toBe(OFFLINE_RETRY_MAX_MS)
    expect(offlineRetryDelayMs(0)).toBe(OFFLINE_RETRY_BASE_MS)
  })
})

describe('checkForAppUpdates with no network (issue #812)', () => {
  const original = { format: process.env.ZENNOTES_UPDATER_FORMAT, feed: process.env.ZENNOTES_UPDATE_FEED_URL }
  const offline = fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND github.com')

  afterEach(() => {
    vi.useRealTimers()
    network.online = true
    restoreUpdaterEnv(original)
  })

  it('waits instead of erroring, and checks again by itself when the link comes back', async () => {
    vi.useFakeTimers()
    network.online = false
    let reachable = false
    const { mod, fetchMock } = await loadManagedUpdater(() => (reachable ? FEED('2.0.3') : offline))

    const state = await mod.checkForAppUpdates()
    expect(state.phase).toBe('offline')
    // The readable cause, not undici's "fetch failed".
    expect(state.message).toContain('getaddrinfo ENOTFOUND github.com')
    expect(state.message).toMatch(/check for updates again on its own/)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Link down for a while: no requests are wasted on it.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mod.getAppUpdateState().phase).toBe('offline')

    // The link returns: one poll later the check runs and gets its answer.
    network.online = true
    reachable = true
    await vi.advanceTimersByTimeAsync(OFFLINE_POLL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mod.getAppUpdateState().phase).toBe('available')
    expect(mod.getAppUpdateState().availableVersion).toBe('2.0.3')

    // Answered: nothing keeps polling.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('backs off while the link is up but GitHub stays out of reach, then stops once answered', async () => {
    vi.useFakeTimers()
    network.online = true
    let reachable = false
    const { mod, fetchMock } = await loadManagedUpdater(() => (reachable ? FEED('2.0.2') : offline))

    expect((await mod.checkForAppUpdates()).phase).toBe('offline')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // First retry after the base delay (polls land on 15 s marks).
    await vi.advanceTimersByTimeAsync(OFFLINE_RETRY_BASE_MS - OFFLINE_POLL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(OFFLINE_POLL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mod.getAppUpdateState().phase).toBe('offline')

    // Second retry waits twice as long: nothing at the base delay again.
    await vi.advanceTimersByTimeAsync(OFFLINE_RETRY_BASE_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(OFFLINE_RETRY_BASE_MS)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // GitHub is back; the third retry (four times the base) succeeds and ends the wait.
    reachable = true
    await vi.advanceTimersByTimeAsync(OFFLINE_RETRY_BASE_MS * 4)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(mod.getAppUpdateState().phase).toBe('not-available')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('still makes a real attempt now and then if the notifier keeps saying offline', async () => {
    vi.useFakeTimers()
    network.online = false
    const { mod, fetchMock } = await loadManagedUpdater(offline)

    expect((await mod.checkForAppUpdates()).phase).toBe('offline')
    await vi.advanceTimersByTimeAsync(OFFLINE_RETRY_MAX_MS - OFFLINE_POLL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(OFFLINE_POLL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mod.getAppUpdateState().phase).toBe('offline')
  })

  it('does not wait on errors that are not the network', async () => {
    vi.useFakeTimers()
    const { mod, fetchMock } = await loadManagedUpdater(new Error('GitHub answered 404 for the release feed.'))

    expect((await mod.checkForAppUpdates()).phase).toBe('error')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lets a manual check while waiting run at once, and keeps waiting if it fails the same way', async () => {
    vi.useFakeTimers()
    network.online = true
    let reachable = false
    const { mod, fetchMock } = await loadManagedUpdater(() => (reachable ? FEED('2.0.2') : offline))

    expect((await mod.checkForAppUpdates()).phase).toBe('offline')
    // The user presses Check for Updates before any retry is due.
    expect((await mod.checkForAppUpdates()).phase).toBe('offline')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // The wait survived the manual check and still recovers on its own.
    reachable = true
    await vi.advanceTimersByTimeAsync(OFFLINE_RETRY_MAX_MS)
    expect(mod.getAppUpdateState().phase).toBe('not-available')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})


// #947: a process kept in the tray runs for days, so the background check
// repeats instead of running once at launch.
describe('background update checks repeat while the app runs (#947)', () => {
  const original = { format: process.env.ZENNOTES_UPDATER_FORMAT, feed: process.env.ZENNOTES_UPDATE_FEED_URL }

  afterEach(() => {
    vi.useRealTimers()
    restoreUpdaterEnv(original)
  })

  it('checks again every six hours until a newer version turns up', async () => {
    vi.useFakeTimers()
    let latest = '2.0.2'
    const { mod, fetchMock } = await loadManagedUpdater(() => FEED(latest))

    mod.scheduleBackgroundAppUpdateCheck(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mod.getAppUpdateState().phase).toBe('not-available')

    await vi.advanceTimersByTimeAsync(mod.BACKGROUND_UPDATE_RECHECK_MS - 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    latest = '2.0.3'
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mod.getAppUpdateState().phase).toBe('available')
    expect(mod.getAppUpdateState().availableVersion).toBe('2.0.3')

    // Found: the person owns it from here, so the repeats stand aside.
    await vi.advanceTimersByTimeAsync(mod.BACKGROUND_UPDATE_RECHECK_MS * 2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('repeats only from a settled state', async () => {
    const { mod } = await loadManagedUpdater(FEED('2.0.2'))
    for (const phase of ['idle', 'not-available', 'error'] as const) {
      expect(mod.canRecheckInBackground(phase)).toBe(true)
    }
    for (const phase of ['checking', 'available', 'downloading', 'downloaded', 'installing', 'offline', 'unsupported'] as const) {
      expect(mod.canRecheckInBackground(phase)).toBe(false)
    }
  })
})

// #1003: a Windows copy (NSIS) checked while the newest release was still
// uploading its files, and the dialog showed electron-updater's whole 404.
describe('checkForAppUpdates on an installing updater (#1003)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

  afterEach(() => {
    packaged.value = false
    installer.handlers.clear()
    installer.checkForUpdates = async () => null
    Object.defineProperty(process, 'platform', platform)
    vi.restoreAllMocks()
  })

  it('answers a missing feed with one sentence, at once, and logs the raw answer', async () => {
    vi.resetModules()
    packaged.value = true
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const url = 'https://github.com/ZenNotes/zennotes/releases/download/v2.78.0/latest.yml'
    const missing = Object.assign(
      new Error(
        `Cannot find latest.yml in the latest release artifacts (${url}): HttpError: 404 \n"method: GET url: ${url}"\nHeaders: {\n  "strict-transport-security": "max-age=31536000; includeSubdomains; preload"\n}\n    at createHttpError (app.asar/node_modules/builder-util-runtime/out/httpExecutor.js:53:12)`
      ),
      { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }
    )
    const check = vi.fn(async () => {
      // electron-updater emits the error, then rejects the same check.
      installer.emit('error', missing)
      throw missing
    })
    installer.checkForUpdates = check

    const mod = await import('./updater')
    const state = await mod.checkForAppUpdates()

    expect(state.phase).toBe('error')
    expect(state.message).toBe('ZenNotes 2.78.0 is still being published. Try again in a few minutes.')
    expect(state.detail).toContain('max-age=31536000')
    expect(state.detail).toContain('at createHttpError')
    // The old 5xx test matched "536" in max-age and retried three times.
    expect(check).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[updater] check failed (still-publishing):',
      expect.stringContaining('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
    )
  })
})

describe('downloadAppUpdate with no network', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

  afterEach(() => {
    packaged.value = false
    installer.handlers.clear()
    installer.checkForUpdates = async () => null
    delete (installer as { downloadUpdate?: unknown }).downloadUpdate
    Object.defineProperty(process, 'platform', platform)
  })

  it('asks for the connection in a sentence, with the cause under Details', async () => {
    vi.resetModules()
    packaged.value = true
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    installer.checkForUpdates = async () => {
      installer.emit('update-available', { version: '2.0.3', files: [], path: '', sha512: '', releaseDate: '' })
      return null
    }
    Object.assign(installer, {
      downloadUpdate: async () => {
        throw new Error('net::ERR_INTERNET_DISCONNECTED')
      }
    })
    const mod = await import('./updater')
    expect((await mod.checkForAppUpdates()).phase).toBe('available')
    const state = await mod.downloadAppUpdate()
    expect(state.phase).toBe('error')
    expect(state.message).toBe("ZenNotes couldn't reach GitHub. Check the connection and try again.")
    expect(state.detail).toBe('net::ERR_INTERNET_DISCONNECTED')
  })
})
