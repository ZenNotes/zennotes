import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  CloudSyncChange,
  CloudSyncContent,
  CloudSyncContentReference,
  CloudSyncManifestItem
} from '@zennotes/bridge-contract/cloud-sync'
import { CloudSyncApiClient, type CloudSyncHttpRequest } from './cloud-sync-api'
import {
  CloudSyncCoordinator,
  type CloudSyncRemote,
  type CloudSyncRepository
} from './cloud-sync-coordinator'
import {
  emptyCloudSyncState,
  type CloudSyncLocalItem,
  type CloudSyncState
} from './cloud-sync-engine'
import { registerCloudSyncStagedFile } from './cloud-sync-content'

type Entry = CloudSyncManifestItem & { content_ref: CloudSyncContentReference }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function entry(id: string, revision = 1, text?: string): Entry {
  const content: CloudSyncContent | undefined =
    text === undefined
      ? undefined
      : {
          encoding: 'utf8',
          data: text,
          sha256: hash(text),
          byte_length: Buffer.byteLength(text),
          media_type: 'text/markdown'
        }
  // Large byte counts here are metadata-only flow fixtures, not capacity evidence.
  const ref: CloudSyncContentReference = content
    ? { ...content, item_id: id, revision }
    : {
        item_id: id,
        revision,
        encoding: 'base64',
        sha256: hash(`${id}:${revision}`),
        byte_length: 200_000_000,
        media_type: 'application/octet-stream'
      }
  delete (ref as Partial<CloudSyncContent>).data
  return {
    item_id: id,
    revision,
    path: `${id}.md`,
    kind: content ? 'text' : 'binary',
    sha256: ref.sha256,
    byte_length: ref.byte_length,
    media_type: ref.media_type,
    content,
    content_ref: ref
  }
}
function local(item: Entry): CloudSyncLocalItem {
  return {
    path: item.path,
    kind: item.kind,
    content: item.content ?? { ...item.content_ref, data: '' }
  }
}
function change(item: Entry, sequence: number): CloudSyncChange {
  return {
    item_id: item.item_id,
    revision: item.revision,
    sequence,
    type: 'upsert',
    path: item.path,
    previous_path: null,
    content_ref: item.content_ref
  }
}

function fixture(
  entries: Entry[],
  initial: CloudSyncState | null = null,
  locals: CloudSyncLocalItem[] = []
) {
  let state = initial
  const files = new Map(locals.map((item) => [item.path, item]))
  const latest = new Map(entries.map((item) => [item.item_id, item]))
  const versions = new Map(
    entries.map((item) => [`${item.item_id}:${item.content_ref.revision}`, item])
  )
  const feed: CloudSyncChange[] = []
  const save = vi.fn(async (next: CloudSyncState) => {
    state = JSON.parse(JSON.stringify(next))
  })
  const discard = vi.fn(async () => {})
  const remote: CloudSyncRemote = {
    negotiateContentReferences: vi.fn(async () => true),
    manifest: vi.fn(async (_vault, options) => {
      const items = [...latest.values()]
      const size = options.perPage ?? 250
      const start = ((options.page ?? 1) - 1) * size
      return {
        data: items.slice(start, start + size).map((item) => {
          const { content, content_ref, ...metadata } = item
          return options.includeContent && content
            ? { ...metadata, content }
            : { ...metadata, content_ref }
        }),
        cursor: feed.length,
        next_page: start + size < items.length ? (options.page ?? 1) + 1 : null
      }
    }),
    changes: vi.fn(async (_vault, after, limit = 250, options) => {
      const remaining = feed.filter((row) => row.sequence > after)
      return {
        data: remaining.slice(0, limit).map((row) => {
          const body = versions.get(`${row.item_id}:${row.revision}`)?.content
          return options?.maxInlineBytes !== 0 && body && row.type === 'upsert'
            ? { ...row, content_ref: undefined, content: body }
            : row
        }),
        cursor: feed.length,
        has_more: remaining.length > limit
      }
    }),
    revision: vi.fn(async (_vault, id, revision) => {
      const item = versions.get(`${id}:${revision}`)!
      return {
        data: {
          item_id: id,
          revision,
          path: item.path,
          kind: item.kind,
          deleted: false,
          ...(item.content ? { content: item.content } : { content_ref: item.content_ref })
        }
      }
    }),
    download: vi.fn<NonNullable<CloudSyncRemote['download']>>(async (_vault, id, revision) => {
      const ref = versions.get(`${id}:${revision}`)!.content_ref
      return {
        data: {
          item_id: id,
          revision,
          content: {
            encoding: ref.encoding,
            sha256: ref.sha256,
            byte_length: ref.byte_length,
            media_type: ref.media_type
          },
          download: {
            method: 'GET',
            url: 'https://objects.example.test/immutable',
            headers: {},
            expires_at: '2099-10-01T12:00:00Z'
          }
        }
      }
    }),
    mutate: vi.fn<CloudSyncRemote['mutate']>(async (_vault, body) => ({
      acknowledged: body.mutations.map((mutation) => {
        const revision = (mutation.base_revision ?? 0) + 1
        const sequence = feed.length + 1
        if (mutation.type === 'upsert') {
          const { data: _bytes, ...metadata } = mutation.content
          const content_ref = { ...metadata, item_id: mutation.item_id, revision }
          feed.push({
            item_id: mutation.item_id,
            revision,
            sequence,
            type: 'upsert',
            path: mutation.path,
            previous_path: null,
            content_ref
          })
        } else
          feed.push({
            item_id: mutation.item_id,
            revision,
            sequence,
            type: 'delete',
            path: 'deleted.md',
            previous_path: null
          })
        return {
          item_id: mutation.item_id,
          operation_id: mutation.operation_id,
          revision,
          sequence
        }
      }),
      cursor: feed.length,
      conflicts: []
    }))
  }
  const repository: CloudSyncRepository = {
    scan: async () => [...files.values()],
    apply: vi.fn(async (row) => {
      if (row.content) files.set(row.path, { path: row.path, kind: 'text', content: row.content })
    }),
    stageCloudContent: vi.fn(async (source) => {
      await source.getInstruction()
      const item = versions.get(`${source.reference.item_id}:${source.reference.revision}`)!
      return registerCloudSyncStagedFile(source.reference, { native: true }, discard, item.content)
    }),
    applyStagedCloudContent: vi.fn<NonNullable<CloudSyncRepository['applyStagedCloudContent']>>(
      async (row, previous) => {
        const current = files.get(row.path)
        if (current && current.content.sha256 !== previous?.sha256)
          return {
            code: 'LOCAL_EDIT_CONFLICT',
            path: row.path,
            conflict_copy_path: null,
            local: current
          }
        files.set(row.path, local(versions.get(`${row.item_id}:${row.content_ref!.revision}`)!))
      }
    ),
    resolveStagedCloudConflict: vi.fn(async (input) => {
      const current = input.expected_path ? files.get(input.expected_path) : undefined
      if ((current?.content.sha256 ?? null) !== input.expected_sha256)
        throw new Error('Local changed')
      if (input.keep_both_path && current)
        files.set(input.keep_both_path, { ...current, path: input.keep_both_path })
      if (input.expected_path) files.delete(input.expected_path)
      files.set(input.cloud_path, {
        ...local(versions.get(`${input.file.reference.item_id}:${input.file.reference.revision}`)!),
        path: input.cloud_path
      })
    })
  }
  const coordinator = new CloudSyncCoordinator(
    'vault',
    remote,
    repository,
    { load: async () => state, save },
    { itemId: () => 'new-local', operationId: () => 'operation' }
  )
  return {
    coordinator,
    remote,
    repository,
    files,
    feed,
    latest,
    versions,
    save,
    discard,
    state: () => state
  }
}

describe('reference-mode sync', () => {
  it.each([{ sha256: undefined }, { revision: NaN }, { byte_length: -1 }])(
    'rejects a malformed manifest envelope before staging: %j',
    async (patch) => {
      const file = entry('large')
      const f = fixture([file])
      vi.mocked(f.remote.manifest).mockResolvedValue({
        data: [{ ...file, content: undefined, ...patch } as Entry],
        cursor: 0,
        next_page: null
      })
      await expect(f.coordinator.sync()).rejects.toThrow()
      expect(f.repository.stageCloudContent).not.toHaveBeenCalled()
      expect(f.state()).toBeNull()
    }
  )

  it('rejects a reference feed sequence gap before applying any bytes', async () => {
    const file = entry('large')
    const f = fixture([file], emptyCloudSyncState('vault'))
    f.feed.push(change(file, 2))
    await expect(f.coordinator.sync()).rejects.toThrow('Expected sync sequence 1')
    expect(f.repository.applyStagedCloudContent).not.toHaveBeenCalled()
    expect(f.remote.download).not.toHaveBeenCalled()
    expect(f.state()?.cursor).toBe(0)
  })

  it('batches 5,000 small notes without issuing individual download requests', async () => {
    const f = fixture(
      Array.from({ length: 5_000 }, (_, index) => entry(`note-${index}`, 1, 'small note'))
    )
    const result = await f.coordinator.sync()
    expect(result.pulled).toBe(5_000)
    expect(f.remote.manifest).toHaveBeenCalledTimes(40)
    expect(f.repository.stageCloudContent).not.toHaveBeenCalled()
    expect(f.files.size).toBe(5_000)
  })

  it('stages a large bootstrap file and releases its handle after verified apply', async () => {
    const file = entry('large')
    const f = fixture([file])
    await f.coordinator.sync()
    expect(f.remote.download).toHaveBeenCalledExactlyOnceWith('vault', 'large', 1)
    expect(f.repository.applyStagedCloudContent).toHaveBeenCalledOnce()
    expect(f.discard).toHaveBeenCalledOnce()
    expect(f.state()?.items.large.sha256).toBe(file.sha256)
    expect(f.state()?.items.large).not.toHaveProperty('content')
  })

  it('does not download an acknowledged own large-file echo', async () => {
    const f = fixture([], emptyCloudSyncState('vault'), [local(entry('own'))])
    const result = await f.coordinator.sync()
    expect(result.pushed).toBe(1)
    expect(result.state.cursor).toBe(1)
    expect(f.remote.download).not.toHaveBeenCalled()
    expect(f.repository.stageCloudContent).not.toHaveBeenCalled()
    expect(
      vi.mocked(f.remote.changes).mock.calls.every((call) => call[3]?.maxInlineBytes === 0)
    ).toBe(true)
  })

  it('does not redownload matching local bytes when an acknowledged echo is replayed after restart', async () => {
    const file = entry('large')
    const state = emptyCloudSyncState('vault')
    state.items.large = {
      item_id: file.item_id,
      revision: file.revision,
      path: file.path,
      kind: file.kind,
      sha256: file.sha256,
      byte_length: file.byte_length,
      media_type: file.media_type
    }
    const f = fixture([file], state, [local(file)])
    f.feed.push(change(file, 1))
    f.repository.matchesCloudContent = async (path, ref) =>
      f.files.get(path)?.content.sha256 === ref.sha256
    const result = await f.coordinator.sync()
    expect(result.state.cursor).toBe(1)
    expect(f.remote.download).not.toHaveBeenCalled()
    expect(f.repository.stageCloudContent).not.toHaveBeenCalled()
  })

  it('coalesces obsolete upserts across metadata pages before hydrating the needed revision', async () => {
    const first = entry('large', 1)
    const second = entry('large', 2)
    const f = fixture([first, second], emptyCloudSyncState('vault'))
    f.feed.push(change(first, 1), change(second, 2))
    const read = vi.mocked(f.remote.changes).getMockImplementation()!
    vi.mocked(f.remote.changes).mockImplementation((vault, after, _limit, options) =>
      read(vault, after, 1, options)
    )
    const result = await f.coordinator.sync()
    expect(result).toMatchObject({ pulled: 2, pushed: 0 })
    expect(f.remote.download).toHaveBeenCalledExactlyOnceWith('vault', 'large', 2)
    expect(result.state.cursor).toBe(2)
    expect(f.discard).toHaveBeenCalledOnce()
  })

  it('batches small-note catch-up after a metadata-only history pass', async () => {
    const notes = Array.from({ length: 501 }, (_, index) => entry(`note-${index}`, 1, 'small note'))
    const f = fixture(notes, emptyCloudSyncState('vault'))
    f.feed.push(...notes.map((note, index) => change(note, index + 1)))
    await f.coordinator.sync()
    expect(f.files.size).toBe(501)
    expect(f.remote.download).not.toHaveBeenCalled()
    const requests = vi.mocked(f.remote.changes).mock.calls
    expect(requests.filter((call) => call[3]?.maxInlineBytes === 0)).toHaveLength(3)
    expect(requests.filter((call) => call[3]?.maxInlineBytes !== 0)).toHaveLength(3)
  })

  it('retains only a reference when a metadata page unexpectedly includes inline conflict bytes', async () => {
    const cloud = entry('note', 1, 'original cloud')
    const mine = local(entry('note', 1, 'local edit'))
    const f = fixture([cloud], null, [mine])
    await f.coordinator.sync()
    const next = entry('note', 2, 'new cloud content')
    f.latest.set('note', next)
    f.versions.set('note:2', next)
    f.feed.push(change(next, 1))
    const read = vi.mocked(f.remote.changes).getMockImplementation()!
    vi.mocked(f.remote.changes).mockImplementation((vault, after, limit) => read(vault, after, limit, {}))

    await f.coordinator.sync()

    expect(f.state()?.pending_conflicts?.note.cloud).toMatchObject({
      revision: 2, content: null, content_ref: next.content_ref
    })
    expect(f.files.get(mine.path)?.content.data).toBe('local edit')
  })

  it('saves the landed prefix on staging failure and resumes after it (#813)', async () => {
    const first = entry('small', 1, 'landed')
    const second = entry('large')
    const f = fixture([first, second], emptyCloudSyncState('vault'))
    f.feed.push(change(first, 1), change(second, 2))
    vi.mocked(f.repository.stageCloudContent!).mockRejectedValueOnce(
      new Error('Network interrupted')
    )
    await expect(f.coordinator.sync()).rejects.toThrow('Network interrupted')
    expect(f.state()?.cursor).toBe(1)
    expect(f.files.get(first.path)?.content.data).toBe('landed')
    f.files.delete(first.path)
    vi.mocked(f.repository.apply).mockClear()
    await f.coordinator.sync()
    expect(f.files.has(first.path)).toBe(false)
    expect(vi.mocked(f.remote.mutate).mock.calls[0][1].mutations[0].type).toBe('delete')
  })

  it('does not save a coalesced prefix when its final staged revision fails', async () => {
    const first = entry('large', 1)
    const second = entry('large', 2)
    const f = fixture([first, second], emptyCloudSyncState('vault'))
    f.feed.push(change(first, 1), change(second, 2))
    vi.mocked(f.repository.stageCloudContent!).mockRejectedValueOnce(new Error('Unavailable'))
    await expect(f.coordinator.sync()).rejects.toThrow('Unavailable')
    expect(f.state()?.cursor).toBe(0)
    expect(f.save).not.toHaveBeenCalled()
  })

  it('keeps a local edit made during bootstrap download as a durable conflict', async () => {
    const file = entry('large')
    const f = fixture([file])
    const stage = vi.mocked(f.repository.stageCloudContent!).getMockImplementation()!
    const edited = local(entry('large', 3))
    vi.mocked(f.repository.stageCloudContent!).mockImplementationOnce(async (source) => {
      const staged = await stage(source)
      f.files.set(file.path, edited)
      return staged
    })
    const result = await f.coordinator.sync()
    expect(result.pendingConflicts).toHaveLength(1)
    expect(f.state()?.pending_conflicts?.large.cloud).toMatchObject({
      content: null,
      content_ref: file.content_ref
    })
    expect(f.files.get(file.path)).toEqual(edited)
    expect(f.remote.mutate).not.toHaveBeenCalled()
    expect(f.discard).toHaveBeenCalledOnce()
  })

  it.each(['cloud', 'both', 'local'] as const)(
    'resolves a large %s choice without materializing JSON bytes',
    async (choice) => {
      const cloud = entry('large', 2)
      const mine = local(entry('large', 1))
      const f = fixture([cloud], null, [mine])
      await f.coordinator.sync()
      const details = await f.coordinator.getConflict('large')
      expect(details.cloud).toMatchObject({
        text: null,
        byte_length: 200_000_000,
        sha256: cloud.sha256,
        deleted: false
      })
      expect(f.remote.download).not.toHaveBeenCalled()
      await f.coordinator.resolveConflict({
        conflict_id: 'large',
        choice,
        keep_both_path: 'my-copy.md',
        expected_local_sha256: mine.content.sha256,
        expected_cloud_revision: 2
      })
      expect(f.state()?.pending_conflicts).toEqual({})
      if (choice === 'local') {
        expect(f.remote.download).not.toHaveBeenCalled()
        expect(vi.mocked(f.remote.mutate).mock.calls[0][1].mutations[0]).toMatchObject({
          content: mine.content
        })
      } else {
        expect(f.discard).toHaveBeenCalledOnce()
        expect(f.files.get(cloud.path)?.content.sha256).toBe(cloud.sha256)
        if (choice === 'both')
          expect(f.files.get('my-copy.md')?.content.sha256).toBe(mine.content.sha256)
      }
    }
  )

  it('rejects an empty keep-both filename before resolving a legacy bootstrap reference', async () => {
    const cloud = entry('large', 2)
    const mine = local(entry('large', 1))
    const f = fixture([cloud], null, [mine])
    await expect(
      f.coordinator.resolveBootstrapConflict({
        conflict: {
          code: 'BOOTSTRAP_CONTENT_CONFLICT',
          item_id: 'large',
          path: cloud.path,
          local_sha256: mine.content.sha256,
          remote_sha256: cloud.sha256
        },
        choice: 'both',
        keep_both_path: ''
      })
    ).rejects.toThrow('filename')
    expect(f.files.get(mine.path)).toEqual(mine)
    expect(f.repository.resolveStagedCloudConflict).not.toHaveBeenCalled()
    expect(f.remote.download).not.toHaveBeenCalled()
  })

  it('uses the immutable upsert under a later state revision', async () => {
    const item = { ...entry('moved', 2), revision: 3 }
    const f = fixture([item])
    await f.coordinator.sync()
    expect(f.remote.download).toHaveBeenCalledExactlyOnceWith('vault', 'moved', 2)
    expect(f.state()?.items.moved.revision).toBe(3)
  })

  it.each([true, false])(
    'preserves a supplied move reference while allowing state-revision downloads (supplied: %s)',
    async (supplied) => {
      const original = entry('note', 1, 'cloud text')
      const mine = local(entry('note', 1, 'local edit'))
      const state = emptyCloudSyncState('vault')
      state.cursor = 1
      state.items.note = {
        item_id: 'note', revision: 1, path: original.path, kind: original.kind,
        sha256: original.sha256, byte_length: original.byte_length, media_type: original.media_type
      }
      const f = fixture([original], state, [mine])
      const moved = { ...original, path: 'moved.md', revision: 2 }
      f.latest.set('note', moved)
      // The download endpoint can resolve a state revision to the last upsert
      // at or before it, returning those bytes under the requested identity.
      f.versions.set('note:2', moved)
      f.feed.push({
        sequence: 2, item_id: 'note', revision: 2, type: 'move',
        path: moved.path, previous_path: original.path,
        ...(supplied ? { content_ref: original.content_ref } : {})
      })
      vi.mocked(f.repository.apply).mockResolvedValue({
        code: 'LOCAL_EDIT_CONFLICT', path: mine.path, conflict_copy_path: null, local: mine
      })

      const result = await f.coordinator.sync()

      expect(result.state.cursor).toBe(2)
      expect(f.state()?.pending_conflicts?.note.cloud).toMatchObject({
        path: moved.path, revision: 2,
        content_ref: { ...original.content_ref, revision: supplied ? 1 : 2 },
        content: original.content
      })
      expect(f.remote.download).toHaveBeenCalledExactlyOnceWith('vault', 'note', supplied ? 1 : 2)
      expect(f.files.get(mine.path)).toEqual(mine)
      expect(f.remote.mutate).not.toHaveBeenCalled()
    }
  )

  it('stops buffered inline feed writes on cancellation and preserves the landed prefix', async () => {
    const notes = [entry('first', 1, 'first bytes'), entry('second', 1, 'second bytes')]
    const f = fixture(notes, emptyCloudSyncState('vault'))
    const cancellation = new AbortController()
    Object.assign(f.remote, { downloadSignal: cancellation.signal })
    // iOS 15 does not supply throwIfAborted or signal.reason.
    Object.defineProperties(cancellation.signal, {
      throwIfAborted: { value: undefined }, reason: { value: undefined }
    })
    f.feed.push(...notes.map((note, index) => change(note, index + 1)))
    const apply = vi.mocked(f.repository.apply).getMockImplementation()!
    vi.mocked(f.repository.apply).mockImplementationOnce(async (...args) => {
      await apply(...args)
      cancellation.abort()
    })

    await expect(f.coordinator.sync()).rejects.toMatchObject({ name: 'AbortError' })

    expect(f.state()?.cursor).toBe(1)
    expect([...f.files.keys()]).toEqual([notes[0].path])
    expect(f.remote.mutate).not.toHaveBeenCalled()
    Object.assign(f.remote, { downloadSignal: new AbortController().signal })
    await expect(f.coordinator.sync()).resolves.toMatchObject({ pulled: 1, pushed: 0 })
    expect(f.state()?.cursor).toBe(2)
    expect([...f.files.keys()]).toEqual(notes.map((note) => note.path))
  })

  it('stops buffered inline bootstrap writes on cancellation and retries the remaining files', async () => {
    const notes = [entry('first', 1, 'first bytes'), entry('second', 1, 'second bytes')]
    const f = fixture(notes)
    const cancellation = new AbortController()
    Object.assign(f.remote, { downloadSignal: cancellation.signal })
    const apply = vi.mocked(f.repository.apply).getMockImplementation()!
    vi.mocked(f.repository.apply).mockImplementationOnce(async (...args) => {
      await apply(...args)
      cancellation.abort()
    })

    await expect(f.coordinator.sync()).rejects.toMatchObject({ name: 'AbortError' })

    expect(f.state()).toBeNull()
    expect([...f.files.keys()]).toEqual([notes[0].path])
    expect(f.remote.mutate).not.toHaveBeenCalled()
    Object.assign(f.remote, { downloadSignal: new AbortController().signal })
    await expect(f.coordinator.sync()).resolves.toMatchObject({ pulled: 1, pushed: 0 })
    expect([...f.files.keys()]).toEqual(notes.map((note) => note.path))
  })

  it('rejects a forged remote staging token and leaves bootstrap recoverable', async () => {
    const f = fixture([entry('large')])
    vi.mocked(f.repository.stageCloudContent!).mockResolvedValueOnce({
      source: 'file',
      reference: entry('large').content_ref
    })
    await expect(f.coordinator.sync()).rejects.toThrow('Untrusted')
    expect(f.repository.applyStagedCloudContent).not.toHaveBeenCalled()
    expect(f.state()).toBeNull()
  })

  it('hydrates only a bounded small referenced preview for conflict review', async () => {
    const cloud = entry('note', 2, 'cloud note')
    const mine = local(entry('note', 1, 'my edit'))
    const f = fixture([cloud], null, [mine])
    const metadata = { ...cloud, content: undefined }
    vi.mocked(f.remote.manifest).mockResolvedValue({ data: [metadata], cursor: 0, next_page: null })
    await f.coordinator.sync()
    expect(f.remote.download).not.toHaveBeenCalled()
    await expect(f.coordinator.getConflict('note')).resolves.toMatchObject({
      local: { text: 'my edit' },
      cloud: { text: 'cloud note', byte_length: 10 }
    })
    expect(f.remote.download).toHaveBeenCalledExactlyOnceWith('vault', 'note', 2)
    expect(f.discard).toHaveBeenCalledOnce()
    expect(f.files.get(mine.path)).toEqual(mine)
  })

  it('uses the same bounded referenced preview when resolving individual text changes', async () => {
    const cloud = entry('note', 2, 'cloud\nend\n')
    const mine = local(entry('note', 1, 'local\nend\n'))
    const state = emptyCloudSyncState('vault')
    state.pending_conflicts = {
      note: {
        id: 'note',
        item_id: 'note',
        kind: 'content',
        sequence: 2,
        base: {
          path: cloud.path,
          kind: 'text',
          revision: 1,
          content: entry('note', 1, 'base\nend\n').content!
        },
        local: { path: mine.path, kind: 'text', revision: null, content: mine.content },
        cloud: {
          path: cloud.path,
          kind: 'text',
          revision: 2,
          content: null,
          content_ref: cloud.content_ref
        }
      }
    }
    const f = fixture([cloud], state, [mine])
    const write = vi.fn<NonNullable<CloudSyncRepository['applyConflictResolutionFiles']>>(
      async () => {}
    )
    f.repository.applyConflictResolutionFiles = write
    const details = await f.coordinator.getConflict('note')
    expect(details.changes).toHaveLength(1)
    await f.coordinator.resolveConflict({
      conflict_id: 'note',
      choice: 'changes',
      expected_local_sha256: mine.content.sha256,
      expected_cloud_revision: 2,
      change_choices: Object.fromEntries(details.changes.map((part) => [part.id, 'cloud' as const]))
    })
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ files: [{ path: cloud.path, content: cloud.content }] })
    )
    expect(f.state()?.pending_conflicts).toEqual({})
    expect(f.discard).toHaveBeenCalledTimes(2)
  })

  it('reports a missing local file as deleted while its Cloud side is only a reference', async () => {
    const cloud = entry('large')
    const state = emptyCloudSyncState('vault')
    state.pending_conflicts = {
      large: {
        id: 'large',
        item_id: 'large',
        kind: 'content',
        sequence: 1,
        base: { path: cloud.path, kind: 'binary', revision: 1, content: null },
        local: { path: cloud.path, kind: 'binary', revision: null, content: local(cloud).content },
        cloud: {
          path: cloud.path,
          kind: 'binary',
          revision: 1,
          content: null,
          content_ref: cloud.content_ref
        }
      }
    }
    const f = fixture([cloud], state)
    await expect(f.coordinator.getConflict('large')).resolves.toMatchObject({
      local: { deleted: true },
      cloud: { deleted: false, byte_length: 200_000_000 }
    })
    expect(f.remote.download).not.toHaveBeenCalled()
  })

  it('rejects corrupted acknowledged echo metadata without downloading it', async () => {
    const f = fixture([], emptyCloudSyncState('vault'), [local(entry('own'))])
    const mutate = vi.mocked(f.remote.mutate).getMockImplementation()!
    vi.mocked(f.remote.mutate).mockImplementation(async (...args) => {
      const response = await mutate(...args)
      f.feed[0].content_ref = { ...f.feed[0].content_ref!, sha256: '0'.repeat(64) }
      return response
    })
    await expect(f.coordinator.sync()).rejects.toThrow('echo did not match')
    expect(f.state()?.cursor).toBe(0)
    expect(f.remote.download).not.toHaveBeenCalled()
  })
})

describe('content reference capability negotiation', () => {
  it('keeps discovery bound to the account that constructed the client', async () => {
    const options = {
      contentReferences: true,
      accountScope: { baseUrl: 'https://caps-isolation.example.test', accountId: 'first' }
    }
    const first = new CloudSyncApiClient(
      {
        request: vi.fn().mockResolvedValue({ data: { capabilities: { content_references: true } } })
      },
      options
    )
    options.accountScope.accountId = 'second'
    await first.negotiateContentReferences()
    const send = vi.fn().mockResolvedValue({ data: { capabilities: {} } })
    const second = new CloudSyncApiClient({ request: send }, options)
    await expect(second.negotiateContentReferences()).rejects.toThrow(
      'needs content-reference support'
    )
    expect(send).toHaveBeenCalledOnce()
  })

  it('expires capability discovery even for a long-lived client', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      const send = vi
        .fn()
        .mockResolvedValueOnce({ data: { capabilities: { content_references: true } } })
        .mockResolvedValueOnce({ data: { capabilities: {} } })
      const api = new CloudSyncApiClient({ request: send }, { contentReferences: true })
      await api.negotiateContentReferences()
      now.mockReturnValue(1_300_001)
      await expect(api.negotiateContentReferences()).rejects.toThrow(
        'needs content-reference support'
      )
      await expect(api.changes('vault', 0)).rejects.toThrow('Negotiate')
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('requires every staging/conflict hook before an opted-in host can read content', async () => {
    const f = fixture([entry('large')])
    Object.assign(f.remote, { requiresContentReferenceHost: true })
    delete f.repository.resolveStagedCloudConflict
    await expect(f.coordinator.sync()).rejects.toThrow('needs all Cloud staging')
    expect(f.remote.manifest).not.toHaveBeenCalled()
    expect(f.remote.negotiateContentReferences).not.toHaveBeenCalled()
  })
  it('discovers capability once across recreated clients while leaving metadata probes cheap', async () => {
    const paths: string[] = []
    const transport = {
      async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
        paths.push(request.path)
        return (
          request.path.endsWith('/account')
            ? { data: { capabilities: { content_references: true } } }
            : { data: [], cursor: 0, next_page: null }
        ) as Response
      }
    }
    const options = {
      contentReferences: true,
      accountScope: { baseUrl: 'https://capabilities.example.test', accountId: 'one' },
      bootstrapContentPageBytes: 1_048_576
    }
    const first = new CloudSyncApiClient(transport, options)
    await first.manifest('vault', { includeContent: false, perPage: 1 })
    await first.negotiateContentReferences()
    await first.manifest('vault', { includeContent: true, page: 2, perPage: 250 })
    const second = new CloudSyncApiClient(transport, options)
    await second.negotiateContentReferences()
    await second.changes('vault', 250, 250, { maxInlineBytes: 0 })
    expect(paths.filter((value) => value.endsWith('/account'))).toHaveLength(1)
    expect(paths[0]).toBe('/api/v1/vaults/vault/manifest?include_content=false&per_page=1')
    expect(paths[2]).toContain(
      'page=2&per_page=250&content_mode=references&max_inline_bytes=262144&max_response_bytes=1048576'
    )
    expect(paths[3]).toContain('after=250&limit=250&content_mode=references&max_inline_bytes=0')
  })

  it('does not silently download giant legacy responses when a streaming host meets an old server', async () => {
    const send = vi.fn(async () => ({ data: { capabilities: {} } }))
    const api = new CloudSyncApiClient({ request: send as never }, { contentReferences: true })
    await expect(api.negotiateContentReferences()).rejects.toThrow(
      'needs content-reference support'
    )
    await expect(api.changes('vault', 0)).rejects.toThrow('Negotiate')
    await expect(api.revision('vault', 'item', 1)).rejects.toThrow('Negotiate')
    expect(send).toHaveBeenCalledOnce()
  })
})
