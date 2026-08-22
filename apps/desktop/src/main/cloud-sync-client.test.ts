import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CloudSyncUpsertMutation } from '@zennotes/bridge-contract/cloud-sync'
import { CloudServiceRequestError, createCloudSyncClient } from './cloud-sync-client'
import { rememberCloudSyncUploadSource } from './cloud-sync-upload-source'

const INLINE_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('createCloudSyncClient', () => {
  it('authenticates requests without exposing the token in the URL', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const client = createCloudSyncClient(
      'https://zennotes.org/',
      'secret-token',
      fetchImplementation
    )

    await client.listVaults()

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://zennotes.org/api/v1/vaults',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token'
        })
      })
    )
    expect(fetchImplementation.mock.calls[0]?.[0]).not.toContain('secret-token')
  })

  it('preserves stable backend error codes', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'FEATURE_NOT_ENTITLED', message: 'Upgrade required.' }
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await expect(client.listVaults()).rejects.toEqual(
      expect.objectContaining<Partial<CloudServiceRequestError>>({
        status: 403,
        code: 'FEATURE_NOT_ENTITLED',
        message: 'Upgrade required.'
      })
    )
  })

  it('surfaces Laravel validation messages', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: 'The mutations.0.path field is required.',
          errors: {
            'mutations.0.path': ['The mutations.0.path field is required.']
          }
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await expect(client.mutate('vault-1', { mutations: [] })).rejects.toEqual(
      expect.objectContaining<Partial<CloudServiceRequestError>>({
        status: 422,
        code: null,
        message: 'The mutations.0.path field is required.'
      })
    )
  })

  it('surfaces field details from the cloud API validation envelope', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The request data is invalid.'
          },
          errors: {
            markdown: ['The markdown field must be present.']
          }
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await expect(
      client.publishNote({
        note_path: 'Empty.md',
        title: 'Empty',
        markdown: ''
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<CloudServiceRequestError>>({
        status: 422,
        code: 'VALIDATION_FAILED',
        message: 'The markdown field must be present.'
      })
    )
  })

  it('lets fetch set the multipart boundary for published-note assets', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 42,
          slug: 'photo',
          url: 'https://zennotes.org/s/photo'
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    )
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await client.publishNote({
      note_path: 'Photo.md',
      title: 'Photo',
      markdown: '![Photo](photo.png)',
      assets: [
        {
          ref: 'photo.png',
          name: 'photo.png',
          mime: 'image/png',
          base64: 'AQID'
        }
      ]
    })

    const options = fetchImplementation.mock.calls[0]?.[1]
    expect(options?.body).toBeInstanceOf(FormData)
    expect(new Headers(options?.headers).has('Content-Type')).toBe(false)
  })

  it('keeps files at the inline limit in the mutation request', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ acknowledged: [], conflicts: [], cursor: 0 }))
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await client.mutate('vault-1', {
      mutations: [upsertMutation(INLINE_UPLOAD_LIMIT_BYTES, 'inline')]
    })

    expect(fetchImplementation).toHaveBeenCalledTimes(1)
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      'https://zennotes.org/api/v1/vaults/vault-1/mutations'
    )
  })

  it('uploads files above the inline limit directly without sending the bearer token', async () => {
    const bytes = Buffer.alloc(INLINE_UPLOAD_LIMIT_BYTES + 1, 7)
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zennotes-direct-upload-'))
    temporaryDirectories.push(directory)
    const sourcePath = path.join(directory, 'archive.zip')
    await writeFile(sourcePath, bytes)
    const mutation = upsertMutation(bytes.byteLength, '')
    rememberCloudSyncUploadSource(mutation.content, sourcePath)
    const acknowledgement = {
      operation_id: mutation.operation_id,
      item_id: mutation.item_id,
      revision: 3,
      sequence: 9
    }
    const uploadedBodies: Buffer[] = []
    let completionAttempts = 0
    const fetchImplementation = vi.fn<typeof fetch>(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/uploads')) {
        return jsonResponse(
          {
            data: {
              id: 'upload-1',
              operation_id: mutation.operation_id,
              status: 'uploading',
              expected_bytes: bytes.byteLength,
              expires_at: '2026-08-19T18:30:00.000Z',
              upload: {
                method: 'PUT',
                url: 'https://objects.example.test/upload-1?signature=signed',
                headers: {
                  'Content-Length': String(bytes.byteLength),
                  'Content-Type': 'application/octet-stream',
                  'X-Upload-Header': 'signed-value'
                }
              }
            }
          },
          201
        )
      }
      if (url.startsWith('https://objects.example.test/')) {
        uploadedBodies.push(Buffer.from(await new Response(options?.body).arrayBuffer()))
        return new Response(null, { status: 200 })
      }
      if (url.endsWith('/complete')) {
        completionAttempts++
        if (completionAttempts === 1) {
          return jsonResponse(
            {
              error: { code: 'TEMPORARY_FAILURE', message: 'Try again.' }
            },
            503
          )
        }
        return jsonResponse({
          data: {
            id: 'upload-1',
            operation_id: mutation.operation_id,
            status: 'completed',
            result: {
              acknowledged: [acknowledgement],
              conflicts: [],
              cursor: 9
            }
          }
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createCloudSyncClient(
      'https://zennotes.org/',
      'secret-token',
      fetchImplementation
    )

    const result = await client.mutate('vault-1', { mutations: [mutation] })

    expect(result).toEqual({
      acknowledged: [acknowledgement],
      conflicts: [],
      cursor: 9
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(4)
    expect(completionAttempts).toBe(2)

    const initiation = fetchImplementation.mock.calls[0]
    expect(initiation?.[0]).toBe('https://zennotes.org/api/v1/vaults/vault-1/uploads')
    expect(JSON.parse(String(initiation?.[1]?.body))).toEqual({
      operation_id: mutation.operation_id,
      item_id: mutation.item_id,
      base_revision: mutation.base_revision,
      path: mutation.path,
      kind: mutation.kind,
      content: {
        encoding: mutation.content.encoding,
        sha256: mutation.content.sha256,
        byte_length: mutation.content.byte_length,
        media_type: mutation.content.media_type
      }
    })

    const directUpload = fetchImplementation.mock.calls[1]
    expect(directUpload?.[0]).toBe('https://objects.example.test/upload-1?signature=signed')
    expect(directUpload?.[1]?.method).toBe('PUT')
    expect(directUpload?.[1]?.redirect).toBe('error')
    expect(new Headers(directUpload?.[1]?.headers)).toEqual(
      new Headers({
        'Content-Length': String(bytes.byteLength),
        'Content-Type': 'application/octet-stream',
        'X-Upload-Header': 'signed-value'
      })
    )
    expect(new Headers(directUpload?.[1]?.headers).has('Authorization')).toBe(false)
    expect(uploadedBodies[0]?.byteLength).toBe(bytes.byteLength)
    expect(uploadedBodies[0]?.[0]).toBe(7)
    expect(uploadedBodies[0]?.at(-1)).toBe(7)

    const completion = fetchImplementation.mock.calls[3]
    expect(completion?.[0]).toBe(
      'https://zennotes.org/api/v1/vaults/vault-1/uploads/upload-1/complete'
    )
    expect(new Headers(completion?.[1]?.headers).get('Authorization')).toBe('Bearer secret-token')
  })

  it('aborts the upload reservation when object storage rejects the PUT', async () => {
    const bytes = Buffer.alloc(INLINE_UPLOAD_LIMIT_BYTES + 1, 11)
    const mutation = upsertMutation(bytes.byteLength, bytes.toString('base64'))
    const fetchImplementation = vi.fn<typeof fetch>(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/uploads') && options?.method === 'POST') {
        return jsonResponse(
          {
            data: {
              id: 'upload-2',
              operation_id: mutation.operation_id,
              status: 'uploading',
              expected_bytes: bytes.byteLength,
              expires_at: '2026-08-19T18:30:00.000Z',
              upload: {
                method: 'PUT',
                url: 'https://objects.example.test/upload-2',
                headers: { 'Content-Type': 'application/octet-stream' }
              }
            }
          },
          201
        )
      }
      if (url === 'https://objects.example.test/upload-2') {
        return new Response(null, { status: 503 })
      }
      if (url.endsWith('/uploads/upload-2') && options?.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await expect(client.mutate('vault-1', { mutations: [mutation] })).rejects.toEqual(
      expect.objectContaining<Partial<CloudServiceRequestError>>({
        status: 503,
        code: 'DIRECT_UPLOAD_FAILED'
      })
    )

    expect(fetchImplementation.mock.calls.at(-1)?.[0]).toBe(
      'https://zennotes.org/api/v1/vaults/vault-1/uploads/upload-2'
    )
    expect(fetchImplementation.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
  })

  it('rejects insecure non-local upload URLs and releases the reservation', async () => {
    const bytes = Buffer.alloc(INLINE_UPLOAD_LIMIT_BYTES + 1, 12)
    const mutation = upsertMutation(bytes.byteLength, bytes.toString('base64'))
    const fetchImplementation = vi.fn<typeof fetch>(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/uploads') && options?.method === 'POST') {
        return jsonResponse(
          {
            data: {
              id: 'upload-insecure',
              operation_id: mutation.operation_id,
              status: 'uploading',
              expected_bytes: bytes.byteLength,
              expires_at: '2026-08-19T18:30:00.000Z',
              upload: {
                method: 'PUT',
                url: 'http://objects.example.test/upload-insecure',
                headers: { 'Content-Type': 'application/octet-stream' }
              }
            }
          },
          201
        )
      }
      if (url.endsWith('/uploads/upload-insecure') && options?.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await expect(client.mutate('vault-1', { mutations: [mutation] })).rejects.toEqual(
      expect.objectContaining<Partial<CloudServiceRequestError>>({
        status: 0,
        code: 'INSECURE_DIRECT_UPLOAD_URL'
      })
    )

    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(fetchImplementation.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
  })

  it('rejects mismatched upload instructions before sending file contents', async () => {
    const bytes = Buffer.alloc(INLINE_UPLOAD_LIMIT_BYTES + 1, 14)
    const mutation = upsertMutation(bytes.byteLength, bytes.toString('base64'))
    const fetchImplementation = vi.fn<typeof fetch>(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/uploads') && options?.method === 'POST') {
        return jsonResponse(
          {
            data: {
              id: 'upload-mismatch',
              operation_id: mutation.operation_id,
              status: 'uploading',
              expected_bytes: bytes.byteLength - 1,
              expires_at: '2026-08-19T18:30:00.000Z',
              upload: {
                method: 'PUT',
                url: 'https://objects.example.test/upload-mismatch',
                headers: { 'Content-Type': 'application/octet-stream' }
              }
            }
          },
          201
        )
      }
      if (url.endsWith('/uploads/upload-mismatch') && options?.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await expect(client.mutate('vault-1', { mutations: [mutation] })).rejects.toEqual(
      expect.objectContaining<Partial<CloudServiceRequestError>>({
        status: 0,
        code: 'INVALID_DIRECT_UPLOAD_RESPONSE'
      })
    )

    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(fetchImplementation.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
  })

  it('returns direct-upload initiation conflicts through the normal sync response', async () => {
    const bytes = Buffer.alloc(INLINE_UPLOAD_LIMIT_BYTES + 1, 13)
    const mutation = upsertMutation(bytes.byteLength, bytes.toString('base64'))
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/uploads')) {
        return jsonResponse(
          {
            error: {
              code: 'REVISION_CONFLICT',
              message: 'The item changed before the upload could start.',
              details: {
                current_revision: 4,
                current_path: 'attachments/archive.zip'
              }
            }
          },
          409
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await expect(client.mutate('vault-1', { mutations: [mutation] })).resolves.toEqual({
      acknowledged: [],
      conflicts: [
        {
          operation_id: mutation.operation_id,
          item_id: mutation.item_id,
          code: 'REVISION_CONFLICT',
          current_revision: 4,
          current_path: 'attachments/archive.zip'
        }
      ],
      cursor: 0
    })
  })

  it('preserves structured capacity details from a direct-upload conflict', async () => {
    const bytes = Buffer.alloc(INLINE_UPLOAD_LIMIT_BYTES + 1, 15)
    const mutation = upsertMutation(bytes.byteLength, bytes.toString('base64'))
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/uploads')) {
        return jsonResponse(
          {
            error: {
              code: 'CAPACITY_EXCEEDED',
              message: 'This upload would exceed the current Cloud capacity.',
              details: {
                dimension: 'sync_active_items',
                used: 100,
                reserved: 0,
                limit: 100,
                projected: 101,
                can_retry_after_reduction: true
              }
            }
          },
          409
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await expect(client.mutate('vault-1', { mutations: [mutation] })).resolves.toEqual({
      acknowledged: [],
      conflicts: [
        {
          operation_id: mutation.operation_id,
          item_id: mutation.item_id,
          code: 'CAPACITY_EXCEEDED',
          current_revision: null,
          current_path: null,
          capacity: {
            dimension: 'sync_active_items',
            used: 100,
            reserved: 0,
            limit: 100,
            projected: 101,
            can_retry_after_reduction: true
          }
        }
      ],
      cursor: 0
    })
  })
})

function upsertMutation(byteLength: number, data: string): CloudSyncUpsertMutation {
  return {
    type: 'upsert',
    operation_id: '4b66f4b4-08f9-4e5a-a300-686ed4ef7e92',
    item_id: '9b0ff39e-7ace-4fae-82aa-9f80a7458543',
    base_revision: 2,
    path: 'attachments/archive.zip',
    kind: 'binary',
    content: {
      encoding: 'base64',
      data,
      sha256: 'a'.repeat(64),
      byte_length: byteLength,
      media_type: 'application/octet-stream'
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
