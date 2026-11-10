import assert from 'node:assert/strict'
import { createDecipheriv, createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import type { CloudSyncContentReference } from '@zennotes/bridge-contract/cloud-sync'
import { generateCloudE2eeKey } from '@zennotes/shared-domain/cloud-e2ee'
import { CloudVaultCipher } from '@zennotes/shared-domain/cloud-e2ee-vault'
// One module instance: the staging token registry is a module-private WeakMap,
// so the helper that reads a handle must share the module instance that wrote
// it (this import resolves to the same file cloud-sync-staging imports).
import { cloudSyncStagedHandle, type CloudSyncDownloadSource } from '@zennotes/shared-domain/cloud-sync-content'
import { NativeCloudStaging } from './cloud-sync-staging'

type StagedHandle = { owner: object; path: string }

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** In-memory vault with a fake native downloader; bytes never pass through JS strings. */
function harness(initial: Record<string, Buffer> = {}) {
  const files = new Map(Object.entries(initial))
  const objects = new Map<string, Buffer>()
  const log: string[] = []
  const native = {
    async statVerified(path: string) { return files.has(path) ? 'file' as const : null },
    async readForSync(path: string) {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`missing ${path}`)
      let utf8 = true
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { utf8 = false }
      return { uri: `file:///${path}`, sha256: hash(bytes), byteLength: bytes.length, utf8 }
    },
    async download(options: { url: string; to: string; byteLength: number; sha256: string }) {
      log.push(`download ${options.url}`)
      const bytes = objects.get(options.url)
      if (!bytes) throw Object.assign(new Error('not found'), { status: 404 })
      if (bytes.length !== options.byteLength || hash(bytes) !== options.sha256) throw new Error('verification failed')
      files.set(options.to, bytes)
    },
    async copyForSync(from: string, to: string) {
      log.push(`copy ${from} -> ${to}`)
      files.set(to, Buffer.from(files.get(from)!))
    },
    async rename(from: string, to: string) {
      log.push(`rename ${from} -> ${to}`)
      const bytes = files.get(from)
      if (!bytes) throw new Error(`rename missing ${from}`)
      files.set(to, bytes)
      files.delete(from)
    },
    async deleteFile(path: string) { files.delete(path) },
    async mkdir() {},
    async readText(path: string) { return files.get(path)!.toString('utf8') }
  }
  const staging = new NativeCloudStaging(native, (path: string) => path.endsWith('.md'), async (path: string) => {
    const bytes = files.get(path)!
    return { path, kind: 'text', content: { encoding: 'utf8', data: bytes.toString('utf8'),
      sha256: hash(bytes), byte_length: bytes.length, media_type: 'text/markdown' } }
  })
  const reference = (itemId: string, revision: number, bytes: Buffer, encoding: 'utf8' | 'base64' = 'base64'): CloudSyncContentReference => ({
    item_id: itemId, revision, encoding, sha256: hash(bytes), byte_length: bytes.length, media_type: 'application/octet-stream'
  })
  const source = (ref: any, url: string): CloudSyncDownloadSource => ({
    reference: ref, previewLimitBytes: 262_144, allowInsecureLoopback: false,
    getInstruction: async () => ({ item_id: ref.item_id, revision: ref.revision,
      content: { encoding: ref.encoding, sha256: ref.sha256, byte_length: ref.byte_length, media_type: ref.media_type },
      download: { url, method: 'GET', headers: {}, expires_at: new Date(Date.now() + 300_000).toISOString() } })
  })
  return { files, objects, log, staging, reference, source, native }
}

describe('native Cloud staging', () => {
  for (const failure of ['copy', 'publish', 'restore', 'cancel'] as const) {
    it(`preserves the original and cleans partial writes after ${failure} failure`, async () => {
      const local = Buffer.from('local')
      const h = harness({ 'note.md': local })
      const cloud = Buffer.from('cloud')
      const ref = h.reference('item', 2, cloud, 'utf8')
      const url = 'https://objects.example.test/item/2'
      h.objects.set(url, cloud)
      const controller = new AbortController()
      const file = await h.staging.stage({ ...h.source(ref, url), signal: controller.signal })
      const rename = h.native.rename
      if (failure === 'copy') h.native.copyForSync = async (_from, to) => {
        h.files.set(to, Buffer.from('partial'))
        throw new Error('copy failed')
      }
      if (failure === 'publish' || failure === 'restore') h.native.rename = async (from, to) => {
        if (failure === 'restore' && from.startsWith('.zennotes/sync/rollback-')) throw new Error('restore failed')
        await rename(from, to)
        if (from.startsWith('.zennotes/sync/downloads/')) {
          h.files.set(to, Buffer.from('corrupt'))
          if (failure === 'restore') throw new Error('publish failed')
        }
      }
      if (failure === 'cancel') controller.abort()
      await assert.rejects(h.staging.resolve({
        expected_path: 'note.md', expected_sha256: hash(local), cloud_path: 'note.md', file,
        ...(failure === 'copy' ? { keep_both_path: 'local.md' } : {})
      }))
      assert.equal(h.files.has('local.md'), false)
      if (failure === 'restore') {
        const recovery = [...h.files.keys()].find((path) => /^\.zennotes\/sync\/rollback-[^/]+$/.test(path))
        assert.ok(recovery, 'stranded original must be visible to the scan recovery guard')
        assert.deepEqual(h.files.get(recovery), local)
      } else {
        assert.deepEqual(h.files.get('note.md'), local)
      }
    })
  }

  it('removes a newly created destination when native rename partially publishes then rejects', async () => {
    const h = harness()
    const bytes = Buffer.from('cloud')
    const ref = h.reference('item', 1, bytes)
    const url = 'https://objects.example.test/item/1'
    h.objects.set(url, bytes)
    const file = await h.staging.stage(h.source(ref, url))
    h.native.rename = async (_from, to) => {
      h.files.set(to, Buffer.from('partial'))
      throw new Error('rename failed')
    }
    await assert.rejects(h.staging.apply({ sequence: 1, item_id: 'item', type: 'upsert',
      path: 'new.bin', previous_path: null, revision: 1, content_ref: ref }, undefined, file))
    assert.equal(h.files.has('new.bin'), false)
  })

  for (const failure of ['publish', 'edited-copy', 'rollback'] as const) {
    it(`keeps a failed keep-both resolution safe and retryable after ${failure}`, async () => {
      const local = Buffer.from('local')
      const cloud = Buffer.from('cloud')
      const h = harness({ 'note.md': local })
      const ref = h.reference('item', 2, cloud, 'utf8')
      const url = 'https://objects.example.test/item/2'
      h.objects.set(url, cloud)
      const file = await h.staging.stage(h.source(ref, url))
      const rename = h.native.rename
      h.native.rename = async (from, to) => {
        if (from.startsWith('.zennotes/sync/downloads/') && to === 'note.md') {
          if (failure === 'edited-copy') h.files.set('local.md', Buffer.from('later user edit'))
          throw new Error('disk full')
        }
        if (failure === 'rollback' && from.startsWith('.zennotes/sync/rollback-')) throw new Error('rollback failed')
        await rename(from, to)
      }
      const input = { expected_path: 'note.md', expected_sha256: hash(local), cloud_path: 'note.md', file, keep_both_path: 'local.md' }
      await assert.rejects(h.staging.resolve(input))
      if (failure === 'publish') {
        assert.deepEqual(h.files.get('note.md'), local)
        assert.equal(h.files.has('local.md'), false, 'the unfinished decision must not block its own retry')
        h.native.rename = rename
        await h.staging.resolve(input)
        assert.deepEqual(h.files.get('note.md'), cloud)
        assert.deepEqual(h.files.get('local.md'), local)
      } else {
        assert.deepEqual(h.files.get('local.md'), failure === 'edited-copy' ? Buffer.from('later user edit') : local)
      }
    })
  }

  it('refreshes an expired signed URL reported as a native Capacitor rejection', async () => {
    const h = harness()
    const bytes = Buffer.from('cloud')
    const ref = h.reference('item', 1, bytes)
    const url = 'https://objects.example.test/item/1'
    h.objects.set(url, bytes)
    const download = h.native.download
    let attempts = 0
    h.native.download = async (options) => {
      if (++attempts === 1) {
        h.files.set(options.to, Buffer.from('partial'))
        throw Object.assign(new Error('expired'), { data: { status: 403 } })
      }
      assert.equal(h.files.has(options.to), false)
      await download(options)
    }
    await h.staging.stage(h.source(ref, url))
    assert.equal(attempts, 2)
  })

  it('downloads into staging, verifies, then publishes atomically', async () => {
    const h = harness()
    const bytes = Buffer.alloc(6_000_000, 42)
    const ref = h.reference('item', 3, bytes)
    h.objects.set('https://objects.example.test/item/3', bytes)
    const file = await h.staging.stage(h.source(ref, 'https://objects.example.test/item/3'))
    assert.equal(cloudSyncStagedHandle<StagedHandle>(file).owner, h.staging)
    const staged = [...h.files.keys()].find((path) => path.startsWith('.zennotes/sync/downloads/'))!
    assert.ok(staged, 'file staged in vault-private directory')
    const conflict = await h.staging.apply(
      { sequence: 9, item_id: 'item', type: 'upsert', path: 'attachements/big.bin', previous_path: null, revision: 3, content_ref: ref },
      undefined, file
    )
    assert.equal(conflict, undefined)
    assert.deepEqual(h.files.get('attachements/big.bin'), bytes)
    assert.equal(h.files.has(staged), false, 'staging file was moved, not copied')
  })

  it('rejects a download whose bytes do not match the reference and leaves nothing behind', async () => {
    const h = harness()
    const bytes = Buffer.alloc(1000, 1)
    const ref = h.reference('item', 1, bytes)
    h.objects.set('https://objects.example.test/item/1', Buffer.alloc(1000, 2))
    await assert.rejects(h.staging.stage(h.source(ref, 'https://objects.example.test/item/1')), /verification/)
    assert.equal([...h.files.keys()].some((path) => path.startsWith('.zennotes/sync/downloads/')), false)
  })

  it('preserves a local edit as a conflict instead of overwriting it', async () => {
    const localEdit = Buffer.from('my local edit')
    const h = harness({ 'note.md': localEdit })
    const cloud = Buffer.from('cloud version')
    const ref = h.reference('item', 2, cloud, 'utf8')
    h.objects.set('https://objects.example.test/item/2', cloud)
    const file = await h.staging.stage(h.source(ref, 'https://objects.example.test/item/2'))
    const tracked = { item_id: 'item', path: 'note.md', kind: 'text' as const, revision: 1, sha256: hash(Buffer.from('original')), byte_length: 8, media_type: 'text/markdown' }
    const conflict = await h.staging.apply(
      { sequence: 5, item_id: 'item', type: 'upsert', path: 'note.md', previous_path: null, revision: 2, content_ref: ref },
      tracked, file
    )
    assert.equal(conflict?.code, 'LOCAL_EDIT_CONFLICT')
    assert.equal(conflict?.local?.content.data, 'my local edit')
    assert.deepEqual(h.files.get('note.md'), localEdit, 'local bytes untouched')
  })

  it('keeps both versions with a byte-verified copy of the local file', async () => {
    const local = Buffer.alloc(6_000_000, 7)
    const h = harness({ 'attachements/big.bin': local })
    const cloud = Buffer.alloc(6_000_000, 9)
    const ref = h.reference('item', 4, cloud)
    h.objects.set('https://objects.example.test/item/4', cloud)
    const file = await h.staging.stage(h.source(ref, 'https://objects.example.test/item/4'))
    await h.staging.resolve({
      expected_path: 'attachements/big.bin', expected_sha256: hash(local),
      cloud_path: 'attachements/big.bin', file, keep_both_path: 'attachements/big (local).bin'
    })
    assert.deepEqual(h.files.get('attachements/big.bin'), cloud)
    assert.deepEqual(h.files.get('attachements/big (local).bin'), local)
    assert.ok(h.log.some((entry) => entry.startsWith('copy attachements/big.bin')))
  })

  it('refuses to resolve when the local file changed since the conflict was recorded', async () => {
    const h = harness({ 'note.md': Buffer.from('changed again') })
    const cloud = Buffer.from('cloud')
    const ref = h.reference('item', 1, cloud, 'utf8')
    h.objects.set('https://objects.example.test/item/1', cloud)
    const file = await h.staging.stage(h.source(ref, 'https://objects.example.test/item/1'))
    await assert.rejects(h.staging.resolve({
      expected_path: 'note.md', expected_sha256: hash(Buffer.from('stale')), cloud_path: 'note.md', file
    }), /changed on this device/)
    assert.equal(h.files.get('note.md')!.toString(), 'changed again')
  })

  it('puts the other device\'s version where it went and moves this device\'s different file beside it', async () => {
    // Dave's phone: the computer trashed the note the phone edited, and the
    // phone had trashed an Untitled.md of its own into the same slot.
    const edited = Buffer.from('# Untitled\n\nEdited on the phone.\n')
    const scratch = Buffer.from('# Untitled\n\nThe phone\'s own scratch.\n')
    const other = Buffer.from('# Untitled\n\nAlready the second one.\n')
    const h = harness({
      'inbox/Daily Notes/Untitled.md': edited,
      'trash/Daily Notes/Untitled.md': scratch,
      'trash/Daily Notes/Untitled 2.md': other
    })
    const cloud = Buffer.from('# Untitled\n\nWritten on the computer.\n')
    const ref = h.reference('item', 3, cloud, 'utf8')
    h.objects.set('https://objects.example.test/item/3', cloud)
    const file = await h.staging.stage(h.source(ref, 'https://objects.example.test/item/3'))
    await h.staging.resolve({
      expected_path: 'inbox/Daily Notes/Untitled.md', expected_sha256: hash(edited),
      cloud_path: 'trash/Daily Notes/Untitled.md', file
    })
    assert.deepEqual(h.files.get('trash/Daily Notes/Untitled.md'), cloud)
    assert.deepEqual(h.files.get('trash/Daily Notes/Untitled 3.md'), scratch)
    assert.deepEqual(h.files.get('trash/Daily Notes/Untitled 2.md'), other)
    assert.equal(h.files.has('inbox/Daily Notes/Untitled.md'), false)
  })

  it('moves this device\'s file back when the other device\'s version cannot be published', async () => {
    const edited = Buffer.from('edited')
    const scratch = Buffer.from('scratch')
    const h = harness({ 'inbox/a.md': edited, 'trash/a.md': scratch })
    const cloud = Buffer.from('cloud')
    const ref = h.reference('item', 2, cloud, 'utf8')
    h.objects.set('https://objects.example.test/item/2', cloud)
    const file = await h.staging.stage(h.source(ref, 'https://objects.example.test/item/2'))
    const rename = h.native.rename
    h.native.rename = async (from, to) => {
      if (from.startsWith('.zennotes/sync/downloads/')) throw new Error('publish failed')
      await rename(from, to)
    }
    await assert.rejects(h.staging.resolve({
      expected_path: 'inbox/a.md', expected_sha256: hash(edited), cloud_path: 'trash/a.md', file
    }), /publish failed/)
    assert.deepEqual(h.files.get('trash/a.md'), scratch)
    assert.equal(h.files.has('trash/a 2.md'), false)
    assert.deepEqual(h.files.get('inbox/a.md'), edited)
  })
})

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

describe('native Cloud staging without crypto.randomUUID (iOS 15.0 to 15.3)', () => {
  beforeEach(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
  })
  afterEach(() => {
    Reflect.deleteProperty(crypto, 'randomUUID')
  })

  it('names its staged download and rollback copy from getRandomValues', async () => {
    const original = Buffer.from('original')
    const h = harness({ 'note.md': original })
    const cloud = Buffer.from('cloud version')
    const ref = h.reference('item', 2, cloud, 'utf8')
    h.objects.set('https://objects.example.test/item/2', cloud)
    const file = await h.staging.stage(h.source(ref, 'https://objects.example.test/item/2'))
    const tracked = { item_id: 'item', path: 'note.md', kind: 'text' as const, revision: 1, sha256: hash(original), byte_length: original.length, media_type: 'text/markdown' }
    const conflict = await h.staging.apply(
      { sequence: 6, item_id: 'item', type: 'upsert', path: 'note.md', previous_path: null, revision: 2, content_ref: ref },
      tracked, file
    )
    assert.equal(conflict, undefined)
    assert.equal(h.files.get('note.md')!.toString(), 'cloud version')
    assert.ok(h.log.some((entry) => new RegExp(`^rename note\\.md -> \\.zennotes/sync/rollback-${UUID}$`).test(entry)))
    assert.ok(h.log.some((entry) => new RegExp(`^rename \\.zennotes/sync/downloads/${UUID} -> note\\.md$`).test(entry)))
  })
})

const TAMPERED = 'The encrypted Cloud file was changed or is incomplete.'

/** Stands in for the CryptoKit chunk loop: opens exactly what the header, key
 *  and AAD JavaScript hands over describe, or fails as the plugin does. */
function openZne1(sealed: Buffer, keys: { header: string; objectKey: string; aad: string }): Buffer {
  if (!sealed.subarray(0, 74).equals(Buffer.from(keys.header, 'base64'))) {
    throw Object.assign(new Error(TAMPERED), { code: 'E2EE_TAMPERED' })
  }
  const key = Buffer.from(keys.objectKey, 'base64')
  const aad = Buffer.from(keys.aad, 'base64')
  const body = sealed.subarray(74)
  const parts: Buffer[] = []
  for (let index = 0, offset = 0; ; index++) {
    const end = Math.min(offset + 65_552, body.length)
    const last = end === body.length
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(index, 7)
    nonce[11] = last ? 1 : 0
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(body.subarray(end - 16, end))
    try {
      parts.push(decipher.update(body.subarray(offset, end - 16)), decipher.final())
    } catch {
      throw Object.assign(new Error(TAMPERED), { code: 'E2EE_TAMPERED' })
    }
    offset = end
    if (last) return Buffer.concat(parts)
  }
}

async function vaultCipher() {
  const accountKey = generateCloudE2eeKey()
  const encryption = await CloudVaultCipher.prepareVault('Test vault', accountKey, 1)
  return CloudVaultCipher.open({ id: 'vault-1', encryption }, accountKey, 1)
}

/** The staging harness with the native header read and chunk loop, and a real vault cipher. */
async function encryptedHarness(initial: Record<string, Buffer> = {}) {
  const h = harness(initial)
  const opened: string[] = []
  const downloads: string[] = []
  const download = h.native.download
  Object.assign(h.native, {
    async download(options: { url: string; to: string; byteLength: number; sha256: string }) {
      downloads.push(options.to)
      await download(options)
    },
    async readHeader(path: string, length: number) {
      return h.files.get(path)!.subarray(0, length).toString('base64')
    },
    async decryptFile(options: { from: string; to: string; header: string; objectKey: string; aad: string }) {
      const plaintext = openZne1(h.files.get(options.from)!, options)
      h.files.set(options.to, plaintext)
      opened.push(`${options.from} -> ${options.to}`)
      return { byteLength: plaintext.length, sha256: hash(plaintext) }
    }
  })
  const cipher = await vaultCipher()
  const seal = async (plaintext: Buffer) => {
    const pieces: Buffer[] = []
    for await (const piece of cipher.encryptStream([plaintext])) pieces.push(Buffer.from(piece))
    return Buffer.concat(pieces)
  }
  /** As the vault cipher hands a reference over: plaintext metadata, and the stored ciphertext in `encrypted`. */
  const reference = (itemId: string, revision: number, plaintext: Buffer, sealed: Buffer): CloudSyncContentReference => ({
    item_id: itemId, revision, encoding: 'base64', sha256: hash(plaintext), byte_length: plaintext.length,
    media_type: 'application/octet-stream', encrypted: { sha256: hash(sealed), byte_length: sealed.length }
  })
  const source = (ref: any, url: string, decryptor: CloudVaultCipher | null = cipher): CloudSyncDownloadSource => ({
    reference: ref, previewLimitBytes: 262_144, allowInsecureLoopback: false,
    ...(decryptor ? { decryptor } : {}),
    getInstruction: async () => ({ item_id: ref.item_id, revision: ref.revision,
      content: { encoding: 'aes-gcm', sha256: ref.encrypted.sha256, byte_length: ref.encrypted.byte_length, media_type: 'application/octet-stream' },
      download: { url, method: 'GET', headers: {}, expires_at: new Date(Date.now() + 300_000).toISOString() } })
  })
  const leftovers = () => [...h.files.keys()].filter((path) => path.startsWith('.zennotes/sync/'))
  return { ...h, cipher, seal, reference, source, opened, downloads, leftovers }
}

describe('native Cloud staging for end-to-end encrypted vaults', () => {
  const url = 'https://objects.example.test/item/7'

  it('downloads the ciphertext, opens it natively, and publishes only the checked plaintext', async () => {
    const h = await encryptedHarness()
    const plaintext = Buffer.alloc(200_000, 3)
    const sealed = await h.seal(plaintext)
    const ref = h.reference('item', 7, plaintext, sealed)
    h.objects.set(url, sealed)
    const file = await h.staging.stage(h.source(ref, url))
    const [staged] = h.leftovers()
    assert.match(staged!, new RegExp(`^\\.zennotes/sync/downloads/${UUID}$`))
    assert.deepEqual(h.downloads, [`${staged}.sealed`], 'the ciphertext downloads beside the staged file')
    assert.deepEqual(h.opened, [`${staged}.sealed -> ${staged}`])
    assert.deepEqual(h.files.get(staged!), plaintext)
    assert.equal([...h.files.values()].some((bytes) => bytes.equals(sealed)), false, 'no ciphertext is left anywhere')
    const conflict = await h.staging.apply(
      { sequence: 8, item_id: 'item', type: 'upsert', path: 'attachements/photo.bin', previous_path: null, revision: 7, content_ref: ref },
      undefined, file
    )
    assert.equal(conflict, undefined)
    assert.deepEqual(h.files.get('attachements/photo.bin'), plaintext)
    assert.deepEqual(h.leftovers(), [])
  })

  it('refuses an encrypted reference without its key before downloading anything', async () => {
    const h = await encryptedHarness()
    const sealed = await h.seal(Buffer.from('secret'))
    h.objects.set(url, sealed)
    await assert.rejects(h.staging.stage(h.source(h.reference('item', 7, Buffer.from('secret'), sealed), url, null)), /no key to open it/)
    assert.deepEqual(h.downloads, [])
    assert.deepEqual(h.leftovers(), [])
  })

  it('refuses an encrypted reference on a device without the native chunk loop', async () => {
    const h = harness()
    const cipher = await vaultCipher()
    const encrypted = { sha256: 'a'.repeat(64), byte_length: 96 }
    await assert.rejects(h.staging.stage({
      reference: { ...h.reference('item', 7, Buffer.from('secret')), encrypted }, decryptor: cipher,
      previewLimitBytes: 262_144, getInstruction: async () => assert.fail('nothing may download')
    }), /cannot open end-to-end encrypted/)
    assert.deepEqual(h.log, [])
  })

  it('rejects ciphertext the service changed even when its hashes agree, and leaves nothing behind', async () => {
    const h = await encryptedHarness()
    const plaintext = Buffer.alloc(70_000, 5)
    const sealed = await h.seal(plaintext)
    sealed[74 + 65_552 + 3]! ^= 0x01
    h.objects.set(url, sealed)
    await assert.rejects(h.staging.stage(h.source(h.reference('item', 7, plaintext, sealed), url)), /changed or is incomplete/)
    assert.deepEqual(h.leftovers(), [])
  })

  it('rejects a key that does not open the object before decrypting anything', async () => {
    const h = await encryptedHarness()
    const plaintext = Buffer.from('another vault')
    const sealed = await h.seal(plaintext)
    h.objects.set(url, sealed)
    await assert.rejects(h.staging.stage(h.source(h.reference('item', 7, plaintext, sealed), url, await vaultCipher())), /key does not open/)
    assert.deepEqual(h.opened, [])
    assert.deepEqual(h.leftovers(), [])
  })

  it('rejects plaintext that is not the file its metadata names', async () => {
    const h = await encryptedHarness()
    const sealed = await h.seal(Buffer.from('served under the wrong name'))
    h.objects.set(url, sealed)
    const claimed = Buffer.from('the file the metadata names')
    await assert.rejects(h.staging.stage(h.source(h.reference('item', 7, claimed, sealed), url)), /not the file its metadata names/)
    assert.deepEqual(h.leftovers(), [])
  })

  it('rejects a download that is not the ciphertext its reference describes', async () => {
    const h = await encryptedHarness()
    const plaintext = Buffer.from('expected')
    const sealed = await h.seal(plaintext)
    h.objects.set(url, await h.seal(plaintext))
    await assert.rejects(h.staging.stage(h.source(h.reference('item', 7, plaintext, sealed), url)), /verification failed/)
    assert.deepEqual(h.opened, [])
    assert.deepEqual(h.leftovers(), [])
  })
})

describe('a download that goes quiet', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('downloads again into a clean scratch file and stages the bytes', async () => {
    vi.spyOn(Math, 'random').mockImplementation(() => 0)
    const h = harness()
    const bytes = Buffer.from('the whole note, as the PC saved it')
    const ref = h.reference('item', 1, bytes)
    const url = 'https://objects.example.test/item/1'
    h.objects.set(url, bytes)
    const download = h.native.download
    const leftBehind: boolean[] = []
    let stalls = 1
    h.native.download = async (options) => {
      leftBehind.push(h.files.has(options.to))
      if (stalls-- > 0) {
        // Half the body arrived, then the connection went silent until the
        // native read timeout gave up: no HTTP status to report.
        h.files.set(options.to, bytes.subarray(0, 10))
        h.log.push(`stalled ${options.url}`)
        throw Object.assign(new Error('Cloud object download failed.'), { code: 'DIRECT_DOWNLOAD_FAILED' })
      }
      await download(options)
    }
    const file = await h.staging.stage(h.source(ref, url))
    assert.deepEqual(h.log, [`stalled ${url}`, `download ${url}`])
    assert.deepEqual(leftBehind, [false, false])
    assert.deepEqual(h.files.get(cloudSyncStagedHandle<StagedHandle>(file).path), bytes)
  })

  it('does not download again when the storage host answered with an error', async () => {
    const h = harness()
    const bytes = Buffer.from('cloud')
    const url = 'https://objects.example.test/item/1'
    let calls = 0
    h.native.download = async () => {
      calls++
      throw Object.assign(new Error('Cloud object download failed (404).'), { code: 'DIRECT_DOWNLOAD_FAILED', data: { status: 404 } })
    }
    await assert.rejects(h.staging.stage(h.source(h.reference('item', 1, bytes), url)), /404/)
    assert.equal(calls, 1)
    assert.deepEqual([...h.files.keys()], [])
  })
})
