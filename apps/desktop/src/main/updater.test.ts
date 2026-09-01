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
  installedLinuxFormat,
  isOfficialLinuxSystemPackage,
  linuxFormatFromOsRelease,
  linuxInstallMismatch,
  linuxNeedsRootInstall,
  linuxPackageFormat,
  linuxUpdaterForFormat,
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

  it('forces the safe AppImage updater for AUR and tar installs even if the stamp leaked', () => {
    expect(
      linuxUpdaterFormat({
        isAppImage: false,
        isOfficialSystemPackage: false,
        osRelease: arch
      })
    ).toBe('appimage')
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
