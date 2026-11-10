/**
 * The browser host's other pieces: how the service worker answers
 * `/_vault/...`, IndexedDB HostStorage and SecretStorage, the fencing
 * generation, and "Download as a folder".
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'vitest'
import { unzipSync } from 'fflate'
import { bumpFenceGeneration, idbGet, readFenceGeneration, resetBrowserDbForTests } from '../idb'
import { idbHostStorage, idbSecretStorage, resetSecretsKeyForTests } from '../idb-storage'
import { archiveFolderName, buildVaultArchive } from '../download-folder'
import { parseVaultAssetUrl, vaultAssetUrl } from '../opfs-paths'
import { parseRange, vaultFileResponse } from '../vault-response'
import { createOpfsDispatcher } from '../opfs-dispatch'
import { OpfsVaultFileSystem, directTransport } from '../opfs-fs'
import { FakeOpfs } from './opfs-fake'
import { isWebKitBrowser } from '../try-banner'

beforeEach(() => {
  // A fresh database per test.
  globalThis.indexedDB = new IDBFactory()
  resetBrowserDbForTests()
  resetSecretsKeyForTests()
})

function request(headers: Record<string, string> = {}, method = 'GET'): Pick<Request, 'method' | 'headers'> {
  return { method, headers: new Headers(headers) }
}

describe('vault asset URLs', () => {
  it('round-trip names with spaces, unicode and reserved characters', () => {
    const url = vaultAssetUrl('try', 'inbox/demo/Café #1?.png')
    assert.equal(url, '/_vault/try/inbox/demo/Caf%C3%A9%20%231%3F.png')
    assert.deepEqual(parseVaultAssetUrl(url), { vaultKey: 'try', segments: ['inbox', 'demo', 'Café #1?.png'] })
  })

  it('refuse paths that leave the vault and keys that are not vault keys', () => {
    assert.equal(parseVaultAssetUrl('/_vault/try/../secrets'), null)
    assert.equal(parseVaultAssetUrl('/_vault/try/a/%2E%2E/b'), null)
    assert.equal(parseVaultAssetUrl('/_vault/..%2Fx/a.png'), null)
    assert.equal(parseVaultAssetUrl('/_vault/try/a%2Fb.png'), null)
    assert.equal(parseVaultAssetUrl('/assets/app.js'), null)
  })
})

describe('the service worker answer for a vault file', () => {
  const bytes = new Uint8Array(Array.from({ length: 100 }, (_, index) => index))
  const file = new Blob([bytes])

  it('answers the whole file, never cached, with its type', async () => {
    const response = vaultFileResponse(file, 'pic.png', request())
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.equal(response.headers.get('content-security-policy'), null)
    assert.equal((await response.arrayBuffer()).byteLength, 100)
  })

  it('answers ranges for media seeking (Safari asks bytes=0-1 first)', async () => {
    const first = vaultFileResponse(file, 'clip.mp4', request({ Range: 'bytes=0-1' }))
    assert.equal(first.status, 206)
    assert.equal(first.headers.get('content-range'), 'bytes 0-1/100')
    assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [0, 1])
    const tail = vaultFileResponse(file, 'clip.mp4', request({ Range: 'bytes=-10' }))
    assert.equal(tail.headers.get('content-range'), 'bytes 90-99/100')
    const open = vaultFileResponse(file, 'clip.mp4', request({ Range: 'bytes=95-' }))
    assert.equal(open.headers.get('content-length'), '5')
    const outside = vaultFileResponse(file, 'clip.mp4', request({ Range: 'bytes=200-' }))
    assert.equal(outside.status, 416)
    assert.equal(outside.headers.get('content-range'), 'bytes */100')
  })

  it('parses only well-formed single ranges', () => {
    assert.equal(parseRange(null, 10), null)
    assert.equal(parseRange('bytes=1-2,4-5', 10), null)
    assert.equal(parseRange('items=0-1', 10), null)
    assert.deepEqual(parseRange('bytes=2-50', 10), { start: 2, end: 9 })
  })

  it('sandboxes anything that could run script as this origin', () => {
    for (const name of ['drawing.svg', 'page.html', 'notes.md', 'data.bin']) {
      const csp = vaultFileResponse(file, name, request()).headers.get('content-security-policy') ?? ''
      assert.match(csp, /^sandbox;/, name)
    }
    assert.equal(vaultFileResponse(file, 'page.html', request()).headers.get('content-type'), 'application/octet-stream')
    assert.equal(vaultFileResponse(file, 'doc.pdf', request()).headers.get('content-security-policy'), null)
  })

  it('answers 404 for a missing file and no body for HEAD', async () => {
    assert.equal(vaultFileResponse(null, 'gone.png', request()).status, 404)
    const head = vaultFileResponse(file, 'pic.png', request({}, 'HEAD'))
    assert.equal(head.status, 200)
    assert.equal(head.body, null)
  })
})

describe('IndexedDB HostStorage', () => {
  it('reads null only for a key that is not there', async () => {
    const storage = idbHostStorage('storage')
    assert.equal(await storage.read('zennotes-cloud-sync/links/a.json'), null)
    await storage.write('zennotes-cloud-sync/links/a.json', '{"vault_id":"v"}')
    assert.equal(await storage.read('zennotes-cloud-sync/links/a.json'), '{"vault_id":"v"}')
    await storage.remove('zennotes-cloud-sync/links/a.json')
    await storage.remove('zennotes-cloud-sync/links/a.json')
    assert.equal(await storage.read('zennotes-cloud-sync/links/a.json'), null)
  })

  it('throws, never answers null, when the database fails', async () => {
    const storage = idbHostStorage('storage')
    await storage.write('k', 'v')
    resetBrowserDbForTests()
    const original = globalThis.indexedDB
    globalThis.indexedDB = { open: () => { throw new Error('IndexedDB is not answering') } } as unknown as IDBFactory
    try {
      await assert.rejects(storage.read('k'), /not answering/)
    } finally {
      globalThis.indexedDB = original
      resetBrowserDbForTests()
    }
  })

  it('keeps storage and preferences apart', async () => {
    await idbHostStorage('storage').write('same', 'durable')
    assert.equal(await idbHostStorage('preferences').read('same'), null)
  })
})

describe('IndexedDB SecretStorage', () => {
  it('stores sealed values under a non-extractable key', async () => {
    const secrets = idbSecretStorage()
    assert.equal(secrets.available(), true)
    await secrets.prepare?.()
    await secrets.set('credential', 'token-123')
    assert.equal(await secrets.get('credential'), 'token-123')
    const stored = await idbGet<{ iv: Uint8Array; data: ArrayBuffer }>('secrets', 'credential')
    assert.ok(stored && !new TextDecoder().decode(stored.data).includes('token-123'))
    const key = await idbGet<CryptoKey>('keys', 'secrets-aes-gcm')
    assert.equal(key?.extractable, false)
    assert.deepEqual(await secrets.keys(), ['credential'])
    await secrets.remove('credential')
    assert.equal(await secrets.get('credential'), null)
  })
})

describe('fencing generations', () => {
  it('increase with every acquisition, per vault', async () => {
    assert.equal(await readFenceGeneration('try'), 0)
    assert.equal(await bumpFenceGeneration('try'), 1)
    assert.equal(await bumpFenceGeneration('try'), 2)
    assert.equal(await bumpFenceGeneration('other'), 1)
    assert.equal(await readFenceGeneration('try'), 2)
  })

  it('two tabs bumping at once never get the same generation', async () => {
    const results = await Promise.all([bumpFenceGeneration('try'), bumpFenceGeneration('try'), bumpFenceGeneration('try')])
    assert.deepEqual([...results].sort(), [1, 2, 3])
  })

  it('a worker opened with a generation refuses writes once a newer one exists', async () => {
    const origin = new FakeOpfs('chrome')
    const generation = await bumpFenceGeneration('try')
    const fs = new OpfsVaultFileSystem(
      'try',
      directTransport(createOpfsDispatcher({ root: async () => origin.root, currentGeneration: readFenceGeneration })),
      { generation }
    )
    await fs.init()
    await fs.writeText('a.md', 'first owner')
    await bumpFenceGeneration('try')
    await assert.rejects(fs.writeText('a.md', 'late write'), /another tab/)
    assert.equal(await fs.readText('a.md'), 'first owner')
  })
})

describe('Download as a folder', () => {
  it('zips every file under one folder named after the vault', async () => {
    const origin = new FakeOpfs('firefox')
    const fs = new OpfsVaultFileSystem('try', directTransport(createOpfsDispatcher({ root: async () => origin.root })), { generation: 0 })
    await fs.init()
    await fs.writeText('inbox/demo/00 Start Here.md', '# Start\n')
    await fs.writeText('.zennotes/vault.json', '{}')
    await fs.writeBase64('assets/pic.png', 'iVBORw0KGgo=')
    const { blob, fileCount } = await buildVaultArchive(fs, 'Try ZenNotes')
    assert.equal(fileCount, 3)
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    assert.deepEqual(Object.keys(entries).sort(), [
      'Try ZenNotes/.zennotes/vault.json',
      'Try ZenNotes/assets/pic.png',
      'Try ZenNotes/inbox/demo/00 Start Here.md'
    ])
    assert.equal(new TextDecoder().decode(entries['Try ZenNotes/inbox/demo/00 Start Here.md']), '# Start\n')
    assert.deepEqual([...entries['Try ZenNotes/assets/pic.png']!], [...Buffer.from('iVBORw0KGgo=', 'base64')])
  })

  it('names the folder something every file system accepts', () => {
    assert.equal(archiveFolderName('Work: notes/2026'), 'Work notes 2026')
    assert.equal(archiveFolderName('   '), 'ZenNotes vault')
  })
})

describe("Safari's seven-day note", () => {
  it('shows for WebKit browsers only', () => {
    const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15'
    const iosChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0 Mobile/15E148 Safari/604.1'
    const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
    const firefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:160.0) Gecko/20100101 Firefox/160.0'
    assert.equal(isWebKitBrowser(safari), true)
    assert.equal(isWebKitBrowser(iosChrome), true)
    assert.equal(isWebKitBrowser(chrome), false)
    assert.equal(isWebKitBrowser(firefox), false)
  })
})
