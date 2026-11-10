import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, describe, it, vi } from 'vitest'
import type { CloudSyncMutationRequest } from '@zennotes/bridge-contract/cloud-sync'
import { generateCloudE2eeKey, toBase64 } from '@zennotes/shared-domain/cloud-e2ee'
import { CloudE2eeKeyring } from '@zennotes/shared-domain/cloud-e2ee-account'
import { CloudVaultCipher } from '@zennotes/shared-domain/cloud-e2ee-vault'
import { CLOUD_TIMEOUT_MESSAGE, describeCloudError } from '@zennotes/shared-domain/cloud-error-copy'
import { cloudSyncPathRefusal } from '@zennotes/shared-domain/cloud-sync-refusal'
import { installTestHost, RecordingHttp } from '../test/test-host'
import { createCloudSyncClient, uploadObject, type CloudServiceRequestError } from './cloud-sync-client'
import type { MobileDirectUploadError } from './mobile-direct-upload'
import { resetPortableHost, type HttpTransportRequest } from './host'

afterEach(() => {
  vi.restoreAllMocks()
  resetPortableHost()
})

it('allows the full publishing timeout through the native iOS transport', async () => {
  const requests: Array<{ connectTimeout?: number; readTimeout?: number }> = []
  installTestHost({
    http: new RecordingHttp(async (options: HttpTransportRequest) => {
      requests.push(options)
      return { status: 200, headers: {}, data: { id: 1, slug: 'test', url: 'https://example.test/s/test' } }
    })
  })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'account' })
  const note = { note_path: 'Test.md', title: 'Test', markdown: 'Latest content' }
  await client.publishNote(note)
  await client.updatePublishedNote(1, note)
  // Capacitor 7 iOS applies connectTimeout ?? readTimeout to the entire
  // URLRequest, so a shorter connection value silently wins over readTimeout.
  assert.deepEqual(requests.map(({ connectTimeout, readTimeout }) => ({ connectTimeout, readTimeout })), [
    { connectTimeout: 300_000, readTimeout: 300_000 },
    { connectTimeout: 300_000, readTimeout: 300_000 }
  ])
})

it('marks every request once this host opens encrypted vaults, and lists their real names only while unlocked', async () => {
  const accountKey = generateCloudE2eeKey()
  const vaults = [
    { id: 'vault-1', name: 'Readable', cursor: 0, created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z', encryption: null },
    // The service stores a placeholder; a locked device never shows whatever it sends.
    { id: 'vault-2', name: 'Name from the service', cursor: 0, created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z',
      encryption: await CloudVaultCipher.prepareVault('Private notes', accountKey, 1) }
  ]
  const headers: Array<Record<string, string>> = []
  installTestHost({
    http: new RecordingHttp(async (options: HttpTransportRequest) => {
      headers.push(options.headers!)
      return { status: 200, headers: {}, data: { data: vaults } }
    })
  })
  const keyring = (unlocked: boolean) => new CloudE2eeKeyring({
    listVaults: async () => vaults,
    store: { load: async () => unlocked ? { format: 1, key: toBase64(accountKey), version: 1 } : null, save: async () => {}, clear: async () => {} }
  })
  const names = async (options: { keyring?: CloudE2eeKeyring }) =>
    (await createCloudSyncClient('https://example.test', 'test-only', { accountId: 'account', ...options }).listVaults()).data
      .map((vault: { name: string }) => vault.name)

  assert.deepEqual(await names({ keyring: keyring(true) }), ['Readable', 'Private notes'])
  assert.deepEqual(await names({ keyring: keyring(false) }), ['Readable', 'Encrypted vault'])
  assert.deepEqual(await names({}), ['Readable', 'Name from the service'])
  assert.deepEqual(headers.map((sent) => [sent['X-ZenNotes-Encryption'], sent.Authorization]), [
    ['zne1', 'Bearer test-only'], ['zne1', 'Bearer test-only'], [undefined, 'Bearer test-only']
  ])
})

it('lets a request go 30 s without a byte, gives a body its time to go out, and a publication longer', async () => {
  const options: Array<{ connectTimeout?: number; readTimeout?: number }> = []
  installTestHost({
    http: new RecordingHttp(async (request: HttpTransportRequest) => {
      options.push(request)
      return { status: 200, headers: {}, data: { data: [], id: 1, slug: 'note', url: 'https://example.test/s/note' } }
    })
  })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'account' })
  await client.listVaults()
  await client.publishNote({ note_path: 'Note.md', title: 'Note', markdown: 'Text' })
  const text = 'x'.repeat(1024 * 1024)
  await client.mutate('vault-1', { mutations: [{
    type: 'upsert', operation_id: 'operation-1', item_id: 'item-1', base_revision: null, path: 'Big.md', kind: 'text',
    content: { encoding: 'utf8', data: text, sha256: createHash('sha256').update(text).digest('hex'), byte_length: text.length, media_type: 'text/markdown' }
  }] }).catch(() => {})
  // URLSession restarts the timeout whenever data arrives, so 30 s is how long
  // a request may wait for a byte; a big page on a slow link takes as long as
  // it needs. Bytes going out do not restart it, so a 1 MiB body also gets
  // its time at 8 KiB a second.
  assert.deepEqual(options.slice(0, 2).map(({ connectTimeout, readTimeout }) => ({ connectTimeout, readTimeout })), [
    { connectTimeout: 30_000, readTimeout: 30_000 },
    { connectTimeout: 300_000, readTimeout: 300_000 }
  ])
  const push = options[2]!
  assert.equal(push.readTimeout, push.connectTimeout)
  assert.ok(push.readTimeout! > 30_000 + 128_000 && push.readTimeout! < 30_000 + 130_000, String(push.readTimeout))
})

it('sends a read that went silent again instead of failing the sync', async () => {
  vi.spyOn(Math, 'random').mockImplementation(() => 0)
  const paths: string[] = []
  installTestHost({
    http: new RecordingHttp(async ({ url }: HttpTransportRequest) => {
      paths.push(new URL(url).pathname)
      if (paths.length === 1) throw Object.assign(new Error('The request timed out.'), { code: 'NSURLErrorDomain' })
      return { status: 200, headers: {}, data: { data: [] } }
    })
  })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'stalled-read' })
  assert.deepEqual(await client.listVaults(), { data: [] })
  assert.deepEqual(paths, ['/api/v1/vaults', '/api/v1/vaults'])
})

it('never sends a request again that the service might apply twice, and says the connection stalled', async () => {
  let calls = 0
  installTestHost({
    http: new RecordingHttp(async () => {
      calls++
      throw Object.assign(new Error('The request timed out.'), { code: 'NSURLErrorDomain' })
    })
  })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'stalled-write' })
  const error = await client.createVault('New vault').catch((failure: unknown) => failure)
  assert.equal(calls, 1)
  assert.equal((error as Error).name, 'CloudSyncTransportError')
  assert.equal((error as { stalled?: boolean }).stalled, true)
  assert.equal(describeCloudError(error).message, CLOUD_TIMEOUT_MESSAGE)
})

it('puts an object again when the store never answered, never when it refused', async () => {
  vi.spyOn(Math, 'random').mockImplementation(() => 0)
  for (const outcome of ['no answer', 'refused'] as const) {
    const puts: Array<{ data?: string }> = []
    const requests: string[] = []
    installTestHost({
      http: new RecordingHttp(async (options: any) => {
        const { method, url, data } = options
        const target = new URL(url)
        if (target.host === 'objects.example.test') {
          puts.push(options)
          if (puts.length > 1) return { status: 200, headers: {}, data: '' }
          if (outcome === 'refused') return { status: 403, headers: {}, data: '' }
          throw Object.assign(new Error('The network connection was lost.'), { code: 'NSURLErrorDomain' })
        }
        requests.push(`${method} ${target.pathname}`)
        if (target.pathname.endsWith('/uploads')) {
          return { status: 201, headers: {}, data: { data: {
            id: 'upload-1', operation_id: data.operation_id, status: 'uploading', expected_bytes: data.content.byte_length,
            expires_at: '2099-01-01T00:00:00Z', upload: { method: 'PUT', url: 'https://objects.example.test/put', headers: {} }
          } } }
        }
        if (method === 'DELETE') return { status: 204, headers: {}, data: '' }
        return { status: 200, headers: {}, data: { data: { id: 'upload-1', operation_id: 'operation-1', status: 'completed',
          result: { acknowledged: [{ operation_id: 'operation-1', item_id: 'item-1', revision: 1, sequence: 1 }], conflicts: [], cursor: 1 } } } }
      })
    })
    const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: `put-${outcome}` })
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 7)
    const mutation = client.mutate('vault-1', { mutations: [{
      type: 'upsert', operation_id: 'operation-1', item_id: 'item-1', base_revision: null, path: 'Scans/receipt.pdf', kind: 'binary',
      content: { encoding: 'base64', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
        byte_length: bytes.length, media_type: 'application/pdf' }
    }] })
    if (outcome === 'no answer') {
      assert.equal((await mutation).acknowledged.length, 1)
      assert.equal(puts.length, 2)
      assert.equal(puts[1]!.data, puts[0]!.data)
      assert.deepEqual(requests, ['POST /api/v1/vaults/vault-1/uploads', 'POST /api/v1/vaults/vault-1/uploads/upload-1/complete'])
    } else {
      await assert.rejects(mutation, /403/)
      assert.equal(puts.length, 1)
      assert.deepEqual(requests, ['POST /api/v1/vaults/vault-1/uploads', 'DELETE /api/v1/vaults/vault-1/uploads/upload-1'])
    }
  }
})

it('keeps which fields a 422 refused, so sync sets one path aside instead of stopping (#1004)', async () => {
  const refused = 'This path is not eligible for vault sync.'
  installTestHost({
    http: new RecordingHttp(async () => ({
      status: 422,
      headers: {},
      data: {
        error: { code: 'VALIDATION_FAILED', message: 'The request data is invalid.' },
        errors: { 'mutations.1.path': [refused] }
      }
    }))
  })
  const content = { encoding: 'base64' as const, data: 'YWJjZA==', sha256: 'a'.repeat(64), byte_length: 4, media_type: 'text/markdown' }
  const body: CloudSyncMutationRequest = {
    mutations: [
      { type: 'upsert', operation_id: 'first', item_id: 'item-1', base_revision: null, path: 'inbox/Note.md', kind: 'text', content },
      { type: 'upsert', operation_id: 'second', item_id: 'item-2', base_revision: null, path: '.zennotes/agent-edits/inbox/Note.md.json', kind: 'text', content }
    ]
  }
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'account' })
  const error = await client.mutate('vault-1', body).catch((caught: unknown) => caught) as CloudServiceRequestError
  assert.equal(error.status, 422)
  assert.equal(error.code, 'VALIDATION_FAILED')
  assert.equal(error.message, refused)
  assert.deepEqual(error.details, { errors: { 'mutations.1.path': [refused] } })
  assert.deepEqual(cloudSyncPathRefusal(error, body)?.indices, [1])
})

// The platforms time a request out differently (HttpTransport.cloudTimeouts), and
// name a stall differently: iOS by URLSession's message, Android by the Java
// exception in `code`. Each copy knew only its own; the package knows both.
it('uses the host\'s timeout policy when it has one, as Android does', async () => {
  const http = Object.assign(new RecordingHttp(async () => ({ status: 200, headers: {}, data: { data: [] } })), {
    cloudTimeouts: ({ timeoutMs }: { timeoutMs?: number }) => ({ connectTimeout: 15_000, readTimeout: timeoutMs ?? 30_000 })
  })
  installTestHost({ http })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-timeouts' })
  await client.listVaults()
  assert.equal(http.requests[0]!.connectTimeout, 15_000)
  assert.equal(http.requests[0]!.readTimeout, 30_000)
})

it('knows an Android read that went silent as a stall', async () => {
  let calls = 0
  installTestHost({
    http: new RecordingHttp(async () => {
      calls++
      throw Object.assign(new Error('timeout'), { code: 'SocketTimeoutException' })
    })
  })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-stall' })
  const error = await client.createVault('New vault').catch((failure: unknown) => failure)
  assert.equal(calls, 1)
  assert.equal((error as { stalled?: boolean }).stalled, true)
  assert.equal(describeCloudError(error).message, CLOUD_TIMEOUT_MESSAGE)
})

it('does not call a connection that never opened a stall', async () => {
  installTestHost({
    http: new RecordingHttp(async () => {
      throw Object.assign(new Error('Unable to resolve host "example.test"'), { code: 'UnknownHostException' })
    })
  })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-offline' })
  const error = await client.createVault('New vault').catch((failure: unknown) => failure)
  assert.equal((error as Error).name, 'CloudSyncTransportError')
  assert.equal((error as { stalled?: boolean }).stalled, false)
})

describe('object-storage PUTs', () => {
  const upload = { url: 'https://objects.example.test/put', method: 'PUT' as const, headers: {}, byteLength: 3 }

  it('sends an in-memory body through the host\'s HTTP, as a base64 file body, by default (the iPhone)', async () => {
    const http = new RecordingHttp(async () => ({ status: 200, headers: {}, data: '' }))
    installTestHost({ http })
    await uploadObject({ ...upload, base64: 'AQID' })
    assert.equal(http.uploads.length, 0)
    assert.equal(http.requests[0]!.dataType, 'file')
    assert.equal(http.requests[0]!.data, 'AQID')
  })

  it('sends every body through the native PUT on a host that says so (Android)', async () => {
    const http = Object.assign(new RecordingHttp(async () => assert.fail('no request goes through the HTTP transport')), {
      putsInMemoryBodies: true
    })
    installTestHost({ http })
    await uploadObject({ ...upload, base64: 'AQID', sha256: 'abc' })
    assert.deepEqual(http.uploads, [{ url: upload.url, headers: {}, base64: 'AQID', byteLength: 3, sha256: 'abc' }])
  })

  it('streams a scanned file by its native URI, and calls a native PUT with no answer unreachable', async () => {
    const http = new RecordingHttp(undefined, async () => { throw new Error('lost') })
    installTestHost({ http })
    const error = await uploadObject({ ...upload, uri: 'file:///vault/scan.pdf', sha256: 'abc' }).catch((failure: unknown) => failure)
    assert.equal(http.uploads[0]!.uri, 'file:///vault/scan.pdf')
    assert.equal((error as MobileDirectUploadError).status, 0)
    assert.equal((error as MobileDirectUploadError).code, 'DIRECT_UPLOAD_FAILED')
  })

  it('refuses a file-backed upload on a host with no native PUT', async () => {
    const http = new RecordingHttp()
    installTestHost({ http: Object.assign(http, { putFile: undefined }) })
    await assert.rejects(uploadObject({ ...upload, uri: 'file:///vault/scan.pdf', sha256: 'abc' }), /native file uploader/)
    assert.equal(http.requests.length, 0)
  })
})
