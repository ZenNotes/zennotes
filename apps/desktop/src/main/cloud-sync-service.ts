import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  CloudAccountStatus,
  CloudBackupNoteRestoreResult,
  CloudBackupRestoreResult,
  CloudBackupSchedule,
  CloudBackupSnapshot,
  CloudBackupSnapshotItem,
  CloudPublishedNote,
  CloudPublishedNoteResult,
  CloudPublishNoteInput,
  CloudServiceAccount,
  CloudSyncRunSummary,
  CloudSyncSettingsChoice,
  CloudSyncSettingsConflict,
  CloudSyncVault,
  CloudVaultLink
} from '@zennotes/bridge-contract/cloud-sync'
import { restoreCloudBackup } from '@zennotes/shared-domain/cloud-backup'
import {
  CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
  CLOUD_SYNC_VAULT_SETTINGS_PATH
} from '@zennotes/shared-domain/cloud-sync'
import { setVaultSettings } from './vault'
import type { CloudSyncApiClient } from '@zennotes/shared-domain/cloud-sync-api'
import { createDesktopCloudSyncCoordinator } from './cloud-sync-filesystem'

type SyncClient = Pick<
  CloudSyncApiClient,
  | 'account'
  | 'listPublishedNotes'
  | 'publishNote'
  | 'updatePublishedNote'
  | 'unpublishNote'
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
  | 'backupDownloadPath'
>

export interface DesktopCloudSyncServiceDependencies {
  storageDirectory: string
  accountStatus(): Promise<CloudAccountStatus>
  getSecret(baseUrl: string): Promise<string | null>
  createClient(baseUrl: string, token: string): SyncClient
  fetchImplementation?: typeof fetch
  now?: () => Date
}

/** Main-process orchestration for linking one local vault to one cloud vault. */
export class DesktopCloudSyncService {
  private readonly runs = new Map<string, Promise<CloudSyncRunSummary>>()
  private readonly now: () => Date
  private readonly fetchImplementation: typeof fetch

  constructor(private readonly dependencies: DesktopCloudSyncServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch
  }

  async listVaults(): Promise<CloudSyncVault[]> {
    const { client } = await this.connection()
    return (await client.listVaults()).data
  }

  async serviceAccount(): Promise<CloudServiceAccount> {
    const { client } = await this.connection()
    return (await client.account()).data
  }

  async listPublishedNotes(): Promise<CloudPublishedNote[]> {
    const { client } = await this.connection()
    return (await client.listPublishedNotes()).data
  }

  async publishNote(input: CloudPublishNoteInput): Promise<CloudPublishedNoteResult> {
    const { client } = await this.connection()
    return await client.publishNote(input)
  }

  async updatePublishedNote(
    shareId: number,
    input: CloudPublishNoteInput
  ): Promise<CloudPublishedNoteResult> {
    const { client } = await this.connection()
    return await client.updatePublishedNote(shareId, input)
  }

  async unpublishNote(shareId: number): Promise<void> {
    const { client } = await this.connection()
    await client.unpublishNote(shareId)
  }

  async link(localRoot: string, vaultId: string): Promise<CloudVaultLink> {
    const { account, client } = await this.connection()
    const vault = (await client.listVaults()).data.find((candidate) => candidate.id === vaultId)
    if (!vault) throw new Error('That ZenNotes Cloud vault is not available to this account.')

    const link: CloudVaultLink = {
      base_url: account.base_url,
      vault_id: vault.id,
      vault_name: vault.name,
      linked_at: this.now().toISOString()
    }
    await this.writeLink(localRoot, link)
    return link
  }

  async createAndLink(localRoot: string, name: string): Promise<CloudVaultLink> {
    const normalizedName = name.trim()
    if (!normalizedName) throw new Error('Cloud vault name is required.')
    const { account, client } = await this.connection()
    const vault = (await client.createVault(normalizedName)).data
    const link: CloudVaultLink = {
      base_url: account.base_url,
      vault_id: vault.id,
      vault_name: vault.name,
      linked_at: this.now().toISOString()
    }
    await this.writeLink(localRoot, link)
    return link
  }

  async linkedVault(localRoot: string): Promise<CloudVaultLink | null> {
    return await this.readLink(localRoot)
  }

  async unlink(localRoot: string): Promise<void> {
    await fs.rm(this.linkPath(localRoot), { force: true })
  }

  async listBackups(localRoot: string): Promise<CloudBackupSnapshot[]> {
    const { client, link } = await this.linkedConnection(localRoot)
    return (await client.listBackups(link.vault_id)).data
  }

  async backupSchedule(localRoot: string): Promise<CloudBackupSchedule> {
    const { client, link } = await this.linkedConnection(localRoot)
    return (await client.backupSchedule(link.vault_id)).data
  }

  async updateBackupSchedule(
    localRoot: string,
    enabled: boolean
  ): Promise<CloudBackupSchedule> {
    const { client, link } = await this.linkedConnection(localRoot)
    return (await client.updateBackupSchedule(link.vault_id, enabled)).data
  }

  async listBackupItems(
    localRoot: string,
    backupId: string
  ): Promise<CloudBackupSnapshotItem[]> {
    const { client, link } = await this.linkedConnection(localRoot)
    return (await client.listBackupItems(link.vault_id, backupId)).data
  }

  async createBackup(localRoot: string, label?: string): Promise<CloudBackupSnapshot> {
    const summary = await this.sync(localRoot)
    assertBackupReady(summary)
    const { client, link } = await this.linkedConnection(localRoot)
    return (await client.createBackup(link.vault_id, label)).data
  }

  async deleteBackup(localRoot: string, backupId: string): Promise<void> {
    const { client, link } = await this.linkedConnection(localRoot)
    await client.deleteBackup(link.vault_id, backupId)
  }

  async downloadBackup(
    localRoot: string,
    backupId: string,
    destinationPath: string
  ): Promise<void> {
    const { account, client, link, token } = await this.linkedConnection(localRoot)
    const response = await this.fetchImplementation(
      `${account.base_url}${client.backupDownloadPath(link.vault_id, backupId)}`,
      {
        headers: {
          Accept: 'application/gzip',
          Authorization: `Bearer ${token}`
        },
        signal: AbortSignal.timeout(120_000)
      }
    )
    if (!response.ok) {
      throw new Error(await backupDownloadError(response))
    }
    if (!response.body) {
      throw new Error('ZenNotes Cloud returned an empty backup archive.')
    }

    const target = path.resolve(destinationPath)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })

    try {
      const file = await fs.open(temporary, 'wx', 0o600)
      try {
        const reader = response.body.getReader()
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          let offset = 0
          while (offset < chunk.value.byteLength) {
            const { bytesWritten } = await file.write(chunk.value, offset)
            if (bytesWritten === 0) {
              throw new Error('ZenNotes could not finish writing the backup archive.')
            }
            offset += bytesWritten
          }
        }
      } finally {
        await file.close()
      }
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  async restoreBackup(
    localRoot: string,
    backupId: string
  ): Promise<CloudBackupRestoreResult> {
    const { client, link } = await this.linkedConnection(localRoot)
    return await restoreCloudBackup({
      client,
      vaultId: link.vault_id,
      backupId,
      idempotencyKey: randomUUID,
      sync: () => this.sync(localRoot)
    })
  }

  async restoreBackupNote(
    localRoot: string,
    backupId: string,
    snapshotItemId: number
  ): Promise<CloudBackupNoteRestoreResult> {
    const beforeRestore = await this.sync(localRoot)
    assertBackupReady(beforeRestore)
    const { client, link } = await this.linkedConnection(localRoot)
    const restore = (
      await client.restoreBackupNote(link.vault_id, backupId, snapshotItemId, {
        idempotency_key: randomUUID(),
        expected_cursor: beforeRestore.cursor
      })
    ).data
    const sync = await this.sync(localRoot)

    return { restore, sync }
  }

  sync(localRoot: string): Promise<CloudSyncRunSummary> {
    const runKey = path.resolve(localRoot)
    const existing = this.runs.get(runKey)
    if (existing) return existing

    const running = this.run(localRoot).finally(() => {
      this.runs.delete(runKey)
    })
    this.runs.set(runKey, running)
    return running
  }

  private async run(localRoot: string): Promise<CloudSyncRunSummary> {
    const link = await this.readLink(localRoot)
    if (!link) throw new Error('Link this local vault to a ZenNotes Cloud vault before syncing.')
    const { account, client } = await this.connection()
    if (link.base_url !== account.base_url) {
      throw new Error('This vault is linked to a different ZenNotes Cloud account.')
    }

    const coordinator = createDesktopCloudSyncCoordinator({
      root: localRoot,
      stateDirectory: path.join(
        this.dependencies.storageDirectory,
        'states',
        rootFingerprint(localRoot),
        fingerprint(account.base_url)
      ),
      vaultId: link.vault_id,
      remote: client
    })
    const result = await coordinator.sync()
    return {
      cursor: result.state.cursor,
      pulled: result.pulled,
      pushed: result.pushed,
      conflicts: result.conflicts,
      bootstrap_conflicts: result.bootstrapConflicts,
      local_conflicts: result.localConflicts
    }
  }

  /** The pending settings question, if sync parked a cloud version. It lives
   *  in the vault rather than in memory, so closing the app does not answer
   *  it by accident. */
  async settingsConflict(localRoot: string): Promise<CloudSyncSettingsConflict | null> {
    const parked = path.join(localRoot, ...CLOUD_SYNC_SETTINGS_CONFLICT_PATH.split('/'))
    try {
      await fs.access(parked)
    } catch {
      return null
    }
    return {
      path: CLOUD_SYNC_VAULT_SETTINGS_PATH,
      cloud_path: CLOUD_SYNC_SETTINGS_CONFLICT_PATH
    }
  }

  /** Answer it. Keeping this device's settings just drops the parked copy;
   *  the next sync pushes the local ones up. Taking the cloud's writes them
   *  through the vault's own normalizer, so a hand-edited or older-format
   *  file cannot land as broken settings. */
  async resolveSettingsConflict(
    localRoot: string,
    choice: CloudSyncSettingsChoice
  ): Promise<void> {
    const parked = path.join(localRoot, ...CLOUD_SYNC_SETTINGS_CONFLICT_PATH.split('/'))
    if (choice === 'cloud') {
      const raw = await fs.readFile(parked, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('The settings from the cloud could not be read, so nothing was changed.')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('The settings from the cloud could not be read, so nothing was changed.')
      }
      await setVaultSettings(localRoot, parsed as Parameters<typeof setVaultSettings>[1])
    }
    await fs.rm(parked, { force: true })
  }

  private async connection(): Promise<{
    account: NonNullable<CloudAccountStatus['account']>
    client: SyncClient
    token: string
  }> {
    const status = await this.dependencies.accountStatus()
    if (status.state !== 'connected' || !status.account) {
      throw new Error('Connect ZenNotes Cloud before using sync.')
    }
    const token = await this.dependencies.getSecret(status.account.base_url)
    if (!token) throw new Error('The ZenNotes Cloud credential is unavailable. Sign in again.')
    return {
      account: status.account,
      client: this.dependencies.createClient(status.account.base_url, token),
      token
    }
  }

  private async linkedConnection(localRoot: string): Promise<{
    account: NonNullable<CloudAccountStatus['account']>
    client: SyncClient
    link: CloudVaultLink
    token: string
  }> {
    const link = await this.readLink(localRoot)
    if (!link) throw new Error('Link this local vault to a ZenNotes Cloud vault first.')
    const connection = await this.connection()
    if (link.base_url !== connection.account.base_url) {
      throw new Error('This vault is linked to a different ZenNotes Cloud account.')
    }
    return { ...connection, link }
  }

  private async readLink(localRoot: string): Promise<CloudVaultLink | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.linkPath(localRoot), 'utf8')) as unknown
      return isCloudVaultLink(value) ? value : null
    } catch {
      return null
    }
  }

  private async writeLink(localRoot: string, link: CloudVaultLink): Promise<void> {
    const target = this.linkPath(localRoot)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temporary, JSON.stringify(link, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, target)
  }

  private linkPath(localRoot: string): string {
    return path.join(
      this.dependencies.storageDirectory,
      'links',
      `${rootFingerprint(localRoot)}.json`
    )
  }
}

async function backupDownloadError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } }
    if (typeof payload.error?.message === 'string') return payload.error.message
  } catch {
    // The response was not JSON; use the stable fallback below.
  }
  return `ZenNotes Cloud could not download this backup (${response.status}).`
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function rootFingerprint(localRoot: string): string {
  return fingerprint(path.resolve(localRoot))
}

function isCloudVaultLink(value: unknown): value is CloudVaultLink {
  if (!value || typeof value !== 'object') return false
  const link = value as Partial<CloudVaultLink>
  return (
    typeof link.base_url === 'string' &&
    typeof link.vault_id === 'string' &&
    typeof link.vault_name === 'string' &&
    typeof link.linked_at === 'string'
  )
}

function assertBackupReady(summary: CloudSyncRunSummary): void {
  if (summary.conflicts.length > 0 || summary.bootstrap_conflicts.length > 0) {
    throw new Error('Resolve sync conflicts before creating a cloud backup.')
  }
}
