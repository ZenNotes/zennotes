import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  CloudAccountStatus,
  CloudSyncMutationRequest,
  CloudSyncVault
} from '@zennotes/bridge-contract/cloud-sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudServiceRequestError } from './cloud-sync-client'
import { DesktopCloudSyncService } from './cloud-sync-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function setup(
  vaults: CloudSyncVault[] = [],
  fetchImplementation?: typeof fetch,
  accountStatus?: () => Promise<CloudAccountStatus>
) {
  const localRoot = await mkdtemp(path.join(os.tmpdir(), 'zennotes-local-vault-'))
  const storageDirectory = await mkdtemp(path.join(os.tmpdir(), 'zennotes-cloud-state-'))
  temporaryDirectories.push(localRoot, storageDirectory)
  const client = {
    account: vi.fn(async () => ({
      data: {
        user: { name: 'Ada', email: 'ada@example.com' },
        device: {
          id: 'device-1',
          name: 'Test Mac',
          platform: 'desktop' as const,
          app_version: '2.26.0'
        },
        features: {
          sync: { active: true, limits: null },
          backup: { active: false, limits: null },
          publish: { active: false, limits: null }
        }
      }
    })),
    listPublishedNotes: vi.fn(async () => ({ data: [] })),
    publishNote: vi.fn(async () => ({
      id: 42,
      slug: 'published-note',
      url: 'https://zennotes.org/s/published-note'
    })),
    updatePublishedNote: vi.fn(async () => ({
      id: 42,
      slug: 'published-note',
      url: 'https://zennotes.org/s/published-note'
    })),
    unpublishNote: vi.fn(async () => {}),
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
    deleteVault: vi.fn(async () => {}),
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
        next_backup_at: enabled ? '2026-08-11T12:00:00.000Z' : null,
        last_backup_at: null
      }
    })),
    listBackupItems: vi.fn(async () => ({ data: [] })),
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
        path: 'note.md',
        revision: 2,
        cursor: 1,
        error_code: null,
        created_at: '2026-08-10T12:00:00.000Z'
      }
    })),
    backupDownloadPath: vi.fn(
      (vaultId: string, backupId: string) =>
        `/api/v1/vaults/${vaultId}/backups/${backupId}/download`
    )
  }
  const service = new DesktopCloudSyncService({
    storageDirectory,
    accountStatus:
      accountStatus ??
      (async () => ({
        state: 'connected',
        account: {
          base_url: 'https://zennotes.org',
          user: { name: 'Ada', email: 'ada@example.com' },
          device: { id: 'device-1', name: 'Test Mac', platform: 'desktop' },
          connected_at: '2026-08-10T12:00:00.000Z'
        }
      })),
    getSecret: async () => 'secret-token',
    createClient: () => client,
    fetchImplementation,
    now: () => new Date('2026-08-10T12:00:00.000Z')
  })
  return { service, client, localRoot }
}

describe('DesktopCloudSyncService', () => {
  // Settings differ between devices, so sync asks instead of picking. Doing
  // nothing keeps this device's settings, which are already in use.
  it('answers the settings question either way', async () => {
    const { service, localRoot } = await setup([])
    const settingsPath = path.join(localRoot, '.zennotes', 'vault.json')
    const parkedPath = path.join(localRoot, '.zennotes', 'vault.cloud-conflict.json')
    await mkdir(path.join(localRoot, '.zennotes'), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({ favorites: ['local.md'] }))

    expect(await service.settingsConflict(localRoot)).toBeNull()

    await writeFile(parkedPath, JSON.stringify({ favorites: ['cloud.md'] }))
    expect(await service.settingsConflict(localRoot)).toEqual({
      path: '.zennotes/vault.json',
      cloud_path: '.zennotes/vault.cloud-conflict.json'
    })

    // Keeping this device's settings drops the pending copy and changes nothing.
    await service.resolveSettingsConflict(localRoot, 'local')
    expect(await service.settingsConflict(localRoot)).toBeNull()
    expect(JSON.parse(await readFile(settingsPath, 'utf8')).favorites).toEqual(['local.md'])

    // Taking the cloud's writes them through the vault's own normalizer.
    await writeFile(parkedPath, JSON.stringify({ favorites: ['cloud.md'] }))
    await service.resolveSettingsConflict(localRoot, 'cloud')
    expect(await service.settingsConflict(localRoot)).toBeNull()
    expect(JSON.parse(await readFile(settingsPath, 'utf8')).favorites).toEqual(['cloud.md'])
  })

  it('refuses to apply cloud settings that are not readable', async () => {
    const { service, localRoot } = await setup([])
    await mkdir(path.join(localRoot, '.zennotes'), { recursive: true })
    await writeFile(path.join(localRoot, '.zennotes', 'vault.json'), JSON.stringify({}))
    await writeFile(path.join(localRoot, '.zennotes', 'vault.cloud-conflict.json'), 'not json')

    await expect(service.resolveSettingsConflict(localRoot, 'cloud')).rejects.toThrow(
      'could not be read'
    )
    // The question stays open rather than resolving itself badly.
    expect(await service.settingsConflict(localRoot)).not.toBeNull()
  })

  it('links only a vault owned by the connected account', async () => {
    const remoteVault: CloudSyncVault = {
      id: 'vault-1',
      name: 'Notes',
      cursor: 0,
      created_at: '2026-08-10T12:00:00.000Z',
      updated_at: '2026-08-10T12:00:00.000Z'
    }
    const { service, localRoot } = await setup([remoteVault])

    await expect(service.link(localRoot, 'other-vault')).rejects.toThrow('not available')
    await expect(service.link(localRoot, remoteVault.id)).resolves.toMatchObject({
      vault_id: remoteVault.id,
      vault_name: remoteVault.name
    })
    await expect(service.linkedVault(localRoot)).resolves.toMatchObject({
      vault_id: remoteVault.id
    })
  })

  it('returns the server-authoritative feature set', async () => {
    const { service } = await setup()

    await expect(service.serviceAccount()).resolves.toMatchObject({
      features: {
        sync: { active: true, limits: null },
        backup: { active: false, limits: null },
        publish: { active: false, limits: null }
      }
    })
  })

  it('publishes, updates, and unpublishes through the connected account', async () => {
    const { service, client } = await setup()
    const input = {
      note_path: 'Notes/Launch.md',
      title: 'Launch',
      markdown: '# Launch'
    }

    await expect(service.listPublishedNotes()).resolves.toEqual([])
    await expect(service.publishNote(input)).resolves.toMatchObject({ id: 42 })
    await expect(service.updatePublishedNote(42, input)).resolves.toMatchObject({ id: 42 })
    await expect(service.unpublishNote(42)).resolves.toBeUndefined()

    expect(client.publishNote).toHaveBeenCalledWith(input)
    expect(client.updatePublishedNote).toHaveBeenCalledWith(42, input)
    expect(client.unpublishNote).toHaveBeenCalledWith(42)
  })

  it('treats the optional published-note list as empty when publishing is unavailable', async () => {
    const disconnected = await setup([], undefined, async () => ({
      state: 'disconnected',
      account: null
    }))

    await expect(disconnected.service.listPublishedNotes()).resolves.toEqual([])
    expect(disconnected.client.listPublishedNotes).not.toHaveBeenCalled()

    const connected = await setup()
    connected.client.listPublishedNotes.mockRejectedValueOnce(
      new CloudServiceRequestError('Publishing is not included.', 403, 'FEATURE_NOT_ENTITLED')
    )

    await expect(connected.service.listPublishedNotes()).resolves.toEqual([])
  })

  it('still surfaces unexpected failures while listing published notes', async () => {
    const { service, client } = await setup()
    client.listPublishedNotes.mockRejectedValueOnce(new Error('Network unavailable'))

    await expect(service.listPublishedNotes()).rejects.toThrow('Network unavailable')
  })

  it('creates, links, and uploads an untracked local vault', async () => {
    const { service, client, localRoot } = await setup()
    await writeFile(path.join(localRoot, 'Note.md'), '# Local note')

    await service.createAndLink(localRoot, 'My Notes')
    const result = await service.sync(localRoot)

    expect(client.createVault).toHaveBeenCalledWith('My Notes')
    expect(client.mutate).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ pulled: 0, pushed: 1, conflicts: [] })
  })

  it('deletes the remote vault before removing the local device link', async () => {
    const remoteVault: CloudSyncVault = {
      id: 'vault-1',
      name: 'Notes',
      cursor: 0,
      created_at: '2026-08-10T12:00:00.000Z',
      updated_at: '2026-08-10T12:00:00.000Z'
    }
    const { service, client, localRoot } = await setup([remoteVault])
    await service.link(localRoot, remoteVault.id)

    await expect(service.deleteLinkedVault(localRoot)).resolves.toBeUndefined()

    expect(client.deleteVault).toHaveBeenCalledWith(remoteVault.id)
    await expect(service.linkedVault(localRoot)).resolves.toBeNull()
  })

  it('coalesces overlapping sync runs for the same local vault', async () => {
    const remoteVault: CloudSyncVault = {
      id: 'vault-1',
      name: 'Notes',
      cursor: 0,
      created_at: '2026-08-10T12:00:00.000Z',
      updated_at: '2026-08-10T12:00:00.000Z'
    }
    const { service, client, localRoot } = await setup([remoteVault])
    await service.link(localRoot, remoteVault.id)

    await Promise.all([service.sync(localRoot), service.sync(localRoot)])

    expect(client.manifest).toHaveBeenCalledTimes(1)
  })

  it('manages backups only through the linked cloud vault', async () => {
    const remoteVault: CloudSyncVault = {
      id: 'vault-1',
      name: 'Notes',
      cursor: 0,
      created_at: '2026-08-10T12:00:00.000Z',
      updated_at: '2026-08-10T12:00:00.000Z'
    }
    const { service, client, localRoot } = await setup([remoteVault])
    await service.link(localRoot, remoteVault.id)

    await expect(service.listBackups(localRoot)).resolves.toEqual([])
    await expect(service.backupSchedule(localRoot)).resolves.toMatchObject({ enabled: false })
    await expect(service.updateBackupSchedule(localRoot, true)).resolves.toMatchObject({
      enabled: true
    })
    await expect(service.listBackupItems(localRoot, 'backup-1')).resolves.toEqual([])
    await expect(service.createBackup(localRoot, 'Release day')).resolves.toMatchObject({
      id: 'backup-1',
      label: 'Release day'
    })
    await expect(service.deleteBackup(localRoot, 'backup-1')).resolves.toBeUndefined()
    await expect(service.restoreBackup(localRoot, 'backup-1')).resolves.toMatchObject({
      restore: { status: 'completed' },
      sync: { cursor: 0 }
    })
    await expect(service.restoreBackupNote(localRoot, 'backup-1', 42)).resolves.toMatchObject({
      restore: { status: 'completed' },
      sync: { cursor: 0 }
    })

    expect(client.createBackup).toHaveBeenCalledWith('vault-1', 'Release day')
    expect(client.deleteBackup).toHaveBeenCalledWith('vault-1', 'backup-1')
    expect(client.updateBackupSchedule).toHaveBeenCalledWith('vault-1', true)
    expect(client.listBackupItems).toHaveBeenCalledWith('vault-1', 'backup-1')
    expect(client.restoreBackupNote).toHaveBeenCalledWith(
      'vault-1',
      'backup-1',
      42,
      expect.objectContaining({ expected_cursor: 0 })
    )
  })

  it('streams an authenticated backup archive to the selected file', async () => {
    const remoteVault: CloudSyncVault = {
      id: 'vault-1',
      name: 'Notes',
      cursor: 0,
      created_at: '2026-08-10T12:00:00.000Z',
      updated_at: '2026-08-10T12:00:00.000Z'
    }
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      new Response(new Uint8Array([31, 139, 8, 0]), {
        status: 200,
        headers: { 'Content-Type': 'application/gzip' }
      })
    )
    const { service, localRoot } = await setup([remoteVault], fetchImplementation)
    const destination = path.join(localRoot, 'backup.json.gz')
    await service.link(localRoot, remoteVault.id)

    await service.downloadBackup(localRoot, 'backup-1', destination)

    expect([...await readFile(destination)]).toEqual([31, 139, 8, 0])
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://zennotes.org/api/v1/vaults/vault-1/backups/backup-1/download',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' })
      })
    )
  })

  it('does not create a backup after a conflicting sync', async () => {
    const remoteVault: CloudSyncVault = {
      id: 'vault-1',
      name: 'Notes',
      cursor: 1,
      created_at: '2026-08-10T12:00:00.000Z',
      updated_at: '2026-08-10T12:00:00.000Z'
    }
    const { service, client, localRoot } = await setup([remoteVault])
    await service.link(localRoot, remoteVault.id)
    vi.spyOn(service, 'sync').mockResolvedValue({
      cursor: 1,
      pulled: 0,
      pushed: 0,
      conflicts: [],
      bootstrap_conflicts: [
        {
          code: 'BOOTSTRAP_CONTENT_CONFLICT',
          item_id: 'item-1',
          path: 'Note.md',
          local_sha256: 'a'.repeat(64),
          remote_sha256: 'b'.repeat(64)
        }
      ], local_conflicts: []
    })

    await expect(service.createBackup(localRoot)).rejects.toThrow('Resolve sync conflicts')
    expect(client.createBackup).not.toHaveBeenCalled()
  })
})
