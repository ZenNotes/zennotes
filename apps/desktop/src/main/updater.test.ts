import { afterEach, describe, expect, it, vi } from 'vitest'

// updater.ts imports electron and electron-updater at module load. Stub both so
// we can unit-test the pure Linux-install helpers without an Electron runtime.
vi.mock('electron', () => ({
  app: { getVersion: () => '2.0.2' },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
  shell: {}
}))
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {},
    DebUpdater: class {},
    RpmUpdater: class {},
    PacmanUpdater: class {}
  }
}))

import {
  elevatedInstallScript,
  installedLinuxFormat,
  linuxFormatFromOsRelease,
  linuxInstallMismatch,
  linuxNeedsRootInstall,
  linuxPackageFormat,
  linuxUpdaterFormat,
  manualInstallHint,
  mismatchedUpdateMessage
} from './updater'

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
      linuxUpdaterFormat({ isAppImage: false, hasPackageStamp: true, osRelease: arch })
    ).toBe('pacman')
    expect(
      linuxUpdaterFormat({
        isAppImage: false,
        hasPackageStamp: true,
        osRelease: 'ID=ubuntu\nID_LIKE=debian\n'
      })
    ).toBe('deb')
    expect(
      linuxUpdaterFormat({ isAppImage: false, hasPackageStamp: true, osRelease: 'ID=fedora\n' })
    ).toBe('rpm')
  })

  it('leaves an AppImage alone even where a stamp leaked into it', () => {
    expect(linuxUpdaterFormat({ isAppImage: true, hasPackageStamp: true, osRelease: arch })).toBe(
      'appimage'
    )
  })

  it('leaves an unstamped install (AUR, tar.gz) to its own package manager', () => {
    // No stamp means nobody shipped this as a ZenNotes system package, so the
    // update must not be installed over whatever owns the files.
    expect(
      linuxUpdaterFormat({ isAppImage: false, hasPackageStamp: false, osRelease: arch })
    ).toBe('unknown')
  })

  it('stays with the default updater when the distro cannot be identified', () => {
    expect(
      linuxUpdaterFormat({ isAppImage: false, hasPackageStamp: true, osRelease: null })
    ).toBe('unknown')
    expect(
      linuxUpdaterFormat({ isAppImage: false, hasPackageStamp: true, osRelease: 'ID=nixos\n' })
    ).toBe('unknown')
  })
})
