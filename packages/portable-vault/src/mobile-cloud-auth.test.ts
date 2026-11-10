/**
 * Ported from the iPhone app's src/bridge/mobile-cloud-auth.test.ts. The
 * phone drove Capacitor's SecureStorage proxy, App listeners and
 * CapacitorHttp; here the same module runs over the host interfaces
 * (src/host.ts), so the Keychain is a SecretStorage, the app listeners are
 * HostShell.onOpenUrl / onActiveChange and the transport is HttpTransport.
 *
 * Moved out with the lift: the Keychain prefix migration (`capacitor-storage_`
 * to `zennotes.cloud.`) and the lazy-proxy race it guarded now live in the
 * iPhone host's SecretStorage.prepare, so their cases belong to that host's
 * tests. Keys here are the package's own (`credential`, `pending-auth`,
 * `cloud-e2ee:...`); the prefix a host stores them under is its business.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it, vi } from 'vitest'
import { createTestHost, RecordingHttp, type HttpResponder } from '../test/test-host'
import type { HostCloudConfig, HostShell, HttpTransportRequest, SecretStorage } from './host'

const account = {
  base_url: 'https://zennotes.org', connected_at: '2026-09-14T12:00:00Z',
  user: { name: 'Test', email: 'test@example.test' },
  device: { id: 'test-device', name: 'Test phone', platform: 'ios' as const }
}
const credential = JSON.stringify({ base_url: account.base_url, token: 'test-only', account })

/** The device's secure store over `saved`, which outlives every cold launch
 *  as the Keychain does. It can hold the next credential read after the
 *  value is read, as a slow native call would. */
class Keychain implements SecretStorage {
  prepared = 0
  private delayRead: { entered(): void; wait: Promise<void> } | null = null
  constructor(readonly saved: Map<string, string>) {}
  available(): boolean {
    return true
  }
  async prepare(): Promise<void> {
    await Promise.resolve()
    this.prepared += 1
  }
  async get(key: string): Promise<string | null> {
    const value = this.saved.get(key) ?? null
    if (key === 'credential' && this.delayRead) {
      const delayed = this.delayRead
      this.delayRead = null
      delayed.entered()
      await delayed.wait
    }
    return value
  }
  async set(key: string, value: string): Promise<void> {
    this.saved.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.saved.delete(key)
  }
  async keys(): Promise<string[]> {
    return [...this.saved.keys()]
  }
  pauseNextCredentialRead() {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    this.delayRead = { entered, wait }
    return { started, release }
  }
}

/** The phone passed an empty CapacitorHttp by default: any request fails
 *  without an answer. */
const noTransport: HttpResponder = () => {
  throw new Error('This test has no Cloud transport.')
}

afterEach(() => {
  vi.doUnmock('./cloud-sync-client')
  vi.resetModules()
})

async function coldLaunch(
  saved: Map<string, string>,
  http: HttpResponder = noTransport,
  cloud: Partial<HostCloudConfig> = {},
  shell: Partial<HostShell> = {}
) {
  const lifecycle: string[] = []
  let lifetime = new AbortController()
  const stop = () => { lifecycle.push('stop'); lifetime.abort() }
  const resume = () => { lifecycle.push('resume'); if (lifetime.signal.aborted) lifetime = new AbortController() }
  // A cold launch is a fresh module: its auth flow, keyring and ready gate
  // start empty, and only `saved` carries over.
  vi.resetModules()
  vi.doMock('./cloud-sync-client', () => ({
    createCloudSyncClient: () => assert.fail('status must only read storage'),
    stopMobileCloudRequests: stop,
    resumeMobileCloudRequests: resume,
    mobileCloudRequestSignal: () => lifetime.signal,
    firstValidationMessage: () => null
  }))
  const keychain = new Keychain(saved)
  const host = createTestHost({
    http: new RecordingHttp(http),
    lifecycle: {
      // What the iPhone's background-sync does before it is installed:
      // leaving stops Cloud requests at once, returning resumes them.
      leftApp: stop,
      returnedToApp: resume
    }
  })
  host.shell.cloud = { ...host.shell.cloud, ...cloud }
  Object.assign(host.shell, shell)
  // The fresh module reads the fresh host module, so install into that one.
  const { installPortableHost } = await import('./host')
  installPortableHost({ ...host, secrets: keychain })
  const module = await import('./mobile-cloud-auth')
  await module.configureMobileCloudAuth('test-version')
  return {
    ...module,
    keychain,
    lifecycle,
    appState: (isActive: boolean) => host.lifecycle.activeListeners.at(-1)!(isActive),
    openUrl: (url: string) => host.lifecycle.urlListeners.at(-1)!(url),
    pauseNextCredentialRead: () => keychain.pauseNextCredentialRead()
  }
}

it('loads a saved account on every cold launch', async () => {
  const saved = new Map([['credential', credential]])
  for (let launch = 0; launch < 2; launch++) {
    const api = await coldLaunch(saved)
    const statuses = await Promise.all([api.getMobileCloudAccountStatus(), api.getMobileCloudAccountStatus()])
    assert.deepEqual(statuses, [{ state: 'connected', account }, { state: 'connected', account }])
    assert.deepEqual([...saved.keys()], ['credential'])
    // Concurrent first calls share one prepare (the phone's lazy-proxy race
    // is the iPhone host's to guard now).
    assert.equal(api.keychain.prepared, 1)
  }
})

// The phone's version also seeded a legacy `capacitor-storage_` record and
// checked it could not come back; that half moves to the iPhone host.
it('preserves the canonical account and prevents it from returning after logout', async () => {
  const saved = new Map([['credential', credential]])
  const api = await coldLaunch(saved)
  assert.equal((await api.authenticatedCredential()).token, 'test-only')
  await api.logoutMobileCloudAccount()
  assert.ok(api.lifecycle.includes('stop'))
  assert.equal(saved.size, 0)
  assert.deepEqual(await (await coldLaunch(saved)).getMobileCloudAccountStatus(), { state: 'disconnected', account: null })
})

it('stops pending Cloud requests in the background and resumes on foreground', async () => {
  const api = await coldLaunch(new Map([['credential', credential]]))
  api.appState(false)
  api.appState(true)
  assert.deepEqual(api.lifecycle, ['stop', 'resume'])
})

it('rejects a credential read spanning logout even after foreground creates a new lifetime', async () => {
  const saved = new Map([['credential', credential]])
  const api = await coldLaunch(saved)
  await api.getMobileCloudAccountStatus()
  const paused = api.pauseNextCredentialRead()
  const pending = api.authenticatedClient().catch((error: unknown) => error)
  await paused.started
  await api.logoutMobileCloudAccount()
  api.appState(true)
  paused.release()
  assert.equal(((await pending) as Error).name, 'AbortError')
  assert.equal(saved.size, 0)
})

// On the phone the invalid record was recovered from the legacy prefix; the
// host's prepare does that move now, and the shared validator still sees it.
it('rejects invalid recovered credentials through the shared auth validator', async () => {
  const invalid = JSON.stringify({ base_url: 'https://wrong.example.test', token: 'test-only', account })
  const saved = new Map([['credential', invalid]])
  const api = await coldLaunch(saved)
  assert.deepEqual(await api.getMobileCloudAccountStatus(), { state: 'disconnected', account: null })
  assert.equal(saved.size, 0)
})

// The phone seeded this under the legacy prefix; that move is the host's now.
it('recovers pending sign-in state across cold launches', async () => {
  const pending = JSON.stringify({
    base_url: account.base_url, state: 'test-state', code_verifier: 'a'.repeat(43), expires_at: '2099-01-01T00:00:00Z'
  })
  const saved = new Map([['pending-auth', pending]])
  for (let launch = 0; launch < 2; launch++) {
    const api = await coldLaunch(saved)
    assert.deepEqual(await api.getMobileCloudAccountStatus(), { state: 'connecting', account: null })
    assert.deepEqual([...saved.entries()], [['pending-auth', pending]])
  }
})

const keyName = (email: string) => `cloud-e2ee:https://zennotes.org#${email}`
const storedKey = (fill: number) => ({ format: 1 as const, key: Buffer.alloc(32, fill).toString('base64'), version: 1 })

it('keeps one encryption key per account, then revokes this device and forgets every key at sign-out', async () => {
  const requests: HttpTransportRequest[] = []
  const saved = new Map([
    ['credential', credential],
    [keyName('other@example.test'), JSON.stringify(storedKey(2))]
  ])
  const api = await coldLaunch(saved, async (options) => {
    requests.push(options)
    return { status: 401, headers: {}, data: {} }
  })
  const store = api.mobileCloudAccountKeyStore({ base_url: account.base_url, account })
  assert.equal(await store.load(), null)
  await store.save(storedKey(7))
  assert.deepEqual(await store.load(), storedKey(7))
  assert.equal(saved.get(keyName('test@example.test')), JSON.stringify(storedKey(7)))
  const shouting = api.mobileCloudAccountKeyStore({
    base_url: account.base_url,
    account: { ...account, user: { ...account.user, email: 'TEST@Example.test' } }
  })
  assert.deepEqual(await shouting.load(), storedKey(7), 'an email in other letter case is the same account')
  saved.set(keyName('test@example.test'), 'not a key')
  assert.equal(await store.load(), null, 'an unreadable entry is no key')
  await store.save(storedKey(7))

  await api.logoutMobileCloudAccount()
  // 401 counts as revoked; either way sign-out finishes and no key survives it.
  assert.deepEqual(requests.map(({ method, url, headers }) => [method, url, headers?.Authorization]), [
    ['DELETE', 'https://zennotes.org/api/v1/devices/current', 'Bearer test-only']
  ])
  assert.deepEqual([...saved.keys()], [])
})

it('keeps only the new account key when a different account signs in', async () => {
  const pending = JSON.stringify({
    base_url: account.base_url, state: 'test-state', code_verifier: 'a'.repeat(43), expires_at: '2099-01-01T00:00:00Z'
  })
  const saved = new Map([
    ['credential', credential],
    ['pending-auth', pending],
    [keyName('test@example.test'), JSON.stringify(storedKey(1))],
    [keyName('second@example.test'), JSON.stringify(storedKey(2))]
  ])
  // The sign-in exchange (CapacitorHttp.post on the phone).
  const api = await coldLaunch(saved, async () => ({ status: 200, headers: {}, data: {
    token: 'second-token', user: { name: 'Second', email: 'Second@Example.test' },
    device: { id: 'device-2', name: 'Test phone', platform: 'ios' }
  } }))
  const switched = new Promise((resolve) => api.onMobileCloudAccountChange(resolve))
  api.openUrl('zennotes://auth?code=abc123&state=test-state')
  assert.equal(((await switched) as { account: { user: { email: string } } }).account.user.email, 'Second@Example.test')
  assert.deepEqual([...saved.keys()].filter((key) => key.includes('cloud-e2ee')), [keyName('second@example.test')])
})

// Android cases (zennotesandroid src/bridge/mobile-cloud-auth.test.ts). Its
// key-store, sign-in and sign-out key cases run in cloud-account-keys.test.ts
// under Android's hashed scheme; this one also holds the revoke request to
// the exact shape Android sends, whatever Cloud answers.
describe('Android cases', () => {
  it('revokes this device and forgets every encryption key when signing out', async () => {
    const unlockedKey = { format: 1 as const, key: Buffer.alloc(32, 7).toString('base64'), version: 1 }
    for (const status of [204, 401, 500]) {
      const saved = new Map([['credential', credential]])
      const requests: HttpTransportRequest[] = []
      const api = await coldLaunch(saved, async (request) => { requests.push(request); return { status, headers: {}, data: {} } },
        { platform: 'android', accountKeyScheme: 'hashed' })
      await api.mobileCloudAccountKeyStore({ base_url: account.base_url, account }).save(unlockedKey)
      saved.set(`e2ee-account-key.${'f'.repeat(64)}`, JSON.stringify(unlockedKey))

      assert.deepEqual(await api.logoutMobileCloudAccount(), { state: 'disconnected', account: null })
      assert.deepEqual(requests, [{
        method: 'DELETE', url: 'https://zennotes.org/api/v1/devices/current',
        headers: { Accept: 'application/json', Authorization: 'Bearer test-only' },
        connectTimeout: 10_000, readTimeout: 10_000, disableRedirects: true
      }])
      assert.equal(saved.size, 0, `answer ${status}`)
    }
  })
})

describe('signing in from a web page (the browser)', () => {
  const callbackUrl = 'https://app.zennotes.org/auth/callback'
  const webAccount = { ...account, device: { id: 'browser-1', name: 'Chrome on macOS', platform: 'web' as const } }

  async function browserLaunch(saved: Map<string, string>, exchange: HttpResponder = noTransport) {
    const opened: string[] = []
    const api = await coldLaunch(saved, exchange, {
      platform: 'web', deviceName: 'Chrome on macOS', callbackUrl, authLifetimeMs: 45 * 60 * 1000
    }, { openExternal: async (url: string) => { opened.push(url) } })
    return { api, opened }
  }

  it('sends the callback page, keeps the pending sign-in by its state and lets it wait 45 minutes', async () => {
    const saved = new Map<string, string>()
    const { api, opened } = await browserLaunch(saved)
    const before = Date.now()
    const result = await api.connectMobileCloudAccount('https://zennotes.org')
    const url = new URL(opened[0]!)
    assert.equal(url.pathname, '/app/connect')
    assert.equal(url.searchParams.get('callback_url'), callbackUrl)
    const state = url.searchParams.get('state')!
    assert.deepEqual([...saved.keys()], [`pending-auth:${state}`])
    const lifetime = Date.parse(result.expires_at) - before
    assert.ok(lifetime > 44 * 60 * 1000 && lifetime <= 45 * 60 * 1000 + 1000)
    assert.deepEqual(await api.getMobileCloudAccountStatus(), { state: 'connecting', account: null })
  })

  it('finishes in another tab from the fragment, as a web device, and uses the record once', async () => {
    const saved = new Map<string, string>()
    const exchanges: HttpTransportRequest[] = []
    const first = await browserLaunch(saved)
    await first.api.connectMobileCloudAccount('https://zennotes.org')
    const state = new URL(first.opened[0]!).searchParams.get('state')!
    // The verification link opened a new tab: a fresh module over the same storage.
    const second = await browserLaunch(saved, async (options) => {
      exchanges.push(options)
      return { status: 200, headers: {}, data: { token: 'test-only', user: webAccount.user, device: webAccount.device } }
    })
    const status = await second.api.completeMobileCloudSignIn(`${callbackUrl}#code=abc123&state=${state}`)
    assert.equal(status.state, 'connected')
    assert.equal(status.account?.device.platform, 'web')
    const body = exchanges[0]!.data as Record<string, unknown>
    assert.equal(body.platform, 'web')
    assert.equal(body.device_name, 'Chrome on macOS')
    assert.equal([...saved.keys()].some((key) => key.startsWith('pending-auth')), false)
    // Replayed, the same callback finds nothing to finish.
    const third = await browserLaunch(saved)
    await third.api.logoutMobileCloudAccount().catch(() => undefined)
    await assert.rejects(third.api.completeMobileCloudSignIn(`${callbackUrl}#code=abc123&state=${state}`), /expired/)
  })

  it('carries a shared computer across tabs and sends it at exchange', async () => {
    const saved = new Map<string, string>()
    const exchanges: HttpTransportRequest[] = []
    const first = await browserLaunch(saved)
    await first.api.connectMobileCloudAccount('https://zennotes.org', { shared: true })
    const state = new URL(first.opened[0]!).searchParams.get('state')!
    const second = await browserLaunch(saved, async (options) => {
      exchanges.push(options)
      return { status: 200, headers: {}, data: { token: 'test-only', user: webAccount.user, device: { ...webAccount.device, shared: true } } }
    })
    const status = await second.api.completeMobileCloudSignIn(`${callbackUrl}#code=abc123&state=${state}`)
    assert.equal((exchanges[0]!.data as Record<string, unknown>).shared, true)
    assert.equal(status.account?.device.shared, true)
  })

  it('refuses a callback for another page or with the code in the query', async () => {
    const { api } = await browserLaunch(new Map())
    await assert.rejects(api.completeMobileCloudSignIn(`https://evil.example/auth/callback#code=abc&state=s`), /not complete/)
    await assert.rejects(api.completeMobileCloudSignIn(`${callbackUrl}?code=abc&state=s`), /not complete/)
  })

  it('carries the service code of a refused exchange (403 CLOUD_WEB_NOT_ENABLED)', async () => {
    const saved = new Map<string, string>()
    const { api, opened } = await browserLaunch(saved, async () => ({
      status: 403, headers: {}, data: { error: { code: 'CLOUD_WEB_NOT_ENABLED', message: 'Not yet.' } }
    }))
    await api.connectMobileCloudAccount('https://zennotes.org')
    const state = new URL(opened[0]!).searchParams.get('state')!
    await assert.rejects(api.completeMobileCloudSignIn(`${callbackUrl}#code=abc123&state=${state}`), (error: unknown) =>
      (error as { code?: string; status?: number }).code === 'CLOUD_WEB_NOT_ENABLED' && (error as { status?: number }).status === 403)
  })
})
