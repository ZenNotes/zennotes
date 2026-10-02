import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CloudSyncApiClient,
  CloudSyncRateLimitCoordinator,
  cloudSyncRetryAfterMs,
  type CloudSyncHttpRequest,
  type CloudSyncHttpTransport
} from './cloud-sync-api'
import { CloudAutoSyncController } from './cloud-auto-sync'

const scope = { baseUrl: 'https://cloud.example.test', accountId: 'account-one' }
const read: CloudSyncHttpRequest = { method: 'GET', path: '/api/v1/vaults/one/manifest?page=3' }
const nativeAbortCheck = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'throwIfAborted')!
const limited = (retryAfter?: string) =>
  Object.assign(new Error('Rate limited'), {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'rEtRy-AfTeR': retryAfter }
  })

function fixture() {
  const coordinator = new CloudSyncRateLimitCoordinator()
  const send = vi.fn<CloudSyncHttpTransport['request']>().mockResolvedValue({ ok: true })
  const transport: CloudSyncHttpTransport = { request: send as CloudSyncHttpTransport['request'] }
  return { coordinator, send, transport, client: coordinator.wrap(transport, scope) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))
})
afterEach(() => {
  Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', nativeAbortCheck)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function simulateIOS15(): void {
  vi.stubGlobal('structuredClone', undefined)
  Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', {
    configurable: true,
    writable: true,
    value: undefined
  })
  vi.spyOn(AbortSignal.prototype, 'reason', 'get').mockReturnValue(undefined)
}

describe('iOS 15 retry compatibility', () => {
  it('replays unchanged JSON mutations when structuredClone and throwIfAborted are unavailable', async () => {
    simulateIOS15()
    const f = fixture()
    const body = {
      mutations: [
        { type: 'delete' as const, item_id: 'note', operation_id: 'original', base_revision: 1 }
      ]
    }
    const expected = JSON.stringify(body)
    const sent: string[] = []
    f.send
      .mockImplementationOnce(async (request) => {
        sent.push(JSON.stringify(request.body))
        const attempt = request.body as typeof body
        attempt.mutations[0].operation_id = 'transport-change'
        throw limited('60')
      })
      .mockImplementationOnce(async (request) => {
        sent.push(JSON.stringify(request.body))
        return {} as never
      })
    const result = new CloudSyncApiClient(f.client).mutate('vault', body)
    void result.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    body.mutations[0].operation_id = 'caller-change'
    await vi.advanceTimersByTimeAsync(59_999)
    expect(f.send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(sent).toEqual([expected, expected])
  })

  it.each(['already aborted', 'cooldown', 'in-flight', 'logout'])(
    'rejects with AbortError without signal.reason: %s',
    async (stage) => {
      simulateIOS15()
      const f = fixture()
      const abort = new AbortController()
      const client = f.coordinator.wrap(f.transport, { ...scope, signal: abort.signal })
      let finish: ((value: unknown) => void) | undefined
      if (stage === 'already aborted') abort.abort()
      else if (stage === 'in-flight') {
        f.send.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve
            })
        )
      } else f.send.mockRejectedValueOnce(limited('60'))
      const result = client.request(read).catch((error) => error)
      await vi.advanceTimersByTimeAsync(0)
      if (stage === 'logout') f.coordinator.cancel(scope)
      else abort.abort()
      const error = await result
      expect(error).toBeInstanceOf(DOMException)
      expect(error).toMatchObject({ name: 'AbortError' })
      finish?.({ stale: true })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(f.send).toHaveBeenCalledTimes(stage === 'already aborted' ? 0 : 1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})

describe('Retry-After parsing', () => {
  it.each([
    ['60', 60_000],
    ['0', 0],
    [' 120 ', 120_000],
    ['Thu, 01 Oct 2026 12:02:00 GMT', 120_000],
    ['Thu, 01 Oct 2026 11:59:00 GMT', 0],
    ['-1', null],
    ['1.5', null],
    ['1e3', null],
    ['tomorrow', null],
    ['', null]
  ])('parses %s without treating malformed seconds as a date', (value, expected) => {
    expect(cloudSyncRetryAfterMs({ 'ReTrY-AfTeR': value })).toBe(expected)
  })

  it('accepts Fetch Headers and accounts for an earlier server clock', () => {
    expect(cloudSyncRetryAfterMs(new Headers({ 'Retry-After': '60' }))).toBe(60_000)
    expect(
      cloudSyncRetryAfterMs({
        'Retry-After': 'Thu, 01 Oct 2026 12:01:00 GMT',
        Date: 'Thu, 01 Oct 2026 11:59:00 GMT'
      })
    ).toBe(120_000)
    expect(cloudSyncRetryAfterMs(undefined)).toBeNull()
  })
})

describe('account-scoped Cloud request recovery', () => {
  it.each(['9'.repeat(400), '9007199254740993'])(
    'keeps an overflowing numeric delay cancellable without early retry or a timer loop',
    async (header) => {
      expect(cloudSyncRetryAfterMs({ 'Retry-After': header })).toBe(Infinity)
      const f = fixture()
      const abort = new AbortController()
      f.send.mockRejectedValueOnce(limited(header))
      const result = f.client.request({ ...read, signal: abort.signal }).catch((error) => error)
      await vi.advanceTimersByTimeAsync(2 * 2_147_483_647)
      expect(f.send).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(1)
      abort.abort()
      expect(await result).toMatchObject({ name: 'AbortError' })
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['60', 'Thu, 01 Oct 2026 12:01:00 GMT', undefined, 'bad header'])(
    'waits for %s and replays the same failed page',
    async (header) => {
      const f = fixture()
      f.send.mockRejectedValueOnce(limited(header))
      const result = f.client.request(read)
      await vi.advanceTimersByTimeAsync(0)
      expect(f.send).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(59_999)
      expect(f.send).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      await expect(result).resolves.toEqual({ ok: true })
      expect(f.send.mock.calls.map(([request]) => request.path)).toEqual([read.path, read.path])
    }
  )

  it('does not retry a long valid delay early, including beyond the timer integer limit', async () => {
    const f = fixture()
    const delay = 30 * 24 * 60 * 60 * 1000
    f.send.mockRejectedValueOnce(limited(String(delay / 1000)))
    const result = f.client.request(read)
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(f.send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toEqual({ ok: true })
  })

  it('bounds consecutive 429 retries and retains the last cooldown for a recreated client', async () => {
    const f = fixture()
    const failure = limited()
    f.send
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
    const client = f.coordinator.wrap(f.transport, { ...scope, maxRetries: 2 })
    const result = client.request(read).catch((error) => error)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await result).toBe(failure)
    expect(f.send).toHaveBeenCalledTimes(3)

    const next = new CloudSyncApiClient(f.coordinator.wrap(f.transport, scope)).manifest('two')
    await vi.advanceTimersByTimeAsync(239_999)
    expect(f.send).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    await next
    expect(f.send).toHaveBeenCalledTimes(4)
  })

  it('resets the retry allowance on each successful request', async () => {
    const f = fixture()
    const client = f.coordinator.wrap(f.transport, { ...scope, maxRetries: 1 })
    for (let page = 1; page <= 5; page++) {
      f.send.mockRejectedValueOnce(limited('2')).mockResolvedValueOnce({ page })
      const result = client.request({ ...read, path: `page-${page}` })
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(result).resolves.toEqual({ page })
    }
    expect(f.send).toHaveBeenCalledTimes(10)
  })

  it('keeps foreground retries behind the server cooldown after request-level exhaustion', async () => {
    const f = fixture()
    f.send.mockRejectedValueOnce(limited('60'))
    const sync = vi.fn(async () => {
      const client = new CloudSyncApiClient(
        f.coordinator.wrap(f.transport, { ...scope, maxRetries: 0 })
      )
      await client.manifest('vault')
    })
    const controller = new CloudAutoSyncController({ ready: () => true, sync, intervalMs: 600_000 })
    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    controller.request('foreground')
    await vi.advanceTimersByTimeAsync(0)
    expect(sync).toHaveBeenCalledTimes(2)
    expect(f.send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(f.send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.send).toHaveBeenCalledTimes(2)
    controller.stop()
  })

  it('shares cooldowns across recreated clients and vaults, not accounts or base URLs', async () => {
    const f = fixture()
    f.send.mockRejectedValueOnce(limited('60'))
    const first = new CloudSyncApiClient(f.client).manifest('one')
    await vi.advanceTimersByTimeAsync(0)
    const secondSend = vi.fn<CloudSyncHttpTransport['request']>().mockResolvedValue({ ok: true })
    const secondTransport: CloudSyncHttpTransport = {
      request: secondSend as CloudSyncHttpTransport['request']
    }
    const second = new CloudSyncApiClient(
      f.coordinator.wrap(secondTransport, {
        ...scope,
        baseUrl: 'https://CLOUD.example.test:443/'
      })
    ).manifest('two')
    const other = f.coordinator.wrap(secondTransport, { ...scope, accountId: 'account-two' })
    const otherHost = f.coordinator.wrap(secondTransport, {
      ...scope,
      baseUrl: 'https://other.example.test'
    })
    await other.request(read)
    await otherHost.request(read)
    expect(secondSend).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(secondSend).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, second])
    expect(secondSend).toHaveBeenCalledTimes(3)
  })

  it('rechecks the shared deadline when another in-flight response extends it', async () => {
    const f = fixture()
    f.send.mockRejectedValueOnce(limited('60')).mockRejectedValueOnce(limited('120'))
    const first = f.client.request(read)
    const second = f.client.request({ ...read, path: 'other-vault' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.all([first, second])
    expect(f.send).toHaveBeenCalledTimes(4)
  })

  it('cancels a pending wait and leaves other clients subject to the cooldown', async () => {
    const f = fixture()
    const abort = new AbortController()
    f.send.mockRejectedValueOnce(limited('60'))
    const client = f.coordinator.wrap(f.transport, { ...scope, signal: abort.signal })
    const result = client.request(read).catch((error) => error)
    await vi.advanceTimersByTimeAsync(0)
    abort.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
    const next = f.client.request(read)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(f.send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await next
  })

  it('keeps a client bound to its original cancellation lifetime', async () => {
    const f = fixture()
    const original = new AbortController()
    const options = { ...scope, signal: original.signal }
    const client = f.coordinator.wrap(f.transport, options)
    options.signal = new AbortController().signal
    original.abort()
    await expect(client.request(read)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.send).not.toHaveBeenCalled()
  })

  it('cancels all old clients for logout without cancelling another account', async () => {
    const f = fixture()
    f.send.mockRejectedValueOnce(limited('60'))
    const first = f.client.request(read).catch((error) => error)
    await vi.advanceTimersByTimeAsync(0)
    const second = f.coordinator
      .wrap(f.transport, scope)
      .request(read)
      .catch((error) => error)
    f.coordinator.cancel(scope)
    expect(await first).toMatchObject({ name: 'AbortError' })
    expect(await second).toMatchObject({ name: 'AbortError' })
    await expect(f.client.request(read)).rejects.toMatchObject({ name: 'AbortError' })
    await f.coordinator.wrap(f.transport, { ...scope, accountId: 'other' }).request(read)
    expect(f.send).toHaveBeenCalledTimes(2)
    const signedInAgain = f.coordinator.wrap(f.transport, scope).request(read)
    await vi.advanceTimersByTimeAsync(60_000)
    await signedInAgain
  })

  it('supports per-request cancellation even if a transport cannot abort its in-flight native call', async () => {
    const f = fixture()
    const abort = new AbortController()
    let finish!: (value: unknown) => void
    f.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const result = f.client.request({ ...read, signal: abort.signal }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(0)
    abort.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    finish({ stale: true })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.send).toHaveBeenCalledOnce()
  })

  it.each([401, 403, 409, 413, 500])('preserves HTTP %i without retrying it', async (status) => {
    const f = fixture()
    const error = Object.assign(new Error('Rejected'), { status, headers: { 'Retry-After': '60' } })
    f.send.mockRejectedValueOnce(error)
    await expect(f.client.request(read)).rejects.toBe(error)
    expect(f.send).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['POST', 'PUT', 'DELETE'] as const)('does not replay an unmarked %s', async (method) => {
    const f = fixture()
    const error = limited('60')
    f.send.mockRejectedValueOnce(error)
    await expect(f.client.request({ method, path: '/unsafe', body: { value: 1 } })).rejects.toBe(
      error
    )
    expect(f.send).toHaveBeenCalledOnce()
    const next = f.client.request(read)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(f.send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await next
  })

  it('replays an explicitly idempotent mutation with unchanged IDs and bytes', async () => {
    const f = fixture()
    const seen: unknown[] = []
    const body = {
      mutations: [
        { type: 'delete' as const, item_id: 'item', operation_id: 'op-1', base_revision: 1 }
      ]
    }
    f.send
      .mockImplementationOnce(async (request) => {
        seen.push(structuredClone(request.body))
        ;(request.body as typeof body).mutations[0].operation_id = 'transport-change'
        throw limited('60')
      })
      .mockImplementationOnce(async (request) => {
        seen.push(structuredClone(request.body))
        return {} as never
      })
    const result = new CloudSyncApiClient(f.client).mutate('vault', body)
    await vi.advanceTimersByTimeAsync(0)
    body.mutations[0].operation_id = 'caller-change'
    await vi.advanceTimersByTimeAsync(60_000)
    await result
    expect(seen).toEqual(
      [1, 2].map(() => ({
        mutations: [
          {
            type: 'delete',
            item_id: 'item',
            operation_id: 'op-1',
            base_revision: 1
          }
        ]
      }))
    )
  })
})
