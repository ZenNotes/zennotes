/**
 * The unlocked E2EE account key in the host's secure store: Android's rules
 * for reading and sweeping it, with each host keeping the name it shipped.
 *
 * - A missing, damaged or unreadable entry reads as locked. An Android
 *   install restored from a backup gets the stored value back without the
 *   Keystore key that decrypts it; the iPhone threw into sync instead.
 * - Signing in sweeps other accounts' keys, but a failed sweep never blocks
 *   it (each entry can unlock only its own account).
 * - Signing out sweeps the keys BEFORE removing the credential, so a failed
 *   sweep leaves the person signed in to try again, never a key that
 *   outlives its credential. The iPhone removed the credential first.
 * - The iPhone names the entry `cloud-e2ee:<base url>#<email>`, Android
 *   `e2ee-account-key.<sha256>`; existing devices hold keys under their
 *   own, so the host picks (accountKeyScheme), and every sweep takes both.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, describe, it, vi } from 'vitest'
import { createTestHost, RecordingHttp, type HttpResponder } from '../test/test-host'
import type { HostCloudConfig, SecretStorage } from './host'

const account = {
  base_url: 'https://zennotes.org', connected_at: '2026-09-14T12:00:00Z',
  user: { name: 'Test', email: 'test@example.test' },
  device: { id: 'test-device', name: 'Test phone', platform: 'android' as const }
}
const credential = JSON.stringify({ base_url: account.base_url, token: 'test-only', account })
const unlockedKey = { format: 1 as const, key: Buffer.alloc(32, 7).toString('base64'), version: 1 }
const hashedName = (baseUrl: string, email: string) =>
  `e2ee-account-key.${createHash('sha256').update(`${baseUrl}\n${email}`).digest('hex')}`

class Keystore implements SecretStorage {
  readonly unreadable = new Set<string>()
  failKeys = 0
  constructor(readonly saved: Map<string, string>) {}
  available(): boolean {
    return true
  }
  async get(key: string): Promise<string | null> {
    if (this.unreadable.has(key)) throw Object.assign(new Error('Could not decrypt the item'), { code: 'osError' })
    return this.saved.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.saved.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.saved.delete(key)
  }
  async keys(): Promise<string[]> {
    if (this.failKeys > 0) {
      this.failKeys -= 1
      throw new Error('The secure store did not answer.')
    }
    return [...this.saved.keys()]
  }
}

afterEach(() => {
  vi.doUnmock('./cloud-sync-client')
  vi.resetModules()
})

async function coldLaunch(
  saved: Map<string, string>,
  http: HttpResponder = () => ({ status: 401, headers: {}, data: {} }),
  cloud: Partial<HostCloudConfig> = {}
) {
  vi.resetModules()
  vi.doMock('./cloud-sync-client', async (original) => ({
    ...(await original<typeof import('./cloud-sync-client')>()),
    stopMobileCloudRequests: () => {},
    resumeMobileCloudRequests: () => {}
  }))
  const keystore = new Keystore(saved)
  const host = createTestHost({ http: new RecordingHttp(http) })
  host.shell.cloud = { ...host.shell.cloud, platform: 'android', deviceName: 'ZenNotes Android', ...cloud }
  const { installPortableHost } = await import('./host')
  installPortableHost({ ...host, secrets: keystore })
  const module = await import('./mobile-cloud-auth')
  await module.configureMobileCloudAuth('test-version')
  const signIn = async (email: string) => {
    saved.set('pending-auth', JSON.stringify({
      base_url: account.base_url, state: 'test-state', code_verifier: 'a'.repeat(43), expires_at: '2099-01-01T00:00:00Z'
    }))
    signedInAs = email
    const changed = new Promise((resolve) => {
      const stop = module.onMobileCloudAccountChange((value) => { stop(); resolve(value) })
    })
    host.lifecycle.urlListeners.at(-1)!('zennotes://auth?code=abc123&state=test-state')
    await changed
  }
  let signedInAs = account.user.email
  host.http.responder = async (request) => {
    if (request.method === 'POST' && request.url.endsWith('/api/v1/app/exchange')) {
      return { status: 200, headers: {}, data: {
        token: 'next-token', user: { name: 'Test', email: signedInAs },
        device: { id: 'test-device', name: 'Test phone', platform: 'android' }
      } }
    }
    return await http(request)
  }
  return { ...module, keystore, host, signIn }
}

describe('the account key store', () => {
  it('keeps one key per account, and reads a missing, damaged or unreadable one as locked', async () => {
    const saved = new Map([['credential', credential]])
    const api = await coldLaunch(saved, undefined, { accountKeyScheme: 'hashed' })
    const store = api.mobileCloudAccountKeyStore({ base_url: account.base_url, account: { ...account, user: { ...account.user, email: 'Test@Example.test' } } })
    assert.equal(await store.load(), null)
    await store.save(unlockedKey)
    assert.deepEqual(await api.mobileCloudAccountKeyStore({ base_url: `${account.base_url}/`, account }).load(), unlockedKey)
    assert.equal(await api.mobileCloudAccountKeyStore({ base_url: 'https://other.example.test', account }).load(), null)
    const [entry] = [...saved.keys()].filter((key) => key.startsWith('e2ee-account-key.'))
    assert.equal(entry, hashedName(account.base_url, account.user.email))

    saved.set(entry!, '{"format":1')
    assert.equal(await store.load(), null)
    saved.set(entry!, JSON.stringify({ ...unlockedKey, key: 'c2hvcnQ=' }))
    assert.equal(await store.load(), null, 'a key that is not 32 bytes could never open a vault')
    saved.set(entry!, JSON.stringify({ ...unlockedKey, version: -1 }))
    assert.equal(await store.load(), null)
    saved.set(entry!, JSON.stringify(unlockedKey))
    api.keystore.unreadable.add(entry!)
    assert.equal(await store.load(), null, 'an entry the store cannot decrypt reads as locked')
    api.keystore.unreadable.clear()
    await store.clear()
    assert.equal(saved.has(entry!), false)
  })

  it('names the entry by account on a host that shipped that scheme (the iPhone\'s, the default)', async () => {
    const saved = new Map([['credential', credential]])
    const api = await coldLaunch(saved)
    await api.mobileCloudAccountKeyStore({ base_url: account.base_url, account }).save(unlockedKey)
    assert.deepEqual([...saved.keys()].filter((key) => key !== 'credential'), ['cloud-e2ee:https://zennotes.org#test@example.test'])
  })
})

describe('signing out', () => {
  it('revokes this device and forgets every key, under either scheme, whatever the answer', async () => {
    for (const status of [204, 401, 500]) {
      const saved = new Map([['credential', credential]])
      const api = await coldLaunch(saved, () => ({ status, headers: {}, data: {} }), { accountKeyScheme: 'hashed' })
      await api.mobileCloudAccountKeyStore({ base_url: account.base_url, account }).save(unlockedKey)
      saved.set(`e2ee-account-key.${'f'.repeat(64)}`, JSON.stringify(unlockedKey))
      saved.set('cloud-e2ee:https://zennotes.org#old@example.test', JSON.stringify(unlockedKey))

      assert.deepEqual(await api.logoutMobileCloudAccount(), { state: 'disconnected', account: null })
      assert.deepEqual(api.host.http.requests.map(({ method, url }) => [method, url]), [
        ['DELETE', 'https://zennotes.org/api/v1/devices/current']
      ])
      assert.equal(saved.size, 0, `answer ${status}`)
    }
  })

  it('keeps the credential when the key sweep fails, so signing out can be tried again', async () => {
    const saved = new Map([['credential', credential]])
    const api = await coldLaunch(saved, () => ({ status: 204, headers: {}, data: {} }))
    const store = api.mobileCloudAccountKeyStore({ base_url: account.base_url, account })
    await store.save(unlockedKey)
    api.keystore.failKeys = 1
    await assert.rejects(api.logoutMobileCloudAccount())
    assert.equal(saved.has('credential'), true, 'no key may outlive its credential')
    assert.deepEqual(await store.load(), unlockedKey)

    assert.deepEqual(await api.logoutMobileCloudAccount(), { state: 'disconnected', account: null })
    assert.equal(saved.size, 0)
  })
})

describe('signing in', () => {
  it('keeps the key across a new sign-in to the same account, and drops it on a switch', async () => {
    const saved = new Map([['credential', credential]])
    const api = await coldLaunch(saved, undefined, { accountKeyScheme: 'hashed' })
    const store = api.mobileCloudAccountKeyStore({ base_url: account.base_url, account })
    await store.save(unlockedKey)

    await api.signIn(account.user.email.toUpperCase())
    assert.deepEqual(await store.load(), unlockedKey)
    assert.equal((await api.authenticatedCredential()).token, 'next-token')

    await api.signIn('someone-else@example.test')
    assert.equal(await store.load(), null)
    assert.deepEqual([...saved.keys()].filter((key) => key.startsWith('e2ee-account-key.')), [])
  })

  it('signs in even when sweeping another account\'s key fails', async () => {
    const saved = new Map([['credential', credential]])
    const api = await coldLaunch(saved)
    saved.set('cloud-e2ee:https://zennotes.org#other@example.test', JSON.stringify(unlockedKey))
    api.keystore.failKeys = 1
    await api.signIn('someone-else@example.test')
    const status = await api.getMobileCloudAccountStatus()
    assert.equal(status.state, 'connected')
    assert.equal(status.account?.user.email, 'someone-else@example.test')
  })
})
