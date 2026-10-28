import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const machine = vi.hoisted(() => ({ userData: '', encryption: true }))

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => machine.userData },
  net: { fetch: vi.fn() },
  // A stand-in for the OS cipher. What matters is that the secrets file never
  // holds the key as written, and that a key comes back out unchanged.
  safeStorage: {
    isEncryptionAvailable: () => machine.encryption,
    encryptString: (text: string) => Buffer.from(`sealed:${Buffer.from(text).toString('hex').split('').reverse().join('')}`),
    decryptString: (sealed: Buffer) => {
      const body = sealed.toString()
      if (!body.startsWith('sealed:')) throw new Error('not sealed')
      return Buffer.from(body.slice('sealed:'.length).split('').reverse().join(''), 'hex').toString()
    }
  }
}))

import { PORTABLE_PREF_KEYS } from '@shared/app-config'
import type { UnsplashFetch } from '@shared/unsplash'
import {
  deleteUnsplashAccessKeySecret,
  getUnsplashAccessKeySecret,
  setUnsplashAccessKeySecret
} from './secret-store'
import { createDesktopUnsplashClient, unsplashApiBaseUrl } from './unsplash'

const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const ok = (json: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: (name: string) => ({ 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '49' })[name.toLowerCase()] ?? null },
  json: async () => json
})

/** Every file under `dir`, read as text. */
async function filesUnder(dir: string): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await filesUnder(path)))
    else if (entry.isFile()) out.push({ path, text: await readFile(path, 'utf8') })
  }
  return out
}

beforeEach(async () => {
  machine.userData = await mkdtemp(join(tmpdir(), 'zn-unsplash-key-'))
  machine.encryption = true
})

afterEach(async () => {
  await rm(machine.userData, { recursive: true, force: true })
})

describe('unsplashApiBaseUrl', () => {
  it('is api.unsplash.com unless a test run names a stand-in', () => {
    expect(unsplashApiBaseUrl({}, true)).toBe('https://api.unsplash.com')
    expect(unsplashApiBaseUrl({ ZENNOTES_UNSPLASH_API_URL: 'http://127.0.0.1:7/' }, false)).toBe('http://127.0.0.1:7')
    // A packaged copy honors the override only for a test run.
    expect(unsplashApiBaseUrl({ ZENNOTES_UNSPLASH_API_URL: 'http://127.0.0.1:7' }, true)).toBe('https://api.unsplash.com')
    expect(unsplashApiBaseUrl({ ZENNOTES_UNSPLASH_API_URL: 'http://127.0.0.1:7', ZEN_PERF: '1' }, true)).toBe(
      'http://127.0.0.1:7'
    )
  })
})

describe('the Unsplash key in the secure store', () => {
  it('round-trips, sealed by the OS on disk', async () => {
    expect(await getUnsplashAccessKeySecret()).toBeNull()
    expect(await setUnsplashAccessKeySecret(` ${KEY} `)).toBe(true)
    expect(await getUnsplashAccessKeySecret()).toBe(KEY)
    const files = await filesUnder(machine.userData)
    expect(files.map((f) => f.path)).toEqual([join(machine.userData, 'remote-workspace-secrets.json')])
    const sealed = JSON.parse(files[0]!.text) as Record<string, string>
    expect(Object.keys(sealed)).toEqual(['unsplash:access-key'])
    expect(files[0]!.text).not.toContain(KEY)
  })

  it('is gone once cleared, leaving the other secrets alone', async () => {
    await setUnsplashAccessKeySecret(KEY)
    await deleteUnsplashAccessKeySecret()
    expect(await getUnsplashAccessKeySecret()).toBeNull()
    const text = await readFile(join(machine.userData, 'remote-workspace-secrets.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({})
    // Clearing again is fine.
    await expect(deleteUnsplashAccessKeySecret()).resolves.toBeUndefined()
  })

  it('is refused, and nothing written, without OS encryption', async () => {
    machine.encryption = false
    expect(await setUnsplashAccessKeySecret(KEY)).toBe(false)
    expect(await readdir(machine.userData)).toEqual([])
  })
})

describe('the desktop Unsplash client', () => {
  it('never puts the key in config, prefs or any answer the renderer sees', async () => {
    const fetch = vi.fn<UnsplashFetch>(async () => ok([]))
    const client = createDesktopUnsplashClient(fetch, () => 'https://api.unsplash.com')
    const saved = await client.save(KEY)
    expect(saved).toEqual({ saved: true, check: { ok: true, remaining: 49, limit: 50 } })
    const status = await client.status()
    expect(status).toEqual({ set: true, store: 'system', canStore: true })
    for (const answer of [saved, status, await client.test(), await client.search('fog', 1)]) {
      expect(JSON.stringify(answer)).not.toContain(KEY)
    }
    // The only file is the sealed secrets file, and the key is in no file as written.
    for (const file of await filesUnder(machine.userData)) expect(file.text).not.toContain(KEY)
    expect(PORTABLE_PREF_KEYS.filter((k) => /unsplash/i.test(k))).toEqual([])
  })

  it('sends the key only to Unsplash, with a bare user agent and no language', async () => {
    const fetch = vi.fn<UnsplashFetch>(async () => ok({ total_pages: 0, results: [] }))
    const client = createDesktopUnsplashClient(fetch, () => 'https://api.unsplash.com')
    await setUnsplashAccessKeySecret(KEY)
    expect(await client.search('fog', 1)).toMatchObject({ ok: true })
    const [url, init] = fetch.mock.calls[0]!
    expect(new URL(url).origin).toBe('https://api.unsplash.com')
    expect(init.credentials).toBe('omit')
    expect(init.headers).toMatchObject({
      authorization: `Client-ID ${KEY}`,
      'user-agent': 'ZenNotes',
      'accept-language': '*'
    })
  })

  it('says it cannot store a key where the OS has no encryption', async () => {
    machine.encryption = false
    const fetch = vi.fn<UnsplashFetch>()
    const client = createDesktopUnsplashClient(fetch, () => 'https://api.unsplash.com')
    expect(await client.status()).toEqual({ set: false, store: 'system', canStore: false })
    expect(await client.save(KEY)).toEqual({ saved: false, reason: 'cannot-store' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
