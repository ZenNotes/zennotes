/**
 * End-to-end encryption for the signed-in account, as the shared Settings
 * panel asks for it: status, setup, unlock, a new passphrase or recovery key,
 * and lock. The account key never leaves this device's Keychain
 * (mobileCloudAccountKeyStore); moving a readable vault into an encrypted one
 * stays a desktop action in v1, so encryptCloudVault is not offered here.
 */
import type {
  CloudEncryptionRecoveryPrompt,
  CloudEncryptionSecretInput,
  CloudEncryptionStatus
} from '@zennotes/bridge-contract/cloud-sync'
import {
  changeCloudEncryptionPassphrase,
  prepareCloudEncryptionSetup,
  prepareNewCloudRecoveryKey,
  unlockCloudEncryption,
  type CloudEncryptionSecret,
  type PendingCloudEncryptionSetup
} from '@zennotes/shared-domain/cloud-e2ee-account'
import {
  MOBILE_END_TO_END_ENCRYPTION,
  getMobileCloudAccountStatus,
  mobileCloudConnection
} from './mobile-cloud-auth'
import { randomUUID } from './uuid'

/** Setups and recovery-key changes waiting for the person to confirm their words, by account. */
const pendingRecovery = new Map<string, { account: string; setup: PendingCloudEncryptionSetup }>()

export async function getMobileCloudEncryptionStatus(): Promise<CloudEncryptionStatus> {
  const off = { available: false, keyset: false, unlocked: false }
  if (!MOBILE_END_TO_END_ENCRYPTION) return off
  if ((await getMobileCloudAccountStatus()).state !== 'connected') return off
  const { client, keyStore } = await mobileCloudConnection()
  const account = (await client.account()).data
  return {
    available: account.capabilities?.end_to_end_encryption === true,
    keyset: account.encryption?.keyset === true,
    unlocked: (await keyStore.load()) !== null
  }
}

/**
 * Derives the keys and returns the recovery words to show. Nothing reaches
 * ZenNotes Cloud until finishMobileCloudEncryptionSetup runs with the id.
 */
export async function prepareMobileCloudEncryptionSetup(passphrase: string): Promise<CloudEncryptionRecoveryPrompt> {
  const { client, keyStore, account } = await encryptionConnection()
  return remember(account, await prepareCloudEncryptionSetup(client.keysetApi(), keyStore, String(passphrase ?? '')))
}

export async function finishMobileCloudEncryptionSetup(setupId: string): Promise<void> {
  await finishPending(setupId)
}

export async function unlockMobileCloudEncryption(secret: CloudEncryptionSecretInput): Promise<void> {
  const { client, keyStore, keyring } = await encryptionConnection()
  await unlockCloudEncryption(client.keysetApi(), keyStore, encryptionSecret(secret))
  keyring.forget()
}

export async function changeMobileCloudEncryptionPassphrase(
  current: CloudEncryptionSecretInput,
  next: string
): Promise<void> {
  const { client, keyStore } = await encryptionConnection()
  await changeCloudEncryptionPassphrase(client.keysetApi(), keyStore, encryptionSecret(current), String(next ?? ''))
}

export async function prepareNewMobileCloudRecoveryKey(
  current: CloudEncryptionSecretInput
): Promise<CloudEncryptionRecoveryPrompt> {
  const { client, keyStore, account } = await encryptionConnection()
  return remember(account, await prepareNewCloudRecoveryKey(client.keysetApi(), keyStore, encryptionSecret(current)))
}

export async function finishNewMobileCloudRecoveryKey(setupId: string): Promise<void> {
  await finishPending(setupId)
}

/** Forgets this device's account key; encrypted vaults stop syncing here until it unlocks again. */
export async function lockMobileCloudEncryption(): Promise<void> {
  if ((await getMobileCloudAccountStatus()).state !== 'connected') return
  const { keyStore, keyring } = await mobileCloudConnection()
  await keyStore.clear()
  keyring?.forget()
}

function remember(account: string, setup: PendingCloudEncryptionSetup): CloudEncryptionRecoveryPrompt {
  const setupId = randomUUID()
  pendingRecovery.set(setupId, { account, setup })
  return { setupId, recoveryWords: setup.recoveryWords }
}

async function finishPending(setupId: string): Promise<void> {
  const pending = pendingRecovery.get(String(setupId ?? ''))
  if (!pending) throw new Error('That recovery key is no longer waiting to be confirmed. Start again.')
  // A setup prepared for one account never finishes under another.
  const { account } = await encryptionConnection()
  if (pending.account !== account) {
    pendingRecovery.delete(setupId)
    throw new Error('The ZenNotes Cloud account changed. Start again.')
  }
  await pending.setup.finish()
  pendingRecovery.delete(setupId)
}

async function encryptionConnection() {
  if (!MOBILE_END_TO_END_ENCRYPTION) throw new Error('End-to-end encryption is not available in this build.')
  const { client, keyStore, keyring, credential } = await mobileCloudConnection()
  if (!keyring) throw new Error('End-to-end encryption is not available in this build.')
  return {
    client,
    keyStore,
    keyring,
    account: `${credential.base_url}#${credential.account.user.email.toLowerCase()}`
  }
}

/** Exactly one of the two secrets, as text; anything else is refused before key work runs. */
function encryptionSecret(value: unknown): CloudEncryptionSecret {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (record && typeof record.passphrase === 'string' && !('recoveryWords' in record)) {
    return { passphrase: record.passphrase }
  }
  if (record && typeof record.recoveryWords === 'string' && !('passphrase' in record)) {
    return { recoveryWords: record.recoveryWords }
  }
  throw new Error('Enter your encryption passphrase or recovery key.')
}
