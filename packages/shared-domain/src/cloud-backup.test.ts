import { describe, expect, it, vi } from 'vitest'
import type { CloudSyncVault } from '@zennotes/bridge-contract/cloud-sync'
import { restoreCloudBackup } from './cloud-backup'

const vault: CloudSyncVault = {
  id: 'vault-1',
  name: 'Notes',
  cursor: 14,
  created_at: '2026-08-10T12:00:00.000Z',
  updated_at: '2026-08-10T12:00:00.000Z'
}

function restore(status: 'pending' | 'restoring' | 'completed' | 'conflict' | 'failed') {
  return {
    id: 'restore-1',
    backup_id: 'backup-1',
    mode: 'replace' as const,
    status,
    expected_cursor: 14,
    start_cursor: status === 'pending' ? null : 14,
    end_cursor: status === 'completed' ? 18 : null,
    restored_items: status === 'completed' ? 3 : 0,
    deleted_items: status === 'completed' ? 1 : 0,
    error: status === 'failed' ? { code: 'RESTORE_FAILED', message: 'Nope' } : null,
    created_at: '2026-08-10T12:00:00.000Z',
    updated_at: '2026-08-10T12:00:00.000Z'
  }
}

describe('restoreCloudBackup', () => {
  it('uses the latest remote cursor, waits for completion, then syncs locally', async () => {
    const client = {
      listVaults: vi.fn(async () => ({ data: [vault] })),
      createBackupRestore: vi.fn(async () => ({ data: restore('pending') })),
      backupRestore: vi
        .fn()
        .mockResolvedValueOnce({ data: restore('restoring') })
        .mockResolvedValueOnce({ data: restore('completed') })
    }
    const sync = vi.fn(async () => ({
      cursor: 18,
      pulled: 4,
      pushed: 0,
      conflicts: [],
      bootstrap_conflicts: [], local_conflicts: []
    }))

    await expect(
      restoreCloudBackup({
        client,
        vaultId: vault.id,
        backupId: 'backup-1',
        idempotencyKey: () => 'restore-operation-1',
        wait: async () => {},
        sync
      })
    ).resolves.toMatchObject({
      restore: { status: 'completed', end_cursor: 18 },
      sync: { cursor: 18, pulled: 4 }
    })

    expect(client.createBackupRestore).toHaveBeenCalledWith(vault.id, 'backup-1', {
      idempotency_key: 'restore-operation-1',
      expected_cursor: 14,
      mode: 'replace'
    })
    expect(client.backupRestore).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenCalledOnce()
  })

  it('returns a restore conflict without overwriting the local vault', async () => {
    const client = {
      listVaults: vi.fn(async () => ({ data: [vault] })),
      createBackupRestore: vi.fn(async () => ({ data: restore('conflict') })),
      backupRestore: vi.fn()
    }
    const sync = vi.fn()

    await expect(
      restoreCloudBackup({
        client,
        vaultId: vault.id,
        backupId: 'backup-1',
        idempotencyKey: () => 'restore-operation-1',
        wait: async () => {},
        sync
      })
    ).resolves.toMatchObject({ restore: { status: 'conflict' }, sync: null })

    expect(client.backupRestore).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('times out without syncing when the restore remains queued', async () => {
    const client = {
      listVaults: vi.fn(async () => ({ data: [vault] })),
      createBackupRestore: vi.fn(async () => ({ data: restore('pending') })),
      backupRestore: vi.fn(async () => ({ data: restore('restoring') }))
    }

    await expect(
      restoreCloudBackup({
        client,
        vaultId: vault.id,
        backupId: 'backup-1',
        idempotencyKey: () => 'restore-operation-1',
        wait: async () => {},
        maxPolls: 2,
        sync: vi.fn()
      })
    ).rejects.toThrow('still running')
  })
})
