import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudSyncContent,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse
} from '@zennotes/bridge-contract/cloud-sync'
import { CloudSyncCoordinator, type CloudSyncRemote, type CloudSyncStateStore } from './cloud-sync-coordinator'
import type { CloudSyncLocalItem, CloudSyncState } from './cloud-sync-engine'
import {
  CLOUD_SYNC_REFUSED_PATH_RETRY_MS,
  CloudSyncPathRefusedError,
  cloudSyncPathRefusal,
  isCloudSyncUploadPathRefused
} from './cloud-sync-refusal'

const NOTE = 'inbox/Note.md'
const RECORD = '.zennotes/agent-edits/inbox/Note.md.json'
const REFUSED = 'This path is not eligible for vault sync.'

function content(data: string): CloudSyncContent {
  return { encoding: 'utf8', data, sha256: `hash:${data}`, byte_length: data.length, media_type: 'text/markdown' }
}

function text(path: string, data = path): CloudSyncLocalItem {
  return { path, kind: 'text', content: content(data) }
}

/** What the desktop and phone transports throw for a Laravel 422. */
function validationError(errors: Record<string, string[]>): Error {
  return Object.assign(new Error(Object.values(errors)[0][0]), {
    name: 'CloudServiceRequestError',
    status: 422,
    code: 'VALIDATION_FAILED',
    details: { errors }
  })
}

function harness(items: CloudSyncLocalItem[], initial?: Partial<CloudSyncState>) {
  let state: CloudSyncState | null = { version: 1, vault_id: 'vault-1', cursor: 0, items: {}, ...initial }
  const states: CloudSyncStateStore & { current: () => CloudSyncState | null } = {
    current: () => state,
    async load() {
      return state
    },
    async save(next) {
      state = structuredClone(next)
    }
  }
  const local = { items }
  const requests: CloudSyncMutationRequest[] = []
  const cloud = { refuses: (path: string) => path.startsWith('.zennotes/agent-edits/') }
  let sequence = 0
  const answer = (body: CloudSyncMutationRequest): CloudSyncMutationResponse => {
    const acknowledged = body.mutations.map((mutation) => ({
      operation_id: mutation.operation_id,
      item_id: mutation.item_id,
      revision: 1,
      sequence: ++sequence
    }))
    return { acknowledged, conflicts: [], cursor: sequence }
  }
  const server: CloudSyncRemote = {
    async manifest() {
      return { data: [], cursor: 0, next_page: null }
    },
    async changes(_vaultId, after) {
      return { data: [], cursor: after, has_more: false }
    },
    async mutate(_vaultId, body) {
      requests.push(structuredClone(body))
      // Laravel validates the whole request before applying any of it.
      const errors: Record<string, string[]> = {}
      body.mutations.forEach((mutation, index) => {
        if (mutation.type !== 'delete' && cloud.refuses(mutation.path)) errors[`mutations.${index}.path`] = [REFUSED]
      })
      if (Object.keys(errors).length > 0) throw validationError(errors)
      return answer(body)
    }
  }
  let operation = 0
  let item = 0
  const coordinator = new CloudSyncCoordinator('vault-1', server, {
    async scan() {
      return local.items
    },
    async apply() {}
  }, states, {
    itemId: () => `item-${++item}`,
    operationId: () => `operation-${++operation}`
  })
  const paths = (request: CloudSyncMutationRequest) =>
    request.mutations.map((mutation) => (mutation.type === 'delete' ? `delete ${mutation.item_id}` : mutation.path))
  return { coordinator, states, local, requests, cloud, server, answer, paths }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a path Cloud refuses (#1004)', () => {
  it('is set aside while the rest of the vault syncs', async () => {
    const h = harness([text(NOTE), text(RECORD)])

    const result = await h.coordinator.sync()

    // The refused request, then the same batch without the refused path.
    expect(h.requests.map(h.paths)).toEqual([[RECORD, NOTE], [NOTE]])
    expect(result.pushed).toBe(1)
    expect(Object.values(h.states.current()!.items).map((row) => row.path)).toEqual([NOTE])
    expect(result.refusedPaths).toEqual([
      { path: RECORD, detail: `HTTP 422 · VALIDATION_FAILED · ${REFUSED}` }
    ])
    expect(h.states.current()!.refused_paths).toEqual({
      [RECORD.toLowerCase()]: {
        path: RECORD,
        refused_at: Date.parse('2026-10-29T12:00:00Z'),
        detail: `HTTP 422 · VALIDATION_FAILED · ${REFUSED}`
      }
    })
  })

  it('is not offered again on every run, and is once a day has passed', async () => {
    const h = harness([text(NOTE), text(RECORD)])
    await h.coordinator.sync()
    h.requests.length = 0

    vi.advanceTimersByTime(CLOUD_SYNC_REFUSED_PATH_RETRY_MS - 1)
    const later = await h.coordinator.sync()
    expect(h.requests).toEqual([])
    expect(later.refusedPaths.map((row) => row.path)).toEqual([RECORD])

    // Still refused a day on: set aside again, from now.
    vi.advanceTimersByTime(1)
    const nextDay = await h.coordinator.sync()
    expect(h.requests.map(h.paths)).toEqual([[RECORD]])
    expect(nextDay.refusedPaths.map((row) => row.path)).toEqual([RECORD])
    expect(h.states.current()!.refused_paths?.[RECORD.toLowerCase()].refused_at).toBe(Date.now())

    // Cloud learned to take it (the #1004 fix was on the server).
    h.cloud.refuses = () => false
    h.requests.length = 0
    vi.advanceTimersByTime(CLOUD_SYNC_REFUSED_PATH_RETRY_MS)
    const accepted = await h.coordinator.sync()
    expect(h.requests.map(h.paths)).toEqual([[RECORD]])
    expect(accepted.pushed).toBe(1)
    expect(accepted.refusedPaths).toEqual([])
    expect(h.states.current()!).not.toHaveProperty('refused_paths')
  })

  it('stops waiting once the file is gone from this device', async () => {
    const h = harness([text(NOTE), text(RECORD)])
    await h.coordinator.sync()
    h.local.items = [text(NOTE)]

    const result = await h.coordinator.sync()

    expect(result.refusedPaths).toEqual([])
    expect(h.states.current()!).not.toHaveProperty('refused_paths')
  })

  it('holds back a refused move without deleting the file in Cloud', async () => {
    const tracked = {
      item_id: 'note', path: NOTE, kind: 'text' as const, revision: 1,
      sha256: 'hash:body', byte_length: 4, media_type: 'text/markdown'
    }
    const moved = '.zennotes/agent-edits/moved.json'
    const h = harness([text(moved, 'body')], { items: { note: tracked } })

    const first = await h.coordinator.sync()
    const second = await h.coordinator.sync()

    expect(h.requests.map(h.paths)).toEqual([[moved]])
    expect(h.requests[0].mutations[0].type).toBe('move')
    expect(first.refusedPaths.map((row) => row.path)).toEqual([moved])
    expect(second.refusedPaths.map((row) => row.path)).toEqual([moved])
    expect(h.states.current()!.items.note.path).toBe(NOTE)
  })

  it('commits what a split batch already applied and resends only what went unanswered', async () => {
    const h = harness([text('a.md'), text('b.md'), text('c.md')])
    // A host that sends the batch as several requests: a.md went through,
    // then b.md's own upload was refused, and c.md was never sent.
    let first = true
    h.server.mutate = async (_vaultId, body) => {
      h.requests.push(structuredClone(body))
      if (!first) return h.answer(body)
      first = false
      throw new CloudSyncPathRefusedError({
        indices: [1],
        applied: h.answer({ mutations: [body.mutations[0]] }),
        detail: `HTTP 422 · VALIDATION_FAILED · ${REFUSED}`
      })
    }

    const result = await h.coordinator.sync()

    expect(h.requests.map(h.paths)).toEqual([['a.md', 'b.md', 'c.md'], ['c.md']])
    expect(result.pushed).toBe(2)
    expect(Object.values(h.states.current()!.items).map((row) => row.path).sort()).toEqual(['a.md', 'c.md'])
    expect(result.refusedPaths.map((row) => row.path)).toEqual(['b.md'])
  })

  it('still stops the run for any other validation failure', async () => {
    const h = harness([text(NOTE)])
    h.server.mutate = async () => {
      throw validationError({ mutations: ['The sync batch is too large. Send fewer notes in this request.'] })
    }

    await expect(h.coordinator.sync()).rejects.toMatchObject({ status: 422 })
    expect(h.states.current()!).not.toHaveProperty('refused_paths')
  })
})

describe('cloudSyncPathRefusal', () => {
  const batch: CloudSyncMutationRequest = {
    mutations: [
      { type: 'upsert', operation_id: 'o1', item_id: 'i1', base_revision: null, path: NOTE, kind: 'text', content: content('a') },
      { type: 'delete', operation_id: 'o2', item_id: 'i2', base_revision: 1 }
    ]
  }

  it('reads the refused positions from the field names', () => {
    expect(cloudSyncPathRefusal(validationError({ 'mutations.0.path': [REFUSED] }), batch)?.indices).toEqual([0])
  })

  it('is null for a field that is not an upsert or move path, or a host that kept no fields', () => {
    expect(cloudSyncPathRefusal(validationError({ 'mutations.1.path': [REFUSED] }), batch)).toBeNull()
    expect(cloudSyncPathRefusal(validationError({ 'mutations.0.content': ['Content is required.'] }), batch)).toBeNull()
    expect(cloudSyncPathRefusal(validationError({ 'mutations.5.path': [REFUSED] }), batch)).toBeNull()
    expect(cloudSyncPathRefusal(Object.assign(new Error(REFUSED), { status: 422, code: 'VALIDATION_FAILED' }), batch)).toBeNull()
    expect(cloudSyncPathRefusal(new Error('fetch failed'), batch)).toBeNull()
  })

  it('recognizes a direct upload refused for its own path', () => {
    expect(isCloudSyncUploadPathRefused(validationError({ path: [REFUSED] }))).toBe(true)
    expect(isCloudSyncUploadPathRefused(validationError({ 'content.sha256': ['Bad hash.'] }))).toBe(false)
  })
})
