/**
 * The account side of end-to-end encryption: setting it up, unlocking a
 * device with the passphrase or the recovery key, changing the passphrase,
 * replacing the recovery key, and finding each vault's cipher
 * (docs/specs/cloud-e2ee.md). Hosts supply the keychain the unlocked account
 * key lives in and the HTTP calls; nothing here touches a disk or a network.
 */
import type {
  CloudEncryptionKeyset,
  CloudEncryptionKeysetCreate,
  CloudEncryptionKeysetUpdate,
  CloudSyncVault
} from '@zennotes/bridge-contract/cloud-sync'
import {
  type Bytes,
  CloudE2eeError,
  type CloudE2eeKdfParams,
  constantTimeEqual,
  derivePassphraseKey,
  fromBase64,
  generateCloudE2eeKey,
  newCloudE2eeKdfParams,
  recoveryKeyFromWords,
  recoveryKeyToWords,
  toBase64,
  unwrapAccountKey,
  wrapAccountKey
} from './cloud-e2ee'
import { CloudE2eeLockedError, CloudVaultCipher, type CloudVaultCipherSource } from './cloud-e2ee-vault'
import { cloudPassphraseProblem } from './cloud-e2ee-passphrase'

const ACCOUNT_KEY_VERSION = 1

export { CLOUD_PASSPHRASE_MIN_LENGTH, cloudPassphraseProblem } from './cloud-e2ee-passphrase'

/** The unlocked account key a device keeps in its platform keychain, never on the server. */
export interface StoredCloudAccountKey {
  format: 1
  /** Base64 of the 32-byte account key. */
  key: string
  version: number
}

export interface CloudAccountKeyStore {
  load(): Promise<StoredCloudAccountKey | null>
  save(value: StoredCloudAccountKey): Promise<void>
  clear(): Promise<void>
}

export interface CloudKeysetApi {
  /** Null when the account has no keyset yet. */
  getKeyset(): Promise<CloudEncryptionKeyset | null>
  createKeyset(body: CloudEncryptionKeysetCreate): Promise<CloudEncryptionKeyset>
  updateKeyset(body: CloudEncryptionKeysetUpdate): Promise<CloudEncryptionKeyset>
}

/** Proof that the person knows one of the account's two secrets. */
export type CloudEncryptionSecret = { passphrase: string } | { recoveryWords: string }

/**
 * How a host runs Argon2id. By default in place; the browser runs it in a
 * worker of its own (64 MiB and about 100 ms it should not spend on the page).
 * Whatever runs it must give the bytes `derivePassphraseKey` gives.
 */
export type CloudPassphraseKeyDerivation = (passphrase: string, kdf: CloudE2eeKdfParams) => Promise<Uint8Array>

function storedKey(accountKey: Uint8Array, version: number): StoredCloudAccountKey {
  return { format: 1, key: toBase64(accountKey), version }
}

async function requireKeyset(api: CloudKeysetApi): Promise<CloudEncryptionKeyset> {
  const keyset = await api.getKeyset()
  if (!keyset) throw new CloudE2eeError('invalid-key', 'End-to-end encryption is not set up for this account.')
  return keyset
}

/** Opens the account key with either secret. A wrong secret is reported plainly. */
async function openAccountKey(
  keyset: CloudEncryptionKeyset,
  secret: CloudEncryptionSecret,
  derive: CloudPassphraseKeyDerivation
): Promise<Bytes> {
  try {
    if ('passphrase' in secret) {
      const passphraseKey = await derive(secret.passphrase, keyset.kdf as CloudE2eeKdfParams)
      return await unwrapAccountKey(keyset.passphrase_envelope, passphraseKey, 'passphrase')
    }
    const recoveryKey = recoveryKeyFromWords(secret.recoveryWords)
    return await unwrapAccountKey(keyset.recovery_envelope, recoveryKey, 'recovery')
  } catch (error) {
    if (error instanceof CloudE2eeError && error.code === 'wrong-key') {
      throw new CloudE2eeError(
        'wrong-key',
        'passphrase' in secret
          ? "That passphrase didn't work. Check for typos and capital letters, or use your recovery key instead."
          : "That recovery key didn't work. Check each word, or use your passphrase instead."
      )
    }
    throw error
  }
}

/**
 * Before anything reaches the service, the person sees the recovery key and
 * proves they kept it. `finish` then creates the keyset and unlocks this
 * device; until it runs, the account is unchanged.
 */
export interface PendingCloudEncryptionSetup {
  recoveryWords: string[]
  finish(): Promise<void>
}

export async function prepareCloudEncryptionSetup(
  api: CloudKeysetApi,
  store: CloudAccountKeyStore,
  passphrase: string,
  derive: CloudPassphraseKeyDerivation = derivePassphraseKey
): Promise<PendingCloudEncryptionSetup> {
  const problem = cloudPassphraseProblem(passphrase)
  if (problem) throw new CloudE2eeError('invalid-key', problem)
  if (await api.getKeyset()) {
    throw new CloudE2eeError('invalid-key', 'End-to-end encryption is already set up for this account. Unlock it with your passphrase instead.')
  }
  const accountKey = generateCloudE2eeKey()
  const recoveryKey = generateCloudE2eeKey()
  const kdf = newCloudE2eeKdfParams()
  const passphraseKey = await derive(passphrase, kdf)
  const body: CloudEncryptionKeysetCreate = {
    format: 1,
    account_key_version: ACCOUNT_KEY_VERSION,
    kdf,
    passphrase_envelope: await wrapAccountKey(accountKey, passphraseKey, 'passphrase'),
    recovery_envelope: await wrapAccountKey(accountKey, recoveryKey, 'recovery')
  }
  let finished = false
  return {
    recoveryWords: recoveryKeyToWords(recoveryKey),
    async finish() {
      if (finished) return
      // The service first, then this device: a keyset that exists without a
      // local key just asks for the passphrase; a local key without a keyset
      // would be a key nothing can recover.
      const created = await api.createKeyset(body)
      await store.save(storedKey(accountKey, created.account_key_version))
      finished = true
    }
  }
}

export async function unlockCloudEncryption(
  api: CloudKeysetApi,
  store: CloudAccountKeyStore,
  secret: CloudEncryptionSecret,
  derive: CloudPassphraseKeyDerivation = derivePassphraseKey
): Promise<void> {
  const keyset = await requireKeyset(api)
  const accountKey = await openAccountKey(keyset, secret, derive)
  await store.save(storedKey(accountKey, keyset.account_key_version))
}

/**
 * Re-wraps the account key under a new passphrase. The current passphrase or
 * the recovery key must open the keyset first, and must open the same key this
 * device holds, so a swapped keyset is noticed instead of adopted.
 */
export async function changeCloudEncryptionPassphrase(
  api: CloudKeysetApi,
  store: CloudAccountKeyStore,
  current: CloudEncryptionSecret,
  next: string,
  derive: CloudPassphraseKeyDerivation = derivePassphraseKey
): Promise<void> {
  const problem = cloudPassphraseProblem(next)
  if (problem) throw new CloudE2eeError('invalid-key', problem)
  const keyset = await requireKeyset(api)
  const accountKey = await openAccountKey(keyset, current, derive)
  await assertSameStoredKey(store, accountKey)
  const kdf = newCloudE2eeKdfParams()
  const passphraseKey = await derive(next, kdf)
  await api.updateKeyset({
    expected_revision: keyset.revision,
    kdf,
    passphrase_envelope: await wrapAccountKey(accountKey, passphraseKey, 'passphrase')
  })
  await store.save(storedKey(accountKey, keyset.account_key_version))
}

/** Replaces the recovery key. Like setup, nothing changes until `finish` runs. */
export async function prepareNewCloudRecoveryKey(
  api: CloudKeysetApi,
  store: CloudAccountKeyStore,
  current: CloudEncryptionSecret,
  derive: CloudPassphraseKeyDerivation = derivePassphraseKey
): Promise<PendingCloudEncryptionSetup> {
  const keyset = await requireKeyset(api)
  const accountKey = await openAccountKey(keyset, current, derive)
  await assertSameStoredKey(store, accountKey)
  const recoveryKey = generateCloudE2eeKey()
  const envelope = await wrapAccountKey(accountKey, recoveryKey, 'recovery')
  let finished = false
  return {
    recoveryWords: recoveryKeyToWords(recoveryKey),
    async finish() {
      if (finished) return
      await api.updateKeyset({ expected_revision: keyset.revision, recovery_envelope: envelope })
      finished = true
    }
  }
}

async function assertSameStoredKey(store: CloudAccountKeyStore, accountKey: Uint8Array): Promise<void> {
  const stored = await store.load()
  if (stored && !constantTimeEqual(fromBase64(stored.key), accountKey)) {
    throw new CloudE2eeError(
      'wrong-key',
      'Your encryption keys on ZenNotes Cloud changed since this device unlocked. Lock this device and unlock it again.'
    )
  }
}

/**
 * Finds each vault's cipher for the API client. Whether a vault is encrypted
 * is fixed when it is created, so the answer is cached for the session; the
 * account key is read from the keychain each time a cipher is first opened.
 */
export class CloudE2eeKeyring implements CloudVaultCipherSource {
  private readonly vaults = new Map<string, CloudSyncVault>()
  private readonly ciphers = new Map<string, Promise<CloudVaultCipher>>()

  constructor(
    private readonly deps: {
      listVaults(): Promise<CloudSyncVault[]>
      store: CloudAccountKeyStore
    }
  ) {}

  /** Hosts that already hold a vault resource can hand it over and skip a request. */
  remember(vault: CloudSyncVault): void {
    this.vaults.set(vault.id, vault)
  }

  async forVault(vaultId: string): Promise<CloudVaultCipher | null> {
    let vault = this.vaults.get(vaultId)
    if (!vault) {
      for (const listed of await this.deps.listVaults()) this.vaults.set(listed.id, listed)
      vault = this.vaults.get(vaultId)
      if (!vault) throw new Error('ZenNotes Cloud no longer has this vault.')
    }
    if (!vault.encryption) return null
    const cacheKey = `${vault.id}:${vault.encryption.key_id}`
    let cipher = this.ciphers.get(cacheKey)
    if (!cipher) {
      const encrypted = vault
      cipher = (async () => {
        const stored = await this.deps.store.load()
        if (!stored) throw new CloudE2eeLockedError()
        return CloudVaultCipher.open(encrypted, fromBase64(stored.key), stored.version)
      })()
      this.ciphers.set(cacheKey, cipher)
      cipher.catch(() => this.ciphers.delete(cacheKey))
    }
    return cipher
  }

  /** The real name of an encrypted vault, or its stored name for a readable one. */
  async vaultName(vault: CloudSyncVault): Promise<string> {
    if (!vault.encryption) return vault.name
    this.remember(vault)
    const cipher = await this.forVault(vault.id)
    return cipher ? cipher.vaultName(vault.encryption) : vault.name
  }

  /** Drops every cached cipher, for example after the device locks or signs out. */
  forget(): void {
    this.ciphers.clear()
  }
}
