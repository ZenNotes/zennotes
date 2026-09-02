import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  archiveReader,
  createInstalledBundleGuard,
  replacedBundleDialog,
  sameArchiveIdentity,
  staleBundlePageHtml,
  type ArchiveIdentity,
  type ArchiveReader
} from './installed-bundle'

/** A minimal asar: the two Pickle records, then the files back to back. */
function buildAsar(files: Record<string, string>): Buffer {
  const header: { files: Record<string, { size: number; offset: string }> } = { files: {} }
  const chunks: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content, 'utf8')
    header.files[name] = { size: bytes.length, offset: String(offset) }
    chunks.push(bytes)
    offset += bytes.length
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const pad = (4 - (json.length % 4)) % 4
  const lead = Buffer.alloc(16)
  lead.writeUInt32LE(4, 0)
  lead.writeUInt32LE(8 + json.length + pad, 4)
  lead.writeUInt32LE(4 + json.length + pad, 8)
  lead.writeUInt32LE(json.length, 12)
  return Buffer.concat([lead, json, Buffer.alloc(pad), ...chunks])
}

const pkg = (version: string) => JSON.stringify({ name: 'zennotes', version })

const tempDirs: string[] = []
function tempArchive(name: string, bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'zen-installed-bundle-'))
  tempDirs.push(dir)
  const file = join(dir, name)
  writeFileSync(file, bytes)
  return file
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('archiveReader', () => {
  it('reads the version out of package.json without going through the asar hooks', () => {
    const file = tempArchive('app.asar', buildAsar({ 'package.json': pkg('2.41.0'), 'a.js': 'x' }))
    expect(archiveReader.packageVersion(file)).toBe('2.41.0')
  })

  it('reads package.json at its offset, not at the start of the data', () => {
    const file = tempArchive(
      'app.asar',
      buildAsar({ 'out/main/index.js': 'console.log(1)', 'package.json': pkg('2.42.0') })
    )
    expect(archiveReader.packageVersion(file)).toBe('2.42.0')
  })

  it('answers null for a file that is not an archive, and for a missing one', () => {
    const file = tempArchive('app.asar', Buffer.from('<!doctype html>'))
    expect(archiveReader.packageVersion(file)).toBeNull()
    expect(archiveReader.packageVersion(join(tempDirs[0], 'gone.asar'))).toBeNull()
  })

  it('digests the header, so a moved file with the same layout matches and a new layout does not', () => {
    const a = tempArchive('a.asar', buildAsar({ 'package.json': pkg('2.41.0'), 'x.js': 'aaaa' }))
    const same = tempArchive('b.asar', buildAsar({ 'package.json': pkg('2.41.0'), 'x.js': 'bbbb' }))
    const grown = tempArchive('c.asar', buildAsar({ 'package.json': pkg('2.41.0'), 'x.js': 'aaaaa' }))
    expect(archiveReader.headerDigest(a)).toBe(archiveReader.headerDigest(same))
    expect(archiveReader.headerDigest(a)).not.toBe(archiveReader.headerDigest(grown))
    expect(() => archiveReader.headerDigest(tempArchive('d.asar', Buffer.alloc(3)))).toThrow()
  })

  it('leaves process.noAsar the way it found it', () => {
    const proc = process as unknown as { noAsar?: boolean }
    const file = tempArchive('app.asar', buildAsar({ 'package.json': pkg('1.0.0') }))
    proc.noAsar = false
    archiveReader.identity(file)
    expect(proc.noAsar).toBe(false)
    archiveReader.packageVersion(join(tempDirs[0], 'gone.asar'))
    expect(proc.noAsar).toBe(false)
  })
})

describe('createInstalledBundleGuard (scripted reader)', () => {
  const id = (ino: number, size = 100, mtimeMs = 1): ArchiveIdentity => ({ ino, size, mtimeMs })

  function scripted(overrides: Partial<ArchiveReader> = {}): ArchiveReader & {
    identity: ReturnType<typeof vi.fn>
    headerDigest: ReturnType<typeof vi.fn>
    packageVersion: ReturnType<typeof vi.fn>
  } {
    return {
      identity: vi.fn(() => id(1)),
      headerDigest: vi.fn(() => 'boot'),
      packageVersion: vi.fn(() => '2.41.0'),
      ...overrides
    } as never
  }

  it('is inert without an archive path', () => {
    const guard = createInstalledBundleGuard(null)
    expect(guard.status()).toBe('unknown')
    expect(guard.installedVersion()).toBeNull()
  })

  it('is inert when the archive cannot be captured at boot', () => {
    const reader = scripted({
      identity: vi.fn(() => {
        throw new Error('ENOENT')
      })
    })
    expect(createInstalledBundleGuard('/opt/x/app.asar', reader).status()).toBe('unknown')
  })

  it('reports current while the file on disk is the one it booted from', () => {
    const reader = scripted()
    const guard = createInstalledBundleGuard('/opt/x/app.asar', reader)
    expect(guard.status()).toBe('current')
    expect(guard.status()).toBe('current')
    // Only the boot capture ever read the header.
    expect(reader.headerDigest).toHaveBeenCalledTimes(1)
  })

  it('reports replaced, sticky, once the header on disk is a different layout', () => {
    const reader = scripted()
    const guard = createInstalledBundleGuard('/opt/x/app.asar', reader)
    reader.identity.mockReturnValue(id(2, 120, 9))
    reader.headerDigest.mockReturnValue('upgraded')
    expect(guard.status()).toBe('replaced')
    expect(guard.installedVersion()).toBe('2.41.0')
    // Even if the original came back, this process's cached header is gone.
    reader.identity.mockReturnValue(id(1))
    reader.headerDigest.mockReturnValue('boot')
    expect(guard.status()).toBe('replaced')
    expect(reader.packageVersion).toHaveBeenCalledTimes(1)
  })

  it('treats a byte-identical reinstall as current and stops re-reading the header', () => {
    const reader = scripted()
    const guard = createInstalledBundleGuard('/opt/x/app.asar', reader)
    reader.identity.mockReturnValue(id(2, 100, 5))
    expect(guard.status()).toBe('current')
    expect(guard.status()).toBe('current')
    expect(reader.headerDigest).toHaveBeenCalledTimes(2)
    expect(reader.packageVersion).not.toHaveBeenCalled()
  })

  it('answers unknown, not replaced, while the archive is unreadable mid-upgrade', () => {
    const reader = scripted()
    const guard = createInstalledBundleGuard('/opt/x/app.asar', reader)
    reader.identity.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(guard.status()).toBe('unknown')
    reader.identity.mockImplementation(() => id(3, 7, 7))
    reader.headerDigest.mockImplementation(() => {
      throw new Error('short read')
    })
    expect(guard.status()).toBe('unknown')
    reader.headerDigest.mockImplementation(() => 'upgraded')
    expect(guard.status()).toBe('replaced')
  })

  it('keeps the installed version at null when the new archive does not say', () => {
    const reader = scripted({ packageVersion: vi.fn(() => null) })
    const guard = createInstalledBundleGuard('/opt/x/app.asar', reader)
    reader.identity.mockReturnValue(id(2))
    reader.headerDigest.mockReturnValue('upgraded')
    expect(guard.status()).toBe('replaced')
    expect(guard.installedVersion()).toBeNull()
  })
})

describe('createInstalledBundleGuard (real files)', () => {
  it('sees a package upgrade land under a running process', () => {
    const file = tempArchive(
      'app.asar',
      buildAsar({ 'package.json': pkg('2.40.0'), 'out/renderer/index.html': '<html>' })
    )
    const guard = createInstalledBundleGuard(file)
    expect(guard.status()).toBe('current')

    // pacman: unlink, then write the new archive at the same path.
    const upgraded = tempArchive(
      'staged.asar',
      buildAsar({
        'package.json': pkg('2.41.0'),
        'out/renderer/assets/zh-TW.js': 'var u={}',
        'out/renderer/index.html': '<html>'
      })
    )
    rmSync(file)
    copyFileSync(upgraded, file)

    expect(guard.status()).toBe('replaced')
    expect(guard.installedVersion()).toBe('2.41.0')
  })

  it('stays quiet when the same archive is written back byte for byte', () => {
    const bytes = buildAsar({ 'package.json': pkg('2.41.0'), 'out/renderer/index.html': '<html>' })
    const file = tempArchive('app.asar', bytes)
    const guard = createInstalledBundleGuard(file)
    rmSync(file)
    writeFileSync(file, bytes)
    expect(guard.status()).toBe('current')
  })
})

describe('replacedBundleDialog / staleBundlePageHtml', () => {
  it('names both versions when they differ', () => {
    const copy = replacedBundleDialog('2.40.0', '2.41.0')
    expect(copy.message).toBe(
      'ZenNotes 2.41.0 is installed, but this window is still running 2.40.0.'
    )
    expect(copy.buttons[0]).toMatch(/restart/i)
  })

  it('does not claim an upgrade it cannot see', () => {
    expect(replacedBundleDialog('2.41.0', null).message).toContain('replaced while 2.41.0 was running')
    expect(replacedBundleDialog('2.41.0', '2.41.0').message).not.toContain('is installed, but')
  })

  it('writes without an em dash and escapes what it puts into the page', () => {
    const copy = replacedBundleDialog('2.40.0', '2.41.0')
    for (const text of [copy.title, copy.message, copy.detail]) expect(text).not.toContain('—')
    const html = staleBundlePageHtml('2.40.0', '<b>2.41.0</b>')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;2.41.0&lt;/b&gt;')
    expect(html).toContain('Quit ZenNotes and open it again.')
  })
})

describe('sameArchiveIdentity', () => {
  it('needs inode, size and mtime to all match', () => {
    const a = { ino: 1, size: 2, mtimeMs: 3 }
    expect(sameArchiveIdentity(a, { ...a })).toBe(true)
    expect(sameArchiveIdentity(a, { ...a, ino: 9 })).toBe(false)
    expect(sameArchiveIdentity(a, { ...a, size: 9 })).toBe(false)
    expect(sameArchiveIdentity(a, { ...a, mtimeMs: 9 })).toBe(false)
  })
})
