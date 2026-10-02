import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { emptyCloudSyncState, reduceCloudSyncChange } from './cloud-sync-engine'
import {
  validateCloudSyncContentReference,
  validateCloudSyncDownloadInstruction,
  registerCloudSyncStagedFile,
  cloudSyncStagedHandle,
  releaseCloudSyncStagedFile
} from './cloud-sync-content'

const reference = {
  item_id: 'item',
  revision: 2,
  encoding: 'base64' as const,
  sha256: createHash('sha256').update('bytes').digest('hex'),
  byte_length: 5,
  media_type: 'application/octet-stream'
}

describe('Cloud content references', () => {
  it('reduces reference metadata without manufacturing content bytes', () => {
    const state = reduceCloudSyncChange(emptyCloudSyncState('vault'), {
      sequence: 1,
      item_id: 'item',
      revision: 2,
      type: 'upsert',
      path: 'file.bin',
      previous_path: null,
      content_ref: reference
    })
    expect(state.cursor).toBe(1)
    expect(state.items.item).toMatchObject({
      sha256: reference.sha256,
      byte_length: 5,
      revision: 2
    })
    expect(state.items.item).not.toHaveProperty('content')
  })

  it('accepts an older immutable upsert reference only when its metadata matches the requested state', () => {
    expect(validateCloudSyncContentReference(reference, { ...reference, revision: 3 })).toEqual(
      reference
    )
    expect(() =>
      validateCloudSyncContentReference({ ...reference, revision: 4 }, reference)
    ).toThrow()
    expect(() =>
      validateCloudSyncContentReference({ ...reference, sha256: '0'.repeat(64) }, reference)
    ).toThrow()
  })

  it.each([
    { data: '' },
    { handle: '/private/file' },
    { source: 'file' },
    { revision: 0 },
    { byte_length: -1 }
  ])('rejects malformed refs and remote native handles: %j', (patch) => {
    expect(() => validateCloudSyncContentReference({ ...reference, ...patch })).toThrow()
  })

  it('validates download identity and prevents bearer forwarding or redirects to insecure URLs', () => {
    const instruction = {
      data: {
        item_id: 'item',
        revision: 2,
        content: {
          encoding: reference.encoding,
          sha256: reference.sha256,
          byte_length: 5,
          media_type: reference.media_type
        },
        download: {
          method: 'GET',
          url: 'https://objects.example.test/signed',
          headers: {},
          expires_at: '2026-10-01T12:00:00Z'
        }
      }
    }
    expect(validateCloudSyncDownloadInstruction(instruction, reference)).toEqual(instruction.data)
    expect(() =>
      validateCloudSyncDownloadInstruction(
        { data: { ...instruction.data, revision: 3 } },
        reference
      )
    ).toThrow()
    expect(() =>
      validateCloudSyncDownloadInstruction(
        {
          data: {
            ...instruction.data,
            download: { ...instruction.data.download, headers: { Authorization: 'Bearer secret' } }
          }
        },
        reference
      )
    ).toThrow()
    expect(() =>
      validateCloudSyncDownloadInstruction(
        {
          data: {
            ...instruction.data,
            download: { ...instruction.data.download, url: 'http://public.example.test/file' }
          }
        },
        reference
      )
    ).toThrow()
  })

  it('accepts only locally registered staging tokens and disposes them exactly once', async () => {
    const discard = vi.fn(async () => {})
    const handle = { privatePath: '/private/staging' }
    const staged = registerCloudSyncStagedFile(reference, handle, discard)
    expect(cloudSyncStagedHandle(staged, reference)).toBe(handle)
    expect(() => cloudSyncStagedHandle(JSON.parse(JSON.stringify(staged)), reference)).toThrow()
    await releaseCloudSyncStagedFile(staged)
    await releaseCloudSyncStagedFile(staged)
    expect(discard).toHaveBeenCalledOnce()
    expect(() => cloudSyncStagedHandle(staged, reference)).toThrow()
  })
})
