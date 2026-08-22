import { describe, expect, it, vi } from 'vitest'
import type {
  CloudSyncMutationRequest,
  CloudSyncVault
} from '@zennotes/bridge-contract/cloud-sync'
import type { CloudSyncRepository } from './cloud-sync-coordinator'
import type { CloudSyncState } from './cloud-sync-engine'
import {
  CloudSyncHostService,
  type CloudSyncHostPersistence,
  type CloudSyncHostVault
} from './cloud-sync-host-service'

function setup(vaults: CloudSyncVault[] = []) {
  let link: unknown = null
  let state: unknown = null
  const persistence: CloudSyncHostPersistence = {
    async loadLink() {
      return link
    },
    async saveLink(_vaultKey, value) {
      link = structuredClone(value)
    },
    async deleteLink() {
      link = null
    },
    async loadState() {
      return state
    },
    async saveState(_vaultKey, _baseUrl, value: CloudSyncState) {
      state = structuredClone(value)
    }
  }
  const repository: CloudSyncRepository = {
    async scan() {
      return []
    },
    async apply() {}
  }
  const hostVault: CloudSyncHostVault = {
    key: 'local-vault-1',
    repository,
    refresh: vi.fn(async () => {})
  }
  const client = {
    account: vi.fn(async () => ({
      data: {
        user: { name: 'Ada', email: 'ada@example.com' },
        device: {
          id: 'device-1',
          name: 'Ada’s iPhone',
          platform: 'ios' as const,
          app_version: '1.5.0'
        },
        features: {
          sync: { active: true, limits: null },
          backup: { active: false, limits: null },
          publish: { active: false, limits: null }
        }
      }
    })),
    listVaults: vi.fn(async () => ({ data: vaults })),
    createVault: vi.fn(async (name: string) => ({
      data: {
        id: 'vault-created',
        name,
        cursor: 0,
        created_at: '2026-08-10T12:00:00.000Z',
        updated_at: '2026-08-10T12:00:00.000Z'
      }
    })),
    deleteVault: vi.fn(async () => undefined),
    manifest: vi.fn(async () => ({ data: [], cursor: 0, next_page: null })),
    changes: vi.fn(async () => ({ data: [], cursor: 0, has_more: false })),
    mutate: vi.fn(async (_vaultId: string, body: CloudSyncMutationRequest) => ({
      acknowledged: body.mutations.map((mutation, index) => ({
        operation_id: mutation.operation_id,
        item_id: mutation.item_id,
        revision: 1,
        sequence: index + 1
      })),
      conflicts: [],
      cursor: body.mutations.length
    })),
    listBackups: vi.fn(async () => ({ data: [] })),
    backupSchedule: vi.fn(async () => ({
      data: {
        enabled: false,
        frequency: 'daily' as const,
        next_backup_at: null,
        last_backup_at: null
      }
    })),
    updateBackupSchedule: vi.fn(async (_vaultId: string, enabled: boolean) => ({
      data: {
        enabled,
        frequency: 'daily' as const,
        next_backup_at: enabled ? '2026-08-11T03:15:00.000Z' : null,
        last_backup_at: null
      }
    })),
    listBackupItems: vi.fn(async () => ({
      data: [
        {
          id: 42,
          item_id: 'item-1',
          path: 'Notes/Launch.md',
          kind: 'text',
          byte_length: 8,
          revision: 3,
          content_hash: 'abc123',
          media_type: 'text/markdown'
        }
      ]
    })),
    createBackup: vi.fn(async (_vaultId: string, label?: string) => ({
      data: {
        id: 'backup-1',
        label: label ?? null,
        status: 'pending' as const,
        cursor: 0,
        item_count: 0,
        total_bytes: 0,
        archive_bytes: null,
        expires_at: null,
        created_at: '2026-08-10T12:00:00.000Z'
      }
    })),
    deleteBackup: vi.fn(async () => {}),
    createBackupRestore: vi.fn(async () => ({
      data: {
        id: 'restore-1',
        backup_id: 'backup-1',
        mode: 'replace' as const,
        status: 'completed' as const,
        expected_cursor: 0,
        start_cursor: 0,
        end_cursor: 1,
        restored_items: 1,
        deleted_items: 0,
        error: null,
        created_at: '2026-08-10T12:00:00.000Z',
        updated_at: '2026-08-10T12:00:00.000Z'
      }
    })),
    backupRestore: vi.fn(),
    restoreBackupNote: vi.fn(async () => ({
      data: {
        id: 'note-restore-1',
        status: 'completed' as const,
        item_id: 'item-1',
        path: 'Notes/Launch.md',
        revision: 4,
        cursor: 1,
        error_code: null,
        created_at: '2026-08-10T12:00:00.000Z'
      }
    }))
  }
  const service = new CloudSyncHostService({
    persistence,
    accountStatus: async () => ({
      state: 'connected',
      account: {
        base_url: 'https://zennotes.org',
        user: { name: 'Ada', email: 'ada@example.com' },
        device: { id: 'device-1', name: 'Ada’s iPhone', platform: 'ios' },
        connected_at: '2026-08-10T12:00:00.000Z'
      }
    }),
    createClient: async () => client,
    now: () => new Date('2026-08-10T12:00:00.000Z'),
    ids: { itemId: () => 'item-1', operationId: () => 'operation-1' }
  })

  return { client, hostVault, persistence, service }
}

describe('CloudSyncHostService', () => {
  it('links only remote vaults owned by the connected account', async () => {
    const remoteVault: CloudSyncVault = {
      id: 'vault-1',
      name: 'Notes',
      cursor: 0,
      created_at: '2026-08-10T12:00:00.000Z',
      updated_at: '2026-08-10T12:00:00.000Z'
    }
    const { hostVault, service } = setup([remoteVault])

    await expect(service.link(hostVault, 'other')).rejects.toThrow('not available')
    await expect(service.link(hostVault, remoteVault.id)).resolves.toMatchObject({
      vault_id: 'vault-1',
      vault_name: 'Notes'
    })
    await expect(service.linkedVault(hostVault)).resolves.toMatchObject({ vault_id: 'vault-1' })
  })

  it('creates, links, and coalesces sync runs for one local vault', async () => {
    const { client, hostVault, service } = setup()

    await service.createAndLink(hostVault, 'My Notes')
    const [first, second] = await Promise.all([service.sync(hostVault), service.sync(hostVault)])

    expect(client.createVault).toHaveBeenCalledWith('My Notes')
    expect(client.manifest).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(hostVault.refresh).toHaveBeenCalledTimes(1)
  })

  it('deletes the remote vault before dropping the link', async () => {
    const { client, hostVault, service } = setup()

    await service.createAndLink(hostVault, 'My Notes')
    await service.deleteLinkedVault(hostVault)

    expect(client.deleteVault).toHaveBeenCalledWith('vault-created')
    await expect(service.linkedVault(hostVault)).resolves.toBeNull()
  })

  it('keeps the link when the remote delete fails', async () => {
    const { client, hostVault, service } = setup()

    await service.createAndLink(hostVault, 'My Notes')
    client.deleteVault.mockRejectedValueOnce(new Error('offline'))

    await expect(service.deleteLinkedVault(hostVault)).rejects.toThrow('offline')
    await expect(service.linkedVault(hostVault)).resolves.toMatchObject({ vault_id: 'vault-created' })
  })

  it('refuses to sync a link from a different cloud origin', async () => {
    const { hostVault, persistence, service } = setup()
    await persistence.saveLink(hostVault.key, {
      base_url: 'https://other.example',
      vault_id: 'vault-1',
      vault_name: 'Notes',
      linked_at: '2026-08-10T12:00:00.000Z'
    })

    await expect(service.sync(hostVault)).rejects.toThrow('different ZenNotes Cloud account')
  })

  it('creates, lists, schedules, deletes, and restores backups for the linked vault', async () => {
    const remoteVault: CloudSyncVault = {
      id: 'vault-1',
      name: 'Notes',
      cursor: 0,
      created_at: '2026-08-10T12:00:00.000Z',
      updated_at: '2026-08-10T12:00:00.000Z'
    }
    const { client, hostVault, service } = setup([remoteVault])
    await service.link(hostVault, remoteVault.id)

    await expect(service.listBackups(hostVault)).resolves.toEqual([])
    await expect(service.backupSchedule(hostVault)).resolves.toMatchObject({ enabled: false })
    await expect(service.updateBackupSchedule(hostVault, true)).resolves.toMatchObject({
      enabled: true
    })
    await expect(service.listBackupItems(hostVault, 'backup-1')).resolves.toEqual([
      expect.objectContaining({ id: 42, path: 'Notes/Launch.md' })
    ])
    await expect(service.createBackup(hostVault, 'Before travel')).resolves.toMatchObject({
      id: 'backup-1',
      label: 'Before travel'
    })
    await expect(service.deleteBackup(hostVault, 'backup-1')).resolves.toBeUndefined()
    await expect(service.restoreBackup(hostVault, 'backup-1')).resolves.toMatchObject({
      restore: { status: 'completed' },
      sync: { cursor: 0 }
    })
    await expect(service.restoreBackupNote(hostVault, 'backup-1', 42)).resolves.toMatchObject({
      restore: { status: 'completed', path: 'Notes/Launch.md' },
      sync: { cursor: 0 }
    })

    expect(client.createBackup).toHaveBeenCalledWith('vault-1', 'Before travel')
    expect(client.deleteBackup).toHaveBeenCalledWith('vault-1', 'backup-1')
    expect(client.updateBackupSchedule).toHaveBeenCalledWith('vault-1', true)
    expect(client.listBackupItems).toHaveBeenCalledWith('vault-1', 'backup-1')
    expect(client.createBackupRestore).toHaveBeenCalledWith('vault-1', 'backup-1', {
      idempotency_key: 'operation-1',
      expected_cursor: 0,
      mode: 'replace'
    })
    expect(client.restoreBackupNote).toHaveBeenCalledWith('vault-1', 'backup-1', 42, {
      idempotency_key: 'operation-1',
      expected_cursor: 0
    })
  })

  it('does not snapshot the remote vault when the pre-backup sync has conflicts', async () => {
    const remoteVault: CloudSyncVault = {
      id: 'vault-1',
      name: 'Notes',
      cursor: 1,
      created_at: '2026-08-10T12:00:00.000Z',
      updated_at: '2026-08-10T12:00:00.000Z'
    }
    const { client, hostVault, service } = setup([remoteVault])
    await service.link(hostVault, remoteVault.id)
    vi.spyOn(service, 'sync').mockResolvedValue({
      cursor: 1,
      pulled: 0,
      pushed: 0,
      conflicts: [
        {
          operation_id: 'operation-1',
          item_id: 'item-1',
          code: 'REVISION_CONFLICT',
          current_revision: 2,
          current_path: 'Note.md'
        }
      ],
      bootstrap_conflicts: [], local_conflicts: []
    })

    await expect(service.createBackup(hostVault)).rejects.toThrow('Resolve sync conflicts')
    expect(client.createBackup).not.toHaveBeenCalled()
  })
})
