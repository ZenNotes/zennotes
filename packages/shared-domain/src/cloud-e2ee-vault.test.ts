import type {
  CloudBackupSnapshotItem,
  CloudEncryptionKeyset,
  CloudEncryptionKeysetCreate,
  CloudEncryptionKeysetUpdate,
  CloudSyncContent,
  CloudSyncMutation,
  CloudSyncUpsertMutation,
  CloudSyncVault
} from '@zennotes/bridge-contract/cloud-sync'
import { describe, expect, it } from 'vitest'
import {
  CloudE2eeKeyring,
  type CloudAccountKeyStore,
  type CloudKeysetApi,
  type StoredCloudAccountKey,
  changeCloudEncryptionPassphrase,
  cloudPassphraseProblem,
  prepareCloudEncryptionSetup,
  prepareNewCloudRecoveryKey,
  unlockCloudEncryption
} from './cloud-e2ee-account'
import { CloudE2eeError, fromBase64, sha256Hex, toBase64 } from './cloud-e2ee'
import { CLOUD_E2EE_HEADER, CloudE2eeLockedError } from './cloud-e2ee-vault'
import {
  CloudSyncApiClient,
  CloudSyncRateLimitCoordinator,
  type CloudSyncHttpRequest,
  type CloudSyncHttpTransport
} from './cloud-sync-api'
import { CloudSyncTransportError } from './cloud-sync-stall'
import { validateCloudSyncContentReference, validateCloudSyncDownloadInstruction } from './cloud-sync-content'

const PASSPHRASE = 'quiet harbor lantern orbit'

class MemoryKeysetApi implements CloudKeysetApi {
  keyset: CloudEncryptionKeyset | null = null

  async getKeyset() {
    return this.keyset ? structuredClone(this.keyset) : null
  }

  async createKeyset(body: CloudEncryptionKeysetCreate) {
    if (this.keyset) throw Object.assign(new Error('exists'), { status: 409, code: 'KEYSET_EXISTS' })
    this.keyset = { ...structuredClone(body), revision: 1, updated_at: new Date().toISOString() }
    return structuredClone(this.keyset)
  }

  async updateKeyset(body: CloudEncryptionKeysetUpdate) {
    if (!this.keyset || body.expected_revision !== this.keyset.revision) {
      throw Object.assign(new Error('conflict'), { status: 409, code: 'KEYSET_REVISION_CONFLICT' })
    }
    const { expected_revision: _revision, ...changes } = body
    this.keyset = { ...this.keyset, ...structuredClone(changes), revision: this.keyset.revision + 1 }
    return structuredClone(this.keyset)
  }
}

class MemoryKeyStore implements CloudAccountKeyStore {
  value: StoredCloudAccountKey | null = null
  async load() {
    return this.value
  }
  async save(value: StoredCloudAccountKey) {
    this.value = { ...value }
  }
  async clear() {
    this.value = null
  }
}

interface StoredItem {
  item_id: string
  path: string
  kind: string
  revision: number
  meta: string | null
  content: CloudSyncContent | null
}

/**
 * Plays ZenNotes Cloud with only what the real service can see: whatever the
 * client sends. Tests read `requests` to prove nothing readable left.
 */
class FakeCloud implements CloudSyncHttpTransport {
  requests: CloudSyncHttpRequest[] = []
  vaults: CloudSyncVault[] = []
  items = new Map<string, StoredItem>()
  backupPages: CloudBackupSnapshotItem[][] = []
  conflictNext: { item_id: string; current_path: string; current_meta: string | null } | null = null

  async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
    this.requests.push(structuredClone(request))
    const path = request.path.split('?')[0]!
    const query = new URLSearchParams(request.path.split('?')[1] ?? '')
    if (request.method === 'GET' && path === '/api/v1/vaults') return { data: this.vaults } as Response
    if (request.method === 'POST' && path === '/api/v1/vaults') {
      const body = request.body as { name: string; encryption?: CloudSyncVault['encryption'] }
      const vault: CloudSyncVault = {
        id: `vault-${this.vaults.length + 1}`,
        name: body.name,
        cursor: 0,
        created_at: '2026-10-12T00:00:00Z',
        updated_at: '2026-10-12T00:00:00Z',
        encryption: body.encryption ?? null
      }
      this.vaults.push(vault)
      return { data: vault } as Response
    }
    if (request.method === 'POST' && path.endsWith('/mutations')) {
      const { mutations } = request.body as { mutations: CloudSyncMutation[] }
      const acknowledged = []
      for (const mutation of mutations) {
        const previous = this.items.get(mutation.item_id)
        const revision = (previous?.revision ?? 0) + 1
        if (mutation.type === 'upsert') {
          this.items.set(mutation.item_id, {
            item_id: mutation.item_id,
            path: mutation.path,
            kind: mutation.kind,
            revision,
            meta: mutation.meta ?? null,
            content: mutation.content
          })
        } else if (mutation.type === 'move' && previous) {
          this.items.set(mutation.item_id, { ...previous, path: mutation.path, meta: mutation.meta ?? null, revision })
        } else if (mutation.type === 'delete') {
          this.items.delete(mutation.item_id)
        }
        acknowledged.push({ operation_id: mutation.operation_id, item_id: mutation.item_id, revision, sequence: revision })
      }
      const conflicts = this.conflictNext
        ? [{ operation_id: 'op-conflict', code: 'PATH_CONFLICT', current_revision: 1, ...this.conflictNext }]
        : []
      this.conflictNext = null
      return { acknowledged, conflicts, cursor: 1 } as Response
    }
    if (request.method === 'GET' && path.endsWith('/manifest')) {
      const data = [...this.items.values()].map((item) => ({
        item_id: item.item_id,
        path: item.path,
        kind: item.kind,
        revision: item.revision,
        sha256: item.content!.sha256,
        byte_length: item.content!.byte_length,
        media_type: item.content!.media_type,
        meta: item.meta,
        content: item.content
      }))
      return { data, cursor: 1, next_page: null } as Response
    }
    if (request.method === 'GET' && path.includes('/backups/') && path.endsWith('/items')) {
      const page = Number(query.get('page') ?? '1')
      return {
        data: this.backupPages[page - 1] ?? [],
        meta: { current_page: page, last_page: this.backupPages.length, per_page: 50, total: 0 }
      } as Response
    }
    throw new Error(`Unexpected request ${request.method} ${request.path}`)
  }
}

async function utf8Content(text: string, mediaType = 'text/markdown'): Promise<CloudSyncContent> {
  const bytes = new TextEncoder().encode(text)
  return { encoding: 'utf8', data: text, sha256: await sha256Hex(bytes), byte_length: bytes.byteLength, media_type: mediaType }
}

async function binaryContent(bytes: Uint8Array, mediaType = 'image/png'): Promise<CloudSyncContent> {
  return { encoding: 'base64', data: toBase64(bytes), sha256: await sha256Hex(bytes), byte_length: bytes.byteLength, media_type: mediaType }
}

async function encryptedSetup() {
  const api = new MemoryKeysetApi()
  const store = new MemoryKeyStore()
  const setup = await prepareCloudEncryptionSetup(api, store, PASSPHRASE)
  await setup.finish()
  const cloud = new FakeCloud()
  const keyring = new CloudE2eeKeyring({ listVaults: async () => cloud.vaults, store })
  const client = new CloudSyncApiClient(cloud, { endToEndEncryption: true, vaultCiphers: keyring })
  const stored = store.value!
  const vault = (await client.createEncryptedVault('Private journal', fromBase64(stored.key), stored.version)).data
  const readable = (await client.createVault('Open notes')).data
  return { api, store, cloud, keyring, client, vault, readable, setup }
}

describe('account setup and unlock', () => {
  it('changes nothing on the service until the recovery key is confirmed', async () => {
    const api = new MemoryKeysetApi()
    const store = new MemoryKeyStore()
    const setup = await prepareCloudEncryptionSetup(api, store, PASSPHRASE)
    expect(setup.recoveryWords).toHaveLength(24)
    expect(api.keyset).toBeNull()
    expect(store.value).toBeNull()
    await setup.finish()
    expect(api.keyset?.revision).toBe(1)
    expect(store.value?.version).toBe(1)
    // Neither secret is in what the service stores.
    const serialized = JSON.stringify(api.keyset)
    expect(serialized).not.toContain(PASSPHRASE)
    expect(serialized).not.toContain(setup.recoveryWords.join(' '))
  }, 20_000)

  it('unlocks another device with the passphrase or the recovery words, and refuses a wrong one', async () => {
    const api = new MemoryKeysetApi()
    const first = new MemoryKeyStore()
    const setup = await prepareCloudEncryptionSetup(api, first, PASSPHRASE)
    await setup.finish()

    const second = new MemoryKeyStore()
    await unlockCloudEncryption(api, second, { passphrase: PASSPHRASE })
    expect(second.value?.key).toBe(first.value?.key)

    const third = new MemoryKeyStore()
    await unlockCloudEncryption(api, third, { recoveryWords: setup.recoveryWords.join(' ') })
    expect(third.value?.key).toBe(first.value?.key)

    await expect(unlockCloudEncryption(api, new MemoryKeyStore(), { passphrase: 'not the passphrase at all' }))
      .rejects.toThrow("That passphrase didn't work.")
  }, 30_000)

  it('changes the passphrase and replaces the recovery key without touching the account key', async () => {
    const api = new MemoryKeysetApi()
    const store = new MemoryKeyStore()
    const setup = await prepareCloudEncryptionSetup(api, store, PASSPHRASE)
    await setup.finish()
    const accountKey = store.value!.key

    await changeCloudEncryptionPassphrase(api, store, { passphrase: PASSPHRASE }, 'velvet canyon morning drum')
    await expect(unlockCloudEncryption(api, new MemoryKeyStore(), { passphrase: PASSPHRASE })).rejects.toThrow(/didn't work/)
    const afterChange = new MemoryKeyStore()
    await unlockCloudEncryption(api, afterChange, { passphrase: 'velvet canyon morning drum' })
    expect(afterChange.value?.key).toBe(accountKey)

    const replacement = await prepareNewCloudRecoveryKey(api, store, { recoveryWords: setup.recoveryWords.join(' ') })
    await replacement.finish()
    await expect(unlockCloudEncryption(api, new MemoryKeyStore(), { recoveryWords: setup.recoveryWords.join(' ') }))
      .rejects.toThrow(/didn't work/)
    const viaNewWords = new MemoryKeyStore()
    await unlockCloudEncryption(api, viaNewWords, { recoveryWords: replacement.recoveryWords.join(' ') })
    expect(viaNewWords.value?.key).toBe(accountKey)
    expect(api.keyset?.revision).toBe(3)
  }, 60_000)

  it('refuses short or repetitive passphrases', () => {
    expect(cloudPassphraseProblem('short one')).toMatch(/at least 12/)
    expect(cloudPassphraseProblem('aaaaaaaaaaaaaaaa')).toMatch(/variety/)
    expect(cloudPassphraseProblem(PASSPHRASE)).toBeNull()
  })
})

describe('encrypted vault sync through the API client', () => {
  it('sends only path ids, sealed metadata and ciphertext, and reads them back as plaintext', async () => {
    const { cloud, client, vault } = await encryptedSetup()
    expect(vault.name).toBe('Encrypted vault')
    const note = await utf8Content('# Secret plans\n\nMeet at noon.')
    const image = await binaryContent(Uint8Array.from({ length: 3000 }, (_, index) => index % 256))
    await client.mutate(vault.id, {
      mutations: [
        { type: 'upsert', operation_id: 'op-1', item_id: 'item-note', base_revision: null, path: 'Plans/Secret.md', kind: 'text', content: note },
        { type: 'upsert', operation_id: 'op-2', item_id: 'item-image', base_revision: null, path: 'attachements/photo.png', kind: 'binary', content: image }
      ]
    })

    const sent = cloud.requests.find((request) => request.path.endsWith('/mutations'))!
    const wire = JSON.stringify(sent.body)
    expect(wire).not.toContain('Secret')
    expect(wire).not.toContain('Meet at noon')
    expect(wire).not.toContain('photo')
    expect(wire).not.toContain(note.sha256)
    for (const mutation of (sent.body as { mutations: Array<CloudSyncUpsertMutation> }).mutations) {
      expect(mutation.path).toMatch(/^[0-9a-f]{64}$/)
      expect(mutation.kind).toBe('binary')
      expect(mutation.content.encoding).toBe('aes-gcm')
      expect(mutation.content.media_type).toBe('application/octet-stream')
      expect(mutation.content.sha256).toBe(await sha256Hex(fromBase64(mutation.content.data)))
    }
    expect(sent.headers?.[CLOUD_E2EE_HEADER]).toBe('zne1')

    const manifest = await client.manifest(vault.id, { includeContent: true })
    const byId = new Map(manifest.data.map((item) => [item.item_id, item]))
    expect(byId.get('item-note')).toMatchObject({ path: 'Plans/Secret.md', kind: 'text', sha256: note.sha256, content: note })
    expect(byId.get('item-image')).toMatchObject({ path: 'attachements/photo.png', kind: 'binary', content: image })
  }, 20_000)

  it('seals a rename from the engine hints and refuses a rename without them', async () => {
    const { cloud, client, vault } = await encryptedSetup()
    const note = await utf8Content('body')
    await client.mutate(vault.id, {
      mutations: [{ type: 'upsert', operation_id: 'op-1', item_id: 'item-1', base_revision: null, path: 'Old name.md', kind: 'text', content: note }]
    })
    const { data: _data, ...metadata } = note
    await client.mutate(vault.id, {
      mutations: [{ type: 'move', operation_id: 'op-2', item_id: 'item-1', base_revision: 1, path: 'New name.md', kind: 'text', content_metadata: metadata }]
    })
    const move = (cloud.requests.at(-1)!.body as { mutations: Array<Record<string, unknown>> }).mutations[0]!
    expect(Object.keys(move).sort()).toEqual(['base_revision', 'item_id', 'meta', 'operation_id', 'path', 'type'])
    expect((await client.manifest(vault.id, { includeContent: true })).data[0]).toMatchObject({ path: 'New name.md', content: note })

    await expect(
      client.mutate(vault.id, { mutations: [{ type: 'move', operation_id: 'op-3', item_id: 'item-1', base_revision: 2, path: 'Bare.md' }] })
    ).rejects.toThrow(/needs the file details/)
  }, 20_000)

  it('replays a stalled encrypted push with the same sealed bytes, never sealing it again', async () => {
    const { cloud, keyring, vault } = await encryptedSetup()
    const sent: Array<{ body: string; header: string | undefined }> = []
    let stalls = 1
    const flaky: CloudSyncHttpTransport = {
      request: async <Response>(request: CloudSyncHttpRequest): Promise<Response> => {
        if (request.path.endsWith('/mutations')) {
          sent.push({ body: JSON.stringify(request.body), header: request.headers?.[CLOUD_E2EE_HEADER] })
          if (stalls-- > 0) throw new CloudSyncTransportError('timeout', { stalled: true })
        }
        return cloud.request<Response>(request)
      }
    }
    const transport = new CloudSyncRateLimitCoordinator().wrap(flaky, {
      baseUrl: 'https://cloud.example.test', accountId: 'account', transportRetryDelaysMs: [0]
    })
    const client = new CloudSyncApiClient(transport, { endToEndEncryption: true, vaultCiphers: keyring })
    const note = await utf8Content('# Secret\n\nMeet at noon.')
    await client.mutate(vault.id, {
      mutations: [{ type: 'upsert', operation_id: 'op-1', item_id: 'item-1', base_revision: null, path: 'Secret.md', kind: 'text', content: note }]
    })

    // Sealing uses fresh nonces, so a second seal would be a different
    // request under the same operation id, which the service refuses.
    expect(sent).toHaveLength(2)
    expect(sent[1].body).toBe(sent[0].body)
    expect(sent[0].header).toBeDefined()
    expect(sent[1].header).toBe(sent[0].header)
    expect(sent[0].body).not.toContain('Meet at noon')
    expect((await client.manifest(vault.id, { includeContent: true })).data).toMatchObject([{ path: 'Secret.md', content: note }])
  }, 20_000)

  it('leaves readable vaults byte for byte as before, minus the client-only hints', async () => {
    const { cloud, client, readable } = await encryptedSetup()
    const note = await utf8Content('plain')
    const { data: _data, ...metadata } = note
    await client.mutate(readable.id, {
      mutations: [
        { type: 'upsert', operation_id: 'op-1', item_id: 'item-1', base_revision: null, path: 'Note.md', kind: 'text', content: note },
        { type: 'move', operation_id: 'op-2', item_id: 'item-1', base_revision: 1, path: 'Moved.md', kind: 'text', content_metadata: metadata }
      ]
    })
    const body = cloud.requests.at(-1)!.body as { mutations: Array<Record<string, unknown>> }
    expect(body.mutations[0]).toEqual({ type: 'upsert', operation_id: 'op-1', item_id: 'item-1', base_revision: null, path: 'Note.md', kind: 'text', content: note })
    expect(body.mutations[1]).toEqual({ type: 'move', operation_id: 'op-2', item_id: 'item-1', base_revision: 1, path: 'Moved.md' })
  }, 20_000)

  it('stops before any request when an encrypted vault is locked on this device', async () => {
    const { cloud, client, vault, store, keyring } = await encryptedSetup()
    await store.clear()
    keyring.forget()
    const before = cloud.requests.length
    await expect(
      client.mutate(vault.id, { mutations: [{ type: 'upsert', operation_id: 'op-1', item_id: 'item-1', base_revision: null, path: 'A.md', kind: 'text', content: await utf8Content('a') }] })
    ).rejects.toBeInstanceOf(CloudE2eeLockedError)
    expect(cloud.requests.slice(before).some((request) => request.path.endsWith('/mutations'))).toBe(false)
  }, 20_000)

  it('refuses a readable streamed upload into an encrypted vault', async () => {
    const { client, vault } = await encryptedSetup()
    const note = await utf8Content('large')
    await expect(client.initiateUpload(vault.id, {
      operation_id: 'op-1', item_id: 'item-1', base_revision: null, path: 'Big.md', kind: 'text',
      content: { encoding: 'utf8', sha256: note.sha256, byte_length: note.byte_length, media_type: 'text/markdown' }
    })).rejects.toThrow(/only encrypted uploads/)
  }, 20_000)

  it('names the other side of a conflict from its sealed metadata', async () => {
    const { cloud, client, vault, keyring } = await encryptedSetup()
    const note = await utf8Content('x')
    await client.mutate(vault.id, {
      mutations: [{ type: 'upsert', operation_id: 'op-1', item_id: 'item-a', base_revision: null, path: 'Taken.md', kind: 'text', content: note }]
    })
    const existing = cloud.items.get('item-a')!
    cloud.conflictNext = { item_id: 'item-b', current_path: existing.path, current_meta: existing.meta }
    const response = await client.mutate(vault.id, {
      mutations: [{ type: 'upsert', operation_id: 'op-2', item_id: 'item-b', base_revision: null, path: 'taken.md', kind: 'text', content: note }]
    })
    expect(response.conflicts[0]).toMatchObject({ code: 'PATH_CONFLICT', current_path: 'Taken.md' })
    expect(response.conflicts[0]).not.toHaveProperty('current_meta')
    expect(await (await keyring.forVault(vault.id))!.pathId('taken.md')).toBe(existing.path)
  }, 20_000)

  it('refuses content the service swapped between items or metadata moved to another path', async () => {
    const { cloud, client, vault } = await encryptedSetup()
    await client.mutate(vault.id, {
      mutations: [
        { type: 'upsert', operation_id: 'op-1', item_id: 'item-a', base_revision: null, path: 'A.md', kind: 'text', content: await utf8Content('alpha') },
        { type: 'upsert', operation_id: 'op-2', item_id: 'item-b', base_revision: null, path: 'B.md', kind: 'text', content: await utf8Content('bravo') }
      ]
    })
    const a = cloud.items.get('item-a')!
    const b = cloud.items.get('item-b')!
    cloud.items.set('item-a', { ...a, content: b.content })
    await expect(client.manifest(vault.id, { includeContent: true })).rejects.toSatisfy(
      (error: unknown) => error instanceof CloudE2eeError && error.code === 'tampered'
    )
    cloud.items.set('item-a', { ...a, meta: b.meta })
    await expect(client.manifest(vault.id, { includeContent: true })).rejects.toSatisfy(
      (error: unknown) => error instanceof CloudE2eeError && error.code === 'tampered'
    )
  }, 20_000)

  it('searches an encrypted backup by decrypting every page here', async () => {
    const { cloud, client, vault, keyring } = await encryptedSetup()
    const cipher = (await keyring.forVault(vault.id))!
    const item = async (id: number, path: string): Promise<CloudBackupSnapshotItem> => {
      const content = await utf8Content(path)
      const { data: _data, ...metadata } = content
      const sealed = await cipher.sealMeta(path, 'text', metadata)
      return { id, item_id: `item-${id}`, path: sealed.pathId, kind: 'binary', byte_length: 200, revision: 1, content_hash: null, media_type: 'application/octet-stream', meta: sealed.meta }
    }
    cloud.backupPages = [[await item(1, 'Recipes/Soup.md'), await item(2, 'Work/Plan.md')], [await item(3, 'Recipes/Bread.md')]]
    const result = await client.listBackupItems(vault.id, 'backup-1', { search: 'recipes' })
    expect(result.data.map((entry) => entry.path)).toEqual(['Recipes/Soup.md', 'Recipes/Bread.md'])
    expect(cloud.requests.filter((request) => request.path.includes('/items')).every((request) => !request.path.includes('search'))).toBe(true)
  }, 20_000)
})

describe('encrypted references and download instructions', () => {
  const reference = {
    item_id: 'item-1',
    revision: 3,
    encoding: 'base64' as const,
    sha256: 'a'.repeat(64),
    byte_length: 1000,
    media_type: 'image/png',
    encrypted: { sha256: 'b'.repeat(64), byte_length: 1090 }
  }
  const instruction = (content: Record<string, unknown>) => ({
    data: {
      item_id: 'item-1',
      revision: 3,
      content,
      download: { method: 'GET', url: 'https://objects.example/x', headers: {}, expires_at: '2099-01-01T00:00:00Z' }
    }
  })

  it('keeps the ciphertext description on a reference', () => {
    expect(validateCloudSyncContentReference(reference)).toEqual(reference)
    expect(() => validateCloudSyncContentReference({ ...reference, encrypted: { sha256: 'b'.repeat(64), byte_length: 10 } })).toThrow()
  })

  it('accepts an aes-gcm download only for an encrypted reference, and only for its ciphertext', () => {
    const sealed = { encoding: 'aes-gcm', sha256: 'b'.repeat(64), byte_length: 1090, media_type: 'application/octet-stream' }
    expect(validateCloudSyncDownloadInstruction(instruction(sealed), reference).content).toEqual(sealed)
    expect(() => validateCloudSyncDownloadInstruction(instruction({ ...sealed, byte_length: 1091 }), reference)).toThrow()
    const { encrypted: _encrypted, ...readable } = reference
    expect(() => validateCloudSyncDownloadInstruction(instruction(sealed), readable)).toThrow()
    expect(() =>
      validateCloudSyncDownloadInstruction(
        instruction({ encoding: 'base64', sha256: 'a'.repeat(64), byte_length: 1000, media_type: 'image/png' }),
        reference
      )
    ).toThrow()
  })
})
