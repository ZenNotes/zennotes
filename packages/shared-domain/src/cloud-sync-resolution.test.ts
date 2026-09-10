import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CloudSyncContent } from '@zennotes/bridge-contract/cloud-sync'
import { CloudSyncCoordinator, type CloudSyncRemote } from './cloud-sync-coordinator'
import type { CloudSyncState, CloudSyncStoredConflict } from './cloud-sync-engine'

function content(data: string): CloudSyncContent {
  return {
    encoding: 'utf8',
    data,
    sha256: createHash('sha256').update(data).digest('hex'),
    byte_length: Buffer.byteLength(data),
    media_type: 'text/markdown'
  }
}

function fixture(withRevision = true) {
  const cloud = content('cloud'),
    local = content('local')
  const pending: CloudSyncStoredConflict = {
    id: 'note',
    item_id: 'note',
    kind: 'content',
    sequence: 2,
    base: { path: 'Note.md', revision: 1, kind: 'text', content: content('base') },
    local: { path: 'Note.md', revision: null, kind: 'text', content: local },
    cloud: { path: 'Note.md', revision: 2, kind: 'text', content: cloud }
  }
  let state: CloudSyncState = {
    version: 1,
    vault_id: 'vault',
    cursor: 2,
    items: {
      note: {
        item_id: 'note',
        path: 'Note.md',
        kind: 'text',
        revision: 2,
        sha256: cloud.sha256,
        byte_length: cloud.byte_length,
        media_type: cloud.media_type
      }
    },
    pending_conflicts: { note: pending }
  }
  const manifest = vi.fn().mockRejectedValue(new Error('Full vault download timed out'))
  const mutate = vi.fn<CloudSyncRemote['mutate']>().mockResolvedValue({
    acknowledged: [{ operation_id: 'save-note', item_id: 'note', revision: 3, sequence: 3 }],
    conflicts: [],
    cursor: 3
  })
  const write = vi.fn().mockResolvedValue(undefined)
  const revision = vi.fn<NonNullable<CloudSyncRemote['revision']>>()
  const remote: CloudSyncRemote = {
    manifest,
    mutate,
    changes: vi.fn(),
    ...(withRevision ? { revision } : {})
  }
  const coordinator = new CloudSyncCoordinator(
    'vault',
    remote,
    {
      scan: async () => [{ path: 'Note.md', kind: 'text', content: local }],
      apply: vi.fn(),
      applyConflictResolutionFiles: write
    },
    {
      load: async () => state,
      save: async (next) => {
        state = next
      }
    },
    { operationId: () => 'save-note', itemId: () => 'new-note' }
  )
  const resolution = {
    conflict_id: 'note',
    choice: 'merged' as const,
    merged_text: 'combined',
    expected_local_sha256: local.sha256,
    expected_cloud_revision: 2
  }
  return { coordinator, resolution, manifest, mutate, revision, write, state: () => state }
}

describe('single-note Cloud resolution', () => {
  it('saves against the reviewed revision without downloading the vault', async () => {
    const f = fixture()
    await f.coordinator.resolveConflict(f.resolution)
    expect(f.manifest).not.toHaveBeenCalled()
    expect(f.mutate).toHaveBeenCalledWith('vault', {
      mutations: [
        expect.objectContaining({
          item_id: 'note',
          base_revision: 2,
          content: content('combined')
        })
      ]
    })
    expect(f.write).toHaveBeenCalledOnce()
    expect(f.state().pending_conflicts).toEqual({})
    expect(f.state().items.note.revision).toBe(3)
  })

  it('preserves the local file and decision when the server rejects a stale revision', async () => {
    const f = fixture()
    f.mutate.mockResolvedValue({
      acknowledged: [],
      cursor: 3,
      conflicts: [
        {
          operation_id: 'save-note',
          code: 'REVISION_CONFLICT',
          item_id: 'note',
          current_revision: 3,
          current_path: 'Note.md'
        }
      ]
    })
    await expect(f.coordinator.resolveConflict(f.resolution)).rejects.toThrow(
      'Cloud version changed while saving'
    )
    expect(f.mutate).toHaveBeenCalledOnce()
    expect(f.write).not.toHaveBeenCalled()
    expect(f.state().pending_conflicts?.note).toBeDefined()
  })

  it('keeps the decision retryable if the save itself times out', async () => {
    const f = fixture()
    f.mutate.mockRejectedValue(new Error('Save request timed out'))
    await expect(f.coordinator.resolveConflict(f.resolution)).rejects.toThrow(
      'Save request timed out'
    )
    expect(f.write).not.toHaveBeenCalled()
    expect(f.state().pending_conflicts?.note).toBeDefined()
  })

  it.each(['cloud', 'both'] as const)(
    'fetches only the selected revision when keeping %s',
    async (choice) => {
      const f = fixture()
      f.state().pending_conflicts!.note.cloud.content = { ...content('cloud'), data: '' }
      f.manifest.mockResolvedValue({ data: [f.state().items.note], cursor: 2, next_page: null })
      f.revision.mockResolvedValue({
        data: {
          item_id: 'note',
          path: 'Note.md',
          revision: 2,
          kind: 'text',
          deleted: false,
          content: content('cloud')
        }
      })
      await f.coordinator.resolveConflict({ ...f.resolution, choice, keep_both_path: 'My copy.md' })
      expect(f.manifest).toHaveBeenCalledWith('vault', {
        includeContent: false,
        page: 1,
        perPage: 250
      })
      expect(f.revision).toHaveBeenCalledExactlyOnceWith('vault', 'note', 2)
      expect(f.mutate).not.toHaveBeenCalled()
      expect(f.write).toHaveBeenCalledWith(
        expect.objectContaining({
          files: expect.arrayContaining([{ path: 'Note.md', content: content('cloud') }])
        })
      )
      expect(f.state().pending_conflicts).toEqual({})
    }
  )

  it('rejects a retained revision whose hash does not match the reviewed file', async () => {
    const f = fixture()
    f.state().pending_conflicts!.note.cloud.content = { ...content('cloud'), data: '' }
    f.manifest.mockResolvedValue({ data: [f.state().items.note], cursor: 2, next_page: null })
    f.revision.mockResolvedValue({
      data: {
        item_id: 'note',
        path: 'Note.md',
        revision: 2,
        kind: 'text',
        deleted: false,
        content: content('wrong bytes')
      }
    })
    await expect(
      f.coordinator.resolveConflict({ ...f.resolution, choice: 'cloud' })
    ).rejects.toThrow('not available')
    expect(f.write).not.toHaveBeenCalled()
    expect(f.state().pending_conflicts?.note).toBeDefined()
  })

  it('retains the content-manifest fallback for hosts without revision reads', async () => {
    const f = fixture(false)
    f.state().pending_conflicts!.note.cloud.content = { ...content('cloud'), data: '' }
    f.manifest.mockImplementation(async (_vault, options) => ({
      data: [
        {
          ...f.state().items.note,
          ...(options.includeContent ? { content: content('cloud') } : {})
        }
      ],
      cursor: 2,
      next_page: null
    }))
    await f.coordinator.resolveConflict({ ...f.resolution, choice: 'cloud' })
    expect(f.manifest).toHaveBeenCalledWith('vault', {
      includeContent: true,
      page: 1,
      perPage: 250
    })
    expect(f.write).toHaveBeenCalledOnce()
  })
})
