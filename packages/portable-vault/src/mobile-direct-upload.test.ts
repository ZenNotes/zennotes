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
import { generateCloudE2eeKey, zne1CiphertextLength } from '@zennotes/shared-domain/cloud-e2ee'
import { CloudE2eeLockedError, CloudVaultCipher } from '@zennotes/shared-domain/cloud-e2ee-vault'
import { CloudSyncPathRefusedError } from '@zennotes/shared-domain/cloud-sync-refusal'
import {
  CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES,
  MobileDirectUploadError,
  mobileObjectUploadOptions,
  mutateWithMobileDirectUploads,
  rememberMobileUploadSource,
  type MobileDirectUploadApi,
  type MobileObjectUpload,
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
