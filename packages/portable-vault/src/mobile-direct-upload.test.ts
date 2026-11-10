import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { describe, it } from 'vitest'
import type {
  CloudSyncContent,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncUploadRequest,
  CloudSyncUpsertMutation
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CloudPathIndex,
  Zne1Purpose,
  decryptItemMeta,
  decryptZne1,
  generateCloudE2eeKey,
  unwrapVaultKey,
  zne1CiphertextLength
} from '@zennotes/shared-domain/cloud-e2ee'
import { CloudE2eeLockedError, CloudVaultCipher } from '@zennotes/shared-domain/cloud-e2ee-vault'
import { CloudSyncPathRefusedError, cloudSyncPathRefusal } from '@zennotes/shared-domain/cloud-sync-refusal'
import { cloudSendTimeoutMs } from '@zennotes/shared-domain/cloud-sync-stall'
import {
  CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES,
  MobileDirectUploadError,
  mobileObjectUploadOptions,
  mutateWithMobileDirectUploads,
  rememberMobileUploadSource,
  type MobileDirectUploadApi,
  type MobileObjectUpload,
  type MobileObjectUploadRequest,
  type MobileUploadSealer
} from './mobile-direct-upload'

describe('mutateWithMobileDirectUploads', () => {
  it('supplies a content type when production signs only the host so iOS sends the file body', () => {
    const headers = { Host: 'objects.example.test' }
    const options = mobileObjectUploadOptions({
      url: 'https://objects.example.test/upload?signature=signed',
      method: 'PUT', headers, base64: 'AQID', byteLength: 3
    })
    assert.equal(options.headers['Content-Type'], 'application/octet-stream')
    assert.equal(options.headers.Host, headers.Host)
    assert.deepEqual(headers, { Host: 'objects.example.test' })
  })

  it('preserves a signed content type regardless of header casing', () => {
    const options = mobileObjectUploadOptions({
      url: 'https://objects.example.test/upload?signature=signed',
      method: 'PUT', headers: { 'content-type': 'image/jpeg' }, base64: 'AQID', byteLength: 3
    })
    const contentTypes = Object.entries(options.headers).filter(([key]) => key.toLowerCase() === 'content-type')
    assert.deepEqual(contentTypes, [['content-type', 'image/jpeg']])
  })

  it('builds a native binary PUT without an account bearer token or redirects', () => {
    const options = mobileObjectUploadOptions({
      url: 'https://objects.example.test/upload?signature=signed',
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': '3'
      },
      base64: 'AQID',
      byteLength: 3
    })

    assert.deepEqual(options, {
      url: 'https://objects.example.test/upload?signature=signed',
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': '3'
      },
      data: 'AQID',
      dataType: 'file',
      // Bytes going out never restart the iOS timeout: the stall bound plus
      // the body's time at 8 KiB a second (1 ms for these 3 bytes).
      connectTimeout: 30_001,
      readTimeout: 30_001,
      disableRedirects: true
    })
    assert.equal(options.headers.Authorization, undefined)
  })

  it('keeps files at the inline limit in the normal mutation request', async () => {
    const mutation = upsertMutation(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES, 'AA==')
    const inlineBodies: CloudSyncMutationRequest[] = []
    const api = fakeApi({
      mutate: async (_vaultId, body) => {
        inlineBodies.push(body)
        return emptyResponse()
      }
    })

    await mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [mutation] }, async () => {
      assert.fail('object upload must not run for an inline file')
    })

    assert.deepEqual(inlineBodies, [{ mutations: [mutation] }])
  })

  it('uploads a file above the inline limit through the signed object URL', async () => {
    const base64 = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 7).toString('base64')
    const mutation = upsertMutation(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, base64)
    const calls: string[] = []
    const acknowledgement = {
      operation_id: mutation.operation_id,
      item_id: mutation.item_id,
      revision: 3,
      sequence: 9
    }
    let completionAttempts = 0
    const api = fakeApi({
      initiateUpload: async () => {
        calls.push('initiate')
        return uploadInstruction(mutation, 'https://objects.example.test/upload?signature=signed')
      },
      completeUpload: async () => {
        calls.push('complete')
        completionAttempts += 1
        if (completionAttempts === 1) {
          throw new MobileDirectUploadError('Try again.', 503, 'TEMPORARY_FAILURE')
        }
        return {
          data: {
            id: 'upload-1',
            operation_id: mutation.operation_id,
            status: 'completed',
            result: { acknowledged: [acknowledgement], conflicts: [], cursor: 9 }
          }
        }
      }
    })
    const uploads: Parameters<MobileObjectUpload>[0][] = []

    const result = await mutateWithMobileDirectUploads(
      api,
      'vault-1',
      { mutations: [mutation] },
      async (upload) => {
        calls.push('put')
        uploads.push(upload)
      }
    )

    assert.deepEqual(result, { acknowledged: [acknowledgement], conflicts: [], cursor: 9 })
    assert.deepEqual(calls, ['initiate', 'put', 'complete', 'complete'])
    assert.equal(uploads[0]?.url, 'https://objects.example.test/upload?signature=signed')
    assert.equal(uploads[0]?.base64, base64)
    assert.equal(uploads[0]?.byteLength, CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1)
    assert.equal(uploads[0]?.headers.Authorization, undefined)
  })

  it('names a direct upload refused for its path by its place in the batch, with what went before (#1004)', async () => {
    const refused = 'This path is not eligible for vault sync.'
    const byteLength = CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1
    const small = { ...upsertMutation(4, 'YWJjZA=='), operation_id: 'small', item_id: 'small-item', path: 'inbox/Note.md' }
    const large = upsertMutation(byteLength, Buffer.alloc(byteLength, 17).toString('base64'))
    const after = { ...small, operation_id: 'after', item_id: 'after-item', path: 'inbox/After.md' }
    const smallAck = { operation_id: 'small', item_id: 'small-item', revision: 1, sequence: 7 }
    const calls: string[] = []
    const api = fakeApi({
      mutate: async (_vaultId, body) => {
        calls.push(`mutate ${body.mutations.map((mutation) => mutation.operation_id).join(',')}`)
        return { acknowledged: [smallAck], conflicts: [], cursor: 7 }
      },
      initiateUpload: async () => {
        calls.push('initiate')
        throw serviceError(refused, 422, 'VALIDATION_FAILED', { errors: { path: [refused] } })
      }
    })

    const error = await mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [small, large, after] }, async () => {
      throw new Error('Unexpected object upload')
    }).catch((caught: unknown) => caught)

    assert.ok(error instanceof CloudSyncPathRefusedError)
    assert.deepEqual(error.refusal.indices, [1])
    assert.deepEqual(error.refusal.applied, { acknowledged: [smallAck], conflicts: [], cursor: 7 })
    assert.equal(error.refusal.detail, `HTTP 422 · VALIDATION_FAILED · ${refused}`)
    // After.md was never sent; sync sends it again without the refused file.
    assert.deepEqual(calls, ['mutate small', 'initiate'])
  })

  it('names an inline path refusal by its place in the whole batch, after a direct upload', async () => {
    const refused = 'This path is not eligible for vault sync.'
    const byteLength = CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1
    const large = upsertMutation(byteLength, Buffer.alloc(byteLength, 3).toString('base64'))
    const first = { ...upsertMutation(4, 'YWJjZA=='), operation_id: 'first', item_id: 'first-item', path: 'inbox/A.md' }
    const second = { ...first, operation_id: 'second', item_id: 'second-item', path: '.zennotes/agent-edits/inbox/A.md.json' }
    const largeAck = { operation_id: large.operation_id, item_id: large.item_id, revision: 2, sequence: 4 }
    const api = fakeApi({
      initiateUpload: async () => uploadInstruction(large, 'https://objects.example.test/upload'),
      completeUpload: async () => ({
        data: { id: 'upload-1', operation_id: large.operation_id, status: 'completed', result: { acknowledged: [largeAck], conflicts: [], cursor: 4 } }
      }),
      // The inline request holds the batch's mutations 1 and 2, so Cloud names
      // its own positions; the refusal must name the batch's.
      mutate: async () => {
        throw serviceError(refused, 422, 'VALIDATION_FAILED', { errors: { 'mutations.1.path': [refused] } })
      }
    })

    const error = await mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [large, first, second] }, async () => {})
      .catch((caught: unknown) => caught)

    assert.ok(error instanceof CloudSyncPathRefusedError)
    assert.deepEqual(error.refusal.indices, [2])
    assert.deepEqual(error.refusal.applied, { acknowledged: [largeAck], conflicts: [], cursor: 4 })
  })

  it('still stops on a refusal that is not about a path', async () => {
    const byteLength = CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1
    const large = upsertMutation(byteLength, Buffer.alloc(byteLength, 5).toString('base64'))
    const failure = serviceError('Invalid.', 422, 'VALIDATION_FAILED', { errors: { sha256: ['Bad hash.'] } })
    const api = fakeApi({ initiateUpload: async () => { throw failure } })
    const error = await mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [large] }, async () => {})
      .catch((caught: unknown) => caught)
    assert.equal(error, failure)
  })

  it('aborts the reservation when object storage rejects the upload', async () => {
    const byteLength = CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1
    const mutation = upsertMutation(byteLength, Buffer.alloc(byteLength, 11).toString('base64'))
    const aborted: string[] = []
    const api = fakeApi({
      initiateUpload: async () => uploadInstruction(mutation, 'https://objects.example.test/upload'),
      abortUpload: async (_vaultId, uploadId) => {
        aborted.push(uploadId)
      }
    })

    await assert.rejects(
      mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [mutation] }, async () => {
        throw new MobileDirectUploadError('Object upload failed.', 503, 'DIRECT_UPLOAD_FAILED')
      }),
      (error: unknown) =>
        error instanceof MobileDirectUploadError && error.code === 'DIRECT_UPLOAD_FAILED'
    )
    assert.deepEqual(aborted, ['upload-1'])
  })

  it('rejects insecure signed URLs before transmitting bytes and aborts the reservation', async () => {
    const byteLength = CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1
    const mutation = upsertMutation(byteLength, Buffer.alloc(byteLength, 12).toString('base64'))
    const aborted: string[] = []
    let uploaded = false
    const api = fakeApi({
      initiateUpload: async () => uploadInstruction(mutation, 'http://objects.example.test/upload'),
      abortUpload: async (_vaultId, uploadId) => {
        aborted.push(uploadId)
      }
    })

    await assert.rejects(
      mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [mutation] }, async () => {
        uploaded = true
      }),
      (error: unknown) =>
        error instanceof MobileDirectUploadError && error.code === 'INSECURE_DIRECT_UPLOAD_URL'
    )
    assert.equal(uploaded, false)
    assert.deepEqual(aborted, ['upload-1'])
  })
})

/** What cloud-sync-client's transport throws for an answer with an error
 *  status (CloudServiceRequestError, whose module needs Capacitor). */
function serviceError(message: string, status: number, code: string, details: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { name: 'CloudServiceRequestError', status, code, details })
}

function fakeApi(overrides: Partial<MobileDirectUploadApi>): MobileDirectUploadApi {
  return {
    mutate: async () => emptyResponse(),
    initiateUpload: async () => {
      throw new Error('Unexpected initiateUpload call')
    },
    completeUpload: async () => {
      throw new Error('Unexpected completeUpload call')
    },
    abortUpload: async () => {},
    ...overrides
  }
}

function emptyResponse(): CloudSyncMutationResponse {
  return { acknowledged: [], conflicts: [], cursor: 0 }
}

function upsertMutation(byteLength: number, data: string): CloudSyncUpsertMutation {
  return {
    type: 'upsert',
    operation_id: 'operation-1',
    item_id: 'item-1',
    base_revision: null,
    path: 'assets/photo.png',
    kind: 'binary',
    content: {
      encoding: 'base64',
      data,
      sha256: 'a'.repeat(64),
      byte_length: byteLength,
      media_type: 'image/png'
    }
  }
}

function uploadInstruction(mutation: CloudSyncUpsertMutation, url: string) {
  return {
    data: {
      id: 'upload-1',
      operation_id: mutation.operation_id,
      status: 'uploading' as const,
      expected_bytes: mutation.content.byte_length,
      expires_at: '2026-08-26T18:30:00.000Z',
      upload: {
        method: 'PUT' as const,
        url,
        headers: {
          'Content-Type': mutation.content.media_type,
          'Content-Length': String(mutation.content.byte_length)
        }
      }
    }
  }
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function vaultCipher() {
  const accountKey = generateCloudE2eeKey()
  const encryption = await CloudVaultCipher.prepareVault('Test vault', accountKey, 1)
  return CloudVaultCipher.open({ id: 'vault-1', encryption }, accountKey, 1)
}

/** Stands in for the CryptoKit chunk loop: seals with exactly the header, key
 *  and AAD JavaScript hands over, so a wrong one cannot open below. */
function sealZne1(plaintext: Buffer, keys: { header: string; objectKey: string; aad: string }): Buffer {
  const key = Buffer.from(keys.objectKey, 'base64')
  const aad = Buffer.from(keys.aad, 'base64')
  const parts = [Buffer.from(keys.header, 'base64')]
  let index = 0
  let offset = 0
  do {
    const end = Math.min(offset + 65_536, plaintext.length)
    const last = end === plaintext.length
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(index, 7)
    nonce[11] = last ? 1 : 0
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad)
    parts.push(cipher.update(plaintext.subarray(offset, end)), cipher.final(), cipher.getAuthTag())
    offset = end
    index++
  } while (offset < plaintext.length)
  return Buffer.concat(parts)
}

async function opened(cipher: CloudVaultCipher, sealed: Buffer): Promise<Buffer> {
  const pieces: Buffer[] = []
  for await (const piece of cipher.decryptStream([sealed])) pieces.push(Buffer.from(piece))
  return Buffer.concat(pieces)
}

/** A large scanned file: no bytes in `data`, a native URI, and a native sealer. */
function largeSource(plaintext: Buffer, sealer: MobileUploadSealer): CloudSyncContent {
  return rememberMobileUploadSource({
    encoding: 'base64', data: '', sha256: sha256(plaintext), byte_length: plaintext.length, media_type: 'image/png'
  }, 'file:///vault/assets/photo.png', sealer)
}

function encryptedHarness(cipher: CloudVaultCipher, overrides: Partial<MobileDirectUploadApi> = {}) {
  const calls: string[] = []
  const requests: CloudSyncUploadRequest[] = []
  const puts: Parameters<MobileObjectUpload>[0][] = []
  const api = fakeApi({
    vaultCipher: async () => cipher,
    initiateUpload: async (_vaultId, body) => {
      calls.push('initiate')
      requests.push(body)
      return { data: {
        id: 'upload-1', operation_id: body.operation_id, status: 'uploading' as const,
        expected_bytes: body.content.byte_length, expires_at: '2026-10-12T18:30:00.000Z',
        upload: { method: 'PUT' as const, url: 'https://objects.example.test/upload', headers: {} }
      } }
    },
    completeUpload: async () => {
      calls.push('complete')
      return { data: { id: 'upload-1', operation_id: 'operation-1', status: 'completed', result: {
        acknowledged: [{ operation_id: 'operation-1', item_id: 'item-1', revision: 1, sequence: 4 }], conflicts: [], cursor: 4
      } } }
    },
    abortUpload: async () => { calls.push('abort') },
    ...overrides
  })
  const uploadObject: MobileObjectUpload = async (request) => {
    calls.push('put')
    puts.push(request)
  }
  return { api, calls, requests, puts, uploadObject }
}

function encryptedUpsert(content: CloudSyncContent): CloudSyncUpsertMutation {
  return { type: 'upsert', operation_id: 'operation-1', item_id: 'item-1', base_revision: null, path: 'assets/photo.png', kind: 'binary', content }
}

describe('direct uploads for end-to-end encrypted vaults', () => {
  it('seals a large file natively, initiates with the ciphertext, and discards the sealed copy', async () => {
    const cipher = await vaultCipher()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 9)
    let sealed: Buffer | null = null
    const discarded: string[] = []
    const content = largeSource(plaintext, async (keys) => {
      sealed = sealZne1(plaintext, keys)
      return {
        uri: 'file:///vault/.zennotes/sync/uploads/sealed', byteLength: sealed.length, sha256: sha256(sealed),
        plaintextByteLength: plaintext.length, plaintextSha256: sha256(plaintext),
        discard: async () => { discarded.push('sealed') }
      }
    })
    const h = encryptedHarness(cipher)
    const result = await mutateWithMobileDirectUploads(h.api, 'vault-1', { mutations: [encryptedUpsert(content)] }, h.uploadObject)

    assert.equal(result.acknowledged.length, 1)
    assert.deepEqual(h.calls, ['initiate', 'put', 'complete'])
    const request = h.requests[0]!
    assert.equal(request.path, await cipher.pathId('assets/photo.png'), 'the service sees a path id')
    assert.equal(request.kind, 'binary')
    assert.deepEqual(request.content, {
      encoding: 'aes-gcm', sha256: sha256(sealed!), byte_length: sealed!.length, media_type: 'application/octet-stream'
    })
    assert.equal(sealed!.length, zne1CiphertextLength(plaintext.length))
    const meta = await cipher.openManifestItem({
      item_id: 'item-1', path: request.path, kind: 'binary', revision: 1, sha256: '', byte_length: 0, media_type: '', meta: request.meta
    })
    assert.deepEqual([meta.path, meta.sha256, meta.byte_length], ['assets/photo.png', sha256(plaintext), plaintext.length])
    assert.deepEqual(h.puts[0], {
      url: 'https://objects.example.test/upload', method: 'PUT', headers: {},
      uri: 'file:///vault/.zennotes/sync/uploads/sealed', sha256: sha256(sealed!), byteLength: sealed!.length
    })
    assert.deepEqual(await opened(cipher, sealed!), plaintext, 'the vault key opens what was uploaded')
    assert.deepEqual(discarded, ['sealed'])
  })

  it('refuses a file that changed since sync hashed it, before initiating', async () => {
    const cipher = await vaultCipher()
    const planned = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 1)
    const changed = Buffer.alloc(planned.length, 2)
    const discarded: string[] = []
    const content = largeSource(planned, async (keys) => {
      const sealed = sealZne1(changed, keys)
      return {
        uri: 'file:///vault/.zennotes/sync/uploads/sealed', byteLength: sealed.length, sha256: sha256(sealed),
        plaintextByteLength: changed.length, plaintextSha256: sha256(changed),
        discard: async () => { discarded.push('sealed') }
      }
    })
    const h = encryptedHarness(cipher)
    await assert.rejects(
      mutateWithMobileDirectUploads(h.api, 'vault-1', { mutations: [encryptedUpsert(content)] }, h.uploadObject),
      (error: unknown) => error instanceof MobileDirectUploadError && error.code === 'DIRECT_UPLOAD_SIZE_MISMATCH'
    )
    assert.deepEqual(h.calls, [])
    assert.deepEqual(discarded, ['sealed'])
  })

  for (const failure of ['initiate', 'put', 'complete'] as const) {
    it(`discards the sealed copy when the ${failure} step fails`, async () => {
      const cipher = await vaultCipher()
      const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 4)
      const discarded: string[] = []
      const content = largeSource(plaintext, async (keys) => {
        const sealed = sealZne1(plaintext, keys)
        return {
          uri: 'file:///vault/.zennotes/sync/uploads/sealed', byteLength: sealed.length, sha256: sha256(sealed),
          plaintextByteLength: plaintext.length, plaintextSha256: sha256(plaintext),
          discard: async () => { discarded.push('sealed') }
        }
      })
      const broken = async () => { throw new MobileDirectUploadError(`${failure} failed`, 400, 'TEST_FAILURE') }
      const h = encryptedHarness(cipher, failure === 'initiate' ? { initiateUpload: broken }
        : failure === 'complete' ? { completeUpload: broken } : {})
      await assert.rejects(mutateWithMobileDirectUploads(
        h.api, 'vault-1', { mutations: [encryptedUpsert(content)] },
        failure === 'put' ? broken : h.uploadObject
      ), new RegExp(`${failure} failed`))
      assert.deepEqual(discarded, ['sealed'])
    })
  }

  it('sends a file direct once sealing takes it over the inline limit, sealed in memory', async () => {
    const cipher = await vaultCipher()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES - 100, 6)
    assert.ok(zne1CiphertextLength(plaintext.length) > CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES)
    const content: CloudSyncContent = {
      encoding: 'base64', data: plaintext.toString('base64'), sha256: sha256(plaintext),
      byte_length: plaintext.length, media_type: 'image/png'
    }
    const h = encryptedHarness(cipher, { mutate: async () => assert.fail('a sealed body over the limit must not go inline') })
    await mutateWithMobileDirectUploads(h.api, 'vault-1', { mutations: [encryptedUpsert(content)] }, h.uploadObject)
    const put = h.puts[0]!
    const sealed = Buffer.from(put.base64!, 'base64')
    assert.equal(put.byteLength, sealed.length)
    assert.equal(h.requests[0]!.content.sha256, sha256(sealed))
    assert.deepEqual(await opened(cipher, sealed), plaintext)

    // The same file in a readable vault still fits inline.
    const inline: CloudSyncMutationRequest[] = []
    await mutateWithMobileDirectUploads(fakeApi({ mutate: async (_vaultId, body) => { inline.push(body); return emptyResponse() } }),
      'vault-1', { mutations: [encryptedUpsert(content)] }, async () => assert.fail('readable vaults upload this inline'))
    assert.equal(inline.length, 1)
  })

  // The cipher checks the bytes against the hash sync planned with, and a
  // file edited since reads as `tampered` there. That is a local change the
  // next sync uploads (Android's mapping), not the damaged-file message the
  // iPhone showed.
  it('reports an encrypted in-memory file that changed since the scan as DIRECT_UPLOAD_SIZE_MISMATCH', async () => {
    const cipher = await vaultCipher()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES - 100, 6)
    const content: CloudSyncContent = {
      encoding: 'base64', data: plaintext.toString('base64'), sha256: sha256(Buffer.alloc(plaintext.length, 9)),
      byte_length: plaintext.length, media_type: 'image/png'
    }
    const h = encryptedHarness(cipher, { mutate: async () => assert.fail('nothing goes inline') })
    await assert.rejects(
      mutateWithMobileDirectUploads(h.api, 'vault-1', { mutations: [encryptedUpsert(content)] }, h.uploadObject),
      { code: 'DIRECT_UPLOAD_SIZE_MISMATCH' }
    )
    assert.deepEqual(h.calls, [])
  })

  // A scanned large file has no bytes in `data`; only its native sealer can
  // read it. Without one the iPhone said so; Android reported a changed file,
  // which repeated every sync.
  it('refuses a large encrypted file with no native sealer with the cannot-seal message, before initiating', async () => {
    const cipher = await vaultCipher()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 5)
    const registered = rememberMobileUploadSource({
      encoding: 'base64', data: '', sha256: sha256(plaintext), byte_length: plaintext.length, media_type: 'image/png'
    }, 'file:///vault/assets/photo.png')
    const unregistered: CloudSyncContent = {
      encoding: 'base64', data: '', sha256: sha256(plaintext), byte_length: plaintext.length, media_type: 'image/png'
    }
    for (const content of [registered, unregistered]) {
      const h = encryptedHarness(cipher, { mutate: async () => assert.fail('nothing goes inline') })
      await assert.rejects(
        mutateWithMobileDirectUploads(h.api, 'vault-1', { mutations: [encryptedUpsert(content)] }, h.uploadObject),
        /cannot seal large files for an end-to-end encrypted vault/
      )
      assert.deepEqual(h.calls, [])
    }
  })

  it('reports a conflict under the real path its sealed metadata names', async () => {
    const cipher = await vaultCipher()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 8)
    const current = await cipher.sealMeta('assets/other name.png', 'binary', {
      encoding: 'base64', sha256: sha256(plaintext), byte_length: plaintext.length, media_type: 'image/png'
    })
    const content = largeSource(plaintext, async (keys) => {
      const sealed = sealZne1(plaintext, keys)
      return {
        uri: 'file:///vault/.zennotes/sync/uploads/sealed', byteLength: sealed.length, sha256: sha256(sealed),
        plaintextByteLength: plaintext.length, plaintextSha256: sha256(plaintext), discard: async () => {}
      }
    })
    const h = encryptedHarness(cipher, {
      initiateUpload: async () => {
        throw new MobileDirectUploadError('Conflict.', 409, 'PATH_CONFLICT', {
          current_revision: 3, current_path: current.pathId, current_meta: current.meta
        })
      }
    })
    const result = await mutateWithMobileDirectUploads(h.api, 'vault-1', { mutations: [encryptedUpsert(content)] }, h.uploadObject)
    assert.equal(result.conflicts[0]?.current_path, 'assets/other name.png')
    assert.equal(result.conflicts[0]?.current_meta, undefined)
  })

  it('stops before any request while an encrypted vault is locked', async () => {
    const calls: string[] = []
    const api = fakeApi({
      vaultCipher: async () => { throw new CloudE2eeLockedError() },
      mutate: async () => { calls.push('mutate'); return emptyResponse() }
    })
    await assert.rejects(
      mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [encryptedUpsert({
        encoding: 'utf8', data: 'x', sha256: sha256(Buffer.from('x')), byte_length: 1, media_type: 'text/markdown'
      })] }, async () => assert.fail('nothing uploads')),
      /Unlock encryption/
    )
    assert.deepEqual(calls, [])
  })
})

// ---------------------------------------------------------------------------
// Android cases (zennotesandroid src/bridge/mobile-direct-upload.test.ts).
// Android's native sealer took the source URI and the raw chunk cipher
// params; the package's takes base64 keys and is bound to its source when it
// is registered, so `nativeSealer` below adapts the same native seal.
// ---------------------------------------------------------------------------

describe('Android cases: mutateWithMobileDirectUploads', () => {
  it('preserves an existing signed content type regardless of casing', () => {
    const options = mobileObjectUploadOptions({
      url: 'https://objects.example.test/upload',
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      base64: 'AQID',
      byteLength: 3
    })
    assert.deepEqual(options.headers, { 'content-type': 'image/png' })
  })

  // Android gave these options a fixed 30 s connect and 300 s read, but
  // never used them: its PUTs all go through ZenDirectUpload.put, which the
  // package keeps for it (HttpTransport.putsInMemoryBodies). A host that does
  // send them through `request` gets the iPhone's send window for both, the
  // package's one rule; the rest of Android's case holds as it was.
  it('builds a native binary PUT without an account bearer token or redirects', () => {
    const options = mobileObjectUploadOptions({
      url: 'https://objects.example.test/upload?signature=signed',
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': '3'
      },
      base64: 'AQID',
      byteLength: 3
    })

    assert.deepEqual(options, {
      url: 'https://objects.example.test/upload?signature=signed',
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': '3'
      },
      data: 'AQID',
      dataType: 'file',
      connectTimeout: cloudSendTimeoutMs(3),
      readTimeout: cloudSendTimeoutMs(3),
      disableRedirects: true
    })
    assert.equal(options.headers.Authorization, undefined)
  })
})

describe('Android cases: a path Cloud refuses (#1004)', () => {
  const refusedText = 'This path is not eligible for vault sync.'
  const validation = (errors: Record<string, string[]>) =>
    new MobileDirectUploadError(refusedText, 422, 'VALIDATION_FAILED', { errors })
  const small = (operation: string, path: string): CloudSyncUpsertMutation =>
    ({ ...upsertMutation(4, 'YWJjZA=='), operation_id: operation, item_id: `${operation}-item`, path })
  const large = (operation: string, path: string): CloudSyncUpsertMutation => {
    const byteLength = CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1
    return { ...upsertMutation(byteLength, Buffer.alloc(byteLength, 5).toString('base64')), operation_id: operation, item_id: `${operation}-item`, path }
  }
  const ack = (mutation: CloudSyncUpsertMutation, sequence: number) =>
    ({ operation_id: mutation.operation_id, item_id: mutation.item_id, revision: 1, sequence })

  it('names an inline mutation by its place in the whole batch, with the direct upload that went before', async () => {
    const big = large('big', 'assets/photo.png')
    const kept = small('kept', 'inbox/Note.md')
    const refused = small('refused', '.zennotes/agent-edits/inbox/Note.md.json')
    const body = { mutations: [big, kept, refused] }
    const api = fakeApi({
      initiateUpload: async () => uploadInstruction(big, 'https://objects.example.test/upload'),
      completeUpload: async () => ({
        data: { id: 'upload-1', operation_id: big.operation_id, status: 'completed' as const, result: { acknowledged: [ack(big, 4)], conflicts: [], cursor: 4 } }
      }),
      // The inline request carries kept and refused; Cloud names its own index 1.
      mutate: async () => { throw validation({ 'mutations.1.path': [refusedText] }) }
    })

    const error = await mutateWithMobileDirectUploads(api, 'vault-1', body, async () => {}).catch((caught: unknown) => caught)

    assert.ok(error instanceof CloudSyncPathRefusedError)
    assert.deepEqual(error.refusal.indices, [2])
    assert.deepEqual(error.refusal.applied, { acknowledged: [ack(big, 4)], conflicts: [], cursor: 4 })
    assert.deepEqual(cloudSyncPathRefusal(error, body)?.indices, [2])
  })

  it('names a direct upload refused for its own path by its place in the batch, with what went before', async () => {
    const kept = small('kept', 'inbox/Note.md')
    const big = large('big', '.zennotes/agent-edits/assets/photo.png.json')
    const body = { mutations: [kept, big] }
    let uploaded = false
    const api = fakeApi({
      mutate: async () => ({ acknowledged: [ack(kept, 3)], conflicts: [], cursor: 3 }),
      initiateUpload: async () => { throw validation({ path: [refusedText] }) }
    })

    const error = await mutateWithMobileDirectUploads(api, 'vault-1', body, async () => { uploaded = true })
      .catch((caught: unknown) => caught)

    assert.ok(error instanceof CloudSyncPathRefusedError)
    assert.deepEqual(error.refusal.indices, [1])
    assert.deepEqual(error.refusal.applied, { acknowledged: [ack(kept, 3)], conflicts: [], cursor: 3 })
    assert.equal(uploaded, false)
  })

  it('stops as before when Cloud refuses anything but a path', async () => {
    const big = large('big', 'assets/photo.png')
    const other = small('other', 'inbox/Note.md')
    const original = validation({ 'mutations.0.base_revision': ['The base revision is invalid.'] })
    const api = fakeApi({
      initiateUpload: async () => uploadInstruction(big, 'https://objects.example.test/upload'),
      completeUpload: async () => ({
        data: { id: 'upload-1', operation_id: big.operation_id, status: 'completed' as const, result: { acknowledged: [ack(big, 4)], conflicts: [], cursor: 4 } }
      }),
      mutate: async () => { throw original }
    })

    const error = await mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [big, other] }, async () => {})
      .catch((caught: unknown) => caught)

    assert.equal(error, original)
  })
})

describe('Android cases: encrypted vaults', () => {
  const SIGNED_URL = 'https://objects.example.test/upload?signature=signed'

  it('seals a large file natively, sends only ciphertext under a path id, and discards the sealed copy', async () => {
    const { cipher, vaultKey } = await encryptedVault()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 70_000, 7)
    const files = new Map([['file:///vault/assets/photo.png', plaintext]])
    const log: string[] = []
    const mutation = fileBackedMutation('assets/photo.png', plaintext)
    rememberMobileUploadSource(mutation.content, 'file:///vault/assets/photo.png', nativeSealer(files, log, 'file:///vault/assets/photo.png'))
    const sealedLength = zne1CiphertextLength(plaintext.length)
    let initiated: CloudSyncUploadRequest | undefined
    let sent: Buffer | undefined
    const uploads: MobileObjectUploadRequest[] = []

    const result = await mutateWithMobileDirectUploads(fakeApi({
      vaultCipher: async () => cipher,
      mutate: async () => assert.fail('a large encrypted file never goes inline'),
      initiateUpload: async (_vaultId, body) => {
        initiated = body
        return androidUploadInstruction(mutation, SIGNED_URL, sealedLength)
      },
      completeUpload: async () => completion(mutation)
    }), 'vault-1', { mutations: [mutation] }, async (upload) => {
      uploads.push(upload)
      sent = files.get(upload.uri!)
    })

    assert.deepEqual(result.acknowledged.map((ack) => ack.revision), [3])
    assert.ok(initiated && sent)
    assert.equal(initiated.path, await cipher.pathId('assets/photo.png'))
    assert.equal(initiated.kind, 'binary')
    assert.deepEqual(initiated.content, {
      encoding: 'aes-gcm', sha256: sha256(sent), byte_length: sealedLength, media_type: 'application/octet-stream'
    })
    const meta = await decryptItemMeta(initiated.meta!, {
      vaultKey, vaultKeyVersion: 1, pathId: initiated.path, pathIndex: await CloudPathIndex.forVaultKey(vaultKey)
    })
    assert.deepEqual([meta.path, meta.kind, meta.sha256, meta.byte_length], ['assets/photo.png', 'binary', sha256(plaintext), plaintext.length])
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0]!.base64, undefined)
    assert.deepEqual([uploads[0]!.sha256, uploads[0]!.byteLength], [sha256(sent), sealedLength])
    const opened = await decryptZne1(sent, { parentKey: vaultKey, purpose: Zne1Purpose.content, keyVersion: 1 })
    assert.ok(Buffer.from(opened).equals(plaintext))
    assert.deepEqual(log, ['seal file:///vault/assets/photo.png', 'discard file:///vault/.zennotes/sync/uploads/0.zne1'])
  })

  it('decides inline or direct by the size an encrypted vault actually sends', async () => {
    const { cipher, vaultKey } = await encryptedVault()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES - 100, 3)
    assert.ok(zne1CiphertextLength(plaintext.length) > CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES)
    const mutation = { ...fileBackedMutation('assets/scan.pdf', plaintext), content: inlineContent(plaintext) }

    const inline: CloudSyncMutationRequest[] = []
    await mutateWithMobileDirectUploads(fakeApi({
      vaultCipher: async () => null,
      mutate: async (_vaultId, body) => { inline.push(body); return emptyResponse() }
    }), 'vault-1', { mutations: [mutation] }, async () => assert.fail('a readable vault sends this file inline'))
    assert.equal(inline.length, 1)

    let initiated: CloudSyncUploadRequest | undefined
    const uploads: MobileObjectUploadRequest[] = []
    await mutateWithMobileDirectUploads(fakeApi({
      vaultCipher: async () => cipher,
      mutate: async () => assert.fail('its ciphertext is over the inline cap'),
      initiateUpload: async (_vaultId, body) => {
        initiated = body
        return androidUploadInstruction(mutation, SIGNED_URL, zne1CiphertextLength(plaintext.length))
      },
      completeUpload: async () => completion(mutation)
    }), 'vault-1', { mutations: [mutation] }, async (upload) => { uploads.push(upload) })

    const sealed = Buffer.from(uploads[0]!.base64!, 'base64')
    assert.equal(sealed.length, zne1CiphertextLength(plaintext.length))
    assert.deepEqual([uploads[0]!.sha256, uploads[0]!.byteLength], [sha256(sealed), sealed.length])
    assert.equal(initiated?.content.sha256, sha256(sealed))
    const opened = await decryptZne1(sealed, { parentKey: vaultKey, purpose: Zne1Purpose.content, keyVersion: 1 })
    assert.ok(Buffer.from(opened).equals(plaintext))
  })

  it('refuses a file that changed after sync hashed it, before anything is sent', async () => {
    const { cipher } = await encryptedVault()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 9)
    const files = new Map([['file:///vault/big.bin', plaintext]])
    const log: string[] = []
    const mutation = fileBackedMutation('big.bin', plaintext)
    const edited = (bytes: Buffer) => Buffer.concat([bytes.subarray(1), Buffer.from([1])])
    rememberMobileUploadSource(mutation.content, 'file:///vault/big.bin', nativeSealer(files, log, 'file:///vault/big.bin', edited))

    await assert.rejects(
      mutateWithMobileDirectUploads(fakeApi({ vaultCipher: async () => cipher }), 'vault-1', { mutations: [mutation] },
        async () => assert.fail('nothing is uploaded')),
      (error: unknown) => error instanceof MobileDirectUploadError && error.code === 'DIRECT_UPLOAD_SIZE_MISMATCH'
    )
    assert.deepEqual(log, ['seal file:///vault/big.bin', 'discard file:///vault/.zennotes/sync/uploads/0.zne1'])
  })

  it('discards the sealed copy when the upload fails, and opens a conflict back to its real path', async () => {
    const { cipher } = await encryptedVault()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 5)
    const files = new Map([['file:///vault/big.bin', plaintext]])
    const log: string[] = []
    const aborted: string[] = []
    const mutation = fileBackedMutation('big.bin', plaintext)
    rememberMobileUploadSource(mutation.content, 'file:///vault/big.bin', nativeSealer(files, log, 'file:///vault/big.bin'))

    await assert.rejects(mutateWithMobileDirectUploads(fakeApi({
      vaultCipher: async () => cipher,
      initiateUpload: async () => androidUploadInstruction(mutation, SIGNED_URL, zne1CiphertextLength(plaintext.length)),
      abortUpload: async (_vaultId, uploadId) => { aborted.push(uploadId) }
    }), 'vault-1', { mutations: [mutation] }, async () => {
      throw new MobileDirectUploadError('Object upload failed.', 503, 'DIRECT_UPLOAD_FAILED')
    }), /Object upload failed/)
    assert.deepEqual(aborted, ['upload-1'])
    assert.deepEqual(log.at(-1), 'discard file:///vault/.zennotes/sync/uploads/0.zne1')

    const other = await cipher.sealMeta('Other.png', 'binary', mutation.content)
    const result = await mutateWithMobileDirectUploads(fakeApi({
      vaultCipher: async () => cipher,
      initiateUpload: async () => {
        throw new MobileDirectUploadError('Path taken.', 409, 'PATH_CONFLICT', {
          current_revision: 4, current_path: other.pathId, current_meta: other.meta
        })
      }
    }), 'vault-1', { mutations: [mutation] }, async () => assert.fail('a conflict uploads nothing'))
    assert.deepEqual(result.conflicts.map((conflict) => [conflict.code, conflict.current_path]), [['PATH_CONFLICT', 'Other.png']])
    assert.deepEqual(log.at(-1), 'discard file:///vault/.zennotes/sync/uploads/1.zne1')
  })

  it('stops a locked encrypted vault before anything is sent', async () => {
    const bytes = Buffer.from('a note')
    await assert.rejects(
      mutateWithMobileDirectUploads(fakeApi({
        vaultCipher: async () => { throw new CloudE2eeLockedError() },
        mutate: async () => assert.fail('nothing is sent while locked')
      }), 'vault-1', { mutations: [{ ...fileBackedMutation('note.md', bytes), content: inlineContent(bytes) }] },
      async () => assert.fail('nothing is uploaded while locked')),
      { code: 'E2EE_LOCKED' }
    )
  })
})

async function encryptedVault() {
  const accountKey = generateCloudE2eeKey()
  const encryption = await CloudVaultCipher.prepareVault('Notes', accountKey, 1)
  return {
    cipher: await CloudVaultCipher.open({ id: 'vault-1', encryption }, accountKey, 1),
    vaultKey: await unwrapVaultKey(encryption.vault_key_envelope, accountKey, 1, encryption.key_id)
  }
}

/** What ZenDirectUpload.encryptFile does on the device, from the same three inputs. */
function nativeSeal(plaintext: Buffer, params: { header: Uint8Array; objectKey: Uint8Array; aad: Uint8Array }): Buffer {
  const parts = [Buffer.from(params.header)]
  const chunks = Math.max(1, Math.ceil(plaintext.length / 65_536))
  for (let index = 0; index < chunks; index++) {
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(index, 7)
    nonce[11] = index === chunks - 1 ? 1 : 0
    const gcm = createCipheriv('aes-256-gcm', params.objectKey, nonce)
    gcm.setAAD(params.aad)
    parts.push(gcm.update(plaintext.subarray(index * 65_536, (index + 1) * 65_536)), gcm.final(), gcm.getAuthTag())
  }
  return Buffer.concat(parts)
}

/** Android's native sealer for the file at `uri`, over the package's base64 keys. */
function nativeSealer(files: Map<string, Buffer>, log: string[], uri: string, read = (bytes: Buffer) => bytes): MobileUploadSealer {
  let count = 0
  return async (keys) => {
    const plaintext = read(files.get(uri)!)
    const sealed = nativeSeal(plaintext, {
      header: Buffer.from(keys.header, 'base64'), objectKey: Buffer.from(keys.objectKey, 'base64'), aad: Buffer.from(keys.aad, 'base64')
    })
    const sealedUri = `file:///vault/.zennotes/sync/uploads/${count++}.zne1`
    files.set(sealedUri, sealed)
    log.push(`seal ${uri}`)
    return {
      uri: sealedUri, byteLength: sealed.length, sha256: sha256(sealed),
      plaintextByteLength: plaintext.length, plaintextSha256: sha256(plaintext),
      discard: async () => {
        log.push(`discard ${sealedUri}`)
        files.delete(sealedUri)
      }
    }
  }
}

function fileBackedMutation(path: string, bytes: Buffer): CloudSyncUpsertMutation {
  return {
    type: 'upsert', operation_id: 'operation-1', item_id: 'item-1', base_revision: null, path, kind: 'binary',
    content: { encoding: 'base64', data: '', sha256: sha256(bytes), byte_length: bytes.length, media_type: 'image/png' }
  }
}

function inlineContent(bytes: Buffer): CloudSyncUpsertMutation['content'] {
  return { encoding: 'base64', data: bytes.toString('base64'), sha256: sha256(bytes), byte_length: bytes.length, media_type: 'application/pdf' }
}

function completion(mutation: CloudSyncUpsertMutation) {
  return {
    data: {
      id: 'upload-1', operation_id: mutation.operation_id, status: 'completed' as const,
      result: { acknowledged: [{ operation_id: mutation.operation_id, item_id: mutation.item_id, revision: 3, sequence: 9 }], conflicts: [], cursor: 9 }
    }
  }
}

/** uploadInstruction with the byte count the service expects (the ciphertext's, for an encrypted vault). */
function androidUploadInstruction(mutation: CloudSyncUpsertMutation, url: string, expectedBytes = mutation.content.byte_length) {
  const instruction = uploadInstruction(mutation, url)
  return { data: { ...instruction.data, expected_bytes: expectedBytes } }
}
