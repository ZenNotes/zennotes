/**
 * Attachments on open (cloud-sync-stubs.ts) through the real Cloud glue:
 * mobile-cloud-sync's host vault -> CloudSyncHostService -> coordinator ->
 * CachedCloudSyncRepository -> NativeCloudStaging, over a vault folder that
 * stubs the way the browser's OPFS worker does. Only the server and the
 * folder's bytes are fakes.
 *
 * The invariants (docs/ideas/cloud-in-browser.md): a stub never causes an
 * upload, never causes a delete unless the person deletes it, moves as a move,
 * and survives a rename of its folder. Around them: stub by kind and size,
 * never by wire shape; a remote change replaces a stub with a stub; a first
 * sync removes stubs before it scans; hydration writes the checked bytes only
 * where the stub still is; review actions and unlinking hydrate first; and
 * eviction touches only synced attachments.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, describe, it, vi } from 'vitest'
import type {
  CloudSyncChange,
  CloudSyncContent,
  CloudSyncContentReference,
  CloudSyncManifestItem,
  CloudSyncMutation
} from '@zennotes/bridge-contract/cloud-sync'
import type { CloudSyncState } from '@zennotes/shared-domain/cloud-sync-engine'
import { createTestHost } from '../test/test-host'
import type { CloudFileFingerprint } from './host'
import { MemoryVaultFileSystem } from './memory-fs'
import { CLOUD_STUB_MAX_BYTES, decodeCloudStub, encodeCloudStub, type CloudStubRecord } from './cloud-stub-format'

const MiB = 1024 * 1024
/** What this fake Cloud sends inline when content is asked for; above it, a
 *  reference (the real service decides by its page budget too). */
const INLINE_LIMIT = 64 * 1024

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function bytesOf(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + seed) & 0xff
  return bytes
}

function mediaTypeOf(path: string): string {
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.pdf')) return 'application/pdf'
  if (path.endsWith('.md')) return 'text/markdown'
  return 'application/octet-stream'
}

/** A vault folder with the sync fast path and stubs, as opfs-fs.ts is. */
class StubbingFolder extends MemoryVaultFileSystem {
  readonly fetched: string[] = []
  constructor(readonly bucket: Map<string, Uint8Array>) {
    super('browser/test', 'opfs://vaults/test')
  }

  stub(path: string): CloudStubRecord | null {
    const file = this.files.get(path)
    return file && file.bytes.byteLength <= CLOUD_STUB_MAX_BYTES ? decodeCloudStub(file.bytes) : null
  }

  bytes(path: string): Uint8Array | undefined {
    return this.files.get(path)?.bytes
  }

  async readForSync(path: string, textCandidate: boolean): Promise<CloudFileFingerprint> {
    const bytes = Buffer.from(await super.readBase64(path), 'base64')
    const stub = bytes.byteLength <= CLOUD_STUB_MAX_BYTES ? decodeCloudStub(bytes) : null
    if (stub) {
      return { uri: `opfs:${path}`, sha256: stub.sha256, byteLength: stub.byte_length, utf8: false, stub: { mediaType: stub.media_type } }
    }
    let utf8 = false
    if (textCandidate) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        utf8 = true
      } catch {
        utf8 = false
      }
    }
    return {
      uri: `opfs:${path}`,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      utf8,
      ...(bytes.byteLength <= 5 * MiB ? { inlineBase64: bytes.toString('base64') } : {})
    }
  }

  async copyForSync(from: string, to: string): Promise<void> {
    if (this.stub(from)) throw new Error(`${from} is a stub`)
    await this.copy(from, to)
  }

  async download(options: { url: string; to: string; byteLength: number; sha256: string }): Promise<void> {
    this.fetched.push(options.url)
    const bytes = this.bucket.get(options.url)
    if (!bytes) throw Object.assign(new Error('missing object'), { code: 'DIRECT_DOWNLOAD_FAILED', status: 404 })
    if (bytes.byteLength !== options.byteLength || sha256(bytes) !== options.sha256) throw new Error('bad download')
    await this.writeBase64(options.to, Buffer.from(bytes).toString('base64'))
  }

  async readHeader(): Promise<string> {
    throw new Error('not in this test')
  }

  async decryptFile(): Promise<{ byteLength: number; sha256: string }> {
    throw new Error('not in this test')
  }

  async sealForUpload(): Promise<never> {
    throw new Error('not in this test')
  }

  async writeCloudStub(path: string, stub: CloudStubRecord): Promise<void> {
    await this.writeBase64(path, Buffer.from(encodeCloudStub(stub)).toString('base64'))
  }

  async readCloudStub(path: string): Promise<CloudStubRecord | null> {
    return this.stub(path)
  }

  async replaceCloudStub(from: string, to: string, expected: CloudStubRecord): Promise<boolean> {
    const current = this.stub(to)
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false
    await this.deleteFile(to)
    await this.rename(from, to)
    return true
  }

  async evictToCloudStub(path: string, expected: { size: number; mtime: number; sha256: string }, stub: CloudStubRecord): Promise<boolean> {
    const stat = await this.statOrNull(path)
    if (stat?.size !== expected.size || stat.mtime !== expected.mtime) return false
    await this.writeCloudStub(path, stub)
    return true
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('./mobile-cloud-auth')
  vi.resetModules()
})

async function fixture(options: { stubs?: boolean; encrypted?: boolean } = {}) {
  const bucket = new Map<string, Uint8Array>()
  const folder = new StubbingFolder(bucket)
  const items = new Map<string, CloudSyncManifestItem>()
  const bodies = new Map<string, Uint8Array>()
  const feed: CloudSyncChange[] = []
  const uploaded: CloudSyncMutation[] = []
  const downloadRequests: string[] = []
  const unanswered = new Set<string>()
  /** Readable while the fixture's sync pulls; ciphertext once a test says so. */
  const sealedDownloads = { on: false }
  let cursor = 0
  let nextId = 1

  const reference = (item: CloudSyncManifestItem): CloudSyncContentReference => ({
    item_id: item.item_id, revision: item.revision, encoding: item.kind === 'text' ? 'utf8' : 'base64',
    sha256: item.sha256, byte_length: item.byte_length, media_type: item.media_type
  })
  const inline = (item: CloudSyncManifestItem): CloudSyncContent => {
    const bytes = bodies.get(`${item.item_id}:${item.revision}`)!
    return item.kind === 'text'
      ? { encoding: 'utf8', data: new TextDecoder().decode(bytes), sha256: item.sha256, byte_length: item.byte_length, media_type: item.media_type }
      : { encoding: 'base64', data: Buffer.from(bytes).toString('base64'), sha256: item.sha256, byte_length: item.byte_length, media_type: item.media_type }
  }
  /** Inline when small, a reference otherwise: the wire shape is the
   *  server's choice, never what decides a stub. */
  const withContent = <T extends CloudSyncManifestItem>(item: T): T => {
    const { content: _content, content_ref: _ref, ...rest } = item as T & { content_ref?: unknown }
    return (item.byte_length <= INLINE_LIMIT ? { ...rest, content: inline(item) } : { ...rest, content_ref: reference(item) }) as T
  }

  function remoteFile(path: string, bytes: Uint8Array, kind: 'text' | 'binary' = path.endsWith('.md') ? 'text' : 'binary') {
    const previous = [...items.values()].find((item) => item.path === path)
    const itemId = previous?.item_id ?? `remote-${nextId++}`
    const revision = (previous?.revision ?? 0) + 1
    const item: CloudSyncManifestItem = {
      item_id: itemId, path, kind, revision, sha256: sha256(bytes), byte_length: bytes.byteLength, media_type: mediaTypeOf(path)
    }
    items.set(itemId, item)
    bodies.set(`${itemId}:${revision}`, bytes)
    bucket.set(`https://bucket.example.test/${itemId}/${revision}`, bytes)
    feed.push({ sequence: ++cursor, item_id: itemId, type: 'upsert', path, previous_path: previous?.path ?? null, revision,
      ...(bytes.byteLength <= INLINE_LIMIT ? { content: inline(item) } : { content_ref: reference(item) }) })
    return item
  }

  const remote = {
    negotiateContentReferences: async () => true,
    allowInsecureLoopbackDownloads: false,
    listVaults: async () => ({ data: [{ id: 'vault-1', name: 'Test vault' }] }),
    manifest: async (_vaultId: string, options?: { includeContent?: boolean }) => ({
      // Reference mode: metadata with a reference for every item, or content
      // (inline when small) when asked for.
      data: [...items.values()].map((item) => (options?.includeContent ? withContent(item) : { ...item, content_ref: reference(item) })),
      cursor,
      next_page: null
    }),
    changes: async (_vaultId: string, after: number) => ({ data: feed.filter((change) => change.sequence > after), cursor, has_more: false }),
    revision: async (_vaultId: string, itemId: string, revision: number) => {
      const item = items.get(itemId)
      assert.ok(item && item.revision === revision)
      return { data: { ...withContent(item), deleted: false } }
    },
    download: async (_vaultId: string, itemId: string, revision: number) => {
      downloadRequests.push(`${itemId}:${revision}`)
      const item = items.get(itemId)
      const bytes = bodies.get(`${itemId}:${revision}`)
      assert.ok(item && bytes)
      if (sealedDownloads.on && unanswered.has(itemId)) throw new Error('the service would not say')
      return {
        data: {
          item_id: itemId, revision,
          content: sealedDownloads.on
            ? { encoding: 'aes-gcm', sha256: 'c'.repeat(64), byte_length: bytes.byteLength + 90, media_type: 'application/octet-stream' }
            : { encoding: item.kind === 'text' ? 'utf8' : 'base64', sha256: sha256(bytes), byte_length: bytes.byteLength, media_type: item.media_type },
          download: { method: 'GET', url: `https://bucket.example.test/${itemId}/${revision}`, headers: {}, expires_at: new Date(Date.now() + 600_000).toISOString() }
        }
      }
    },
    mutate: async (_vaultId: string, request: { mutations: CloudSyncMutation[] }) => {
      uploaded.push(...JSON.parse(JSON.stringify(request.mutations)))
      const acknowledged = request.mutations.map((mutation) => {
        const previous = items.get(mutation.item_id)
        const revision = (previous?.revision ?? 0) + 1
        if (mutation.type === 'upsert') {
          const bytes = mutation.content.encoding === 'utf8'
            ? new TextEncoder().encode(mutation.content.data)
            : new Uint8Array(Buffer.from(mutation.content.data, 'base64'))
          const item: CloudSyncManifestItem = {
            item_id: mutation.item_id, path: mutation.path, kind: mutation.kind, revision,
            sha256: mutation.content.sha256, byte_length: mutation.content.byte_length, media_type: mutation.content.media_type
          }
          items.set(item.item_id, item)
          bodies.set(`${item.item_id}:${revision}`, bytes)
          bucket.set(`https://bucket.example.test/${item.item_id}/${revision}`, bytes)
          feed.push({ sequence: ++cursor, item_id: item.item_id, type: 'upsert', path: item.path, previous_path: previous?.path ?? null, revision,
            ...(bytes.byteLength <= INLINE_LIMIT ? { content: inline(item) } : { content_ref: reference(item) }) })
        } else {
          assert.ok(previous)
          if (mutation.type === 'delete') items.delete(mutation.item_id)
          else {
            items.set(mutation.item_id, { ...previous, path: mutation.path, revision })
            bodies.set(`${mutation.item_id}:${revision}`, bodies.get(`${mutation.item_id}:${previous.revision}`)!)
          }
          feed.push({ sequence: ++cursor, item_id: mutation.item_id, type: mutation.type,
            path: mutation.type === 'move' ? mutation.path : previous.path, previous_path: previous.path, revision })
        }
        return { operation_id: mutation.operation_id, item_id: mutation.item_id, revision, sequence: cursor }
      })
      return { acknowledged, conflicts: [], cursor }
    }
  }

  vi.resetModules()
  const credential = {
    base_url: 'https://sync.example.test', token: 'test-only',
    account: { base_url: 'https://sync.example.test', user: { email: 'test@example.test' } }
  }
  vi.doMock('./mobile-cloud-auth', () => ({
    MOBILE_END_TO_END_ENCRYPTION: true,
    authenticatedClient: async () => remote,
    authenticatedCredential: async () => credential,
    getMobileCloudAccountStatus: async () => ({ state: 'connected', account: { base_url: 'https://sync.example.test' } }),
    mobileCloudAccountKeyStore: () => ({ load: async () => null, save: async () => {}, clear: async () => {} }),
    mobileCloudCredentialScope: () => 'test-scope',
    mobileCloudKeyring: () => ({ remember() {}, forget() {}, forVault: async () => (options.encrypted ? {} : null) })
  }))
  const host = { ...createTestHost(), ...(options.stubs === false ? {} : { cloudStubs: { enabled: () => true } }) }
  const { installPortableHost } = await import('./host')
  installPortableHost(host)
  const { PortableVault } = await import('./vault-fs')
  const api = await import('./mobile-cloud-sync')
  const vault = new PortableVault('test', folder)
  vi.spyOn(vault, 'rescan').mockImplementation(async () => {})
  await api.linkMobileCloudVault(vault, 'vault-1')
  const persisted = host.storage.values
  const stateKey = () => [...persisted.keys()].find((path) => path.includes('/states/'))
  return {
    api, vault, folder, items, uploaded, downloadRequests, remoteFile, unanswered, sealedDownloads,
    sync: () => api.syncMobileCloudVault(vault),
    clearUploads: () => { uploaded.length = 0 },
    clearState: () => { const key = stateKey(); if (key) persisted.delete(key) },
    state: (): CloudSyncState => JSON.parse(persisted.get(stateKey()!)!)
  }
}

const NOTE = new TextEncoder().encode('# A note\n\nWith a picture: ![[assets/photo.png]]\n')

describe('attachments on open: what arrives as a stub', () => {
  it('writes a large binary as a stub and downloads nothing for it, notes in full', async () => {
    const h = await fixture()
    h.remoteFile('note.md', NOTE)
    const photo = h.remoteFile('assets/photo.png', bytesOf(2 * MiB, 1))
    await h.sync()
    assert.equal(new TextDecoder().decode(h.folder.bytes('note.md')), new TextDecoder().decode(NOTE))
    const stub = h.folder.stub('assets/photo.png')
    assert.ok(stub)
    assert.equal(stub.item_id, photo.item_id)
    assert.equal(stub.sha256, photo.sha256)
    assert.equal(stub.byte_length, 2 * MiB)
    assert.equal(stub.media_type, 'image/png')
    assert.deepEqual(h.folder.fetched, [])
    assert.equal(h.uploaded.length, 0)
  })

  it('decides by kind and size, never by whether it came inline or as a reference', async () => {
    const h = await fixture()
    // A reference that is a note: written in full, however large.
    const bigNote = new TextEncoder().encode(`# Long\n\n${'words '.repeat(300_000)}`)
    h.remoteFile('long.md', bigNote)
    // A reference that is a small attachment: below the threshold, in full.
    h.remoteFile('assets/small.png', bytesOf(200 * 1024, 2))
    // Inline and tiny: in full.
    h.remoteFile('assets/icon.png', bytesOf(4 * 1024, 3))
    // A reference above the threshold: a stub.
    h.remoteFile('assets/manual.pdf', bytesOf(3 * MiB, 4))
    await h.sync()
    assert.equal(h.folder.bytes('long.md')?.byteLength, bigNote.byteLength)
    assert.equal(h.folder.stub('long.md'), null)
    assert.equal(h.folder.bytes('assets/small.png')?.byteLength, 200 * 1024)
    assert.equal(h.folder.bytes('assets/icon.png')?.byteLength, 4 * 1024)
    assert.ok(h.folder.stub('assets/manual.pdf'))
  })

  it('mirrors everything when the host keeps attachments', async () => {
    const h = await fixture({ stubs: false })
    h.remoteFile('assets/photo.png', bytesOf(2 * MiB, 5))
    await h.sync()
    assert.equal(h.folder.stub('assets/photo.png'), null)
    assert.equal(h.folder.bytes('assets/photo.png')?.byteLength, 2 * MiB)
  })
})

describe('attachments on open: the invariants', () => {
  it('never uploads a stub, scan after scan', async () => {
    const h = await fixture()
    h.remoteFile('assets/photo.png', bytesOf(2 * MiB, 6))
    await h.sync()
    for (let run = 0; run < 3; run += 1) await h.sync()
    assert.deepEqual(h.uploaded, [])
  })

  it('never deletes the attachment unless the person deletes the stub', async () => {
    const h = await fixture()
    const photo = h.remoteFile('assets/photo.png', bytesOf(2 * MiB, 7))
    await h.sync()
    await h.sync()
    assert.ok(h.items.has(photo.item_id))
    assert.deepEqual(h.uploaded.filter((mutation) => mutation.type === 'delete'), [])
    // The person deletes it: that delete is theirs, and goes up.
    await h.folder.deleteFile('assets/photo.png')
    await h.sync()
    assert.deepEqual(h.uploaded.map((mutation) => mutation.type), ['delete'])
    assert.ok(!h.items.has(photo.item_id))
  })

  it('moves as a move', async () => {
    const h = await fixture()
    const photo = h.remoteFile('assets/photo.png', bytesOf(2 * MiB, 8))
    await h.sync()
    await h.folder.rename('assets/photo.png', 'assets/renamed.png')
    await h.sync()
    assert.equal(h.uploaded.length, 1)
    assert.equal(h.uploaded[0]!.type, 'move')
    assert.equal(h.items.get(photo.item_id)?.path, 'assets/renamed.png')
    assert.ok(h.folder.stub('assets/renamed.png'))
    assert.deepEqual(h.folder.fetched, [])
  })

  it('survives a rename of its folder', async () => {
    const h = await fixture()
    h.remoteFile('trip/notes.md', NOTE)
    const photo = h.remoteFile('trip/photo.png', bytesOf(2 * MiB, 9))
    await h.sync()
    await h.folder.rename('trip', 'travel')
    await h.sync()
    assert.deepEqual(h.uploaded.map((mutation) => mutation.type).sort(), ['move', 'move'])
    assert.equal(h.items.get(photo.item_id)?.path, 'travel/photo.png')
    const stub = h.folder.stub('travel/photo.png')
    assert.ok(stub)
    assert.equal(stub.sha256, photo.sha256)
    assert.deepEqual(h.folder.fetched, [])
  })

  it('replaces a stub with a new stub when the attachment changes in Cloud', async () => {
    const h = await fixture()
    h.remoteFile('assets/photo.png', bytesOf(2 * MiB, 10))
    await h.sync()
    const changed = h.remoteFile('assets/photo.png', bytesOf(2 * MiB + 5, 11))
    await h.sync()
    const stub = h.folder.stub('assets/photo.png')
    assert.ok(stub)
    assert.equal(stub.revision, 2)
    assert.equal(stub.sha256, changed.sha256)
    assert.deepEqual(h.folder.fetched, [])
    assert.deepEqual(h.uploaded, [])
  })

  it('removes stubs before a first sync scans, so a lost state raises no conflict', async () => {
    const h = await fixture()
    h.remoteFile('assets/photo.png', bytesOf(2 * MiB, 12))
    await h.sync()
    h.clearState()
    const summary = await h.sync()
    assert.equal(summary.bootstrap_conflicts?.length ?? 0, 0)
    assert.deepEqual(h.uploaded, [])
    // Cloud still has it, and it arrived again the same way.
    assert.ok(h.folder.stub('assets/photo.png'))
  })
})

describe('attachments on open: hydration', () => {
  it('downloads the recorded revision, checks it and writes it in the stub’s place', async () => {
    const h = await fixture()
    const bytes = bytesOf(2 * MiB, 13)
    h.remoteFile('assets/photo.png', bytes)
    await h.sync()
    assert.equal(await h.api.hydrateMobileCloudStub(h.vault, 'assets/photo.png'), true)
    assert.equal(h.folder.stub('assets/photo.png'), null)
    assert.equal(sha256(h.folder.bytes('assets/photo.png')!), sha256(bytes))
    // Hydrated bytes are the synced bytes: nothing goes up, nothing comes down again.
    await h.sync()
    assert.deepEqual(h.uploaded, [])
    assert.equal(h.folder.fetched.length, 1)
    // A real file is not a stub: nothing to do.
    assert.equal(await h.api.hydrateMobileCloudStub(h.vault, 'assets/photo.png'), false)
  })

  it('drops the download when the stub changed while it ran', async () => {
    const h = await fixture()
    h.remoteFile('assets/photo.png', bytesOf(2 * MiB, 14))
    await h.sync()
    const replace = h.folder.replaceCloudStub.bind(h.folder)
    vi.spyOn(h.folder, 'replaceCloudStub').mockImplementation(async (from, to, expected) => {
      // The person moved it away meanwhile.
      await h.folder.rename('assets/photo.png', 'assets/moved.png')
      return replace(from, to, expected)
    })
    assert.equal(await h.api.hydrateMobileCloudStub(h.vault, 'assets/photo.png'), false)
    assert.ok(h.folder.stub('assets/moved.png'))
    assert.equal(await h.folder.statVerified('assets/photo.png'), null)
  })

  it('lists stubs and hydrates every one before unlinking', async () => {
    const h = await fixture()
    h.remoteFile('note.md', NOTE)
    h.remoteFile('assets/a.png', bytesOf(2 * MiB, 15))
    h.remoteFile('assets/b.pdf', bytesOf(3 * MiB, 16))
    await h.sync()
    assert.deepEqual((await h.api.listMobileCloudStubs(h.vault)).map((entry) => entry.path).sort(), ['assets/a.png', 'assets/b.pdf'])
    await h.api.unlinkMobileCloudVault(h.vault)
    assert.equal(h.folder.stub('assets/a.png'), null)
    assert.equal(h.folder.stub('assets/b.pdf'), null)
    assert.equal(await h.api.getMobileCloudVaultLink(h.vault), null)
  })

  it('stays linked when an attachment cannot be brought here before unlinking', async () => {
    const h = await fixture()
    const photo = h.remoteFile('assets/a.png', bytesOf(2 * MiB, 17))
    await h.sync()
    h.folder.bucket.delete(`https://bucket.example.test/${photo.item_id}/1`)
    await assert.rejects(h.api.unlinkMobileCloudVault(h.vault), /still only in ZenNotes Cloud/)
    assert.ok(await h.api.getMobileCloudVaultLink(h.vault))
    assert.ok(h.folder.stub('assets/a.png'))
  })
})

describe('attachments on open: eviction', () => {
  it('turns synced attachments back into stubs, never a changed file or a note', async () => {
    const h = await fixture({ stubs: false })
    h.remoteFile('note.md', NOTE)
    const kept = h.remoteFile('assets/kept.png', bytesOf(2 * MiB, 18))
    h.remoteFile('assets/edited.png', bytesOf(2 * MiB, 19))
    h.remoteFile('assets/tiny.png', bytesOf(10 * 1024, 20))
    await h.sync()
    // A local edit Cloud has not received yet.
    h.folder.put('assets/edited.png', bytesOf(2 * MiB, 21))
    const result = await h.api.evictMobileCloudAttachments(h.vault)
    assert.equal(result.stubbed, 1)
    assert.equal(result.freedBytes, 2 * MiB)
    const stub = h.folder.stub('assets/kept.png')
    assert.ok(stub)
    assert.equal(stub.item_id, kept.item_id)
    assert.equal(h.folder.stub('assets/edited.png'), null)
    assert.equal(h.folder.stub('assets/tiny.png'), null)
    assert.equal(h.folder.stub('note.md'), null)
    // The evicted one is still synced: only the local edit goes up.
    h.clearUploads()
    await h.sync()
    assert.deepEqual(h.uploaded.map((mutation) => [mutation.type, 'path' in mutation ? mutation.path : null]), [['upsert', 'assets/edited.png']])
    assert.ok(h.folder.stub('assets/kept.png'))
  })

  it('records an encrypted file’s ciphertext in its stub, or leaves the file when the service would not say', async () => {
    const h = await fixture({ stubs: false, encrypted: true })
    h.remoteFile('assets/kept.png', bytesOf(2 * MiB, 30))
    const quiet = h.remoteFile('assets/quiet.png', bytesOf(2 * MiB, 31))
    await h.sync()
    h.sealedDownloads.on = true
    h.unanswered.add(quiet.item_id)
    const result = await h.api.evictMobileCloudAttachments(h.vault)
    assert.equal(result.stubbed, 1)
    assert.deepEqual(h.folder.stub('assets/kept.png')?.encrypted, { sha256: 'c'.repeat(64), byte_length: 2 * MiB + 90 })
    assert.equal(h.folder.stub('assets/quiet.png'), null)
  })

  it('takes them in the order the host gives, until enough is free', async () => {
    const h = await fixture({ stubs: false })
    h.remoteFile('assets/old.png', bytesOf(2 * MiB, 22))
    h.remoteFile('assets/new.png', bytesOf(2 * MiB, 23))
    await h.sync()
    const result = await h.api.evictMobileCloudAttachments(h.vault, {
      targetBytes: 1,
      order: (candidates) => candidates.map((candidate) => candidate.path).sort((left) => (left.includes('old') ? -1 : 1))
    })
    assert.equal(result.stubbed, 1)
    assert.ok(h.folder.stub('assets/old.png'))
    assert.equal(h.folder.stub('assets/new.png'), null)
  })
})
