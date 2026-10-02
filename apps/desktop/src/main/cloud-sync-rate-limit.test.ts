import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { CloudSyncRateLimitCoordinator } from '@zennotes/shared-domain/cloud-sync-api'
import type { CloudSyncUpsertMutation } from '@zennotes/bridge-contract/cloud-sync'
import { createCloudSyncClient } from './cloud-sync-client'
import { DesktopCloudSyncService } from './cloud-sync-service'

describe('desktop Cloud request rate-limit recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))
  })

  afterEach(() => vi.useRealTimers())

  it('retains the same manifest page while waiting on a non-JSON 429 Retry-After', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('<html>Slow down</html>', {
          status: 429,
          headers: { 'rEtRy-AfTeR': '60' }
        })
      )
      .mockResolvedValueOnce(Response.json({ data: [], cursor: 17, next_page: null }))
    const client = createCloudSyncClient('https://retry-page.example.test', 'page-token', fetcher)
    let settled = false
    const result = client
      .manifest('vault', { includeContent: false, page: 3, perPage: 250 })
      .then(
        (data) => ({ data }),
        (error) => ({ error })
      )
      .finally(() => {
        settled = true
      })

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ data: { data: [], cursor: 17, next_page: null } })
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      'https://retry-page.example.test/api/v1/vaults/vault/manifest?include_content=false&page=3&per_page=250',
      'https://retry-page.example.test/api/v1/vaults/vault/manifest?include_content=false&page=3&per_page=250'
    ])
  })

  it('stops pending desktop requests on logout and resumes without bypassing the account cooldown', async () => {
    const rateLimits = new CloudSyncRateLimitCoordinator()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('not JSON', { status: 429, headers: { 'Retry-After': '60' } })
      )
      .mockResolvedValueOnce(Response.json({ data: [] }))
    const service = new DesktopCloudSyncService({
      storageDirectory: process.cwd(),
      accountStatus: async () => ({
        state: 'connected',
        account: {
          base_url: 'https://desktop-account.example.test',
          user: { name: 'Test', email: 'account@example.test' },
          device: { id: 'device', name: 'Test', platform: 'desktop' },
          connected_at: '2026-10-01T12:00:00Z'
        }
      }),
      getSecret: async () => 'token',
      createClient: (baseUrl, token, options) => {
        expect(options?.accountId).toBe('account@example.test')
        return createCloudSyncClient(baseUrl, token, fetcher, { ...options, rateLimits })
      }
    })
    const first = service.listVaults().catch((error) => error)
    await vi.advanceTimersByTimeAsync(0)
    service.stop()
    expect(await first).toMatchObject({ name: 'AbortError' })
    await expect(service.listVaults()).rejects.toMatchObject({ name: 'AbortError' })
    service.resume()
    const next = service.listVaults()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await expect(next).resolves.toEqual([])
  })

  it('shares a cooldown across recreated desktop clients even when credentials rotate', async () => {
    const rateLimits = new CloudSyncRateLimitCoordinator()
    const firstFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'RATE_LIMITED' } },
          {
            status: 429,
            headers: { 'Retry-After': 'Thu, 01 Oct 2026 12:05:00 GMT' }
          }
        )
      )
      .mockResolvedValueOnce(Response.json({ data: [] }))
    const secondFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }))
    const options = { accountId: 'same-account', rateLimits }
    const first = createCloudSyncClient(
      'https://shared.example.test',
      'old-token',
      firstFetch,
      options
    ).listVaults()
    await vi.advanceTimersByTimeAsync(0)
    const second = createCloudSyncClient(
      'https://shared.example.test/',
      'new-token',
      secondFetch,
      options
    ).listVaults()
    await vi.advanceTimersByTimeAsync(299_999)
    expect(firstFetch).toHaveBeenCalledOnce()
    expect(secondFetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, second])
    expect(new Headers(firstFetch.mock.calls[1][1]?.headers).get('Authorization')).toBe(
      'Bearer old-token'
    )
    expect(new Headers(secondFetch.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      'Bearer new-token'
    )
  })

  it('rejects exhausted 429s with their status, code, details and headers intact', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json(
        {
          error: { code: 'RATE_LIMITED', message: 'Wait', details: { limit: 120 } }
        },
        { status: 429, headers: { 'Retry-After': '2' } }
      )
    )
    const client = createCloudSyncClient('https://exhausted.example.test', 'token', fetcher, {
      accountId: 'account',
      rateLimits: new CloudSyncRateLimitCoordinator()
    })
    const result = client.listVaults().catch((error) => error)
    await vi.advanceTimersByTimeAsync(6_000)
    const error = await result
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', details: { limit: 120 } })
    expect(error.headers.get('Retry-After')).toBe('2')
  })

  it('does not send credentials after stop while an asynchronous credential read is pending', async () => {
    let release!: (token: string) => void
    const credential = new Promise<string>((resolve) => {
      release = resolve
    })
    const createClient = vi.fn()
    const service = new DesktopCloudSyncService({
      storageDirectory: process.cwd(),
      accountStatus: async () => ({
        state: 'connected',
        account: {
          base_url: 'https://logout.example.test',
          user: { name: 'Test', email: 'account@example.test' },
          device: { id: 'device', name: 'Test', platform: 'desktop' },
          connected_at: '2026-10-01T12:00:00Z'
        }
      }),
      getSecret: () => credential,
      createClient
    })
    const result = service.listVaults().catch((error) => error)
    await vi.advanceTimersByTimeAsync(0)
    service.stop()
    service.resume()
    release('stale-token')
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(createClient).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'retries upload API operations but keeps signed PUTs separate (object throttled: %s)',
    async (objectThrottled) => {
      const text = 'x'.repeat(5 * 1024 * 1024 + 1)
      const mutation: CloudSyncUpsertMutation = {
        type: 'upsert',
        item_id: 'item',
        operation_id: 'stable-operation',
        base_revision: null,
        path: 'large.md',
        kind: 'text',
        content: {
          encoding: 'utf8',
          data: text,
          byte_length: text.length,
          sha256: createHash('sha256').update(text).digest('hex'),
          media_type: 'text/markdown'
        }
      }
      const initiationBodies: unknown[] = []
      let completions = 0
      let objectPuts = 0
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        const url = String(input)
        if (url.endsWith('/uploads')) {
          initiationBodies.push(JSON.parse(options?.body as string))
          if (initiationBodies.length === 1)
            return new Response('Too many requests', {
              status: 429,
              headers: { 'Retry-After': '5' }
            })
          return Response.json({
            data: {
              id: 'upload-1',
              operation_id: mutation.operation_id,
              expected_bytes: text.length,
              upload: { method: 'PUT', url: 'https://objects.example.test/signed', headers: {} }
            }
          })
        }
        if (url === 'https://objects.example.test/signed') {
          objectPuts++
          expect(new Headers(options?.headers).has('Authorization')).toBe(false)
          expect(new Headers(options?.headers).get('Content-Length')).toBe(String(text.length))
          return new Response(null, {
            status: objectThrottled ? 429 : 200,
            headers: { 'Retry-After': '9999' }
          })
        }
        if (url.endsWith('/complete')) {
          if (++completions === 1)
            return Response.json({}, { status: 429, headers: { 'Retry-After': '5' } })
          return Response.json({ data: { result: { acknowledged: [], conflicts: [], cursor: 1 } } })
        }
        if (options?.method === 'DELETE') return new Response(null, { status: 204 })
        throw new Error(`Unexpected request: ${url}`)
      })
      const client = createCloudSyncClient(
        'https://uploads.example.test',
        'private-token',
        fetcher,
        {
          accountId: 'account',
          rateLimits: new CloudSyncRateLimitCoordinator()
        }
      )
      const result = client.mutate('vault', { mutations: [mutation] }).then(
        (data) => ({ data }),
        (error) => ({ error })
      )
      await vi.advanceTimersByTimeAsync(10_000)
      expect(initiationBodies).toHaveLength(2)
      expect(initiationBodies[0]).toEqual(initiationBodies[1])
      expect(initiationBodies[0]).toMatchObject({ operation_id: 'stable-operation' })
      expect(objectPuts).toBe(1)
      if (objectThrottled) {
        expect(await result).toMatchObject({ error: { status: 429, code: 'DIRECT_UPLOAD_FAILED' } })
        expect(completions).toBe(0)
      } else {
        expect(await result).toEqual({ data: { acknowledged: [], conflicts: [], cursor: 1 } })
        expect(completions).toBe(2)
      }
    }
  )
})
