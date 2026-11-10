import assert from 'node:assert/strict'
import { afterEach, it, vi } from 'vitest'
import { installTestHost, RecordingHttp } from '../test/test-host'
import * as api from './cloud-sync-client'
import { createCloudSyncClient } from './cloud-sync-client'
import { resetPortableHost, type HttpTransportRequest, type HttpTransportResponse } from './host'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

afterEach(() => {
  vi.useRealTimers()
  resetPortableHost()
})

it('retries the same native manifest page after the complete Retry-After delay', async () => {
  const requests: string[] = []
  installTestHost({
    http: new RecordingHttp(async ({ url }: HttpTransportRequest): Promise<HttpTransportResponse> => {
      requests.push(url)
      return requests.length === 1
        ? { status: 429, data: '<html>Slow down</html>', headers: { 'rEtRy-AfTeR': '2' } }
        : { status: 200, headers: {}, data: { data: [], cursor: 500, next_page: null } }
    })
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: 1_000_000 })
  const client = createCloudSyncClient('https://retry.example.test', 'test-token', { accountId: 'account' })
  let settled = false
  const pending = client.manifest('vault', { includeContent: false, page: 3, perPage: 250 })
    .then((data: unknown) => ({ data }), (error: unknown) => ({ error })).finally(() => { settled = true })
  await flush()
  assert.equal(settled, false)
  vi.advanceTimersByTime(1999)
  await flush()
  assert.equal(requests.length, 1)
  vi.advanceTimersByTime(1)
  assert.deepEqual(await pending, { data: { data: [], cursor: 500, next_page: null } })
  assert.equal(requests.length, 2)
  assert.equal(requests[0], requests[1])
})

it('cancels a native retry wait and preserves its cooldown across recreated clients', async () => {
  const requests: string[] = []
  installTestHost({
    http: new RecordingHttp(async ({ url }: HttpTransportRequest): Promise<HttpTransportResponse> => {
      requests.push(url)
      return requests.length === 1
        ? { status: 429, data: {}, headers: { 'Retry-After': '2' } }
        : { status: 200, headers: {}, data: { data: [] } }
    })
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: 1_000_000 })
  const first = api.createCloudSyncClient('https://cancel.example.test', 'old-token', { accountId: 'account' })
    .listVaults().catch((error: unknown) => error)
  await flush()
  api.stopMobileCloudRequests()
  assert.equal(((await first) as Error).name, 'AbortError')
  api.resumeMobileCloudRequests()
  const pending = api.createCloudSyncClient('https://cancel.example.test', 'new-token', { accountId: 'account' }).listVaults()
  await flush()
  assert.equal(requests.length, 1)
  vi.advanceTimersByTime(2000)
  assert.deepEqual(await pending, { data: [] })
  assert.equal(requests.length, 2)
})
