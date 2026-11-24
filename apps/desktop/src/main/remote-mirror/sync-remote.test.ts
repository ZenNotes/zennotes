import { describe, expect, it, vi } from 'vitest'
import type { CloudSyncMutation } from '@zennotes/bridge-contract/cloud-sync'
import { createZnServerSyncRemote, fetchServerSyncVaultId, RemoteMirrorUnreachableError, splitByBytes } from './sync-remote'

vi.mock('../system-trust', () => ({ trustSystemCertificates: () => undefined }))

function upsert(id: string, bytes: number): CloudSyncMutation {
  return {
    type: 'upsert',
    operation_id: `op-${id}`,
    item_id: id,
    base_revision: null,
    path: `inbox/${id}.md`,
    kind: 'text',
    content: { encoding: 'utf8', data: 'x'.repeat(bytes), sha256: 'a'.repeat(64), byte_length: bytes, media_type: 'text/markdown' }
  } as CloudSyncMutation
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('splitByBytes', () => {
  it('keeps order and cuts before the budget', () => {
    const batches = splitByBytes([upsert('a', 400), upsert('b', 400), upsert("c", 400)], 1500)
    expect(batches.map((batch) => batch.map((m) => m.item_id))).toEqual([['a', 'b'], ['c']])
  })

  it('sends one mutation larger than the budget on its own', () => {
    const batches = splitByBytes([upsert('a', 5000), upsert('b', 10)], 1000)
    expect(batches.map((batch) => batch.length)).toEqual([1, 1])
  })
})

describe('createZnServerSyncRemote', () => {
  it('names the vault, sends the token and always asks for content', async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({ data: [], cursor: 3, next_page: null }))
    const remote = createZnServerSyncRemote({ baseUrl: 'http://srv', authToken: 't0k', revisions: false, fetchImplementation })
    await remote.manifest('v1', { page: 2, perPage: 50 })
    const [url, init] = fetchImplementation.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://srv/api/sync/manifest?vault_id=v1&page=2&perPage=50&include_content=1')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer t0k')
  })

  it('reads older revisions only from a server that serves them', async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({ data: { item_id: 'i', revision: 1, path: 'a.md', kind: 'text', deleted: false } }))
    expect(createZnServerSyncRemote({ baseUrl: 'http://srv', revisions: false, fetchImplementation }).revision).toBeUndefined()
    const remote = createZnServerSyncRemote({ baseUrl: 'http://srv', revisions: true, fetchImplementation })
    await remote.revision!('v1', 'i', 1)
    expect((fetchImplementation.mock.calls[0] as unknown as [string])[0]).toBe('http://srv/api/sync/revision?vault_id=v1&item=i&revision=1')
  })

  it('words a server refusal the way the engine reads Cloud', async () => {
    const remote = createZnServerSyncRemote({
      baseUrl: 'http://srv',
      revisions: false,
      fetchImplementation: async () => jsonResponse({ code: 'VAULT_MISMATCH', message: 'other vault' }, 409)
    })
    await expect(remote.changes('v1', 0)).rejects.toMatchObject({ name: 'CloudServiceRequestError', status: 409, code: 'VAULT_MISMATCH' })
  })

  it('tells an unreachable server from a refusal', async () => {
    const onAnswer = vi.fn()
    const remote = createZnServerSyncRemote({
      baseUrl: 'http://srv',
      revisions: false,
      onAnswer,
      fetchImplementation: async () => {
        throw new TypeError('fetch failed')
      }
    })
    await expect(remote.changes('v1', 0)).rejects.toBeInstanceOf(RemoteMirrorUnreachableError)
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('splits a large batch and answers as one', async () => {
    const bodies: number[] = []
    let cursor = 0
    const remote = createZnServerSyncRemote({
      baseUrl: 'http://srv',
      revisions: false,
      mutationBatchBytes: 1500,
      fetchImplementation: async (_url, init) => {
        const { mutations } = JSON.parse(String((init as RequestInit).body)) as { mutations: CloudSyncMutation[] }
        bodies.push(mutations.length)
        return jsonResponse({
          acknowledged: mutations.map((m) => ({ operation_id: m.operation_id, item_id: m.item_id, revision: 1, sequence: ++cursor })),
          conflicts: [],
          cursor
        })
      }
    })
    const answer = await remote.mutate('v1', { mutations: [upsert('a', 400), upsert('b', 400), upsert('c', 400)] })
    expect(bodies).toEqual([2, 1])
    expect(answer.acknowledged.map((ack) => ack.item_id)).toEqual(['a', 'b', 'c'])
    expect(answer.cursor).toBe(3)
  })
})

describe('fetchServerSyncVaultId', () => {
  it('learns the vault from a manifest asked without one', async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({ vault_id: 'v9', cursor: 4, data: [], next_page: null }))
    await expect(fetchServerSyncVaultId({ baseUrl: 'http://srv', fetchImplementation })).resolves.toEqual({ vaultId: 'v9', cursor: 4 })
    expect((fetchImplementation.mock.calls[0] as unknown as [string])[0]).not.toContain('vault_id=')
  })
})
