/**
 * The browser's half of Cloud sync (Phase 4): the OPFS store as the
 * package's SyncFastPath (fingerprints, streamed and checked downloads,
 * uploads from OPFS), stubs at the file level (read, write, swap, evict, and
 * reads that hydrate first), and the sign-in and revocation rules the page
 * owns: the fragment callback, the device name, and which answers wipe.
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'vitest'
import { decodeCloudStub, encodeCloudStub, type CloudStubRecord } from '@zennotes/portable-vault/cloud-stub-format'
import { parseCloudAuthFragmentCallback } from '@zennotes/shared-domain/cloud-auth-flow'
import { browserDeviceName, cloudCallbackUrl } from '../cloud-account'
import { isRevocationAnswer, revocationAwareTransport } from '../cloud-session'
import { cloudVaultKey, vaultsOfAccount, type BrowserVaultEntry } from '../browser-vaults'
import { createOpfsDispatcher } from '../opfs-dispatch'
import { OPFS_QUOTA, OPFS_STUB, OpfsError } from '../opfs-errors'
import { OpfsVaultFileSystem, directTransport, type OpfsTransport } from '../opfs-fs'
import { FakeOpfs, type FakeEngine } from './opfs-fake'

const MiB = 1024 * 1024
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
let ids = 0
const randomId = (): string => `id${(ids += 1)}`

function bytesOf(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 7 + seed) & 0xff
  return bytes
}

async function openFs(engine: FakeEngine = 'chrome', fetchImpl?: typeof fetch) {
  const origin = new FakeOpfs(engine)
  const dispatcher = createOpfsDispatcher({ root: async () => origin.root, randomId, fetch: fetchImpl })
  const fs = new OpfsVaultFileSystem('cloud-v1', directTransport(dispatcher), { generation: 0 })
  await fs.init()
  return fs
}

function stubFor(bytes: Uint8Array, overrides: Partial<CloudStubRecord> = {}): CloudStubRecord {
  return { format: 1, item_id: 'item-1', revision: 3, sha256: sha(bytes), byte_length: bytes.byteLength, media_type: 'image/png', ...overrides }
}

function fakeFetch(objects: Map<string, Uint8Array | number>, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    seen.push(url)
    const object = objects.get(url)
    if (object === undefined) throw new TypeError('Failed to fetch')
    if (typeof object === 'number') return new Response('no', { status: object })
    return new Response(object.slice())
  }) as typeof fetch
}

describe('the OPFS store as the sync fast path', () => {
  for (const engine of ['chrome', 'firefox', 'safari'] as const) {
    it(`fingerprints small files with their bytes and large ones in slices (${engine})`, async () => {
      const fs = await openFs(engine)
      const note = new TextEncoder().encode('# Hi\n')
      await fs.writeBytes('note.md', note)
      const small = await fs.readForSync('note.md', true)
      assert.equal(small.sha256, sha(note))
      assert.equal(small.byteLength, note.byteLength)
      assert.equal(small.utf8, true)
      assert.equal(Buffer.from(small.inlineBase64!, 'base64').toString(), '# Hi\n')
      assert.equal(small.uri, 'opfs-vault:cloud-v1/note.md')

      const large = bytesOf(6 * MiB, 1)
      await fs.writeBytes('assets/video.mp4', large)
      const print = await fs.readForSync('assets/video.mp4', false)
      assert.equal(print.sha256, sha(large))
      assert.equal(print.byteLength, large.byteLength)
      assert.equal(print.inlineBase64, undefined)
      assert.equal(print.stub, undefined)
    })
  }

  it('answers a stub with the fingerprint it records, and no bytes', async () => {
    const fs = await openFs()
    const photo = bytesOf(2 * MiB, 2)
    const stub = stubFor(photo)
    await fs.writeCloudStub('assets/photo.png', stub)
    const print = await fs.readForSync('assets/photo.png', false)
    assert.equal(print.sha256, stub.sha256)
    assert.equal(print.byteLength, stub.byte_length)
    assert.deepEqual(print.stub, { mediaType: 'image/png' })
    assert.equal(print.inlineBase64, undefined)
    assert.deepEqual(await fs.readCloudStub('assets/photo.png'), stub)
    assert.equal(await fs.readCloudStub('missing.png'), null)
  })

  it('streams a signed download into a new path and checks length and hash', async () => {
    const photo = bytesOf(3 * MiB, 3)
    const objects = new Map<string, Uint8Array | number>([['https://bucket.test/ok', photo], ['https://bucket.test/gone', 403]])
    const fs = await openFs('safari', fakeFetch(objects))
    await fs.download({ url: 'https://bucket.test/ok', headers: {}, to: '.zennotes/sync/downloads/a', byteLength: photo.byteLength, sha256: sha(photo) })
    assert.equal(sha(await fs.readStoredBytes('.zennotes/sync/downloads/a')), sha(photo))
    // A wrong hash leaves nothing behind.
    await assert.rejects(
      fs.download({ url: 'https://bucket.test/ok', headers: {}, to: '.zennotes/sync/downloads/b', byteLength: photo.byteLength, sha256: '0'.repeat(64) }),
      /SHA-256 verification/
    )
    assert.equal(await fs.statVerified('.zennotes/sync/downloads/b'), null)
    // The storage host's answer travels with the failure; no answer has no status.
    await assert.rejects(
      fs.download({ url: 'https://bucket.test/gone', headers: {}, to: '.zennotes/sync/downloads/c', byteLength: 1, sha256: '0'.repeat(64) }),
      (error: unknown) => (error as { code?: string; status?: number }).code === 'DIRECT_DOWNLOAD_FAILED' && (error as { status?: number }).status === 403
    )
    await assert.rejects(
      fs.download({ url: 'https://bucket.test/offline', headers: {}, to: '.zennotes/sync/downloads/d', byteLength: 1, sha256: '0'.repeat(64) }),
      (error: unknown) => (error as { code?: string; status?: number }).code === 'DIRECT_DOWNLOAD_FAILED' && (error as { status?: number }).status === undefined
    )
  })

  it('hands an upload the file only while it is the bytes sync planned, never a stub', async () => {
    const fs = await openFs()
    const big = bytesOf(6 * MiB, 4)
    await fs.writeBytes('assets/big.bin', big)
    const file = await fs.fileForUpload(fs.uriFor('assets/big.bin'), sha(big), big.byteLength)
    assert.equal(file.size, big.byteLength)
    await assert.rejects(fs.fileForUpload(fs.uriFor('assets/big.bin'), '0'.repeat(64), big.byteLength), /changed since/)
    await fs.writeCloudStub('assets/stub.png', stubFor(big))
    await assert.rejects(fs.fileForUpload(fs.uriFor('assets/stub.png'), sha(big), big.byteLength), (error: unknown) => (error as { code?: string }).code === OPFS_STUB)
    await assert.rejects(fs.fileForUpload('opfs-vault:another/x', sha(big), 1), /not in this vault/)
  })

  it('refuses to copy a stub for sync', async () => {
    const fs = await openFs()
    await fs.writeCloudStub('a.png', stubFor(bytesOf(2 * MiB, 5)))
    await assert.rejects(fs.copyForSync('a.png', 'b.png', 2 * MiB), (error: unknown) => (error as { code?: string }).code === OPFS_STUB)
  })
})

describe('stubs at the file level', () => {
  it('swaps downloaded bytes in only while the stub is still the one read', async () => {
    const fs = await openFs()
    const photo = bytesOf(2 * MiB, 6)
    const stub = stubFor(photo)
    await fs.writeCloudStub('photo.png', stub)
    await fs.writeBytes('.zennotes/sync/downloads/x', photo)
    assert.equal(await fs.replaceCloudStub('.zennotes/sync/downloads/x', 'photo.png', { ...stub, revision: 9 }), false)
    assert.ok(await fs.readCloudStub('photo.png'))
    assert.equal(await fs.replaceCloudStub('.zennotes/sync/downloads/x', 'photo.png', stub), true)
    assert.equal(sha(await fs.readStoredBytes('photo.png')), sha(photo))
    assert.equal(await fs.statVerified('.zennotes/sync/downloads/x'), null)
  })

  it('evicts a file to its stub only while it is unchanged', async () => {
    const fs = await openFs()
    const photo = bytesOf(2 * MiB, 7)
    await fs.writeBytes('photo.png', photo)
    const stat = (await fs.statOrNull('photo.png'))!
    assert.equal(await fs.evictToCloudStub('photo.png', { size: stat.size, mtime: stat.mtime + 1, sha256: sha(photo) }, stubFor(photo)), false)
    assert.equal(await fs.evictToCloudStub('photo.png', { size: stat.size, mtime: stat.mtime, sha256: sha(photo) }, stubFor(photo)), true)
    assert.ok(decodeCloudStub(await fs.readStoredBytes('photo.png')))
  })

  it('hydrates a stub before any read of its bytes and before a copy', async () => {
    const fs = await openFs()
    const photo = bytesOf(2 * MiB, 8)
    await fs.writeCloudStub('assets/photo.png', stubFor(photo))
    const asked: string[] = []
    fs.setStubHydrator(async (path) => {
      asked.push(path)
      await fs.writeBytes(path, photo)
      return true
    })
    assert.equal(sha(await fs.readBytes('assets/photo.png')), sha(photo))
    await fs.writeCloudStub('assets/photo.png', stubFor(photo))
    assert.equal(Buffer.from(await fs.readBase64('assets/photo.png'), 'base64').byteLength, photo.byteLength)
    // A folder copy meets the stub inside it, hydrates it, and goes on.
    await fs.writeCloudStub('assets/photo.png', stubFor(photo))
    await fs.writeText('assets/note.md', 'hello')
    await fs.copy('assets', 'copied')
    assert.equal(sha(await fs.readStoredBytes('copied/photo.png')), sha(photo))
    assert.deepEqual(asked, ['assets/photo.png', 'assets/photo.png', 'assets/photo.png'])
  })

  it('says a stub is only in Cloud when nothing can hydrate it', async () => {
    const fs = await openFs()
    await fs.writeCloudStub('a.png', stubFor(bytesOf(2 * MiB, 9)))
    await assert.rejects(fs.readBytes('a.png'), /only in ZenNotes Cloud/)
    await assert.rejects(fs.copy('a.png', 'b.png'), /only in ZenNotes Cloud/)
  })

  it('makes room and tries once more when a write finds the browser full', async () => {
    let failNext = true
    const origin = new FakeOpfs('chrome')
    const real = directTransport(createOpfsDispatcher({ root: async () => origin.root, randomId }))
    const transport: OpfsTransport = {
      async call(op, args, transfer) {
        if (op === 'write' && failNext) {
          failNext = false
          throw new OpfsError(OPFS_QUOTA, 'full', 'QuotaExceededError')
        }
        return real.call(op, args, transfer)
      },
      close: () => real.close()
    }
    const fs = new OpfsVaultFileSystem('cloud-v1', transport, { generation: 0 })
    await fs.init()
    let pressure = 0
    fs.setQuotaPressureHandler(async () => {
      pressure += 1
    })
    await fs.writeText('note.md', 'kept')
    assert.equal(pressure, 1)
    assert.equal(await fs.readText('note.md'), 'kept')
  })

  it('stub records round-trip and anything else is not one', () => {
    const record = stubFor(bytesOf(10, 1))
    assert.deepEqual(decodeCloudStub(encodeCloudStub(record)), record)
    assert.equal(decodeCloudStub(new TextEncoder().encode('ZNSTUB1\n{"format":2}')), null)
    assert.equal(decodeCloudStub(new TextEncoder().encode('# just a note')), null)
  })
})

describe('signing in from the browser', () => {
  it('reads the code and state from the fragment of exactly the callback page', () => {
    const callback = cloudCallbackUrl('https://app.zennotes.org')
    assert.equal(callback, 'https://app.zennotes.org/auth/callback')
    assert.deepEqual(parseCloudAuthFragmentCallback(`${callback}#code=abc123&state=s-1`, callback), { code: 'abc123', state: 's-1' })
    for (const refused of [
      `https://evil.example/auth/callback#code=abc123&state=s-1`,
      `https://app.zennotes.org/auth/other#code=abc123&state=s-1`,
      `${callback}?code=abc123&state=s-1`,
      `${callback}?x=1#code=abc123&state=s-1`,
      `${callback}#code=abc!&state=s-1`,
      `${callback}#state=s-1`
    ]) {
      assert.equal(parseCloudAuthFragmentCallback(refused, callback), null, refused)
    }
  })

  it('names the device for the browser and the system', () => {
    assert.equal(browserDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'), 'Chrome on macOS')
    assert.equal(browserDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0'), 'Firefox on Windows')
    assert.equal(browserDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'), 'Safari on iPhone')
    assert.equal(browserDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0'), 'Edge on Windows')
    assert.equal(browserDeviceName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'), 'Chrome on Linux')
    assert.equal(browserDeviceName('Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'), 'Chrome on Android')
  })
})

describe('revocation', () => {
  it('wipes only on DEVICE_REVOKED or ACTIVE_DEVICE_REQUIRED, never a plain sign-out', () => {
    assert.equal(isRevocationAnswer(401, { error: { code: 'DEVICE_REVOKED' } }), true)
    assert.equal(isRevocationAnswer(403, { error: { code: 'ACTIVE_DEVICE_REQUIRED' } }), true)
    assert.equal(isRevocationAnswer(401, { error: { code: 'UNAUTHENTICATED' } }), false)
    assert.equal(isRevocationAnswer(401, null), false)
    assert.equal(isRevocationAnswer(403, { error: { code: 'DEVICE_REVOKED' } }), false)
  })

  it('hears it on authenticated Cloud requests and still answers the caller', async () => {
    let revoked = 0
    const transport = revocationAwareTransport({
      request: async (options) => ({
        status: options.url.endsWith('/revoked') ? 401 : 200,
        headers: {},
        data: options.url.endsWith('/revoked') ? { error: { code: 'DEVICE_REVOKED' } } : {}
      })
    }, () => {
      revoked += 1
    })
    const answer = await transport.request({ url: 'https://zennotes.org/api/v1/revoked', headers: { Authorization: 'Bearer t' } })
    assert.equal(answer.status, 401)
    assert.equal(revoked, 1)
    // The exchange carries no credential: its answers never wipe.
    await transport.request({ url: 'https://zennotes.org/api/v1/revoked' })
    await transport.request({ url: 'https://zennotes.org/api/v1/fine', headers: { Authorization: 'Bearer t' } })
    assert.equal(revoked, 1)
  })
})

describe('the vaults this browser keeps', () => {
  it('keys a Cloud vault by its id, never its name', () => {
    assert.equal(cloudVaultKey('01JABCDEF'), 'cloud-01jabcdef')
    assert.equal(cloudVaultKey('9f1c2e3a-0000-4000-8000-1234567890ab'), 'cloud-9f1c2e3a-0000-4000-8000-1234567890ab')
    assert.throws(() => cloudVaultKey('///'))
  })

  it('tells one account’s vaults from another’s, ignoring the email’s case', () => {
    const entry = (key: string, email: string): BrowserVaultEntry => ({
      key, name: key, kind: 'cloud', vaultId: key, account: { baseUrl: 'https://zennotes.org', email }, lastOpenedAt: 0
    })
    const entries = [entry('a', 'Pat@Example.test'), entry('b', 'sam@example.test'), { key: 'try', name: 'Try', kind: 'try' as const, lastOpenedAt: 0 }]
    const split = vaultsOfAccount(entries, { baseUrl: 'https://zennotes.org', email: 'pat@example.test' })
    assert.deepEqual(split.mine.map((item) => item.key), ['a'])
    assert.deepEqual(split.others.map((item) => item.key), ['b'])
  })
})
