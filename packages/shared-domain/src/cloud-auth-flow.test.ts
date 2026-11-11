import { describe, expect, it, vi } from 'vitest'
import type { CloudAccount } from '@zennotes/bridge-contract/cloud-sync'
import { CLOUD_SIGN_IN_TROUBLE_MESSAGE, describeCloudError } from './cloud-error-copy'
import {
  CloudAuthFlow,
  createCloudAuthChallenge,
  normalizeCloudBaseUrl,
  parseCloudAuthCallback,
  type CloudAuthCredential,
  type CloudAuthPending,
  type CloudAuthStorage
} from './cloud-auth-flow'

class MemoryCloudAuthStorage implements CloudAuthStorage {
  pending: unknown = null
  credential: unknown = null

  async loadPending(): Promise<unknown> {
    return this.pending
  }

  async savePending(pending: CloudAuthPending): Promise<void> {
    this.pending = structuredClone(pending)
  }

  async deletePending(): Promise<void> {
    this.pending = null
  }

  async loadCredential(): Promise<unknown> {
    return this.credential
  }

  async saveCredential(credential: CloudAuthCredential): Promise<void> {
    this.credential = structuredClone(credential)
  }

  async deleteCredential(): Promise<void> {
    this.credential = null
  }
}

function setup() {
  const storage = new MemoryCloudAuthStorage()
  const openExternal = vi.fn(async () => {})
  const exchange = vi.fn(async () => ({
    token: 'secret-token',
    user: { name: 'Ada', email: 'ada@example.com' },
    device: { id: 'device-1', name: 'Ada’s iPhone', platform: 'ios' as const }
  }))
  const flow = new CloudAuthFlow({
    platform: 'ios',
    appVersion: '1.5.0',
    deviceName: 'Ada’s iPhone',
    storage,
    openExternal,
    exchange,
    now: () => new Date('2026-08-10T12:00:00.000Z'),
    randomState: () => 'fixed-state',
    randomVerifier: () => 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  })

  return { exchange, flow, openExternal, storage }
}

describe('CloudAuthFlow', () => {
  it('starts a short-lived browser authorization without returning a credential', async () => {
    const { flow, openExternal, storage } = setup()

    await expect(flow.connect('https://zennotes.org/')).resolves.toEqual({
      authorization_url:
        'https://zennotes.org/app/connect?state=fixed-state&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      expires_at: '2026-08-10T12:05:00.000Z'
    })
    expect(openExternal).toHaveBeenCalledWith(
      'https://zennotes.org/app/connect?state=fixed-state&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256'
    )
    await expect(flow.status()).resolves.toEqual({ state: 'connecting', account: null })
    expect(JSON.stringify(storage.pending)).not.toContain('token')
  })

  it('exchanges a state-bound callback and stores the credential through the secure adapter', async () => {
    const { exchange, flow, storage } = setup()
    await flow.connect('https://zennotes.org')

    const status = await flow.complete({ code: 'OneTimeCode', state: 'fixed-state' })

    expect(exchange).toHaveBeenCalledWith('https://zennotes.org', {
      code: 'OneTimeCode',
      state: 'fixed-state',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      device_name: 'Ada’s iPhone',
      platform: 'ios',
      app_version: '1.5.0'
    })
    expect(status).toEqual({
      state: 'connected',
      account: {
        base_url: 'https://zennotes.org',
        user: { name: 'Ada', email: 'ada@example.com' },
        device: { id: 'device-1', name: 'Ada’s iPhone', platform: 'ios' },
        connected_at: '2026-08-10T12:00:00.000Z'
      }
    })
    expect(storage.credential).toMatchObject({ token: 'secret-token' })
    expect(storage.pending).toBeNull()
    await expect(flow.credential()).resolves.toMatchObject({ token: 'secret-token' })
  })

  it('rejects mismatched or expired callbacks before making a network request', async () => {
    const { exchange, flow, storage } = setup()
    await flow.connect('https://zennotes.org')

    await expect(flow.complete({ code: 'OneTimeCode', state: 'other-state' })).rejects.toThrow(
      'This sign-in has expired.'
    )
    storage.pending = {
      base_url: 'https://zennotes.org',
      state: 'fixed-state',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      expires_at: '2026-08-10T11:59:59.000Z'
    }
    await expect(flow.complete({ code: 'OneTimeCode', state: 'fixed-state' })).rejects.toThrow(
      'This sign-in has expired.'
    )
    expect(exchange).not.toHaveBeenCalled()
    expect(storage.pending).toBeNull()
  })

  it('fails closed for malformed stored credentials and exchange responses', async () => {
    const { exchange, flow, storage } = setup()
    storage.credential = { token: 42, account: {} }

    await expect(flow.status()).resolves.toEqual({ state: 'disconnected', account: null })
    expect(storage.credential).toBeNull()

    await flow.connect('https://zennotes.org')
    exchange.mockResolvedValueOnce({
      token: '',
      user: { name: 'Ada', email: 'ada@example.com' },
      device: { id: 'device-1', name: 'Ada’s iPhone', platform: 'ios' }
    })
    await expect(flow.complete({ code: 'OneTimeCode', state: 'fixed-state' })).rejects.toThrow(
      'unexpected answer while signing you in'
    )
    expect(storage.credential).toBeNull()
  })

  it('words a busy or broken service during the exchange as connect again', async () => {
    const { exchange, flow } = setup()
    await flow.connect('https://zennotes.org')
    exchange.mockRejectedValueOnce(
      Object.assign(new Error('Server Error'), { name: 'CloudServiceRequestError', status: 503, code: null })
    )
    const failure = await flow.complete({ code: 'OneTimeCode', state: 'fixed-state' }).catch((error: unknown) => error)
    expect(describeCloudError(failure).message).toBe(CLOUD_SIGN_IN_TROUBLE_MESSAGE)
  })

  it('clears pending state if the external browser cannot open and clears credentials on logout', async () => {
    const { flow, openExternal, storage } = setup()
    openExternal.mockRejectedValueOnce(new Error('unavailable'))

    await expect(flow.connect('https://zennotes.org')).rejects.toThrow('unavailable')
    expect(storage.pending).toBeNull()

    const account: CloudAccount = {
      base_url: 'https://zennotes.org',
      user: { name: 'Ada', email: 'ada@example.com' },
      device: { id: 'device-1', name: 'Ada’s iPhone', platform: 'ios' },
      connected_at: '2026-08-10T12:00:00.000Z'
    }
    storage.credential = { base_url: account.base_url, token: 'secret-token', account }

    await expect(flow.logout()).resolves.toEqual({ state: 'disconnected', account: null })
    expect(storage.credential).toBeNull()
  })
})

describe('CloudAuthFlow logout revokes the device', () => {
  const account: CloudAccount = {
    base_url: 'https://zennotes.org',
    user: { name: 'Ada', email: 'ada@example.com' },
    device: { id: 'device-1', name: 'Ada’s iPhone', platform: 'ios' },
    connected_at: '2026-08-10T12:00:00.000Z'
  }

  function setupRevoke(
    revoke: (baseUrl: string, token: string) => Promise<void>,
    baseUrl = account.base_url
  ) {
    const storage = new MemoryCloudAuthStorage()
    storage.credential = {
      base_url: baseUrl,
      token: 'secret-token',
      account: { ...account, base_url: baseUrl }
    }
    const flow = new CloudAuthFlow({
      platform: 'ios',
      appVersion: '1.5.0',
      deviceName: 'Ada’s iPhone',
      storage,
      openExternal: vi.fn(async () => {}),
      exchange: vi.fn(async () => ({})),
      revoke
    })
    return { flow, storage }
  }

  it('asks the service with the stored token before deleting the credential', async () => {
    let credentialWhileRevoking: unknown = 'not called'
    const { flow, storage } = setupRevoke(async () => {
      credentialWhileRevoking = storage.credential
    })

    await expect(flow.logout()).resolves.toEqual({ state: 'disconnected', account: null })

    expect(credentialWhileRevoking).toMatchObject({ token: 'secret-token' })
    expect(storage.credential).toBeNull()
  })

  it('passes the stored origin and token', async () => {
    const revoke = vi.fn(async () => {})
    const { flow } = setupRevoke(revoke)

    await flow.logout()

    expect(revoke).toHaveBeenCalledExactlyOnceWith('https://zennotes.org', 'secret-token')
  })

  it('still signs out when the service refuses or cannot be reached', async () => {
    for (const failure of [
      async () => {
        throw new Error('offline')
      },
      () => {
        throw new Error('thrown before any promise')
      }
    ]) {
      const { flow, storage } = setupRevoke(failure as (baseUrl: string, token: string) => Promise<void>)

      await expect(flow.logout()).resolves.toEqual({ state: 'disconnected', account: null })
      expect(storage.credential).toBeNull()
    }
  })

  it('stops waiting for a service that never answers', async () => {
    vi.useFakeTimers()
    try {
      const { flow, storage } = setupRevoke(() => new Promise<void>(() => {}))

      const logout = flow.logout()
      await vi.advanceTimersByTimeAsync(4_999)
      expect(storage.credential).not.toBeNull()
      await vi.advanceTimersByTimeAsync(1)

      await expect(logout).resolves.toEqual({ state: 'disconnected', account: null })
      expect(storage.credential).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never sends the token to an origin it would not connect to', async () => {
    const revoke = vi.fn(async () => {})
    const { flow, storage } = setupRevoke(revoke, 'http://zennotes.org')

    await expect(flow.logout()).resolves.toEqual({ state: 'disconnected', account: null })

    expect(revoke).not.toHaveBeenCalled()
    expect(storage.credential).toBeNull()
  })

  it('has nothing to revoke while a sign-in is only pending', async () => {
    const revoke = vi.fn(async () => {})
    const { flow, storage } = setupRevoke(revoke)
    storage.credential = null
    storage.pending = {
      base_url: 'https://zennotes.org',
      state: 'fixed-state',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      expires_at: '2999-01-01T00:00:00.000Z'
    }

    await expect(flow.logout()).resolves.toEqual({ state: 'disconnected', account: null })

    expect(revoke).not.toHaveBeenCalled()
    expect(storage.pending).toBeNull()
  })
})

describe('CloudAuthFlow on a shared computer', () => {
  const device = { id: 'browser-1', name: 'Chrome on macOS', platform: 'web' as const }
  const user = { name: 'Ada', email: 'ada@example.com' }

  function setupShared(answer: unknown) {
    const storage = new MemoryCloudAuthStorage()
    const exchange = vi.fn(async () => answer)
    const revoke = vi.fn(async () => {})
    const flow = new CloudAuthFlow({
      platform: 'web',
      appVersion: '2.85.0',
      deviceName: 'Chrome on macOS',
      storage,
      openExternal: vi.fn(async () => {}),
      exchange,
      revoke,
      now: () => new Date('2026-08-10T12:00:00.000Z'),
      randomState: () => 'fixed-state',
      randomVerifier: () => 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    })
    return { exchange, flow, revoke, storage }
  }

  it('remembers the choice with the pending sign-in and sends it at exchange', async () => {
    const { exchange, flow, storage } = setupShared({ token: 'secret-token', user, device: { ...device, shared: true } })
    await flow.connect('https://zennotes.org', { shared: true })
    expect(storage.pending).toMatchObject({ shared: true })

    const status = await flow.complete({ code: 'OneTimeCode', state: 'fixed-state' })

    expect(exchange).toHaveBeenCalledWith('https://zennotes.org', expect.objectContaining({ platform: 'web', shared: true }))
    expect(status.account?.device.shared).toBe(true)
  })

  it('asks the website to end its own session, so the next person has to log in', async () => {
    const { flow } = setupShared({ token: 'secret-token', user, device: { ...device, shared: true } })

    const { authorization_url: url } = await flow.connect('https://zennotes.org', { shared: true })

    expect(new URL(url).searchParams.get('shared')).toBe('1')
  })

  it('sends nothing for an ordinary sign-in, since only a browser may send it', async () => {
    const { exchange, flow, storage } = setupShared({ token: 'secret-token', user, device })
    const { authorization_url: url } = await flow.connect('https://zennotes.org')
    expect(new URL(url).searchParams.has('shared')).toBe(false)
    expect(storage.pending).not.toHaveProperty('shared')

    await flow.complete({ code: 'OneTimeCode', state: 'fixed-state' })

    expect(exchange.mock.calls[0]?.at(1)).not.toHaveProperty('shared')
  })

  it('refuses a service that did not record it, and ends the token it handed out', async () => {
    const { flow, revoke, storage } = setupShared({ token: 'long-lived', user, device })
    await flow.connect('https://zennotes.org', { shared: true })

    await expect(flow.complete({ code: 'OneTimeCode', state: 'fixed-state' })).rejects.toThrow()

    expect(revoke).toHaveBeenCalledWith('https://zennotes.org', 'long-lived')
    expect(storage.credential).toBeNull()
    expect(storage.pending).toBeNull()
  })
})

describe('cloud auth input validation', () => {
  it('derives the RFC 7636 S256 challenge from a verifier', async () => {
    await expect(
      createCloudAuthChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    ).resolves.toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('accepts clean HTTPS origins and optionally permits loopback development servers', () => {
    expect(normalizeCloudBaseUrl('https://zennotes.org/')).toBe('https://zennotes.org')
    expect(() => normalizeCloudBaseUrl('http://zennotes.org')).toThrow('HTTPS')
    expect(() => normalizeCloudBaseUrl('https://zennotes.org/app')).toThrow('without a path')
    expect(
      normalizeCloudBaseUrl('http://localhost:8000', { allowInsecureLoopback: true })
    ).toBe('http://localhost:8000')
  })

  it('permits only explicitly configured insecure development origins', () => {
    expect(
      normalizeCloudBaseUrl('http://zennotes.test', {
        allowedInsecureOrigins: ['http://zennotes.test']
      })
    ).toBe('http://zennotes.test')
    expect(() =>
      normalizeCloudBaseUrl('http://other.test', {
        allowedInsecureOrigins: ['http://zennotes.test']
      })
    ).toThrow('HTTPS')
  })

  it('parses only bounded ZenNotes auth callbacks', () => {
    expect(parseCloudAuthCallback('zennotes://auth?code=OneTimeCode&state=fixed-state')).toEqual({
      code: 'OneTimeCode',
      state: 'fixed-state'
    })
    expect(parseCloudAuthCallback('other://auth?code=OneTimeCode&state=fixed-state')).toBeNull()
    expect(parseCloudAuthCallback('zennotes://auth?code=bad%20code&state=fixed-state')).toBeNull()
    expect(
      parseCloudAuthCallback(`zennotes://auth?code=OneTimeCode&state=${'x'.repeat(129)}`)
    ).toBeNull()
  })
})
