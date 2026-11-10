/**
 * End-to-end encryption for the signed-in Cloud account, as the shared
 * Settings panel (app-core's CloudEncryptionPanel) asks for it: set up,
 * unlock, change the passphrase, replace the recovery key, lock, and create
 * encrypted vaults. The key work is the core's (cloud-e2ee-account); this
 * module supplies the account's keyset API, this device's key store and its
 * keyring. The account key never leaves the host's secure store
 * (mobileCloudAccountKeyStore). Moving a readable vault into an encrypted one
 * stays a desktop action in v1, so encryptCloudVault is not offered here.
 *
 * The factory shape is Android's (it lets the tests drive it with real
 * shared-domain crypto); the secret check, the account-changed message and
 * answering "is it encrypted" from the session keyring are the iPhone's.
 */
import type {
  CloudEncryptionRecoveryPrompt,
  CloudEncryptionSecretInput,
  CloudEncryptionStatus,
  CloudSyncVault
} from '@zennotes/bridge-contract/cloud-sync'
import type { CloudSyncApiClient } from '@zennotes/shared-domain/cloud-sync-api'
import { fromBase64 } from '@zennotes/shared-domain/cloud-e2ee'
import {
  changeCloudEncryptionPassphrase,
  prepareCloudEncryptionSetup,
  prepareNewCloudRecoveryKey,
  unlockCloudEncryption,
  type CloudAccountKeyStore,
  type CloudE2eeKeyring,
  type CloudEncryptionSecret,
  type CloudPassphraseKeyDerivation,
  type PendingCloudEncryptionSetup
} from '@zennotes/shared-domain/cloud-e2ee-account'
import {
  MOBILE_END_TO_END_ENCRYPTION,
  authenticatedClient,
  authenticatedCredential,
  getMobileCloudAccountStatus,
  mobileCloudAccountKeyStore,
  mobileCloudCredentialScope,
  mobileCloudKeyring
} from './mobile-cloud-auth'
import { portableHost } from './host'
import { randomUUID } from './uuid'

export const ENCRYPTED_VAULT_BACKUP_DOWNLOAD_MESSAGE =
  'Download backups of encrypted vaults from the ZenNotes desktop app.'

export type MobileCloudEncryptionClient = Pick<
  CloudSyncApiClient,
  'account' | 'keysetApi' | 'createEncryptedVault' | 'listVaults'
>

/** This device's side of the signed-in account's encryption. */
export interface MobileCloudEncryptionKeys {
  store: CloudAccountKeyStore
  keyring: Pick<CloudE2eeKeyring, 'remember' | 'forVault' | 'forget'>
  /** Which signed-in credential this is; a pending setup finishes only under the one that began it. */
  scope: string
}

export interface MobileCloudEncryptionDependencies {
  /** The host opted in: every path an encrypted vault's bytes take is sealed and opened here. */
  enabled: boolean
  /** The signed-in account's client, or null while no account is signed in. */
  client(): Promise<MobileCloudEncryptionClient | null>
  keys(): Promise<MobileCloudEncryptionKeys>
  /** Where Argon2id runs, when the host keeps it off the page. */
  kdf?(): CloudPassphraseKeyDerivation | undefined
}

const NOT_AVAILABLE: CloudEncryptionStatus = { available: false, keyset: false, unlocked: false }

export function createMobileCloudEncryption(deps: MobileCloudEncryptionDependencies) {
  /** Setups and recovery-key changes waiting for the person to confirm their words. */
  const pending = new Map<string, { scope: string; setup: PendingCloudEncryptionSetup }>()

  async function connection(): Promise<{ client: MobileCloudEncryptionClient } & MobileCloudEncryptionKeys> {
    if (!deps.enabled) throw new Error('End-to-end encryption is not available in this version of ZenNotes.')
    const client = await deps.client()
    if (!client) throw new Error('Connect ZenNotes Cloud before setting up encryption.')
    return { client, ...(await deps.keys()) }
  }

  function remember(scope: string, setup: PendingCloudEncryptionSetup): CloudEncryptionRecoveryPrompt {
    const setupId = randomUUID()
    pending.set(setupId, { scope, setup })
    return { setupId, recoveryWords: setup.recoveryWords }
  }

  async function finish(setupId: string): Promise<void> {
    const id = String(setupId ?? '')
    const waiting = pending.get(id)
    if (!waiting) throw new Error('That recovery key is no longer waiting to be confirmed. Start again.')
    // A setup prepared under one sign-in never finishes under another: a
    // sign-out in between forgot every key it would have kept.
    const current = await connection()
    if (waiting.scope !== current.scope) {
      pending.delete(id)
      throw new Error('The ZenNotes Cloud account changed. Start again.')
    }
    await waiting.setup.finish()
    pending.delete(id)
  }

  async function listed(vaultId: string): Promise<CloudSyncVault | null> {
    const client = await deps.client()
    if (!client) return null
    return (await client.listVaults()).data.find((candidate) => candidate.id === vaultId) ?? null
  }

  return {
    async status(): Promise<CloudEncryptionStatus> {
      if (!deps.enabled) return NOT_AVAILABLE
      const client = await deps.client()
      if (!client) return NOT_AVAILABLE
      const account = (await client.account()).data
      const { store } = await deps.keys()
      return {
        available: account.capabilities?.end_to_end_encryption === true,
        keyset: account.encryption?.keyset === true,
        unlocked: (await store.load()) !== null
      }
    },

    /** Derives the keys and returns the recovery words; nothing reaches ZenNotes Cloud until finishSetup. */
    async prepareSetup(passphrase: string): Promise<CloudEncryptionRecoveryPrompt> {
      const { client, store, scope } = await connection()
      return remember(scope, await prepareCloudEncryptionSetup(client.keysetApi(), store, String(passphrase ?? ''), deps.kdf?.()))
    },

    finishSetup: finish,

    async unlock(secret: CloudEncryptionSecretInput): Promise<void> {
      const checked = encryptionSecret(secret)
      const { client, store, keyring } = await connection()
      await unlockCloudEncryption(client.keysetApi(), store, checked, deps.kdf?.())
      keyring.forget()
    },

    async changePassphrase(current: CloudEncryptionSecretInput, next: string): Promise<void> {
      const checked = encryptionSecret(current)
      const { client, store } = await connection()
      await changeCloudEncryptionPassphrase(client.keysetApi(), store, checked, String(next ?? ''), deps.kdf?.())
    },

    async prepareNewRecoveryKey(current: CloudEncryptionSecretInput): Promise<CloudEncryptionRecoveryPrompt> {
      const checked = encryptionSecret(current)
      const { client, store, scope } = await connection()
      return remember(scope, await prepareNewCloudRecoveryKey(client.keysetApi(), store, checked, deps.kdf?.()))
    },

    finishNewRecoveryKey: finish,

    /** Whether this device holds the account key now. No request: a host asks
     *  before it opens an encrypted vault, online or not. */
    async isUnlocked(): Promise<boolean> {
      if (!deps.enabled || !(await deps.client())) return false
      const { store } = await deps.keys()
      return (await store.load()) !== null
    },

    /** Forgets this device's account key; encrypted vaults stop syncing until it unlocks again. */
    async lock(): Promise<void> {
      if (!(await deps.client())) return
      const { store, keyring } = await deps.keys()
      await store.clear()
      keyring.forget()
    },

    /** Creates an encrypted vault and returns its id; its real name is sealed. */
    async createEncryptedVault(name: string): Promise<string> {
      const normalized = name.trim()
      if (!normalized) throw new Error('Cloud vault name is required.')
      const { client, store, keyring } = await connection()
      const stored = await store.load()
      if (!stored) throw new Error('Unlock end-to-end encryption on this device first.')
      const created = (await client.createEncryptedVault(normalized, fromBase64(stored.key), stored.version)).data
      keyring.remember(created)
      return created.id
    },

    /**
     * Linking an encrypted vault needs its key (its name and content), so a
     * device that cannot open it stops here instead of at the first sync.
     */
    async assertCanLink(vaultId: string): Promise<void> {
      // Signed out, the link itself says so.
      if (!(await deps.client())) return
      if (!deps.enabled) {
        if ((await listed(vaultId))?.encryption) {
          throw new Error('This vault is end-to-end encrypted, which this version of ZenNotes cannot open.')
        }
        return
      }
      const { keyring } = await deps.keys()
      await keyring.forVault(vaultId)
    },

    /** Whether a vault is end-to-end encrypted, from the session keyring (one
     *  vault listing per sign-in, not one per question). A locked device knows
     *  too: the keyring refuses it as E2EE_LOCKED. */
    async isEncrypted(vaultId: string): Promise<boolean> {
      // A build that cannot open encrypted vaults refuses to link one.
      if (!deps.enabled || !(await deps.client())) return false
      const { keyring } = await deps.keys()
      try {
        return (await keyring.forVault(vaultId)) !== null
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'E2EE_LOCKED') return true
        throw error
      }
    }
  }
}

/** Exactly one of the two secrets, as text; anything else is refused before
 *  key work runs. The core branches on `'passphrase' in secret`, so both at
 *  once would silently use the passphrase, and neither would fail far from
 *  the cause, after a keyset request. */
export function encryptionSecret(value: unknown): CloudEncryptionSecret {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (record && typeof record.passphrase === 'string' && !('recoveryWords' in record)) {
    return { passphrase: record.passphrase }
  }
  if (record && typeof record.recoveryWords === 'string' && !('passphrase' in record)) {
    return { recoveryWords: record.recoveryWords }
  }
  throw new Error('Enter your encryption passphrase or recovery key.')
}

const encryption = createMobileCloudEncryption({
  enabled: MOBILE_END_TO_END_ENCRYPTION,
  async client() {
    if ((await getMobileCloudAccountStatus()).state !== 'connected') return null
    return authenticatedClient()
  },
  async keys() {
    const credential = await authenticatedCredential()
    return {
      store: mobileCloudAccountKeyStore(credential),
      keyring: mobileCloudKeyring(credential),
      scope: mobileCloudCredentialScope(credential)
    }
  },
  kdf: () => portableHost().passphraseKdf
})

export const getMobileCloudEncryptionStatus = (): Promise<CloudEncryptionStatus> => encryption.status()
export const isMobileCloudEncryptionUnlocked = (): Promise<boolean> => encryption.isUnlocked()
export const prepareMobileCloudEncryptionSetup = (passphrase: string): Promise<CloudEncryptionRecoveryPrompt> =>
  encryption.prepareSetup(passphrase)
export const finishMobileCloudEncryptionSetup = (setupId: string): Promise<void> => encryption.finishSetup(setupId)
export const unlockMobileCloudEncryption = (secret: CloudEncryptionSecretInput): Promise<void> => encryption.unlock(secret)
export const changeMobileCloudEncryptionPassphrase = (current: CloudEncryptionSecretInput, next: string): Promise<void> =>
  encryption.changePassphrase(current, next)
export const prepareNewMobileCloudRecoveryKey = (current: CloudEncryptionSecretInput): Promise<CloudEncryptionRecoveryPrompt> =>
  encryption.prepareNewRecoveryKey(current)
export const finishNewMobileCloudRecoveryKey = (setupId: string): Promise<void> => encryption.finishNewRecoveryKey(setupId)
export const lockMobileCloudEncryption = (): Promise<void> => encryption.lock()
export const createMobileEncryptedCloudVault = (name: string): Promise<string> => encryption.createEncryptedVault(name)
export const assertMobileCloudVaultCanLink = (vaultId: string): Promise<void> => encryption.assertCanLink(vaultId)
export const isMobileCloudVaultEncrypted = (vaultId: string): Promise<boolean> => encryption.isEncrypted(vaultId)
