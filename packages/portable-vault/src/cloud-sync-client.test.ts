import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, describe, it, vi } from 'vitest'
import type { CloudSyncMutationRequest } from '@zennotes/bridge-contract/cloud-sync'
import { generateCloudE2eeKey, toBase64, zne1CiphertextLength } from '@zennotes/shared-domain/cloud-e2ee'
import { CloudE2eeKeyring } from '@zennotes/shared-domain/cloud-e2ee-account'
import { CloudVaultCipher } from '@zennotes/shared-domain/cloud-e2ee-vault'
import { CLOUD_TIMEOUT_MESSAGE, describeCloudError } from '@zennotes/shared-domain/cloud-error-copy'
import { registerCloudSyncStagedFile } from '@zennotes/shared-domain/cloud-sync-content'
import { CloudSyncCoordinator, type CloudSyncRepository } from '@zennotes/shared-domain/cloud-sync-coordinator'
import { CloudSyncPathRefusedError, cloudSyncPathRefusal } from '@zennotes/shared-domain/cloud-sync-refusal'
import { CLOUD_CONNECT_TIMEOUT_MS, CLOUD_STALL_TIMEOUT_MS } from '@zennotes/shared-domain/cloud-sync-stall'
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

// ---------------------------------------------------------------------------
// Android cases (zennotesandroid src/bridge/cloud-sync-client.test.ts). The
// phone ran each over a fresh bundle of the module; here each uses its own
// account scope, so no negotiated capability carries over between them.
// Android's host sends every object-storage body through its native PUT
// (`putsInMemoryBodies`) and sizes timeouts itself (`cloudTimeouts`).
// ---------------------------------------------------------------------------

/** Android's timeout policy: a connection gets 15 s to open, and a request
 *  may go 30 s without a byte unless it asks for longer. */
const androidTimeouts = ({ timeoutMs }: { timeoutMs?: number }) =>
  ({ connectTimeout: CLOUD_CONNECT_TIMEOUT_MS, readTimeout: timeoutMs ?? CLOUD_STALL_TIMEOUT_MS })

/** Android's host: the native PUT takes in-memory bodies too. */
function androidHttp(
  responder: ConstructorParameters<typeof RecordingHttp>[0],
  fileResponder: ConstructorParameters<typeof RecordingHttp>[1] = null
) {
  return Object.assign(new RecordingHttp(responder, fileResponder), { putsInMemoryBodies: true, cloudTimeouts: androidTimeouts })
}

/** Account capability + reference-mode responses, as the backend now serves them. */
function referenceServer(items: any[], feedRef: { feed: any[] }, requests: URL[], downloads: string[]) {
  return async ({ url, method }: HttpTransportRequest) => {
    const request = new URL(url)
    requests.push(request)
    if (request.pathname.endsWith('/account')) {
      return { status: 200, headers: {}, data: { data: { capabilities: { content_references: true }, user: {}, device: {}, features: {}, usage: {} } } }
    }
    if (request.pathname.endsWith('/manifest')) {
      assert.equal(request.searchParams.get('content_mode'), 'references')
      const page = Number(request.searchParams.get('page') ?? 1)
      const size = Number(request.searchParams.get('per_page') ?? 100)
      const data = items.slice((page - 1) * size, page * size).map(({ content, ...metadata }) => ({
        ...metadata, content_ref: { item_id: metadata.item_id, revision: metadata.revision, ...content, data: undefined }
      })).map((row) => ({ ...row, content_ref: Object.fromEntries(Object.entries(row.content_ref).filter(([, v]) => v !== undefined)) }))
      return { status: 200, headers: {}, data: { data, cursor: 3, next_page: page * size < items.length ? page + 1 : null } }
    }
    if (request.pathname.endsWith('/download')) {
      const [, itemId, revision] = request.pathname.match(/items\/([^/]+)\/revisions\/(\d+)\/download/)!
      const item = items.find((candidate) => candidate.item_id === itemId)!
      const content = item.versions?.[Number(revision)] ?? item.content
      downloads.push(`${itemId}:${revision}`)
      return { status: 200, headers: {}, data: { data: {
        item_id: itemId, revision: Number(revision),
        content: { encoding: content.encoding, sha256: content.sha256, byte_length: content.byte_length, media_type: content.media_type },
        download: { url: `https://objects.example.test/${itemId}/${revision}`, method: 'GET', headers: {}, expires_at: new Date(Date.now() + 300_000).toISOString() }
      } } }
    }
    assert.ok(request.pathname.endsWith('/changes'), `unexpected ${method} ${request.pathname}`)
    assert.equal(request.searchParams.get('content_mode'), 'references')
    const after = Number(request.searchParams.get('after'))
    const size = Number(request.searchParams.get('limit'))
    const remaining = feedRef.feed.filter((change) => change.sequence > after)
    const data = remaining.slice(0, size)
    return { status: 200, headers: {}, data: { data, cursor: feedRef.feed.at(-1)?.sequence ?? 3, has_more: remaining.length > size } }
  }
}

function memoryKeyStore(value: { format: 1; key: string; version: number } | null) {
  return { load: async () => value, save: async () => assert.fail('nothing saves here'), clear: async () => {} }
}

async function encryptedVaultFixture(name = 'Journal 2026') {
  const accountKey = generateCloudE2eeKey()
  const vault = {
    id: 'vault-1', name: 'Encrypted vault', cursor: 0, created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z',
    encryption: await CloudVaultCipher.prepareVault(name, accountKey, 1)
  }
  return { vault, unlocked: { format: 1 as const, key: toBase64(accountKey), version: 1 } }
}

describe('Android cases', () => {
  it('syncs large attachments as native-staged references, never as base64 through the bridge', async () => {
    const requests: URL[] = []
    const downloads: string[] = []
    const items = [1, 2, 3].map((id) => {
      const bytes = Buffer.alloc(1_048_577, id)
      const hash = createHash('sha256').update(bytes).digest('hex')
      const content = { encoding: 'base64', sha256: hash, byte_length: bytes.length, media_type: 'image/jpeg' }
      return { item_id: `asset-${id}`, path: `assets/${id}.jpg`, kind: 'binary', revision: 1, sha256: hash, byte_length: bytes.length, media_type: 'image/jpeg', content, versions: { 1: content } as Record<number, any> }
    })
    const feedRef = { feed: [] as any[] }
    installTestHost({ http: androidHttp(referenceServer(items, feedRef, requests, downloads)) })
    const files = new Map<string, any>()
    let state: any = null
    const staged: string[] = []
    const repository = {
      scan: async () => [...files.values()],
      apply: async () => assert.fail('reference-mode hosts must receive staged files, not inline apply'),
      stageCloudContent: async (source: any) => {
        await source.getInstruction()
        staged.push(`${source.reference.item_id}:${source.reference.revision}`)
        return registerCloudSyncStagedFile(source.reference, { native: true }, async () => {})
      },
      applyStagedCloudContent: async (change: any) => {
        files.set(change.path, { path: change.path, kind: 'binary', content: { ...change.content_ref, data: '' } })
      },
      resolveStagedCloudConflict: async () => assert.fail('no conflicts expected')
    }
    const sync = new CloudSyncCoordinator('vault-1', createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-references' }),
      repository as unknown as CloudSyncRepository, {
        load: async () => state,
        save: async (next: any) => { state = structuredClone(next) }
      }, {
        itemId: () => assert.fail('download must not invent an item'),
        operationId: () => assert.fail('download must not upload unchanged files')
      })

    await sync.sync()
    assert.equal(state.cursor, 3)
    assert.equal(files.size, 3)
    assert.deepEqual(staged.sort(), ['asset-1:1', 'asset-2:1', 'asset-3:1'])
    assert.deepEqual(downloads.sort(), staged.sort())
    // No request ever carried a body larger than metadata.
    assert.ok(requests.every((url) => !url.pathname.includes('/revisions/') || url.pathname.endsWith('/download')))

    feedRef.feed = items.map((item, index) => {
      const bytes = Buffer.alloc(2_000_000, 100 + index)
      const hash = createHash('sha256').update(bytes).digest('hex')
      const content = { encoding: 'base64', sha256: hash, byte_length: bytes.length, media_type: 'image/jpeg' }
      item.versions[2] = content
      return { sequence: 4 + index, item_id: item.item_id, path: item.path, previous_path: item.path, type: 'upsert', revision: 2,
        content_ref: { item_id: item.item_id, revision: 2, ...content } }
    })
    requests.length = 0
    staged.length = 0
    await sync.sync()
    assert.equal(state.cursor, 6)
    assert.deepEqual([...files.values()].map((item) => item.content.sha256), feedRef.feed.map((change) => change.content_ref.sha256))
    assert.deepEqual(staged.sort(), ['asset-1:2', 'asset-2:2', 'asset-3:2'])
  })

  it('keeps metadata-only manifest pagination intact', async () => {
    const requests: URL[] = []
    installTestHost({
      http: androidHttp(async ({ url }: HttpTransportRequest) => {
        requests.push(new URL(url))
        return { status: 200, headers: {}, data: { data: [], cursor: 10, next_page: null } }
      })
    })
    const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-metadata-pages' })
    await client.manifest('vault-1', { includeContent: false, page: 2, perPage: 250 })
    await client.manifest('vault-1', { includeContent: false, perPage: 1 })
    assert.equal(requests[0]!.searchParams.get('per_page'), '250')
    assert.equal(requests[0]!.searchParams.get('page'), '2')
    assert.equal(requests[1]!.searchParams.get('per_page'), '1')
    assert.ok(requests.every((url) => url.searchParams.get('include_content') === 'false'))
  })

  it('preserves the requested change page size and metadata-only content budget', async () => {
    const requests: URL[] = []
    installTestHost({ http: androidHttp(referenceServer([], { feed: [] }, requests, [])) })
    const client = createCloudSyncClient('https://pagination.example.test', 'test-only', { accountId: 'android-change-pages' })
    await client.negotiateContentReferences()
    await client.changes('vault-1', 10, 250, { contentMode: 'references', maxInlineBytes: 0 })
    const request = requests.at(-1)!
    assert.equal(request.searchParams.get('limit'), '250')
    assert.equal(request.searchParams.get('after'), '10')
    assert.equal(request.searchParams.get('max_inline_bytes'), '0')
    assert.equal(request.searchParams.get('max_response_bytes'), '1048576')
  })

  it('announces end-to-end encryption only for a client given a keyring, and forwards request headers', async () => {
    const requests: { headers: Record<string, string> }[] = []
    installTestHost({
      http: androidHttp(async ({ headers }: HttpTransportRequest) => {
        requests.push({ headers: headers! })
        return { status: 200, headers: {}, data: { data: [], cursor: 0, next_page: null } }
      })
    })
    const readable = { id: 'vault-1', name: 'Notes', cursor: 0, created_at: '', updated_at: '', encryption: null }
    const keyring = new CloudE2eeKeyring({ listVaults: async () => [readable], store: memoryKeyStore(null) })
    await createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-marker' }).manifest('vault-1', { includeContent: false })
    await createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-marker', keyring }).manifest('vault-1', { includeContent: false })
    assert.equal(requests[0]!.headers['X-ZenNotes-Encryption'], undefined)
    assert.equal(requests[1]!.headers['X-ZenNotes-Encryption'], 'zne1')
    assert.ok(requests.every(({ headers }) => headers.Authorization === 'Bearer test-only'))
  })

  it('sends an encrypted vault\'s file direct once its ciphertext passes the inline cap, sealed and never readable', async () => {
    const { vault, unlocked } = await encryptedVaultFixture()
    const requests: { method: string; path: string; headers: Record<string, string>; data: any }[] = []
    const http = androidHttp(async ({ method, url, headers, data }: any) => {
      const path = new URL(url).pathname
      requests.push({ method, path, headers, data })
      if (path.endsWith('/uploads')) {
        return { status: 201, headers: {}, data: { data: {
          id: 'upload-1', operation_id: data.operation_id, status: 'uploading', expected_bytes: data.content.byte_length,
          expires_at: '2099-01-01T00:00:00Z', upload: { method: 'PUT', url: 'https://objects.example.test/put', headers: {} }
        } } }
      }
      assert.ok(path.endsWith('/uploads/upload-1/complete'), `unexpected ${method} ${path}`)
      return { status: 200, headers: {}, data: { data: { id: 'upload-1', operation_id: 'operation-1', status: 'completed',
        result: { acknowledged: [{ operation_id: 'operation-1', item_id: 'item-1', revision: 1, sequence: 1 }], conflicts: [], cursor: 1 } } } }
    })
    installTestHost({ http })
    const keyring = new CloudE2eeKeyring({ listVaults: async () => [vault], store: memoryKeyStore(unlocked) })
    const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-sealed', keyring })
    const bytes = Buffer.alloc(5 * 1024 * 1024 - 100, 4)
    const result = await client.mutate('vault-1', { mutations: [{
      type: 'upsert', operation_id: 'operation-1', item_id: 'item-1', base_revision: null, path: 'Scans/receipt.pdf', kind: 'binary',
      content: { encoding: 'base64', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
        byte_length: bytes.length, media_type: 'application/pdf' }
    }] })

    assert.equal(result.acknowledged.length, 1)
    assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), [
      'POST /api/v1/vaults/vault-1/uploads', 'POST /api/v1/vaults/vault-1/uploads/upload-1/complete'
    ])
    assert.ok(requests.every(({ headers }) => headers['X-ZenNotes-Encryption'] === 'zne1'))
    const initiated = requests[0]!.data
    assert.match(initiated.path, /^[0-9a-f]{64}$/)
    assert.equal(JSON.stringify(initiated).includes('receipt'), false)
    assert.deepEqual([initiated.kind, initiated.content.encoding, initiated.content.byte_length], ['binary', 'aes-gcm', zne1CiphertextLength(bytes.length)])
    const sealed = Buffer.from(http.uploads[0]!.base64!, 'base64')
    assert.equal(http.uploads[0]!.sha256, createHash('sha256').update(sealed).digest('hex'))
    assert.equal(sealed.subarray(0, 4).toString('latin1'), 'ZNE1')
  })

  it('lets a request go 30 s without a byte and a connection 15 s to open; only a publication waits longer', async () => {
    const options: Array<{ connectTimeout?: number; readTimeout?: number }> = []
    installTestHost({
      http: androidHttp(async (request: HttpTransportRequest) => {
        options.push(request)
        return { status: 200, headers: {}, data: { data: [], id: 1, slug: 'note', url: 'https://example.test/s/note' } }
      })
    })
    const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-publication' })
    await client.listVaults()
    await client.publishNote({ note_path: 'Note.md', title: 'Note', markdown: 'Text' })
    // Android's read timeout starts over with every byte, so 30 s is how long a
    // request may go silent; a big page on a slow link takes as long as it needs.
    assert.deepEqual(options.map(({ connectTimeout, readTimeout }) => ({ connectTimeout, readTimeout })), [
      { connectTimeout: 15_000, readTimeout: 30_000 },
      { connectTimeout: 15_000, readTimeout: 300_000 }
    ])
  })

  it('sends a read that went silent again instead of failing the sync', async () => {
    vi.spyOn(Math, 'random').mockImplementation(() => 0)
    const paths: string[] = []
    installTestHost({
      http: androidHttp(async ({ url }: HttpTransportRequest) => {
        paths.push(new URL(url).pathname)
        if (paths.length === 1) throw Object.assign(new Error('timeout'), { code: 'SocketTimeoutException' })
        return { status: 200, headers: {}, data: { data: [] } }
      })
    })
    const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-stalled-read' })
    assert.deepEqual(await client.listVaults(), { data: [] })
    assert.deepEqual(paths, ['/api/v1/vaults', '/api/v1/vaults'])
  })

  it('never sends a request again that the service might apply twice, and says the connection stalled', async () => {
    let calls = 0
    installTestHost({
      http: androidHttp(async () => {
        calls++
        throw Object.assign(new Error('timeout'), { code: 'SocketTimeoutException' })
      })
    })
    const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-stalled-write' })
    const error = await client.createVault('New vault').catch((failure: unknown) => failure)
    assert.equal(calls, 1)
    assert.equal((error as Error).name, 'CloudSyncTransportError')
    assert.equal((error as { stalled?: boolean }).stalled, true)
    assert.equal(describeCloudError(error).message, CLOUD_TIMEOUT_MESSAGE)
  })

  it('puts an object again when the store never answered, never when it refused', async () => {
    vi.spyOn(Math, 'random').mockImplementation(() => 0)
    for (const outcome of ['no answer', 'refused'] as const) {
      const requests: string[] = []
      const http = androidHttp(async ({ method, url, data }: any) => {
        const path = new URL(url).pathname
        requests.push(`${method} ${path}`)
        if (path.endsWith('/uploads')) {
          return { status: 201, headers: {}, data: { data: {
            id: 'upload-1', operation_id: data.operation_id, status: 'uploading', expected_bytes: data.content.byte_length,
            expires_at: '2099-01-01T00:00:00Z', upload: { method: 'PUT', url: 'https://objects.example.test/put', headers: {} }
          } } }
        }
        if (method === 'DELETE') return { status: 204, headers: {}, data: '' }
        return { status: 200, headers: {}, data: { data: { id: 'upload-1', operation_id: 'operation-1', status: 'completed',
          result: { acknowledged: [{ operation_id: 'operation-1', item_id: 'item-1', revision: 1, sequence: 1 }], conflicts: [], cursor: 1 } } } }
      }, async () => {
        // The native PUT: the call being answered is already in http.uploads.
        if (http.uploads.length > 1) return { status: 200 }
        if (outcome === 'refused') return { status: 403 }
        throw Object.assign(new Error('Cloud object upload failed.'), { code: 'DIRECT_UPLOAD_FAILED' })
      })
      installTestHost({ http })
      const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: `android-put-${outcome}` })
      const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 7)
      const mutation = client.mutate('vault-1', { mutations: [{
        type: 'upsert', operation_id: 'operation-1', item_id: 'item-1', base_revision: null, path: 'Scans/receipt.pdf', kind: 'binary',
        content: { encoding: 'base64', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
          byte_length: bytes.length, media_type: 'application/pdf' }
      }] })
      if (outcome === 'no answer') {
        assert.equal((await mutation).acknowledged.length, 1)
        assert.equal(http.uploads.length, 2)
        assert.equal(http.uploads[1]!.base64, http.uploads[0]!.base64)
        assert.deepEqual(requests, ['POST /api/v1/vaults/vault-1/uploads', 'POST /api/v1/vaults/vault-1/uploads/upload-1/complete'])
      } else {
        await assert.rejects(mutation, /403/)
        assert.equal(http.uploads.length, 1)
        assert.deepEqual(requests, ['POST /api/v1/vaults/vault-1/uploads', 'DELETE /api/v1/vaults/vault-1/uploads/upload-1'])
      }
    }
  })

  it('keeps which fields a 422 refused, so sync sets one path aside and sends the rest (#1004)', async () => {
    const refused = 'This path is not eligible for vault sync.'
    const requests: string[] = []
    installTestHost({
      http: androidHttp(async ({ url, method }: HttpTransportRequest) => {
        requests.push(`${method} ${new URL(url).pathname}`)
        if (url.endsWith('/uploads')) {
          return { status: 422, headers: {}, data: { error: { code: 'VALIDATION_FAILED', message: 'The request data is invalid.' }, errors: { path: [refused] } } }
        }
        if (requests.length === 1) {
          return { status: 422, headers: {}, data: { error: { code: 'VALIDATION_FAILED', message: 'The request data is invalid.' }, errors: { 'mutations.1.path': [refused] } } }
        }
        return { status: 200, headers: {}, data: { acknowledged: [{ operation_id: 'kept', item_id: 'kept-item', revision: 1, sequence: 3 }], conflicts: [], cursor: 3 } }
      })
    })
    const content = (bytes: number) => ({ encoding: 'base64', data: Buffer.alloc(bytes, 1).toString('base64'), sha256: 'a'.repeat(64), byte_length: bytes, media_type: 'text/markdown' })
    // Android's own fixture sends `kind: 'markdown'`; the client passes it through.
    const upsert = (operation: string, path: string, bytes = 4) =>
      ({ type: 'upsert', operation_id: operation, item_id: `${operation}-item`, base_revision: null, path, kind: 'markdown', content: content(bytes) })
    const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'android-refused-path' })

    // One request: the transport keeps Cloud's `errors`, so the refusal names the path.
    const inline = { mutations: [upsert('kept', 'inbox/Note.md'), upsert('agent', '.zennotes/agent-edits/inbox/Note.md.json')] } as unknown as CloudSyncMutationRequest
    const error = await client.mutate('vault-1', inline).catch((caught: unknown) => caught) as CloudServiceRequestError
    assert.equal(error.status, 422)
    assert.equal(error.code, 'VALIDATION_FAILED')
    assert.equal(error.message, refused)
    assert.deepEqual(error.details, { errors: { 'mutations.1.path': [refused] } })
    assert.deepEqual(cloudSyncPathRefusal(error, inline)?.indices, [1])

    // Several requests: a large file's upload refused for its path is named by
    // its place in the batch, and carries what the inline request applied.
    const mixed = { mutations: [upsert('kept', 'inbox/Note.md'), upsert('big', '.zennotes/agent-edits/big.json', 5 * 1024 * 1024 + 1)] } as unknown as CloudSyncMutationRequest
    const split = await client.mutate('vault-1', mixed).catch((caught: unknown) => caught)
    assert.ok(split instanceof CloudSyncPathRefusedError)
    assert.deepEqual(split.refusal.indices, [1])
    assert.deepEqual(split.refusal.applied.acknowledged.map((entry: { operation_id: string }) => entry.operation_id), ['kept'])
    assert.deepEqual(cloudSyncPathRefusal(split, mixed)?.indices, [1])
  })
})
