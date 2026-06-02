import { describe, expect, it, vi } from 'vitest'

// updater.ts imports electron and electron-updater at module load. Stub both so
// we can unit-test the pure Linux-install helpers without an Electron runtime.
vi.mock('electron', () => ({
  app: { getVersion: () => '2.0.2' },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
  shell: {}
}))
vi.mock('electron-updater', () => ({
  default: { autoUpdater: {} }
}))

import {
  elevatedInstallScript,
  linuxNeedsRootInstall,
  linuxPackageFormat,
  manualInstallHint
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
