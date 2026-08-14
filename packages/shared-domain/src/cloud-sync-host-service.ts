import type {
  CloudAccountStatus,
  CloudBackupNoteRestoreResult,
  CloudBackupRestoreResult,
  CloudBackupSchedule,
  CloudBackupSnapshot,
  CloudBackupSnapshotItem,
  CloudServiceAccount,
  CloudSyncRunSummary,
  CloudSyncVault,
  CloudVaultLink
} from '@zennotes/bridge-contract/cloud-sync'
import type { CloudSyncApiClient } from './cloud-sync-api'
import { restoreCloudBackup } from './cloud-backup'
import { normalizeCloudSyncPath } from './cloud-sync'
import {
  CloudSyncCoordinator,
  type CloudSyncRepository,
  type CloudSyncStateStore
} from './cloud-sync-coordinator'
import type { CloudSyncIdSource, CloudSyncState } from './cloud-sync-engine'

type SyncClient = Pick<
  CloudSyncApiClient,
  | 'account'
  | 'listVaults'
  | 'createVault'
  | 'manifest'
  | 'changes'
  | 'mutate'
  | 'listBackups'
  | 'backupSchedule'
  | 'updateBackupSchedule'
  | 'listBackupItems'
  | 'createBackup'
  | 'deleteBackup'
  | 'createBackupRestore'
  | 'backupRestore'
  | 'restoreBackupNote'
>

export interface CloudSyncHostVault {
  /** Stable per local vault, without account credentials. */
  key: string
  repository: CloudSyncRepository
  refresh(): Promise<void>
}

export interface CloudSyncHostPersistence {
  loadLink(vaultKey: string): Promise<unknown>
  saveLink(vaultKey: string, link: CloudVaultLink): Promise<void>
  deleteLink(vaultKey: string): Promise<void>
  loadState(vaultKey: string, baseUrl: string, vaultId: string): Promise<unknown>
  saveState(vaultKey: string, baseUrl: string, state: CloudSyncState): Promise<void>
}

export interface CloudSyncHostServiceDependencies {
  persistence: CloudSyncHostPersistence
  accountStatus(): Promise<CloudAccountStatus>
  createClient(): Promise<SyncClient>
  now?: () => Date
  ids?: CloudSyncIdSource
}

/** Account/link orchestration shared by the iOS and Android host adapters. */
export class CloudSyncHostService {
  private readonly runs = new Map<string, Promise<CloudSyncRunSummary>>()
  private readonly now: () => Date
  private readonly ids: CloudSyncIdSource

  constructor(private readonly dependencies: CloudSyncHostServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.ids = dependencies.ids ?? {
      itemId: () => crypto.randomUUID(),
      operationId: () => crypto.randomUUID()
    }
  }

  async listVaults(): Promise<CloudSyncVault[]> {
    const { client } = await this.connection()
    return (await client.listVaults()).data
  }

  async serviceAccount(): Promise<CloudServiceAccount> {
    const { client } = await this.connection()
    return (await client.account()).data
  }

  async link(vault: CloudSyncHostVault, vaultId: string): Promise<CloudVaultLink> {
    const { account, client } = await this.connection()
    const remoteVault = (await client.listVaults()).data.find(
      (candidate) => candidate.id === vaultId
    )
    if (!remoteVault) {
      throw new Error('That ZenNotes Cloud vault is not available to this account.')
    }

    const link = this.linkValue(account.base_url, remoteVault)
    await this.dependencies.persistence.saveLink(vault.key, link)
    return link
  }

  async createAndLink(vault: CloudSyncHostVault, name: string): Promise<CloudVaultLink> {
    const normalizedName = name.trim()
    if (!normalizedName) throw new Error('Cloud vault name is required.')

    const { account, client } = await this.connection()
    const remoteVault = (await client.createVault(normalizedName)).data
    const link = this.linkValue(account.base_url, remoteVault)
    await this.dependencies.persistence.saveLink(vault.key, link)
    return link
  }

  async linkedVault(vault: CloudSyncHostVault): Promise<CloudVaultLink | null> {
    const value = await this.dependencies.persistence.loadLink(vault.key)
    return isCloudVaultLink(value) ? value : null
  }

  async unlink(vault: CloudSyncHostVault): Promise<void> {
    await this.dependencies.persistence.deleteLink(vault.key)
  }

  async listBackups(vault: CloudSyncHostVault): Promise<CloudBackupSnapshot[]> {
    const { client, link } = await this.linkedConnection(vault)
    return (await client.listBackups(link.vault_id)).data
  }

  async backupSchedule(vault: CloudSyncHostVault): Promise<CloudBackupSchedule> {
    const { client, link } = await this.linkedConnection(vault)
    return (await client.backupSchedule(link.vault_id)).data
  }

  async updateBackupSchedule(
    vault: CloudSyncHostVault,
    enabled: boolean
  ): Promise<CloudBackupSchedule> {
    const { client, link } = await this.linkedConnection(vault)
    return (await client.updateBackupSchedule(link.vault_id, enabled)).data
  }

  async listBackupItems(
    vault: CloudSyncHostVault,
    backupId: string
  ): Promise<CloudBackupSnapshotItem[]> {
    const { client, link } = await this.linkedConnection(vault)
    return (await client.listBackupItems(link.vault_id, backupId)).data
  }

  async createBackup(
    vault: CloudSyncHostVault,
    label?: string
  ): Promise<CloudBackupSnapshot> {
    const summary = await this.sync(vault)
    assertBackupReady(summary)
    const { client, link } = await this.linkedConnection(vault)
    return (await client.createBackup(link.vault_id, label)).data
  }

  async deleteBackup(vault: CloudSyncHostVault, backupId: string): Promise<void> {
    const { client, link } = await this.linkedConnection(vault)
    await client.deleteBackup(link.vault_id, backupId)
  }

  async restoreBackup(
    vault: CloudSyncHostVault,
    backupId: string
  ): Promise<CloudBackupRestoreResult> {
    const { client, link } = await this.linkedConnection(vault)
    return await restoreCloudBackup({
      client,
      vaultId: link.vault_id,
      backupId,
      idempotencyKey: this.ids.operationId,
      sync: () => this.sync(vault)
    })
  }

  async restoreBackupNote(
    vault: CloudSyncHostVault,
    backupId: string,
    snapshotItemId: number
  ): Promise<CloudBackupNoteRestoreResult> {
    const beforeRestore = await this.sync(vault)
    assertBackupReady(beforeRestore)
    const { client, link } = await this.linkedConnection(vault)
    const restore = (
      await client.restoreBackupNote(link.vault_id, backupId, snapshotItemId, {
        idempotency_key: this.ids.operationId(),
        expected_cursor: beforeRestore.cursor
      })
    ).data
    const sync = await this.sync(vault)

    return { restore, sync }
  }

  sync(vault: CloudSyncHostVault): Promise<CloudSyncRunSummary> {
    const existing = this.runs.get(vault.key)
    if (existing) return existing

    const running = this.run(vault).finally(() => {
      this.runs.delete(vault.key)
    })
    this.runs.set(vault.key, running)
    return running
  }

  private async run(vault: CloudSyncHostVault): Promise<CloudSyncRunSummary> {
    const link = await this.linkedVault(vault)
    if (!link) throw new Error('Link this local vault to a ZenNotes Cloud vault before syncing.')

    const { account, client } = await this.connection()
    if (link.base_url !== account.base_url) {
      throw new Error('This vault is linked to a different ZenNotes Cloud account.')
    }

    const coordinator = new CloudSyncCoordinator(
      link.vault_id,
      client,
      vault.repository,
      this.stateStore(vault.key, account.base_url, link.vault_id),
      this.ids
    )

    try {
      const result = await coordinator.sync()
      return {
        cursor: result.state.cursor,
        pulled: result.pulled,
        pushed: result.pushed,
        conflicts: result.conflicts,
        bootstrap_conflicts: result.bootstrapConflicts,
        local_conflicts: result.localConflicts
      }
    } finally {
      await vault.refresh()
    }
  }

  private async connection(): Promise<{
    account: NonNullable<CloudAccountStatus['account']>
    client: SyncClient
  }> {
    const status = await this.dependencies.accountStatus()
    if (status.state !== 'connected' || !status.account) {
      throw new Error('Connect ZenNotes Cloud before using sync.')
    }
    return { account: status.account, client: await this.dependencies.createClient() }
  }

  private async linkedConnection(vault: CloudSyncHostVault): Promise<{
    account: NonNullable<CloudAccountStatus['account']>
    client: SyncClient
    link: CloudVaultLink
  }> {
    const link = await this.linkedVault(vault)
    if (!link) throw new Error('Link this local vault to a ZenNotes Cloud vault first.')
    const connection = await this.connection()
    if (link.base_url !== connection.account.base_url) {
      throw new Error('This vault is linked to a different ZenNotes Cloud account.')
    }
    return { ...connection, link }
  }

  private stateStore(vaultKey: string, baseUrl: string, vaultId: string): CloudSyncStateStore {
    return {
      load: async () => {
        const value = await this.dependencies.persistence.loadState(vaultKey, baseUrl, vaultId)
        return isCloudSyncState(value, vaultId) ? value : null
      },
      save: (state) => this.dependencies.persistence.saveState(vaultKey, baseUrl, state)
    }
  }

  private linkValue(baseUrl: string, vault: CloudSyncVault): CloudVaultLink {
    return {
      base_url: baseUrl,
      vault_id: vault.id,
      vault_name: vault.name,
      linked_at: this.now().toISOString()
    }
  }
}

function isCloudVaultLink(value: unknown): value is CloudVaultLink {
  if (!value || typeof value !== 'object') return false
  const link = value as Partial<CloudVaultLink>
  return (
    typeof link.base_url === 'string' &&
    typeof link.vault_id === 'string' &&
    typeof link.vault_name === 'string' &&
    typeof link.linked_at === 'string' &&
    Number.isFinite(new Date(link.linked_at).getTime())
  )
}

function isCloudSyncState(value: unknown, vaultId: string): value is CloudSyncState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<CloudSyncState>
  return (
    state.version === 1 &&
    state.vault_id === vaultId &&
    typeof state.cursor === 'number' &&
    Number.isInteger(state.cursor) &&
    state.cursor >= 0 &&
    Boolean(state.items) &&
    typeof state.items === 'object' &&
    !Array.isArray(state.items) &&
    Object.entries(state.items).every(([itemId, item]) => isTrackedItem(itemId, item))
  )
}

function isTrackedItem(itemId: string, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (
    item.item_id !== itemId ||
    typeof item.path !== 'string' ||
    !['text', 'binary'].includes(String(item.kind)) ||
    typeof item.revision !== 'number' ||
    !Number.isInteger(item.revision) ||
    item.revision < 1 ||
    typeof item.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.sha256) ||
    typeof item.byte_length !== 'number' ||
    !Number.isInteger(item.byte_length) ||
    item.byte_length < 0 ||
    typeof item.media_type !== 'string'
  ) {
    return false
  }

  try {
    return normalizeCloudSyncPath(item.path) === item.path
  } catch {
    return false
  }
}

function assertBackupReady(summary: CloudSyncRunSummary): void {
  if (summary.conflicts.length > 0 || summary.bootstrap_conflicts.length > 0) {
    throw new Error('Resolve sync conflicts before creating a cloud backup.')
  }
}
