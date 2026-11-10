/**
 * The browser's half of end-to-end encryption (Phase 5): the OPFS worker's
 * ZNE1 chunk loops against the spec's vectors and the shared whole-object
 * functions, Argon2id in a worker of its own, where the account key is kept,
 * and the release manifest's hash.
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it, vi } from 'vitest'
import { encodeCloudStub } from '@zennotes/portable-vault/cloud-stub-format'
import {
  CloudE2eeError,
  Zne1Purpose,
  beginZne1Encryption,
  decryptZne1,
  derivePassphraseKey,
  fromHex,
  newCloudE2eeKdfParams,
  toBase64,
  toHex
} from '@zennotes/shared-domain/cloud-e2ee'
import { deriveInWorker } from '../argon2-client'
import { accountKeySecretStorage, forgetKeptAccountKeys, loadLockOnClose, locksOnClose, setLockOnClose } from '../browser-keys'
import { runningRelease } from '../browser-release'
import { createOpfsDispatcher } from '../opfs-dispatch'
import { OPFS_STUB } from '../opfs-errors'
import { OpfsVaultFileSystem, directTransport } from '../opfs-fs'
import { FakeOpfs, type FakeEngine } from './opfs-fake'

const CHUNK = 65536
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const vectors = JSON.parse(readFileSync(new URL('../../../../../docs/specs/cloud-e2ee-vectors.json', import.meta.url), 'utf8')) as {
  objects: Array<{
    purpose: number
    parent_key_hex: string
    salt_hex: string
    plaintext_length: number
    object_key_hex: string
    aad_hex: string
    header_hex: string
    ciphertext_length: number
    ciphertext_sha256: string
    /** Only the small vectors spell the bytes out; every one has the hash. */
    ciphertext_hex?: string
  }>
}

let ids = 0
const randomId = (): string => `id${(ids += 1)}`

/** The vectors' plaintext: byte i is i mod 251. */
function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251)
}

async function openFs(engine: FakeEngine = 'chrome') {
  const origin = new FakeOpfs(engine)
  const dispatcher = createOpfsDispatcher({ root: async () => origin.root, randomId })
  const fs = new OpfsVaultFileSystem('cloud-v1', directTransport(dispatcher), { generation: 0 })
  await fs.init()
  return fs
}

const PARENT = Uint8Array.from({ length: 32 }, (_, index) => index + 3)
const options = { parentKey: PARENT, purpose: Zne1Purpose.content, keyVersion: 1 } as const

async function nativeKeys() {
  const params = await beginZne1Encryption(options)
  return { header: toBase64(params.header), objectKey: toBase64(params.objectKey), aad: toBase64(params.aad) }
}

describe('ZNE1 in the OPFS worker', () => {
  for (const vector of vectors.objects) {
    it(`opens and seals the spec's ${vector.plaintext_length}-byte vector byte for byte`, async () => {
      const fs = await openFs()
      const plain = pattern(vector.plaintext_length)
      const keys = {
        header: toBase64(fromHex(vector.header_hex)),
        objectKey: toBase64(fromHex(vector.object_key_hex)),
        aad: toBase64(fromHex(vector.aad_hex))
      }
      await fs.writeBytes('source.bin', plain)
      const sealed = await fs.sealForUpload(fs.uriFor('source.bin'), keys)
      assert.equal(sealed.sha256, vector.ciphertext_sha256)
      assert.equal(sealed.byteLength, vector.ciphertext_length)
      assert.equal(sealed.plaintextSha256, sha(plain))
      assert.equal(sealed.plaintextByteLength, plain.byteLength)
      const upload = await fs.fileForUpload(sealed.uri, sealed.sha256, sealed.byteLength)
      const ciphertext = new Uint8Array(await upload.arrayBuffer())
      if (vector.ciphertext_hex) assert.equal(toHex(ciphertext), vector.ciphertext_hex)

      await fs.writeBytes('staged.sealed', ciphertext)
      assert.equal(await fs.readHeader('staged.sealed', 74), keys.header)
      const opened = await fs.decryptFile({ from: 'staged.sealed', to: 'opened.bin', ...keys })
      assert.deepEqual(opened, { byteLength: plain.byteLength, sha256: sha(plain) })
      assert.equal(toHex(await fs.readStoredBytes('opened.bin')), toHex(plain))
      await sealed.discard()
      assert.equal(await fs.statVerified(fs.pathForUri(sealed.uri)!), null)
    })
  }

  for (const engine of ['chrome', 'firefox', 'safari'] as const) {
    // 64 chunks is one read: the sizes either side of it cross that seam.
    for (const size of [64 * CHUNK - 1, 64 * CHUNK, 64 * CHUNK + 1]) {
      it(`round trips ${size} bytes across its read boundary (${engine})`, async () => {
        const fs = await openFs(engine)
        const plain = pattern(size)
        await fs.writeBytes('big.bin', plain)
        const sealedKeys = await nativeKeys()
        const sealed = await fs.sealForUpload(fs.uriFor('big.bin'), sealedKeys)
        const stored = await fs.readStoredBytes(fs.pathForUri(sealed.uri)!)
        assert.equal(sha(stored), sealed.sha256)
        // Opened by the whole-object function, the apps' path.
        assert.equal(sha(await decryptZne1(stored, options)), sha(plain))
        const opened = await fs.decryptFile({ from: fs.pathForUri(sealed.uri)!, to: 'back.bin', ...sealedKeys })
        assert.equal(opened.sha256, sha(plain))
        assert.equal(sha(await fs.readStoredBytes('back.bin')), sha(plain))
      })
    }
  }

  it('leaves nothing when a chunk was changed, and never overwrites', async () => {
    const fs = await openFs()
    const sealedKeys = await nativeKeys()
    const plain = pattern(3 * CHUNK)
    await fs.writeBytes('src.bin', plain)
    const sealed = await fs.sealForUpload(fs.uriFor('src.bin'), sealedKeys)
    const good = await fs.readStoredBytes(fs.pathForUri(sealed.uri)!)

    const flipped = good.slice()
    flipped[74 + CHUNK + 20]! ^= 1
    await fs.writeBytes('flipped.sealed', flipped)
    await assert.rejects(fs.decryptFile({ from: 'flipped.sealed', to: 'out.bin', ...sealedKeys }), /changed or is incomplete/)
    assert.equal(await fs.statVerified('out.bin'), null)

    // Cut at a chunk boundary: the chunk before it was never the last one.
    await fs.writeBytes('short.sealed', good.subarray(0, 74 + CHUNK + 16))
    await assert.rejects(fs.decryptFile({ from: 'short.sealed', to: 'out.bin', ...sealedKeys }), /changed or is incomplete/)
    assert.equal(await fs.statVerified('out.bin'), null)

    // The header at the front is not the one the keys were checked against.
    const otherHeader = good.slice()
    otherHeader[20]! ^= 1
    await fs.writeBytes('header.sealed', otherHeader)
    await assert.rejects(fs.decryptFile({ from: 'header.sealed', to: 'out.bin', ...sealedKeys }), /changed while it was being opened/)

    await fs.writeBytes('taken.bin', new Uint8Array([1]))
    await assert.rejects(fs.decryptFile({ from: fs.pathForUri(sealed.uri)!, to: 'taken.bin', ...sealedKeys }), /already exists/)
    assert.equal(toHex(await fs.readStoredBytes('taken.bin')), '01')
  })

  it('never seals a stub', async () => {
    const fs = await openFs()
    await fs.writeBytes('photo.png', encodeCloudStub({ format: 1, item_id: 'i', revision: 1, sha256: 'a'.repeat(64), byte_length: 5_000_000, media_type: 'image/png' }))
    await assert.rejects(fs.sealForUpload(fs.uriFor('photo.png'), await nativeKeys()), (error: { code?: string }) => error.code === OPFS_STUB)
  })

  it('removes what a closed tab left in the staging folders when the vault opens', async () => {
    const origin = new FakeOpfs('chrome')
    const dispatcher = createOpfsDispatcher({ root: async () => origin.root, randomId })
    const fs = new OpfsVaultFileSystem('cloud-v1', directTransport(dispatcher), { generation: 0 })
    await fs.init()
    await fs.writeBytes('.zennotes/sync/uploads/abandoned.sealed', new Uint8Array([1]))
    await fs.writeBytes('.zennotes/sync/downloads/abandoned', new Uint8Array([2]))
    await fs.writeBytes('.zennotes/sync/rollback-keep', new Uint8Array([3]))
    await fs.writeBytes('note.md', new Uint8Array([4]))
    const next = new OpfsVaultFileSystem('cloud-v1', directTransport(createOpfsDispatcher({ root: async () => origin.root, randomId })), { generation: 0 })
    await next.init()
    assert.equal(await next.statVerified('.zennotes/sync/uploads/abandoned.sealed'), null)
    assert.equal(await next.statVerified('.zennotes/sync/downloads/abandoned'), null)
    assert.equal(await next.statVerified('.zennotes/sync/rollback-keep'), 'file')
    assert.equal(await next.statVerified('note.md'), 'file')
  })
})

describe('Argon2id in a worker', () => {
  class FakeWorker {
    terminated = 0
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    constructor(private readonly answer: (data: { passphrase: string; kdf: never }) => Promise<unknown>) {}
    postMessage(data: { passphrase: string; kdf: never }): void {
      void this.answer(data).then((reply) => this.onmessage?.({ data: reply } as MessageEvent))
    }
    terminate(): void {
      this.terminated += 1
    }
  }

  it('gives the bytes the apps derive and ends the worker', async () => {
    const kdf = newCloudE2eeKdfParams()
    const worker = new FakeWorker(async ({ passphrase }) => ({ ok: true, key: await derivePassphraseKey(passphrase, kdf) }))
    const key = await deriveInWorker('a long enough passphrase', kdf, () => worker as unknown as Worker)
    assert.equal(toHex(key), toHex(await derivePassphraseKey('a long enough passphrase', kdf)))
    assert.equal(worker.terminated, 1)
  })

  it('keeps the error code across the boundary and ends the worker', async () => {
    const worker = new FakeWorker(async () => ({ ok: false, code: 'invalid-kdf', message: 'The encryption settings are not usable.' }))
    await assert.rejects(
      deriveInWorker('x', newCloudE2eeKdfParams(), () => worker as unknown as Worker),
      (error: unknown) => error instanceof CloudE2eeError && error.code === 'invalid-kdf'
    )
    assert.equal(worker.terminated, 1)
  })

  it('reports a worker that died and ends it', async () => {
    const worker = new FakeWorker(async () => new Promise(() => {}))
    const running = deriveInWorker('x', newCloudE2eeKdfParams(), () => worker as unknown as Worker)
    worker.onerror?.({ message: 'out of memory' } as ErrorEvent)
    await assert.rejects(running, /out of memory/)
    assert.equal(worker.terminated, 1)
  })
})

describe('where the account key is kept', () => {
  function innerStore() {
    const values = new Map<string, string>()
    return {
      values,
      available: () => true,
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => void values.set(key, value),
      remove: async (key: string) => void values.delete(key),
      keys: async () => [...values.keys()]
    }
  }
  const KEY = 'e2ee-account-key.abc'

  it('seals it in the store by default', async () => {
    forgetKeptAccountKeys()
    await setLockOnClose(false, accountKeySecretStorage(innerStore()))
    const inner = innerStore()
    const secrets = accountKeySecretStorage(inner)
    await secrets.set(KEY, 'value')
    assert.equal(inner.values.get(KEY), 'value')
    assert.equal(await secrets.get(KEY), 'value')
  })

  it('keeps it only in memory with Lock when I close this tab, and moves one already unlocked', async () => {
    forgetKeptAccountKeys()
    const inner = innerStore()
    const secrets = accountKeySecretStorage(inner)
    await setLockOnClose(false, secrets)
    await secrets.set(KEY, 'value')
    await secrets.set('credential', 'token')

    await setLockOnClose(true, secrets)
    assert.equal(locksOnClose(), true)
    assert.equal(inner.values.has(KEY), false)
    assert.equal(await secrets.get(KEY), 'value')
    // The sign-in is not the key: it stays where it was.
    assert.equal(inner.values.get('credential'), 'token')
    // A sweep sees it, as signing out needs.
    assert.ok((await secrets.keys()).includes(KEY))

    await setLockOnClose(false, secrets)
    assert.equal(inner.values.get(KEY), 'value')
    assert.equal(await secrets.get(KEY), 'value')
  })

  it('forgets it with the tab, and on remove', async () => {
    forgetKeptAccountKeys()
    const inner = innerStore()
    const secrets = accountKeySecretStorage(inner)
    await setLockOnClose(true, secrets)
    await secrets.set(KEY, 'value')
    assert.equal(await secrets.get(KEY), 'value')
    forgetKeptAccountKeys()
    assert.equal(await secrets.get(KEY), null)

    await secrets.set(KEY, 'value')
    await secrets.remove(KEY)
    assert.equal(await secrets.get(KEY), null)
    assert.deepEqual(await secrets.keys(), [])
    await setLockOnClose(false, secrets)
  })

  it('remembers the choice across a reload', async () => {
    forgetKeptAccountKeys()
    await setLockOnClose(true, accountKeySecretStorage(innerStore()))
    assert.equal(await loadLockOnClose(), true)
    await setLockOnClose(false, accountKeySecretStorage(innerStore()))
    assert.equal(await loadLockOnClose(), false)
  })
})

describe('the running release', () => {
  const body = JSON.stringify({ version: '2.85.0-cloud-web.h0123456789abcdef', files: [] }, null, 2) + '\n'

  it('names the release and hashes the manifest the browser received', async () => {
    const asked: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input))
      return new Response(body, { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const release = await runningRelease('/vendor/cloud-web/releases/2.85.0-abc123456789/', fetchImpl)
    assert.deepEqual(release, {
      release: '2.85.0-abc123456789',
      manifestVersion: '2.85.0-cloud-web.h0123456789abcdef',
      manifestSha256: sha(new TextEncoder().encode(body))
    })
    assert.deepEqual(asked, ['/vendor/cloud-web/releases/2.85.0-abc123456789/artifact-manifest.json'])
  })

  it('has no hash for a local run, or when the file is not a manifest', async () => {
    const missing = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    const html = vi.fn(async () => new Response('<!doctype html>')) as unknown as typeof fetch
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    for (const fetchImpl of [missing, html, offline]) {
      const release = await runningRelease('/', fetchImpl)
      assert.equal(release.manifestSha256, null)
      assert.match(release.release, /local build/)
    }
  })
})
