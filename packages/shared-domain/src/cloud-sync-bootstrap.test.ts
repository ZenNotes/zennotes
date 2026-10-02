import { createHash } from 'node:crypto'
import { setImmediate as yieldToNativeWork } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import type {
  CloudSyncBootstrapConflict,
  CloudSyncContent,
  CloudSyncManifestItem,
  CloudSyncRevision
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CloudSyncCoordinator,
  type CloudSyncRemote,
  type CloudSyncRepository,
  type CloudSyncStateStore
} from './cloud-sync-coordinator'
import type { CloudSyncLocalItem, CloudSyncState } from './cloud-sync-engine'
import {
  CloudSyncApiClient,
  CloudSyncRateLimitCoordinator,
  type CloudSyncHttpRequest
} from './cloud-sync-api'

function content(data: string, binary = false): CloudSyncContent {
  const bytes = Buffer.from(data)
  return {
    encoding: binary ? 'base64' : 'utf8',
    data: binary ? bytes.toString('base64') : data,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byte_length: bytes.length,
    media_type: binary ? 'application/octet-stream' : 'text/markdown'
  }
}

function file(path: string, data: string, binary = false): CloudSyncLocalItem {
  return {
    path,
    kind: binary ? 'binary' : 'text',
    content: content(data, binary)
  }
}

function fixture(
  cloudFiles: CloudSyncLocalItem[],
  localFiles: CloudSyncLocalItem[] = [],
  bootstrapContentPageBytes?: number
) {
  const inventory: CloudSyncManifestItem[] = cloudFiles.map((file, index) => ({
    item_id: `item-${index}`,
    path: file.path,
    kind: file.kind,
    revision: index + 1,
    sha256: file.content.sha256,
    byte_length: file.content.byte_length,
    media_type: file.content.media_type
  }))
  const locals = new Map(localFiles.map((file) => [file.path, structuredClone(file)]))
  let state: CloudSyncState | null = null
  const states: CloudSyncStateStore = {
    load: async () => structuredClone(state),
    save: vi.fn(async (next) => {
      state = structuredClone(next)
    })
  }
  const events: string[] = []
  const repository: CloudSyncRepository = {
    scan: async () => structuredClone([...locals.values()]),
    apply: vi.fn(async (change) => {
      events.push(`apply:${change.item_id}`)
      if (!change.content) throw new Error('Missing file bytes')
      locals.set(change.path, {
        path: change.path,
        kind: change.content.encoding === 'utf8' ? 'text' : 'binary',
        content: structuredClone(change.content)
      })
    }),
    resolveBootstrapConflict: vi.fn(async (input) => {
      const local = locals.get(input.path)
      if (!local || local.content.sha256 !== input.expectedLocalSha256)
        throw new Error('Local changed')
      if (input.resolution.choice === 'both') {
        locals.set(input.resolution.keep_both_path!, {
          ...local,
          path: input.resolution.keep_both_path!
        })
      }
      locals.set(input.path, {
        ...local,
        content:
          input.resolution.choice === 'merged'
            ? content(input.resolution.merged_text!)
            : structuredClone(input.cloudContent)
      })
    })
  }
  const manifest = vi.fn<CloudSyncRemote['manifest']>(async (_vaultId, options) => {
    if (options.includeContent !== false) throw new Error('HTTP 413 SYNC_RESPONSE_TOO_LARGE')
    return { data: structuredClone(inventory), cursor: 10, next_page: null }
  })
  const revision = vi.fn<NonNullable<CloudSyncRemote['revision']>>(
    async (_vaultId, itemId, rev) => {
      events.push(`revision:${itemId}`)
      const index = inventory.findIndex((item) => item.item_id === itemId)
      const item = inventory[index]
      if (!item || item.revision !== rev) throw new Error('Revision not found')
      return {
        data: {
          item_id: itemId,
          revision: rev,
          path: item.path,
          kind: item.kind,
          deleted: false,
          content: structuredClone(cloudFiles[index].content)
        }
      }
    }
  )
  const mutate = vi.fn<CloudSyncRemote['mutate']>(async (_vaultId, body) => ({
    acknowledged: body.mutations.map((mutation) => ({
      operation_id: mutation.operation_id,
      item_id: mutation.item_id,
      revision: (mutation.base_revision ?? 0) + 1,
      sequence: 11
    })),
    conflicts: [],
    cursor: 11
  }))
  const remote: CloudSyncRemote = {
    bootstrapContentPageBytes,
    manifest,
    revision,
    mutate,
    changes: vi.fn(async (_vaultId, after) => ({
      data: [],
      cursor: after,
      has_more: false
    }))
  }
  let id = 0
  const coordinator = new CloudSyncCoordinator('vault', remote, repository, states, {
    itemId: () => `local-${++id}`,
    operationId: () => `operation-${++id}`
  })
  return {
    coordinator,
    remote,
    repository,
    states,
    manifest,
    revision,
    mutate,
    inventory,
    locals,
    events,
    state: () => state
  }
}

function enableBulkManifest(f: ReturnType<typeof fixture>, cloud: CloudSyncLocalItem[]) {
  f.manifest.mockImplementation(async (_vaultId, options) => {
    const pageSize = options.perPage ?? 250
    const start = ((options.page ?? 1) - 1) * pageSize
    const end = Math.min(start + pageSize, f.inventory.length)
    return {
      data: f.inventory.slice(start, end).map((item, index) => ({
        ...item,
        ...(options.includeContent
          ? { content: structuredClone(cloud[start + index].content) }
          : {})
      })),
      cursor: 10,
      next_page: end < f.inventory.length ? (options.page ?? 1) + 1 : null
    }
  })
}

describe('bounded bulk Cloud bootstrap', () => {
  it('respects a small host byte budget without changing page offsets or losing notes', async () => {
    const cloud = Array.from({ length: 260 }, (_, index) => file(`${index}.md`, 'a'.repeat(1_024)))
    const f = fixture(cloud, [], 64 * 1024)
    enableBulkManifest(f, cloud)
    await f.coordinator.sync()
    const contentPages = f.manifest.mock.calls.filter((call) => call[1].includeContent)
    expect(contentPages.map((call) => call[1])).toEqual(
      Array.from({ length: 52 }, (_, index) => ({
        includeContent: true,
        page: index + 1,
        perPage: 5
      }))
    )
    expect([...f.locals.values()]).toEqual(cloud)
    expect(f.revision).not.toHaveBeenCalled()
  })

  it('recovers the same pages across multiple low-limit windows during a complete bootstrap', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))
    try {
      const cloud = Array.from({ length: 750 }, (_, index) => file(`${index}.md`, `note ${index}`))
      const f = fixture(cloud)
      enableBulkManifest(f, cloud)
      const attempts: Array<{ path: string; limited: boolean }> = []
      let window = -1
      let used = 0
      const rateLimits = new CloudSyncRateLimitCoordinator()
      const api = new CloudSyncApiClient(
        rateLimits.wrap(
          {
            async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
              const currentWindow = Math.floor(Date.now() / 5_000)
              if (window !== currentWindow) {
                window = currentWindow
                used = 0
              }
              const limited = ++used > 2
              attempts.push({ path: request.path, limited })
              if (limited)
                throw Object.assign(new Error('Rate limited'), {
                  status: 429,
                  headers: { 'Retry-After': '5' }
                })
              const url = new URL(request.path, 'https://bootstrap.example.test')
              if (url.pathname.endsWith('/manifest')) {
                return (await f.manifest('vault', {
                  includeContent: url.searchParams.get('include_content') === 'true',
                  page: Number(url.searchParams.get('page')),
                  perPage: Number(url.searchParams.get('per_page'))
                })) as Response
              }
              if (url.pathname.endsWith('/changes'))
                return { data: [], cursor: 10, has_more: false } as Response
              throw new Error(`Unexpected bootstrap request: ${request.path}`)
            }
          },
          { baseUrl: 'https://bootstrap.example.test', accountId: 'account' }
        )
      )
      const coordinator = new CloudSyncCoordinator('vault', api, f.repository, f.states, {
        itemId: () => 'unused-item',
        operationId: () => 'unused-operation'
      })
      let settled = false
      const result = coordinator.sync()
      void result.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      // WebCrypto completes on the native event loop. Advance only scheduled
      // cooldowns, without spending real seconds polling through fake windows.
      for (let turn = 0; !settled && turn < 10_000; turn++) {
        await yieldToNativeWork()
        if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync()
      }
      expect(settled).toBe(true)
      await expect(result).resolves.toMatchObject({ pulled: 750, pushed: 0 })
      expect(attempts).toHaveLength(10)
      expect(attempts.filter((attempt) => attempt.limited)).toHaveLength(3)
      for (let index = 0; index < attempts.length; index++) {
        if (attempts[index].limited) expect(attempts[index + 1].path).toBe(attempts[index].path)
      }
      expect(f.manifest.mock.calls.filter((call) => !call[1].includeContent)).toHaveLength(3)
      expect([...f.locals.values()]).toEqual(cloud)
      expect(f.state()?.cursor).toBe(10)
    } finally {
      vi.useRealTimers()
    }
  })

  it('syncs 5,000 small notes within 41 requests, including metadata and the change feed', async () => {
    const cloud = Array.from({ length: 5_000 }, (_, index) =>
      file(`${index}.md`, 'a'.repeat(1_024))
    )
    const f = fixture(cloud)
    enableBulkManifest(f, cloud)
    let requests = 0
    const countRequest = () => {
      if (++requests > 120) throw Object.assign(new Error('Rate limited'), { status: 429 })
    }
    const manifest = f.manifest.getMockImplementation()!
    f.manifest.mockImplementation(async (...args) => {
      countRequest()
      if (args[1].includeContent) {
        const offset = ((args[1].page ?? 1) - 1) * (args[1].perPage ?? 250)
        expect(f.locals.size).toBe(offset)
      }
      return manifest(...args)
    })
    const revision = f.revision.getMockImplementation()!
    f.revision.mockImplementation(async (...args) => {
      countRequest()
      return revision(...args)
    })
    vi.mocked(f.remote.changes).mockImplementation(async (_vaultId, after) => {
      countRequest()
      return { data: [], cursor: after, has_more: false }
    })

    const result = await f.coordinator.sync()
    expect(result).toMatchObject({
      pulled: 5_000,
      pushed: 0,
      pendingConflicts: []
    })
    expect(f.manifest.mock.calls.filter((call) => !call[1].includeContent)).toHaveLength(20)
    expect(f.manifest.mock.calls.filter((call) => call[1].includeContent)).toHaveLength(20)
    expect(f.revision).not.toHaveBeenCalled()
    expect(requests).toBe(41)
    expect([...f.locals.values()]).toEqual(cloud)
    expect(Object.keys(f.state()!.items)).toHaveLength(5_000)
  })

  it('isolates a large file without turning its small neighbours into hundreds of revision reads', async () => {
    const cloud = Array.from({ length: 250 }, (_, index) => file(`${index}.md`, `note ${index}`))
    cloud[120] = file('large.bin', 'b'.repeat(2 * 1024 * 1024), true)
    const f = fixture(cloud)
    enableBulkManifest(f, cloud)
    const manifest = f.manifest.getMockImplementation()!
    f.manifest.mockImplementation(async (...args) => {
      const response = await manifest(...args)
      if (args[1].includeContent) {
        expect(response.data.some((item) => item.item_id === 'item-120')).toBe(false)
      }
      return response
    })

    await f.coordinator.sync()
    expect(f.manifest.mock.calls.length + f.revision.mock.calls.length).toBeLessThanOrEqual(20)
    expect(f.revision.mock.calls.filter((call) => call[1] === 'item-120')).toHaveLength(1)
    expect([...f.locals.values()]).toEqual(cloud)
  })

  it('subdivides a 413 content page and remembers the smaller size for subsequent pages', async () => {
    const cloud = Array.from({ length: 500 }, (_, index) => file(`${index}.md`, `note ${index}`))
    const f = fixture(cloud)
    enableBulkManifest(f, cloud)
    const manifest = f.manifest.getMockImplementation()!
    f.manifest.mockImplementation(async (...args) => {
      if (args[1].includeContent && args[1].perPage! > 125) {
        throw Object.assign(new Error('Content page exceeds budget'), {
          status: 413,
          code: 'SYNC_RESPONSE_TOO_LARGE'
        })
      }
      return manifest(...args)
    })

    await f.coordinator.sync()
    expect(
      f.manifest.mock.calls.filter((call) => call[1].includeContent).map((call) => call[1])
    ).toEqual([
      { includeContent: true, page: 1, perPage: 250 },
      ...[1, 2, 3, 4].map((page) => ({
        includeContent: true,
        page,
        perPage: 125
      }))
    ])
    expect(f.revision).not.toHaveBeenCalled()
    expect([...f.locals.values()]).toEqual(cloud)
  })

  it('falls back to revisions after bounded probes when every content page is rejected', async () => {
    const cloud = Array.from({ length: 15 }, (_, index) => file(`${index}.md`, `note ${index}`))
    const f = fixture(cloud)
    enableBulkManifest(f, cloud)
    const manifest = f.manifest.getMockImplementation()!
    f.manifest.mockImplementation(async (...args) => {
      if (args[1].includeContent) {
        throw Object.assign(new Error('Content page exceeds budget'), {
          status: 413,
          code: 'SYNC_RESPONSE_TOO_LARGE'
        })
      }
      return manifest(...args)
    })

    await f.coordinator.sync()
    expect(
      f.manifest.mock.calls.filter((call) => call[1].includeContent).map((call) => call[1].perPage)
    ).toEqual([250, 125, 25, 5])
    expect(f.revision).toHaveBeenCalledTimes(15)
    expect([...f.locals.values()]).toEqual(cloud)
  })

  it('sizes bulk pages conservatively for heavily escaped text before making a content request', async () => {
    const cloud = Array.from({ length: 250 }, (_, index) =>
      file(`${index}.md`, '\u0001'.repeat(16_384))
    )
    const f = fixture(cloud)
    enableBulkManifest(f, cloud)
    const manifest = f.manifest.getMockImplementation()!
    f.manifest.mockImplementation(async (...args) => {
      const response = await manifest(...args)
      if (args[1].includeContent) {
        expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(16 * 1024 * 1024)
      }
      return response
    })

    await f.coordinator.sync()
    expect(
      f.manifest.mock.calls.filter((call) => call[1].includeContent).map((call) => call[1])
    ).toEqual([1, 2].map((page) => ({ includeContent: true, page, perPage: 125 })))
    expect(f.revision).not.toHaveBeenCalled()
    expect(f.locals.size).toBe(250)
  })

  it.each(['cursor', 'revision', 'missing item', 'reordered items'])(
    'rejects a bulk %s mismatch before applying that page',
    async (mismatch) => {
      const cloud = Array.from({ length: 10 }, (_, index) => file(`${index}.md`, `note ${index}`))
      const f = fixture(cloud)
      enableBulkManifest(f, cloud)
      const manifest = f.manifest.getMockImplementation()!
      f.manifest.mockImplementation(async (...args) => {
        const response = await manifest(...args)
        if (args[1].includeContent) {
          if (mismatch === 'cursor') response.cursor++
          if (mismatch === 'revision') response.data.at(-1)!.revision++
          if (mismatch === 'missing item') response.data.pop()
          if (mismatch === 'reordered items') response.data.reverse()
        }
        return response
      })

      await expect(f.coordinator.sync()).rejects.toThrow('Vault changed')
      expect(f.repository.apply).not.toHaveBeenCalled()
      expect(f.states.save).not.toHaveBeenCalled()
      expect(f.revision).not.toHaveBeenCalled()
      expect(f.manifest).toHaveBeenCalledTimes(2)
      enableBulkManifest(f, cloud)
      await expect(f.coordinator.sync()).resolves.toMatchObject({
        pulled: 10,
        pushed: 0
      })
    }
  )

  it('rejects corrupt bulk bytes rather than trusting the content and manifest hashes', async () => {
    const cloud = Array.from({ length: 10 }, (_, index) => file(`${index}.md`, `note ${index}`))
    const f = fixture(cloud)
    enableBulkManifest(f, cloud)
    const manifest = f.manifest.getMockImplementation()!
    f.manifest.mockImplementation(async (...args) => {
      const response = await manifest(...args)
      if (args[1].includeContent) response.data[0].content!.data = 'wrong!'
      return response
    })

    await expect(f.coordinator.sync()).rejects.toThrow('invalid hash')
    expect(f.repository.apply).not.toHaveBeenCalled()
    expect(f.states.save).not.toHaveBeenCalled()
    expect(f.mutate).not.toHaveBeenCalled()
    expect(f.revision).not.toHaveBeenCalled()
  })

  it('keeps local conflicts paused and previews intact when their cloud bodies arrive in bulk', async () => {
    const cloud = Array.from({ length: 10 }, (_, index) => file(`${index}.md`, `note ${index}`))
    const local = file('0.md', 'local edits')
    const f = fixture(cloud, [local, cloud[3]])
    enableBulkManifest(f, cloud)

    const result = await f.coordinator.sync()
    expect(result).toMatchObject({ pulled: 8, pushed: 0 })
    expect(result.pendingConflicts).toEqual([expect.objectContaining({ item_id: 'item-0' })])
    expect(f.locals.get(local.path)).toEqual(local)
    await expect(f.coordinator.getConflict('item-0')).resolves.toMatchObject({
      local: { text: 'local edits' },
      cloud: { text: 'note 0' }
    })
    expect(f.inventory.every((item) => item.content === undefined)).toBe(true)
    expect(f.revision).not.toHaveBeenCalled()
    expect(f.manifest).toHaveBeenCalledTimes(2)
    expect(f.mutate).not.toHaveBeenCalled()
  })

  it('does not prefetch another page while a file is being applied', async () => {
    const cloud = Array.from({ length: 500 }, (_, index) => file(`${index}.md`, `note ${index}`))
    const f = fixture(cloud)
    enableBulkManifest(f, cloud)
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    let applying!: () => void
    const started = new Promise<void>((resolve) => {
      applying = resolve
    })
    const apply = vi.mocked(f.repository.apply).getMockImplementation()!
    vi.mocked(f.repository.apply).mockImplementationOnce(async (...args) => {
      applying()
      await paused
      return apply(...args)
    })

    const syncing = f.coordinator.sync()
    await started
    expect(f.manifest).toHaveBeenCalledTimes(3)
    expect(f.locals.size).toBe(0)
    release()
    await syncing
    expect(f.manifest).toHaveBeenCalledTimes(4)
    expect(f.locals.size).toBe(500)
  })

  it.each([
    Object.assign(new Error('Too many requests'), {
      status: 429,
      retryAfter: 60
    }),
    Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
    Object.assign(new Error('Request timed out'), { name: 'TimeoutError' }),
    Object.assign(new Error('Unrelated 413'), {
      status: 413,
      code: 'OTHER_ERROR'
    })
  ])(
    'stops without fallback or further writes when a bulk request fails: $message',
    async (error) => {
      const cloud = Array.from({ length: 500 }, (_, index) => file(`${index}.md`, `note ${index}`))
      const f = fixture(cloud)
      enableBulkManifest(f, cloud)
      const manifest = f.manifest.getMockImplementation()!
      f.manifest.mockImplementation(async (...args) => {
        if (args[1].includeContent && args[1].page === 2) throw error
        return manifest(...args)
      })

      await expect(f.coordinator.sync()).rejects.toBe(error)
      expect(f.locals.size).toBe(250)
      expect(f.revision).not.toHaveBeenCalled()
      expect(f.manifest).toHaveBeenCalledTimes(4)
      expect(f.states.save).not.toHaveBeenCalled()
      expect(f.mutate).not.toHaveBeenCalled()
      expect(f.state()).toBeNull()

      enableBulkManifest(f, cloud)
      f.manifest.mockClear()
      await expect(f.coordinator.sync()).resolves.toMatchObject({
        pulled: 250,
        pushed: 0
      })
      expect(f.manifest.mock.calls.filter((call) => call[1].includeContent)).toHaveLength(1)
      expect([...f.locals.values()]).toEqual(cloud)
    }
  )
})

describe('metadata-first Cloud bootstrap', () => {
  it('hydrates and applies one revision at a time without a content-bearing manifest', async () => {
    // Real, modest test bodies exercise the ordering and snapshot bounds. The
    // 413 is simulated; this is not a live server capacity or heap benchmark.
    const cloud = [
      file('one.bin', 'a'.repeat(300_000), true),
      file('two.md', 'héllo'),
      file('empty.md', '')
    ]
    const f = fixture(cloud)
    const result = await f.coordinator.sync()

    expect([...f.locals.values()]).toEqual(cloud)
    expect(result).toMatchObject({
      pulled: 3,
      pushed: 0,
      pendingConflicts: []
    })
    expect(f.manifest).toHaveBeenCalledExactlyOnceWith('vault', {
      includeContent: false,
      page: 1,
      perPage: 250
    })
    expect(f.events).toEqual([
      'revision:item-0',
      'apply:item-0',
      'revision:item-1',
      'apply:item-1',
      'revision:item-2',
      'apply:item-2'
    ])
    expect(f.state()?.cursor).toBe(10)
    expect(Object.values(f.state()!.items).every((item) => !('content' in item))).toBe(true)
    expect(f.mutate).not.toHaveBeenCalled()
  })

  it('does not fetch identical local files and still uploads local-only files', async () => {
    const same = file('same.md', 'already here')
    const local = file('local.md', 'only here')
    const f = fixture([same], [same, local])
    const result = await f.coordinator.sync()
    expect(f.revision).not.toHaveBeenCalled()
    expect(f.repository.apply).not.toHaveBeenCalled()
    expect(result).toMatchObject({ pulled: 0, pushed: 1 })
    expect(f.mutate.mock.calls[0][1].mutations).toEqual([
      expect.objectContaining({
        type: 'upsert',
        path: local.path,
        content: local.content
      })
    ])
  })

  it('keeps bootstrap retryable after a revision download fails midway', async () => {
    const cloud = [file('one.md', 'cloud one'), file('two.md', 'cloud two')]
    const local = file('local.md', 'not uploaded on failure')
    const f = fixture(cloud, [local])
    const read = f.revision.getMockImplementation()!
    f.revision.mockImplementationOnce(read).mockRejectedValueOnce(new Error('Download timed out'))

    await expect(f.coordinator.sync()).rejects.toThrow('Download timed out')
    expect(f.state()).toBeNull()
    expect(f.states.save).not.toHaveBeenCalled()
    expect(f.mutate).not.toHaveBeenCalled()
    expect([...f.locals.values()]).toEqual([local, cloud[0]])

    const result = await f.coordinator.sync()
    expect(result).toMatchObject({ pulled: 1, pushed: 1 })
    expect(f.revision.mock.calls.map((call) => call[1])).toEqual(['item-0', 'item-1', 'item-1'])
    expect([...f.locals.values()]).toEqual([local, ...cloud])
    expect(f.state()?.cursor).toBe(10)
  })

  it.each([
    ['item id', { item_id: 'wrong' }],
    ['revision', { revision: 99 }],
    ['path', { path: 'elsewhere.md' }],
    ['kind', { kind: 'binary' }],
    ['deleted revision', { deleted: true }],
    ['missing content', { content: null }],
    ['hash metadata', { content: { ...content('cloud'), sha256: 'wrong' } }],
    ['length metadata', { content: { ...content('cloud'), byte_length: 99 } }],
    ['media type', { content: { ...content('cloud'), media_type: 'image/png' } }],
    ['missing bytes', { content: { ...content('cloud'), data: '' } }],
    ['truncated bytes', { content: { ...content('cloud'), data: 'clou' } }],
    ['corrupt bytes', { content: { ...content('cloud'), data: 'other' } }],
    ['invalid base64', { content: { ...content('cloud'), encoding: 'base64', data: '!' } }],
    ['encrypted bytes', { content: { ...content('cloud'), encoding: 'aes-gcm' } }]
  ] satisfies Array<[string, Partial<CloudSyncRevision>]>)(
    'rejects mismatched %s before writing or saving',
    async (_name, patch) => {
      const f = fixture([file('one.md', 'cloud')], [file('local.md', 'keep me')])
      const read = f.revision.getMockImplementation()!
      f.revision.mockImplementationOnce(async (...args) => {
        const response = await read(...args)
        return { data: { ...response.data, ...patch } }
      })
      await expect(f.coordinator.sync()).rejects.toThrow()
      expect(f.repository.apply).not.toHaveBeenCalled()
      expect(f.states.save).not.toHaveBeenCalled()
      expect(f.mutate).not.toHaveBeenCalled()
      expect(f.state()).toBeNull()
      expect([...f.locals.values()]).toEqual([file('local.md', 'keep me')])
      await expect(f.coordinator.sync()).resolves.toMatchObject({
        pulled: 1,
        pushed: 1
      })
    }
  )

  it('finishes a stable paginated inventory before hydrating any revision', async () => {
    const cloud = [file('one.md', 'one'), file('two.md', 'two')]
    const f = fixture(cloud)
    f.manifest
      .mockResolvedValueOnce({
        data: [{ ...f.inventory[0], revision: 99 }],
        cursor: 8,
        next_page: 2
      })
      .mockResolvedValueOnce({
        data: [f.inventory[1]],
        cursor: 9,
        next_page: null
      })
      .mockResolvedValueOnce({
        data: [f.inventory[0]],
        cursor: 10,
        next_page: 2
      })
      .mockResolvedValueOnce({
        data: [f.inventory[1]],
        cursor: 10,
        next_page: null
      })
    const read = f.revision.getMockImplementation()!
    f.revision.mockImplementation(async (...args) => {
      expect(f.manifest).toHaveBeenCalledTimes(4)
      return read(...args)
    })

    await f.coordinator.sync()
    expect(f.manifest.mock.calls.map((call) => call[1])).toEqual(
      [1, 2, 1, 2].map((page) => ({
        includeContent: false,
        page,
        perPage: 250
      }))
    )
    expect(f.revision.mock.calls.map((call) => call.slice(1))).toEqual([
      ['item-0', 1],
      ['item-1', 2]
    ])
    expect([...f.locals.values()]).toEqual(cloud)
    expect(f.state()?.cursor).toBe(10)
  })

  it('does not initialize or hydrate when the manifest keeps changing', async () => {
    const f = fixture([file('one.md', 'cloud')])
    let cursor = 0
    f.manifest.mockImplementation(async (_vaultId, options) => ({
      data: f.inventory,
      cursor: ++cursor,
      next_page: options.page === 1 ? 2 : null
    }))
    await expect(f.coordinator.sync()).rejects.toThrow('Vault changed repeatedly')
    expect(f.manifest).toHaveBeenCalledTimes(6)
    expect(f.revision).not.toHaveBeenCalled()
    expect(f.repository.apply).not.toHaveBeenCalled()
    expect(f.states.save).not.toHaveBeenCalled()
  })

  it('pulls changes after the captured cursor even when cloud advances during hydration', async () => {
    const f = fixture([file('one.md', 'at the manifest cursor')])
    const latest = content('newer revision')
    vi.mocked(f.remote.changes).mockResolvedValueOnce({
      data: [
        {
          sequence: 11,
          item_id: 'item-0',
          revision: 2,
          path: 'one.md',
          type: 'upsert',
          previous_path: null,
          content: latest
        }
      ],
      cursor: 11,
      has_more: false
    })
    await f.coordinator.sync()
    expect(f.remote.changes).toHaveBeenCalledWith('vault', 10, 250)
    expect(f.locals.get('one.md')?.content).toEqual(latest)
    expect(f.state()?.cursor).toBe(11)
    expect(f.state()?.items['item-0'].revision).toBe(2)
    expect(f.mutate).not.toHaveBeenCalled()
  })

  it('preserves edits to a partially hydrated file when bootstrap is retried', async () => {
    const f = fixture([file('one.md', 'cloud one'), file('two.md', 'cloud two')])
    const read = f.revision.getMockImplementation()!
    f.revision.mockImplementationOnce(read).mockRejectedValueOnce(new Error('Offline'))
    await expect(f.coordinator.sync()).rejects.toThrow('Offline')
    const edited = file('one.md', 'edited after failed sync')
    f.locals.set(edited.path, edited)

    const result = await f.coordinator.sync()
    expect(f.locals.get(edited.path)).toEqual(edited)
    expect(result.pendingConflicts).toEqual([expect.objectContaining({ item_id: 'item-0' })])
    expect(f.state()?.pending_conflicts?.['item-0']).toMatchObject({
      local: { content: edited.content },
      cloud: { content: content('cloud one') }
    })
    expect(f.mutate).not.toHaveBeenCalled()
  })

  it('does not push if bootstrap state persistence fails, and retries from the files on disk', async () => {
    const cloud = file('one.md', 'cloud')
    const f = fixture([cloud])
    vi.mocked(f.states.save).mockRejectedValueOnce(new Error('Disk full'))
    await expect(f.coordinator.sync()).rejects.toThrow('Disk full')
    expect(f.state()).toBeNull()
    expect(f.locals.get(cloud.path)).toEqual(cloud)
    expect(f.mutate).not.toHaveBeenCalled()
    await expect(f.coordinator.sync()).resolves.toMatchObject({
      pulled: 0,
      pushed: 0
    })
    expect(f.revision).toHaveBeenCalledOnce()
    expect(f.state()?.cursor).toBe(10)
  })

  it('leaves vault settings merging to the host and uploads the merged result', async () => {
    const path = '.zennotes/vault.json'
    const local = file(path, '{"favorites":["local.md"]}')
    const cloud = file(path, '{"favorites":["cloud.md"]}')
    const merged = file(path, '{"favorites":["local.md","cloud.md"]}')
    const f = fixture([cloud], [local])
    vi.mocked(f.repository.apply).mockImplementationOnce(async (change, previous) => {
      expect(previous).toBeUndefined()
      expect(change.content).toEqual(cloud.content)
      f.locals.set(path, merged)
    })
    const result = await f.coordinator.sync()
    expect(result.pendingConflicts).toEqual([])
    expect(f.mutate.mock.calls[0][1].mutations).toEqual([
      expect.objectContaining({
        type: 'upsert',
        path,
        base_revision: 1,
        content: merged.content
      })
    ])
  })

  it('keeps settings conflicts paused while hydrating other files', async () => {
    const path = '.zennotes/vault.json'
    const local = file(path, '{"favorites":["local.md"]}')
    const f = fixture(
      [file(path, '{"favorites":["cloud.md"]}'), file('note.md', 'cloud note')],
      [local]
    )
    vi.mocked(f.repository.apply).mockImplementationOnce(async (change) => ({
      code: 'SETTINGS_CONFLICT',
      path: change.path,
      conflict_copy_path: '.zennotes/vault.cloud-conflict.json'
    }))
    f.repository.pendingConflictPaths = async () => [path]
    const result = await f.coordinator.sync()
    expect(result.localConflicts).toEqual([expect.objectContaining({ code: 'SETTINGS_CONFLICT' })])
    expect(result.pendingConflicts).toEqual([])
    expect(f.locals.get(path)).toEqual(local)
    expect(f.locals.get('note.md')?.content.data).toBe('cloud note')
    expect(f.mutate).not.toHaveBeenCalled()
  })

  it('retains small first-sync previews but keeps large conflict bodies out of durable state', async () => {
    const cloud = [file('small.md', 'cloud'), file('large.bin', 'c'.repeat(300_000), true)]
    const local = [file('small.md', 'local'), file('large.bin', 'l'.repeat(300_000), true)]
    const f = fixture(cloud, local)
    const result = await f.coordinator.sync()
    expect(result.pendingConflicts).toHaveLength(2)
    expect([...f.locals.values()]).toEqual(local)
    expect(f.mutate).not.toHaveBeenCalled()
    expect(f.repository.apply).not.toHaveBeenCalled()
    await expect(f.coordinator.getConflict('item-0')).resolves.toMatchObject({
      local: { text: 'local' },
      cloud: { text: 'cloud' },
      base: { text: null }
    })
    expect(f.state()?.pending_conflicts?.['item-1']).toMatchObject({
      local: {
        content: {
          data: '',
          sha256: local[1].content.sha256,
          byte_length: 300_000
        }
      },
      cloud: {
        content: {
          data: '',
          sha256: cloud[1].content.sha256,
          byte_length: 300_000
        }
      }
    })
    expect(JSON.stringify(f.state()).length).toBeLessThan(5_000)
    f.revision.mockClear()
    const written = vi.fn<NonNullable<CloudSyncRepository['applyConflictResolutionFiles']>>()
    f.repository.applyConflictResolutionFiles = written
    await f.coordinator.resolveConflict({
      conflict_id: 'item-1',
      choice: 'cloud',
      expected_local_sha256: local[1].content.sha256,
      expected_cloud_revision: 2
    })
    expect(f.revision).toHaveBeenCalledExactlyOnceWith('vault', 'item-1', 2)
    expect(written).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [{ path: 'large.bin', content: cloud[1].content }]
      })
    )
    expect(Object.keys(f.state()?.pending_conflicts ?? {})).toEqual(['item-0'])
  })

  it('uses the content-manifest fallback only on hosts without revision reads', async () => {
    const cloud = file('one.md', 'cloud')
    const f = fixture([cloud])
    delete f.remote.revision
    f.manifest.mockImplementation(async (_vaultId, options) => {
      expect(options.includeContent).toBe(true)
      return {
        data: [{ ...f.inventory[0], content: cloud.content }],
        cursor: 10,
        next_page: null
      }
    })
    await expect(f.coordinator.sync()).resolves.toMatchObject({
      pulled: 1,
      pushed: 0
    })
    expect(f.revision).not.toHaveBeenCalled()
    expect(f.locals.get(cloud.path)).toEqual(cloud)
  })

  it('keeps a large first-sync decision queued if its later revision hydration is invalid', async () => {
    const local = file('large.md', 'l'.repeat(300_000))
    const f = fixture([file('large.md', 'c'.repeat(300_000))], [local])
    await f.coordinator.sync()
    const before = structuredClone(f.state())
    const read = f.revision.getMockImplementation()!
    f.revision.mockImplementationOnce(async (...args) => {
      const response = await read(...args)
      return { data: { ...response.data, revision: 99 } }
    })
    const write = vi.fn()
    f.repository.applyConflictResolutionFiles = write
    const decision = {
      conflict_id: 'item-0',
      choice: 'cloud' as const,
      expected_local_sha256: local.content.sha256,
      expected_cloud_revision: 1
    }
    await expect(f.coordinator.resolveConflict(decision)).rejects.toThrow('not available')
    expect(write).not.toHaveBeenCalled()
    expect(f.state()).toEqual(before)
    expect(f.locals.get(local.path)).toEqual(local)
    await f.coordinator.resolveConflict(decision)
    expect(write).toHaveBeenCalledOnce()
    expect(f.state()?.pending_conflicts).toEqual({})
  })
})

describe('legacy bootstrap conflict decisions with metadata manifests', () => {
  function conflictFixture() {
    const local = file('note.md', 'local')
    const cloud = file('note.md', 'cloud')
    const f = fixture([cloud, file('unrelated.bin', 'x'.repeat(300_000), true)], [local])
    const conflict: CloudSyncBootstrapConflict = {
      code: 'BOOTSTRAP_CONTENT_CONFLICT',
      item_id: 'item-0',
      path: local.path,
      local_sha256: local.content.sha256,
      remote_sha256: cloud.content.sha256
    }
    return { ...f, conflict, local, cloud }
  }

  it('previews only the selected conflict revision without initializing state', async () => {
    const f = conflictFixture()
    await expect(f.coordinator.getBootstrapConflict(f.conflict)).resolves.toMatchObject({
      local: { text: 'local' },
      cloud: { text: 'cloud' }
    })
    expect(f.revision).toHaveBeenCalledExactlyOnceWith('vault', 'item-0', 1)
    expect(f.state()).toBeNull()
    expect(f.locals.get('note.md')).toEqual(f.local)
  })

  it.each(['cloud', 'both'] as const)(
    'resolves %s without downloading unrelated bodies',
    async (choice) => {
      const f = conflictFixture()
      await f.coordinator.resolveBootstrapConflict({
        conflict: f.conflict,
        choice,
        keep_both_path: 'local-copy.md'
      })
      expect(f.locals.get('note.md')).toEqual(f.cloud)
      if (choice === 'both') expect(f.locals.get('local-copy.md')?.content).toEqual(f.local.content)
      expect(f.revision).toHaveBeenCalledExactlyOnceWith('vault', 'item-0', 1)
      expect(f.mutate).not.toHaveBeenCalled()
      expect(f.state()).toBeNull()
      const result = await f.coordinator.sync()
      expect(result.pulled).toBe(1)
      expect(f.locals.has('unrelated.bin')).toBe(true)
    }
  )

  it('rejects a changed conflict before downloading its revision', async () => {
    const f = conflictFixture()
    f.inventory[0].sha256 = content('new cloud').sha256
    await expect(f.coordinator.getBootstrapConflict(f.conflict)).rejects.toThrow('conflict changed')
    expect(f.revision).not.toHaveBeenCalled()
    expect(f.repository.resolveBootstrapConflict).not.toHaveBeenCalled()
    expect(f.state()).toBeNull()
  })

  it('rejects a local edit made since the bootstrap conflict was reviewed', async () => {
    const f = conflictFixture()
    const edited = file('note.md', 'edited again')
    f.locals.set(edited.path, edited)
    await expect(
      f.coordinator.resolveBootstrapConflict({
        conflict: f.conflict,
        choice: 'cloud'
      })
    ).rejects.toThrow('conflict changed')
    expect(f.revision).not.toHaveBeenCalled()
    expect(f.locals.get(edited.path)).toEqual(edited)
    expect(f.state()).toBeNull()
  })

  it('supports the legacy content manifest for conflict detail and resolution', async () => {
    const f = conflictFixture()
    delete f.remote.revision
    f.manifest.mockImplementation(async (_vaultId, options) => {
      expect(options.includeContent).toBe(true)
      return {
        data: [{ ...f.inventory[0], content: f.cloud.content }],
        cursor: 10,
        next_page: null
      }
    })
    await expect(f.coordinator.getBootstrapConflict(f.conflict)).resolves.toMatchObject({
      local: { text: 'local' },
      cloud: { text: 'cloud' }
    })
    await f.coordinator.resolveBootstrapConflict({
      conflict: f.conflict,
      choice: 'cloud'
    })
    expect(f.locals.get('note.md')).toEqual(f.cloud)
    expect(f.revision).not.toHaveBeenCalled()
    expect(f.state()).toBeNull()
  })

  it('preserves the local file when its selected revision is unavailable', async () => {
    const f = conflictFixture()
    f.revision.mockRejectedValueOnce(new Error('Revision expired'))
    await expect(
      f.coordinator.resolveBootstrapConflict({
        conflict: f.conflict,
        choice: 'cloud'
      })
    ).rejects.toThrow('Revision expired')
    expect(f.locals.get('note.md')).toEqual(f.local)
    expect(f.repository.resolveBootstrapConflict).not.toHaveBeenCalled()
    expect(f.mutate).not.toHaveBeenCalled()
    expect(f.state()).toBeNull()
  })

  it.each(['local', 'merged'] as const)(
    'preserves the local file when a %s decision cannot reach Cloud',
    async (choice) => {
      const f = conflictFixture()
      f.mutate.mockRejectedValueOnce(new Error('Save timed out'))
      await expect(
        f.coordinator.resolveBootstrapConflict({
          conflict: f.conflict,
          choice,
          merged_text: 'combined'
        })
      ).rejects.toThrow('Save timed out')
      expect(f.locals.get('note.md')).toEqual(f.local)
      expect(f.repository.resolveBootstrapConflict).not.toHaveBeenCalled()
      expect(f.state()).toBeNull()
    }
  )

  it('writes a merged decision locally only after Cloud acknowledges it', async () => {
    const f = conflictFixture()
    const save = f.mutate.getMockImplementation()!
    f.mutate.mockImplementationOnce(async (...args) => {
      expect(f.locals.get('note.md')).toEqual(f.local)
      expect(f.repository.resolveBootstrapConflict).not.toHaveBeenCalled()
      return save(...args)
    })
    await f.coordinator.resolveBootstrapConflict({
      conflict: f.conflict,
      choice: 'merged',
      merged_text: 'combined'
    })
    expect(f.mutate.mock.calls[0][1].mutations).toEqual([
      expect.objectContaining({
        item_id: 'item-0',
        base_revision: 1,
        content: content('combined')
      })
    ])
    expect(f.locals.get('note.md')?.content).toEqual(content('combined'))
    expect(f.state()).toBeNull()
  })

  it.each(['stale revision', 'missing acknowledgement'])(
    'does not replace local bytes after a %s response',
    async (failure) => {
      const f = conflictFixture()
      f.mutate.mockImplementationOnce(async (_vaultId, body) => ({
        acknowledged: [],
        cursor: 11,
        conflicts:
          failure === 'stale revision'
            ? [
                {
                  operation_id: body.mutations[0].operation_id,
                  item_id: 'item-0',
                  code: 'REVISION_CONFLICT',
                  current_revision: 2,
                  current_path: 'note.md'
                }
              ]
            : []
      }))
      await expect(
        f.coordinator.resolveBootstrapConflict({
          conflict: f.conflict,
          choice: 'merged',
          merged_text: 'combined'
        })
      ).rejects.toThrow()
      expect(f.locals.get('note.md')).toEqual(f.local)
      expect(f.repository.resolveBootstrapConflict).not.toHaveBeenCalled()
      expect(f.state()).toBeNull()
    }
  )
})
