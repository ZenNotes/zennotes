/**
 * An encrypted vault's stub (cloud-sync-stubs.ts): the download is ciphertext,
 * checked against what the stub records of it, opened by the host's chunk loop
 * with keys the real CloudVaultCipher derives, and placed only as plaintext
 * matching the stub's own hash.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'vitest'
import {
  ZNE1_HEADER_BYTES,
  ZNE1_SEALED_CHUNK_BYTES,
  createZne1ChunkDecryptor,
  fromBase64,
  generateCloudE2eeKey,
  toBase64
} from '@zennotes/shared-domain/cloud-e2ee'
import { CloudVaultCipher } from '@zennotes/shared-domain/cloud-e2ee-vault'
import { hydrateCloudStub, type CloudStubDownloads, type CloudStubFiles, type CloudStubRecord } from './cloud-sync-stubs'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function bytesOf(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 13 + seed) & 0xff
  return bytes
}

async function sealedVault() {
  const accountKey = generateCloudE2eeKey()
  const vault = { id: 'vault-1', encryption: await CloudVaultCipher.prepareVault('Journal', accountKey, 1) }
  return CloudVaultCipher.open(vault, accountKey, 1)
}

class Folder implements CloudStubFiles {
  readonly files = new Map<string, Uint8Array>()
  readonly stubs = new Map<string, CloudStubRecord>()
  readonly downloads: Array<{ to: string; byteLength: number; sha256: string }> = []
  constructor(readonly object: Uint8Array) {}

  async readCloudStub(path: string): Promise<CloudStubRecord | null> {
    return this.stubs.get(path) ?? null
  }

  async download(options: { url: string; to: string; byteLength: number; sha256: string }): Promise<void> {
    this.downloads.push({ to: options.to, byteLength: options.byteLength, sha256: options.sha256 })
    if (this.object.byteLength !== options.byteLength || sha256(this.object) !== options.sha256) throw new Error('bad download')
    this.files.set(options.to, this.object)
  }

  async readHeader(path: string, length: number): Promise<string> {
    return toBase64(this.files.get(path)!.subarray(0, length))
  }

  async decryptFile(options: { from: string; to: string; header: string; objectKey: string; aad: string }) {
    const loop = await createZne1ChunkDecryptor({
      header: fromBase64(options.header), objectKey: fromBase64(options.objectKey), aad: fromBase64(options.aad)
    })
    const sealed = this.files.get(options.from)!
    const parts: number[] = []
    for (let at = ZNE1_HEADER_BYTES; at < sealed.byteLength; at += ZNE1_SEALED_CHUNK_BYTES) {
      const end = Math.min(at + ZNE1_SEALED_CHUNK_BYTES, sealed.byteLength)
      parts.push(...(await loop.decryptChunk(sealed.subarray(at, end), end === sealed.byteLength)))
    }
    const plain = Uint8Array.from(parts)
    this.files.set(options.to, plain)
    return { byteLength: plain.byteLength, sha256: sha256(plain) }
  }

  async replaceCloudStub(from: string, to: string): Promise<boolean> {
    if (!this.stubs.delete(to)) return false
    this.files.set(to, this.files.get(from)!)
    this.files.delete(from)
    return true
  }

  async mkdir(): Promise<void> {}

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path)
  }

  async statVerified(path: string): Promise<'file' | null> {
    return this.files.has(path) ? 'file' : null
  }

  staged(): string[] {
    return [...this.files.keys()].filter((path) => path.startsWith('.zennotes/'))
  }
}

async function sealedFile(cipher: CloudVaultCipher, plain: Uint8Array) {
  const content = await cipher.sealContent({
    encoding: 'base64', data: Buffer.from(plain).toString('base64'), sha256: sha256(plain), byte_length: plain.byteLength, media_type: 'image/png'
  })
  return { object: new Uint8Array(Buffer.from(content.data, 'base64')), encrypted: { sha256: content.sha256, byte_length: content.byte_length } }
}

function downloads(cipher: CloudVaultCipher | undefined, encrypted: { sha256: string; byte_length: number }): CloudStubDownloads {
  return {
    vaultId: 'vault-1',
    ...(cipher ? { decryptor: cipher } : {}),
    download: async () => ({
      data: {
        item_id: 'item-1',
        revision: 2,
        content: { encoding: 'aes-gcm', sha256: encrypted.sha256, byte_length: encrypted.byte_length, media_type: 'application/octet-stream' },
        download: { method: 'GET', url: 'https://bucket.example.test/o', headers: {}, expires_at: new Date(Date.now() + 600_000).toISOString() }
      }
    })
  }
}

function stubFor(plain: Uint8Array, encrypted: { sha256: string; byte_length: number }): CloudStubRecord {
  return { format: 1, item_id: 'item-1', revision: 2, sha256: sha256(plain), byte_length: plain.byteLength, media_type: 'image/png', encrypted }
}

describe('hydrating a stub of an encrypted vault', () => {
  it('checks the ciphertext, opens it and places the plaintext where the stub was', async () => {
    const cipher = await sealedVault()
    const plain = bytesOf(200_000, 5)
    const { object, encrypted } = await sealedFile(cipher, plain)
    const folder = new Folder(object)
    folder.stubs.set('assets/photo.png', stubFor(plain, encrypted))
    assert.equal(await hydrateCloudStub(folder, downloads(cipher, encrypted), 'assets/photo.png'), true)
    assert.equal(sha256(folder.files.get('assets/photo.png')!), sha256(plain))
    // Checked against the stored ciphertext, never the plaintext's own hash.
    assert.equal(folder.downloads[0]!.sha256, encrypted.sha256)
    assert.equal(folder.downloads[0]!.byteLength, encrypted.byte_length)
    assert.deepEqual(folder.staged(), [])
  })

  it('refuses before downloading when it has no key', async () => {
    const cipher = await sealedVault()
    const plain = bytesOf(1000, 6)
    const { object, encrypted } = await sealedFile(cipher, plain)
    const folder = new Folder(object)
    folder.stubs.set('photo.png', stubFor(plain, encrypted))
    await assert.rejects(hydrateCloudStub(folder, downloads(undefined, encrypted), 'photo.png'), /no key/)
    assert.equal(folder.downloads.length, 0)
    assert.ok(folder.stubs.has('photo.png'))
  })

  it('keeps the stub when the plaintext is not the file its metadata names', async () => {
    const cipher = await sealedVault()
    const plain = bytesOf(1000, 7)
    const { object, encrypted } = await sealedFile(cipher, plain)
    const folder = new Folder(object)
    const other = bytesOf(1000, 8)
    const stub = stubFor(other, encrypted)
    folder.stubs.set('photo.png', stub)
    await assert.rejects(hydrateCloudStub(folder, downloads(cipher, encrypted), 'photo.png'), /not the file/)
    assert.deepEqual(folder.stubs.get('photo.png'), stub)
    assert.equal(folder.files.has('photo.png'), false)
    assert.deepEqual(folder.staged(), [])
  })

  it('refuses a file sealed with another vault’s key', async () => {
    const cipher = await sealedVault()
    const plain = bytesOf(1000, 9)
    const { object, encrypted } = await sealedFile(await sealedVault(), plain)
    const folder = new Folder(object)
    folder.stubs.set('photo.png', stubFor(plain, encrypted))
    await assert.rejects(hydrateCloudStub(folder, downloads(cipher, encrypted), 'photo.png'), (error: { code?: string }) => error.code === 'wrong-key')
    assert.deepEqual(folder.staged(), [])
  })
})
