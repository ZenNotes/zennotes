import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'vitest'
import type { MobileObjectUploadRequest } from './mobile-direct-upload'
import { mobilePublishAssetPlatform } from './mobile-publish-assets'

const asset = { ref: 'photo.png', name: 'photo.png', mime: 'image/png', path: 'attachements/photo.png' }
const target = { ref: 'photo.png', method: 'PUT' as const, url: 'https://objects.example.test/shares/abc/photo.png?sig=1', headers: { Host: 'objects.example.test' } }

describe('mobilePublishAssetPlatform', () => {
  it('stages an on-device file natively: fingerprint, then a file-backed PUT with its type', async () => {
    const uploads: MobileObjectUploadRequest[] = []
    const platform = mobilePublishAssetPlatform({
      fingerprint: async (path) => {
        assert.equal(path, 'attachements/photo.png')
        return { uri: 'file:///vault/attachements/photo.png', sha256: 'a'.repeat(64), byteLength: 1234 }
      },
      readBase64: async () => assert.fail('an on-device file is not read into JavaScript')
    }, async (request) => { uploads.push(request) })

    const described = await platform.describe(asset)
    assert.deepEqual(described, { byteLength: 1234, sha256: 'a'.repeat(64), handle: { uri: 'file:///vault/attachements/photo.png' } })

    await platform.upload(target, { ...asset, ...described })
    assert.deepEqual(uploads, [{
      url: target.url,
      method: 'PUT',
      headers: { Host: 'objects.example.test', 'Content-Type': 'image/png' },
      byteLength: 1234,
      uri: 'file:///vault/attachements/photo.png',
      sha256: 'a'.repeat(64)
    }])
  })

  it('hashes a remote vault file in JavaScript and uploads its bytes', async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5])
    const uploads: MobileObjectUploadRequest[] = []
    const platform = mobilePublishAssetPlatform({
      fingerprint: async () => null,
      readBase64: async () => bytes.toString('base64')
    }, async (request) => { uploads.push(request) })

    const described = await platform.describe(asset)
    assert.equal(described.byteLength, 5)
    assert.equal(described.sha256, createHash('sha256').update(bytes).digest('hex'))

    await platform.upload({ ...target, headers: { Host: 'objects.example.test', 'content-type': 'image/png' } }, { ...asset, ...described })
    assert.equal(uploads[0]?.base64, bytes.toString('base64'))
    assert.deepEqual(uploads[0]?.headers, { Host: 'objects.example.test', 'content-type': 'image/png' })
    assert.equal(await platform.readBase64(asset), bytes.toString('base64'))
  })

  it('refuses an insecure upload URL before sending anything', async () => {
    let sent = false
    const platform = mobilePublishAssetPlatform({
      fingerprint: async () => ({ uri: 'file:///vault/a.png', sha256: 'b'.repeat(64), byteLength: 1 }),
      readBase64: async () => ''
    }, async () => { sent = true })

    await assert.rejects(platform.upload({ ...target, url: 'http://objects.example.test/x' }, { ...asset, byteLength: 1, sha256: 'b'.repeat(64), handle: { uri: 'file:///vault/a.png' } }))
    assert.equal(sent, false)
  })
})
