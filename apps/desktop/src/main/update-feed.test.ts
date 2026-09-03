import { describe, expect, it, vi } from 'vitest'
import {
  compareVersions,
  fetchLatestRelease,
  isNewerVersion,
  parseLatestFeed
} from './update-feed'

const FEED = `version: 2.42.0
files:
  - url: ZenNotes-2.42.0-linux-x86_64.AppImage
    sha512: abc
    size: 251757960
path: ZenNotes-2.42.0-linux-x86_64.AppImage
sha512: abc
releaseDate: '2026-09-02T15:28:11.000Z'
`

describe('parseLatestFeed', () => {
  it('reads the version and release date electron-builder writes', () => {
    expect(parseLatestFeed(FEED)).toEqual({
      version: '2.42.0',
      releaseDate: '2026-09-02T15:28:11.000Z'
    })
  })

  it('tolerates a quoted version and a missing date', () => {
    expect(parseLatestFeed('version: "2.43.0"\nfiles: []\n')).toEqual({
      version: '2.43.0',
      releaseDate: null
    })
  })

  it('refuses a document with no version line', () => {
    expect(() => parseLatestFeed('files: []\n')).toThrow(/no version/)
  })
})

describe('compareVersions / isNewerVersion', () => {
  it('compares numerically, not lexically', () => {
    expect(isNewerVersion('2.10.0', '2.9.0')).toBe(true)
    expect(isNewerVersion('2.42.0', '2.41.0')).toBe(true)
    expect(isNewerVersion('2.42.0', '2.42.0')).toBe(false)
    expect(isNewerVersion('2.41.9', '2.42.0')).toBe(false)
    expect(isNewerVersion('3.0.0', '2.99.99')).toBe(true)
  })

  it('treats a prerelease as older than its release and ignores a leading v', () => {
    expect(compareVersions('2.43.0-beta.1', '2.43.0')).toBe(-1)
    expect(compareVersions('2.43.0', '2.43.0-beta.1')).toBe(1)
    expect(compareVersions('v2.42.0', '2.42.0')).toBe(0)
    expect(compareVersions('2.42', '2.42.0')).toBe(0)
  })
})

describe('fetchLatestRelease', () => {
  it('fetches the feed and parses it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => FEED })
    await expect(fetchLatestRelease(fetchImpl, 'https://example.test/latest-linux.yml')).resolves.toEqual({
      version: '2.42.0',
      releaseDate: '2026-09-02T15:28:11.000Z'
    })
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/latest-linux.yml')
  })

  it('turns a bad status into an error the updater can show', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' })
    await expect(fetchLatestRelease(fetchImpl)).rejects.toThrow(/503/)
  })
})
