import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  CloudAccountStatus,
  CloudBackupItemsPage,
  CloudBackupItemsQuery,
  CloudBackupNoteRestoreResult,
  CloudBackupRestoreResult,
  CloudBackupSchedule,
  CloudBackupSnapshot,
  CloudBackupSnapshotItem,
  CloudPublishedNote,
  CloudPublishedNoteResult,
  CloudPublishNoteInput,
  CloudServiceAccount,
  CloudSyncBootstrapConflict,
  CloudSyncBootstrapConflictDetails,
  CloudSyncBootstrapConflictResolution,
  CloudSyncPendingConflictDetails,
  CloudSyncPendingConflictResolution,
  CloudSyncRunSummary,
  CloudSyncSettingsChoice,
  CloudSyncSettingsConflict,
  CloudSyncVault,
  CloudVaultLink
} from '@zennotes/bridge-contract/cloud-sync'
import {
  cloudBackupCreateError,
  cloudBackupItemsPage,
  restoreCloudBackup
} from '@zennotes/shared-domain/cloud-backup'
import {
  CLOUD_NOT_LINKED_MESSAGE,
  CLOUD_NOT_SIGNED_IN_MESSAGE,
  CLOUD_OTHER_ACCOUNT_MESSAGE,
  CLOUD_VAULT_NAME_REQUIRED_MESSAGE
} from '@zennotes/shared-domain/cloud-error-copy'
import {
  CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
  CLOUD_SYNC_VAULT_SETTINGS_PATH
} from '@zennotes/shared-domain/cloud-sync'
import { setVaultSettings } from './vault'
import type { CloudSyncApiClient } from '@zennotes/shared-domain/cloud-sync-api'
import { CloudServiceRequestError, type DesktopCloudSyncClientOptions } from './cloud-sync-client'
import { publishWithStagedUploads } from '@zennotes/shared-domain/cloud-publish-uploads'
import {
  desktopPublishAssetPlatform,
  type DesktopPublishAssetFiles,
  type PublishAssetUploader
} from './cloud-publish-assets'
import {
  CLOUD_VAULT_REMOVED_MESSAGE,
  CLOUD_VAULT_SUPERSEDED_MESSAGE,
  confirmCloudVaultMissing,
  isCloudResourceMissing,
  isCloudVaultSuperseded,
  sameCloudVaultLink
} from '@zennotes/shared-domain/cloud-vault-availability'
import { createDesktopCloudSyncCoordinator, DesktopCloudSyncStateStore } from './cloud-sync-filesystem'
import { rewriteBackupArchive } from './cloud-backup-archive'
import {
  CloudE2eeKeyring,
  changeCloudEncryptionPassphrase,
  prepareCloudEncryptionSetup,
  prepareNewCloudRecoveryKey,
  unlockCloudEncryption,
  type CloudAccountKeyStore,
  type CloudEncryptionSecret,
  type PendingCloudEncryptionSetup
} from '@zennotes/shared-domain/cloud-e2ee-account'
import { fromBase64 } from '@zennotes/shared-domain/cloud-e2ee'
import {
  CLOUD_E2EE_HEADER,
  CLOUD_E2EE_HEADER_VALUE,
  ENCRYPTED_VAULT_PLACEHOLDER_NAME
} from '@zennotes/shared-domain/cloud-e2ee-vault'

type SyncClient = Pick<
  CloudSyncApiClient,
  | 'account'
  | 'listPublishedNotes'
  | 'publishNote'
  | 'updatePublishedNote'
  | 'createPublishUpload'
  | 'abortPublishUpload'
  | 'unpublishNote'
  | 'listVaults'
  | 'createVault'
  | 'createEncryptedVault'
  | 'supersedeVault'
  | 'keysetApi'
  | 'deleteVault'
  | 'manifest'
  | 'changes'
  | 'revision'
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
> & PublishAssetUploader

export interface DesktopCloudSyncServiceDependencies {
  storageDirectory: string
  accountStatus(): Promise<CloudAccountStatus>
  getSecret(baseUrl: string): Promise<string | null>
  createClient(baseUrl: string, token: string, options?: DesktopCloudSyncClientOptions): SyncClient
  fetchImplementation?: typeof fetch
  now?: () => Date
  withWindowSync?(root: string, run: () => Promise<CloudSyncRunSummary>): Promise<CloudSyncRunSummary>
  /**
   * Where this device keeps an account's unlocked encryption key. Without it
   * the service never offers end-to-end encryption and the service refuses
   * encrypted vaults to this app.
   */
  accountKeyStore?(account: NonNullable<CloudAccountStatus['account']>): CloudAccountKeyStore
}

/** What the Settings page shows about end-to-end encryption for the signed-in account. */
export interface DesktopCloudEncryptionStatus {
  /** The service accepts encrypted vaults for this account. */
  available: boolean
  /** The account has set up encryption. */
  keyset: boolean
  /** This device holds the account key. */
  unlocked: boolean
}

/** Main-process orchestration for linking one local vault to one cloud vault. */
export class DesktopCloudSyncService {
  private readonly runs = new Map<string, Promise<CloudSyncRunSummary>>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly linkUpdates = new Map<string, Promise<unknown>>()
  private readonly keyrings = new Map<string, CloudE2eeKeyring>()
  /** Setups and recovery-key changes waiting for the person to confirm their words. */
  private readonly pendingRecovery = new Map<string, PendingCloudEncryptionSetup>()
  private readonly now: () => Date
  private readonly fetchImplementation: typeof fetch
  private requestController = new AbortController()

  constructor(private readonly dependencies: DesktopCloudSyncServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch
  }

  /** Logout and shutdown cancel waits before credentials or windows disappear. */
  stop(): void {
    this.requestController.abort()
  }

  resume(): void {
    if (this.requestController.signal.aborted) this.requestController = new AbortController()
  }

  async listVaults(): Promise<CloudSyncVault[]> {
    const { client, keyring } = await this.connection()
    const vaults = (await client.listVaults()).data
    // An encrypted vault's real name is sealed; show it when this device is
    // unlocked, and the placeholder otherwise.
    return Promise.all(
      vaults.map(async (vault) => {
        if (!vault.encryption || !keyring) return vault
        try {
          return { ...vault, name: await keyring.vaultName(vault) }
        } catch {
          return { ...vault, name: ENCRYPTED_VAULT_PLACEHOLDER_NAME }
        }
      })
    )
  }

  async encryptionStatus(): Promise<DesktopCloudEncryptionStatus> {
    const connection = await this.optionalConnection()
    if (!connection?.keyStore) return { available: false, keyset: false, unlocked: false }
    const account = (await connection.client.account()).data
    return {
      available: account.capabilities?.end_to_end_encryption === true,
      keyset: account.encryption?.keyset === true,
      unlocked: (await connection.keyStore.load()) !== null
    }
  }

  /**
   * Derives the keys and returns the recovery words to show. Nothing reaches
   * ZenNotes Cloud until finishEncryptionSetup runs with the returned id.
   */
  async prepareEncryptionSetup(passphrase: string): Promise<{ setupId: string; recoveryWords: string[] }> {
    const { client, keyStore } = await this.encryptionConnection()
    const pending = await prepareCloudEncryptionSetup(client.keysetApi(), keyStore, passphrase)
    const setupId = randomUUID()
    this.pendingRecovery.set(setupId, pending)
    return { setupId, recoveryWords: pending.recoveryWords }
  }

  async finishEncryptionSetup(setupId: string): Promise<void> {
    await this.finishPending(setupId)
  }

  async unlockEncryption(secret: CloudEncryptionSecret): Promise<void> {
    const { client, keyStore, keyring } = await this.encryptionConnection()
    await unlockCloudEncryption(client.keysetApi(), keyStore, secret)
    keyring?.forget()
  }

  async changeEncryptionPassphrase(current: CloudEncryptionSecret, next: string): Promise<void> {
    const { client, keyStore } = await this.encryptionConnection()
    await changeCloudEncryptionPassphrase(client.keysetApi(), keyStore, current, next)
  }

  async prepareNewRecoveryKey(current: CloudEncryptionSecret): Promise<{ setupId: string; recoveryWords: string[] }> {
    const { client, keyStore } = await this.encryptionConnection()
    const pending = await prepareNewCloudRecoveryKey(client.keysetApi(), keyStore, current)
    const setupId = randomUUID()
    this.pendingRecovery.set(setupId, pending)
    return { setupId, recoveryWords: pending.recoveryWords }
  }

  async finishNewRecoveryKey(setupId: string): Promise<void> {
    await this.finishPending(setupId)
  }

  /** Forgets this device's account key; encrypted vaults stop syncing until it unlocks again. */
  async lockEncryption(): Promise<void> {
    const connection = await this.optionalConnection()
    if (!connection?.keyStore) return
    await connection.keyStore.clear()
    connection.keyring?.forget()
  }

  private async finishPending(setupId: string): Promise<void> {
    const pending = this.pendingRecovery.get(setupId)
    if (!pending) throw new Error('That recovery key is no longer waiting to be confirmed. Start again.')
    await pending.finish()
    this.pendingRecovery.delete(setupId)
  }

  private async encryptionConnection() {
    const connection = await this.connection()
    if (!connection.keyStore) throw new Error("This version of ZenNotes can't use end-to-end encryption. Update ZenNotes to the latest version.")
    return { ...connection, keyStore: connection.keyStore }
  }

  async serviceAccount(): Promise<CloudServiceAccount> {
    const { client } = await this.connection()
    return (await client.account()).data
  }

  async listPublishedNotes(): Promise<CloudPublishedNote[]> {
    const connection = await this.optionalConnection()
    if (!connection) return []

    try {
      return (await connection.client.listPublishedNotes()).data
    } catch (error) {
      if (error instanceof CloudServiceRequestError && error.code === 'FEATURE_NOT_ENTITLED') {
        return []
      }
      throw error
    }
  }

  async publishNote(
    input: CloudPublishNoteInput,
    files: DesktopPublishAssetFiles
  ): Promise<CloudPublishedNoteResult> {
    const { client } = await this.connection()
    return await publishWithStagedUploads(client, input, desktopPublishAssetPlatform(client, files))
  }

  async updatePublishedNote(
    shareId: number,
    input: CloudPublishNoteInput,
    files: DesktopPublishAssetFiles
  ): Promise<CloudPublishedNoteResult> {
    const { client } = await this.connection()
    return await publishWithStagedUploads(client, input, desktopPublishAssetPlatform(client, files), {
      shareId
    })
  }

  async unpublishNote(shareId: number): Promise<void> {
    const { client } = await this.connection()
    await client.unpublishNote(shareId)
  }

  async link(localRoot: string, vaultId: string): Promise<CloudVaultLink> {
    const { account, client, keyring } = await this.connection()
    const vault = (await client.listVaults()).data.find((candidate) => candidate.id === vaultId)
    if (!vault) throw new Error('That ZenNotes Cloud vault is not available to this account.')
    if (vault.encryption && !keyring) {
      throw new Error('This vault is end-to-end encrypted, which this version of ZenNotes cannot open. Update ZenNotes to the latest version.')
    }
    // Opening an encrypted vault's name needs the account key, so linking a
    // locked device stops here instead of at the first sync.
    const vaultName = vault.encryption && keyring ? await keyring.vaultName(vault) : vault.name

    const link: CloudVaultLink = {
      base_url: account.base_url,
      vault_id: vault.id,
      vault_name: vaultName,
      linked_at: this.now().toISOString()
    }
    await this.writeLink(localRoot, link)
    return link
  }

  async createAndLink(
    localRoot: string,
    name: string,
    options: { encrypted?: boolean } = {}
  ): Promise<CloudVaultLink> {
    const normalizedName = name.trim()
    if (!normalizedName) throw new Error(CLOUD_VAULT_NAME_REQUIRED_MESSAGE)
    const { account, client, keyStore, keyring } = await this.connection()
    let vault: CloudSyncVault
    if (options.encrypted) {
      const stored = await keyStore?.load()
      if (!stored) throw new Error('Unlock end-to-end encryption on this device first.')
      vault = (await client.createEncryptedVault(normalizedName, fromBase64(stored.key), stored.version)).data
      keyring?.remember(vault)
    } else {
      vault = (await client.createVault(normalizedName)).data
    }
    const link: CloudVaultLink = {
      base_url: account.base_url,
      vault_id: vault.id,
      // An encrypted vault's stored name is a placeholder; the link is local,
      // so it keeps the real one.
      vault_name: options.encrypted ? normalizedName : vault.name,
      linked_at: this.now().toISOString()
    }
    await this.writeLink(localRoot, link)
    return link
  }

  async linkedVault(localRoot: string): Promise<CloudVaultLink | null> {
    return await this.readLink(localRoot)
  }

  async unlink(localRoot: string): Promise<void> {
    await this.exclusive(path.resolve(localRoot), () => fs.rm(this.linkPath(localRoot), { force: true }), this.linkUpdates)
  }

  async deleteLinkedVault(localRoot: string): Promise<void> {
    const { client, link } = await this.linkedConnection(localRoot)
    await client.deleteVault(link.vault_id)
    await this.unlink(localRoot)
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

  async listBackupItemsPage(
    localRoot: string,
    backupId: string,
    query: CloudBackupItemsQuery
  ): Promise<CloudBackupItemsPage> {
    const { client, link } = await this.linkedConnection(localRoot)
    return cloudBackupItemsPage(await client.listBackupItems(link.vault_id, backupId, query), query)
  }

  async createBackup(localRoot: string, label?: string): Promise<CloudBackupSnapshot> {
    const summary = await this.sync(localRoot)
    assertBackupReady(summary)
    const { client, link, keyring } = await this.linkedConnection(localRoot)
    // A typed label would reach ZenNotes Cloud readable, so encrypted vaults
    // keep their backups unlabeled.
    const encrypted = keyring ? (await keyring.forVault(link.vault_id)) !== null : false
    try {
      return (await client.createBackup(link.vault_id, encrypted ? undefined : label)).data
    } catch (error) {
      throw cloudBackupCreateError(error)
    }
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
    const { account, client, link, token, keyring } = await this.linkedConnection(localRoot)
    // An encrypted vault's archive holds ciphertext under path ids; it is
    // saved readable, decrypted item by item on this device.
    const cipher = keyring ? await keyring.forVault(link.vault_id) : null
    const response = await this.fetchImplementation(
      `${account.base_url}${client.backupDownloadPath(link.vault_id, backupId)}`,
      {
        headers: {
          Accept: 'application/gzip',
          Authorization: `Bearer ${token}`,
          ...(keyring ? { [CLOUD_E2EE_HEADER]: CLOUD_E2EE_HEADER_VALUE } : {})
        },
        signal: AbortSignal.timeout(120_000)
      }
    )
    if (!response.ok) {
      throw await backupDownloadError(response)
    }
    if (!response.body) {
      throw new CloudServiceRequestError('ZenNotes Cloud returned an empty backup archive.', response.status, 'BACKUP_NOT_AVAILABLE')
    }

    const target = path.resolve(destinationPath)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    const sealed = cipher ? `${temporary}.sealed` : temporary
    await fs.mkdir(path.dirname(target), { recursive: true })

    try {
      const file = await fs.open(sealed, 'wx', 0o600)
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
      if (cipher) {
        await rewriteBackupArchive(sealed, temporary, (item) =>
          cipher.openArchiveItem(item as Parameters<typeof cipher.openArchiveItem>[0])
        )
        await fs.rm(sealed, { force: true })
      }
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      if (sealed !== temporary) await fs.rm(sealed, { force: true }).catch(() => {})
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

  async hasRemoteChanges(localRoot: string): Promise<boolean> {
    const key = path.resolve(localRoot)
    if (this.runs.has(key)) return false
    return this.exclusive(key, async () => {
      const link = await this.readLink(localRoot)
      if (!link) return false
      const connection = await this.optionalConnection()
      if (!connection || link.base_url !== connection.account.base_url) return false
      const states = this.stateStore(localRoot, link)
      const state = await states.load(link.vault_id)
      if (!state) return true
      try {
        const manifest = await connection.client.manifest(link.vault_id, {
          includeContent: false,
          perPage: 1
        })
        return manifest.cursor !== state.cursor
      } catch (error) {
        if (isCloudVaultSuperseded(error) && await this.retireMissingLink(localRoot, link)) {
          throw new Error(CLOUD_VAULT_SUPERSEDED_MESSAGE)
        }
        if (isCloudResourceMissing(error) && await this.retireMissingLink(localRoot, link)) {
          throw new Error(CLOUD_VAULT_REMOVED_MESSAGE)
        }
        throw error
      }
    })
  }

  private stateStore(localRoot: string, link: CloudVaultLink): DesktopCloudSyncStateStore {
    return new DesktopCloudSyncStateStore(path.join(
      this.dependencies.storageDirectory, 'states', rootFingerprint(localRoot), fingerprint(link.base_url)
    ))
  }

  private retireMissingLink(localRoot: string, link: CloudVaultLink): Promise<boolean> {
    return this.exclusive(path.resolve(localRoot), async () => {
      if (!sameCloudVaultLink(await this.readLink(localRoot), link)) return false
      await this.stateStore(localRoot, link).retire(link.vault_id, path.join(
        this.dependencies.storageDirectory, 'retired-states', rootFingerprint(localRoot), fingerprint(link.base_url)
      ))
      await fs.rm(this.linkPath(localRoot), { force: true })
      return true
    }, this.linkUpdates)
  }

  /**
   * Moves the linked readable Cloud vault into a new end-to-end encrypted one
   * with the same name: this device's copy, fully synced first, uploads into
   * the new vault, and only then is the readable vault retired. Until that
   * last step the readable vault is untouched, and an interrupted move
   * finishes on the next clean sync.
   */
  async encryptLinkedVault(localRoot: string): Promise<CloudVaultLink> {
    const before = await this.sync(localRoot)
    if (hasOpenConflicts(before)) {
      throw new Error('Some files are waiting for review. Choose Review, settle them, then encrypt this vault.')
    }
    const { client, link, keyStore, keyring } = await this.linkedConnection(localRoot)
    if (!keyStore || !keyring) throw new Error("This version of ZenNotes can't use end-to-end encryption. Update ZenNotes to the latest version.")
    if (link.replaces_vault_id) return this.syncAndRetireReplacedVault(localRoot)
    if (await keyring.forVault(link.vault_id)) throw new Error('This vault is already end-to-end encrypted.')
    const stored = await keyStore.load()
    if (!stored) throw new Error('Unlock end-to-end encryption on this device first.')
    const vault = (await client.createEncryptedVault(link.vault_name, fromBase64(stored.key), stored.version)).data
    keyring.remember(vault)
    await this.writeLink(localRoot, {
      ...link,
      vault_id: vault.id,
      linked_at: this.now().toISOString(),
      replaces_vault_id: link.vault_id
    })
    return this.syncAndRetireReplacedVault(localRoot)
  }

  private async syncAndRetireReplacedVault(localRoot: string): Promise<CloudVaultLink> {
    const summary = await this.sync(localRoot)
    if (hasOpenConflicts(summary)) {
      throw new Error('Some files are waiting for review. Choose Review, settle them, then choose Sync now to finish encrypting this vault.')
    }
    const link = await this.readLink(localRoot)
    if (!link) throw new Error(CLOUD_NOT_LINKED_MESSAGE)
    return (await this.retireReplacedVault(localRoot, link, summary)) ?? link
  }

  /**
   * After a clean sync into a replacement vault, retires the readable vault it
   * replaces. Returns the updated link, or null when there is nothing to do.
   */
  private async retireReplacedVault(
    localRoot: string,
    link: CloudVaultLink,
    summary: CloudSyncRunSummary
  ): Promise<CloudVaultLink | null> {
    if (!link.replaces_vault_id || hasOpenConflicts(summary)) return null
    const { client } = await this.connection()
    try {
      await client.supersedeVault(link.replaces_vault_id, link.vault_id)
    } catch (error) {
      // A retry after a lost answer finds the old vault already replaced by
      // this one; that is the outcome this step was after.
      const successor = (error as { details?: { successor_vault_id?: unknown } | null }).details?.successor_vault_id
      if (cloudErrorCode(error) !== 'VAULT_SUPERSEDED' || successor !== link.vault_id) throw error
    }
    const { replaces_vault_id: _replaced, ...current } = link
    await this.writeLink(localRoot, current)
    return current
  }

  sync(localRoot: string): Promise<CloudSyncRunSummary> {
    const runKey = path.resolve(localRoot)
    const existing = this.runs.get(runKey)
    if (existing) return existing

    const run = () => this.exclusive(runKey, async () => {
      const summary = await this.run(localRoot)
      const link = await this.readLink(localRoot)
      if (link?.replaces_vault_id) await this.retireReplacedVault(localRoot, link, summary)
      return summary
    })
    const running = (this.dependencies.withWindowSync?.(runKey, run) ?? run()).finally(() => {
      this.runs.delete(runKey)
    })
    this.runs.set(runKey, running)
    return running
  }

  private async run(localRoot: string): Promise<CloudSyncRunSummary> {
    const link = await this.readLink(localRoot)
    if (!link) throw new Error(CLOUD_NOT_LINKED_MESSAGE)
    const { account, client } = await this.connection()
    if (link.base_url !== account.base_url) {
      throw new Error(CLOUD_OTHER_ACCOUNT_MESSAGE)
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
    try {
      const result = await coordinator.sync()
      return {
        cursor: result.state.cursor,
        pulled: result.pulled,
        pushed: result.pushed,
        conflicts: result.conflicts,
        bootstrap_conflicts: result.bootstrapConflicts,
        local_conflicts: result.localConflicts,
        pending_conflicts: result.pendingConflicts,
        legacy_conflict_copies: result.legacyConflictCopies,
        refused_paths: result.refusedPaths
      }
    } catch (error) {
      if (isCloudVaultSuperseded(error) && await this.retireMissingLink(localRoot, link)) {
        throw new Error(CLOUD_VAULT_SUPERSEDED_MESSAGE)
      }
      if (await confirmCloudVaultMissing(client, link.vault_id, error) &&
          await this.retireMissingLink(localRoot, link)) {
        throw new Error(CLOUD_VAULT_REMOVED_MESSAGE)
      }
      throw error
    }
  }

  async getBootstrapConflict(
    localRoot: string,
    conflict: CloudSyncBootstrapConflict
  ): Promise<CloudSyncBootstrapConflictDetails> {
    return await this.exclusive(path.resolve(localRoot), async () => {
      const { account, client, link } = await this.linkedConnection(localRoot)
      return await createDesktopCloudSyncCoordinator({
        root: localRoot,
        stateDirectory: path.join(
          this.dependencies.storageDirectory,
          'states',
          rootFingerprint(localRoot),
          fingerprint(account.base_url)
        ),
        vaultId: link.vault_id,
        remote: client
      }).getBootstrapConflict(conflict)
    })
  }

  async resolveBootstrapConflict(
    localRoot: string,
    resolution: CloudSyncBootstrapConflictResolution
  ): Promise<void> {
    await this.exclusive(path.resolve(localRoot), async () => {
      const { account, client, link } = await this.linkedConnection(localRoot)
      await createDesktopCloudSyncCoordinator({
        root: localRoot,
        stateDirectory: path.join(
          this.dependencies.storageDirectory,
          'states',
          rootFingerprint(localRoot),
          fingerprint(account.base_url)
        ),
        vaultId: link.vault_id,
        remote: client
      }).resolveBootstrapConflict(resolution)
    })
  }

  async getConflict(
    localRoot: string,
    conflictId: string
  ): Promise<CloudSyncPendingConflictDetails> {
    return await this.exclusive(path.resolve(localRoot), async () => {
      const { account, client, link } = await this.linkedConnection(localRoot)
      return await createDesktopCloudSyncCoordinator({
        root: localRoot,
        stateDirectory: path.join(
          this.dependencies.storageDirectory,
          'states',
          rootFingerprint(localRoot),
          fingerprint(account.base_url)
        ),
        vaultId: link.vault_id,
        remote: client
      }).getConflict(conflictId)
    })
  }

  async saveConflictDraft(
    localRoot: string,
    conflictId: string,
    draftText: string | null
  ): Promise<void> {
    await this.exclusive(path.resolve(localRoot), async () => {
      const { account, client, link } = await this.linkedConnection(localRoot)
      await createDesktopCloudSyncCoordinator({
        root: localRoot,
        stateDirectory: path.join(
          this.dependencies.storageDirectory,
          'states',
          rootFingerprint(localRoot),
          fingerprint(account.base_url)
        ),
        vaultId: link.vault_id,
        remote: client
      }).saveConflictDraft(conflictId, draftText)
    })
  }

  async resolveConflict(
    localRoot: string,
    resolution: CloudSyncPendingConflictResolution
  ): Promise<void> {
    await this.exclusive(path.resolve(localRoot), async () => {
      const { account, client, link } = await this.linkedConnection(localRoot)
      await createDesktopCloudSyncCoordinator({
        root: localRoot,
        stateDirectory: path.join(
          this.dependencies.storageDirectory,
          'states',
          rootFingerprint(localRoot),
          fingerprint(account.base_url)
        ),
        vaultId: link.vault_id,
        remote: client
      }).resolveConflict(resolution)
    })
  }

  private exclusive<T>(key: string, operation: () => Promise<T>, operations = this.operations): Promise<T> {
    const previous = operations.get(key)
    let current!: Promise<T>
    current = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(operation)
      .finally(() => {
        if (operations.get(key) === current) operations.delete(key)
      })
    operations.set(key, current)
    return current
  }

  /** The pending settings question, if sync parked a cloud version. It lives
   *  in the vault rather than in memory, so closing the app does not answer
   *  it by accident. */
  async settingsConflict(localRoot: string): Promise<CloudSyncSettingsConflict | null> {
    const parked = path.join(localRoot, ...CLOUD_SYNC_SETTINGS_CONFLICT_PATH.split('/'))
    let raw: string
    try {
      raw = await fs.readFile(parked, 'utf8')
    } catch {
      return null
    }
    // The parsed copy lets the app show what differs and offer a per-section
    // answer. A copy that does not parse is still a pending question (the
    // file is there, and sync will not touch vault.json until it is gone), so
    // it is reported without the contents and the app asks whole-file.
    const cloudSettings = parseParkedSettings(raw)
    return {
      path: CLOUD_SYNC_VAULT_SETTINGS_PATH,
      cloud_path: CLOUD_SYNC_SETTINGS_CONFLICT_PATH,
      ...(cloudSettings ? { cloud_settings: cloudSettings } : {})
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
      const parsed = parseParkedSettings(await fs.readFile(parked, 'utf8'))
      if (!parsed) {
        throw new Error('The settings from the cloud could not be read, so nothing was changed.')
      }
      await setVaultSettings(
        localRoot,
        parsed as unknown as Parameters<typeof setVaultSettings>[1]
      )
    }
    await fs.rm(parked, { force: true })
  }

  private async connection(): Promise<{
    account: NonNullable<CloudAccountStatus['account']>
    client: SyncClient
    token: string
    keyStore?: CloudAccountKeyStore
    keyring?: CloudE2eeKeyring
  }> {
    const connection = await this.optionalConnection()
    if (!connection) throw new Error(CLOUD_NOT_SIGNED_IN_MESSAGE)
    return connection
  }

  private async optionalConnection(): Promise<{
    account: NonNullable<CloudAccountStatus['account']>
    client: SyncClient
    token: string
    keyStore?: CloudAccountKeyStore
    keyring?: CloudE2eeKeyring
  } | null> {
    const signal = this.requestController.signal
    signal.throwIfAborted()
    const status = await this.dependencies.accountStatus()
    if (status.state !== 'connected' || !status.account) return null
    const account = status.account
    const token = await this.dependencies.getSecret(account.base_url)
    signal.throwIfAborted()
    if (!token) throw new Error("ZenNotes can't find your saved Cloud sign-in on this device. Choose Disconnect, then Connect ZenNotes Cloud to sign in again.")
    const keyStore = this.dependencies.accountKeyStore?.(account)
    const keyring = keyStore ? this.keyringFor(account, token, keyStore) : undefined
    return {
      account,
      client: this.dependencies.createClient(account.base_url, token, {
        accountId: account.user.email,
        signal,
        contentReferences: true,
        ...(keyring ? { endToEndEncryption: true, vaultCiphers: keyring } : {})
      }),
      token,
      ...(keyStore && keyring ? { keyStore, keyring } : {})
    }
  }

  /**
   * One keyring per signed-in credential, so the "is this vault encrypted"
   * answers and opened ciphers last across calls but never across accounts.
   */
  private keyringFor(
    account: NonNullable<CloudAccountStatus['account']>,
    token: string,
    store: CloudAccountKeyStore
  ): CloudE2eeKeyring {
    const scope = fingerprint(JSON.stringify([account.base_url, account.user.email, token]))
    let keyring = this.keyrings.get(scope)
    if (!keyring) {
      for (const [key, stale] of this.keyrings) {
        stale.forget()
        this.keyrings.delete(key)
      }
      keyring = new CloudE2eeKeyring({
        listVaults: async () =>
          (await this.dependencies.createClient(account.base_url, token, {
            accountId: account.user.email,
            signal: this.requestController.signal
          }).listVaults()).data,
        store
      })
      this.keyrings.set(scope, keyring)
    }
    return keyring
  }

  private async linkedConnection(localRoot: string): Promise<{
    account: NonNullable<CloudAccountStatus['account']>
    client: SyncClient
    link: CloudVaultLink
    token: string
    keyStore?: CloudAccountKeyStore
    keyring?: CloudE2eeKeyring
  }> {
    const link = await this.readLink(localRoot)
    if (!link) throw new Error(CLOUD_NOT_LINKED_MESSAGE)
    const connection = await this.connection()
    if (link.base_url !== connection.account.base_url) {
      throw new Error(CLOUD_OTHER_ACCOUNT_MESSAGE)
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
    await this.exclusive(path.resolve(localRoot), async () => {
      const target = this.linkPath(localRoot)
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(temporary, JSON.stringify(link, null, 2), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, target)
    }, this.linkUpdates)
  }

  private linkPath(localRoot: string): string {
    return path.join(
      this.dependencies.storageDirectory,
      'links',
      `${rootFingerprint(localRoot)}.json`
    )
  }
}

/** The refusal as the API client would throw it, so it is worded by its
 *  status and code like every other Cloud answer. A refusal without a code
 *  reads as an archive that cannot be downloaded right now. */
async function backupDownloadError(response: Response): Promise<CloudServiceRequestError> {
  let message: string | null = null
  let code: string | null = null
  try {
    const payload = (await response.json()) as { error?: { message?: unknown; code?: unknown } }
    if (typeof payload.error?.message === 'string') message = payload.error.message
    if (typeof payload.error?.code === 'string') code = payload.error.code
  } catch {
    // The response was not JSON; the status says enough.
  }
  return new CloudServiceRequestError(
    message ?? `ZenNotes Cloud could not download this backup (${response.status}).`,
    response.status,
    code ?? (response.status === 401 ? null : 'BACKUP_NOT_AVAILABLE')
  )
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function rootFingerprint(localRoot: string): string {
  return fingerprint(path.resolve(localRoot))
}

/** The parked cloud vault.json as an object, or null when the bytes are not
 *  one (invalid JSON, a bare list, a hand-edited scalar). */
function parseParkedSettings(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
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

function hasOpenConflicts(summary: CloudSyncRunSummary): boolean {
  return (
    summary.conflicts.length > 0 ||
    summary.bootstrap_conflicts.length > 0 ||
    (summary.pending_conflicts?.length ?? 0) > 0
  )
}

function cloudErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

function assertBackupReady(summary: CloudSyncRunSummary): void {
  if (
    summary.conflicts.length > 0 ||
    summary.bootstrap_conflicts.length > 0 ||
    (summary.pending_conflicts?.length ?? 0) > 0
  ) {
    throw new Error('Some files are waiting for review. Settle them first (Review), then create the backup.')
  }
}
