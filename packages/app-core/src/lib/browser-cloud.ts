/**
 * The actions ZenNotes in the browser adds around ZenNotes Cloud, for the
 * command palette: attachments kept in this browser or downloaded on open,
 * freeing space, opening another Cloud vault here, keeping Try mode's vault
 * in Cloud, unlocking and locking encryption, and the running release. Each
 * is present only where the host has the bridge method (the browser), and
 * each reports what happened in a toast.
 */
import type { BrowserRelease } from '@zennotes/bridge-contract/bridge'
import { confirmApp } from './confirm-requests'
import { humanIpcError } from './ipc-error'
import { useToastStore } from './toast'

function say(message: string, tone: 'success' | 'error' | 'info' = 'info'): void {
  useToastStore.getState().addToast(message, tone)
}

export function canManageBrowserAttachments(): boolean {
  return typeof window.zen?.getBrowserStorageStatus === 'function'
}

export function canChooseCloudVaultInBrowser(): boolean {
  return typeof window.zen?.chooseCloudVaultInBrowser === 'function'
}

export function canKeepVaultInCloud(): boolean {
  return typeof window.zen?.keepVaultInCloud === 'function'
}

export async function toggleKeepAttachmentsInBrowser(): Promise<void> {
  try {
    const current = await window.zen.getBrowserStorageStatus!()
    const next = await window.zen.setBrowserKeepAttachments!(!current.keepAttachments)
    say(
      next.keepAttachments
        ? 'Attachments are kept in this browser now. Any still in ZenNotes Cloud download in the background.'
        : 'Large attachments download when you open them now.',
      'success'
    )
  } catch (error) {
    say(humanIpcError(error, 'Could not change how this browser keeps attachments.'), 'error')
  }
}

export async function downloadAttachmentsToBrowser(): Promise<void> {
  try {
    const result = await window.zen.downloadBrowserAttachments!()
    if (result.changed === 0 && result.failed === 0) {
      say('Every attachment of this vault is already in this browser.', 'info')
    } else if (result.failed > 0) {
      say(`Downloaded ${result.changed} attachments; ${result.failed} could not download. Try again when online.`, 'error')
    } else {
      say(`Downloaded ${result.changed} ${result.changed === 1 ? 'attachment' : 'attachments'} to this browser.`, 'success')
    }
  } catch (error) {
    say(humanIpcError(error, 'Could not download the attachments.'), 'error')
  }
}

export async function freeUpBrowserSpace(): Promise<void> {
  try {
    const result = await window.zen.freeBrowserSpace!()
    say(
      result.changed === 0
        ? 'Nothing to free: no synced attachment here is large enough.'
        : `Freed space from ${result.changed} ${result.changed === 1 ? 'attachment' : 'attachments'}. They download again when you open them.`,
      'success'
    )
  } catch (error) {
    say(humanIpcError(error, 'Could not free up space.'), 'error')
  }
}

export async function chooseCloudVaultInBrowser(): Promise<void> {
  try {
    await window.zen.chooseCloudVaultInBrowser!()
  } catch (error) {
    say(humanIpcError(error, 'Could not show your ZenNotes Cloud vaults.'), 'error')
  }
}

export async function keepVaultInCloud(): Promise<void> {
  try {
    await window.zen.keepVaultInCloud!()
  } catch (error) {
    say(humanIpcError(error, 'Could not keep this vault in ZenNotes Cloud.'), 'error')
  }
}

export function canManageBrowserEncryption(): boolean {
  return typeof window.zen?.getBrowserEncryptionPrefs === 'function'
}

export function canCopyBrowserRelease(): boolean {
  return typeof window.zen?.getBrowserRelease === 'function'
}

async function encryptionStatus(): Promise<{ keyset: boolean; unlocked: boolean } | null> {
  const status = await window.zen.getCloudEncryptionStatus?.()
  return status?.available ? status : null
}

export async function unlockBrowserEncryption(): Promise<void> {
  try {
    const status = await encryptionStatus()
    if (!status?.keyset) {
      say('End-to-end encryption is not set up for this account. Set it up in Settings, under Cloud.', 'info')
    } else if (status.unlocked) {
      say('Encryption is already unlocked in this browser.', 'info')
    } else {
      await window.zen.openBrowserUnlock!()
    }
  } catch (error) {
    say(humanIpcError(error, 'Could not open the unlock screen.'), 'error')
  }
}

export async function lockBrowserEncryption(): Promise<void> {
  try {
    const status = await encryptionStatus()
    if (!status?.unlocked) {
      say('Encryption is already locked in this browser.', 'info')
      return
    }
    const confirmed = await confirmApp({
      title: 'Lock encryption in this browser?',
      description: 'Encrypted vaults close and stop syncing here until you unlock again.',
      confirmLabel: 'Lock',
      danger: false
    })
    if (!confirmed) return
    await window.zen.lockCloudEncryption!()
    say('Encryption is locked in this browser.', 'success')
  } catch (error) {
    say(humanIpcError(error, 'Could not lock encryption in this browser.'), 'error')
  }
}

export async function toggleBrowserLockOnClose(): Promise<void> {
  try {
    const current = await window.zen.getBrowserEncryptionPrefs!()
    const next = await window.zen.setBrowserLockOnClose!(!current.lockOnClose)
    say(
      next.lockOnClose
        ? 'Encryption locks when this tab closes.'
        : 'Encryption stays unlocked in this browser after this tab closes.',
      'success'
    )
  } catch (error) {
    say(humanIpcError(error, 'Could not change when encryption locks.'), 'error')
  }
}

export function browserReleaseText(release: BrowserRelease): string {
  return release.manifestSha256
    ? `ZenNotes ${release.release}\nManifest SHA-256: ${release.manifestSha256}`
    : `ZenNotes ${release.release}`
}

export async function copyBrowserRelease(): Promise<void> {
  try {
    const release = await window.zen.getBrowserRelease!()
    await navigator.clipboard.writeText(browserReleaseText(release))
    say(release.manifestSha256 ? 'Copied the release and its manifest hash.' : 'Copied the release. This build has no manifest.', 'success')
  } catch (error) {
    say(humanIpcError(error, 'Could not copy the release.'), 'error')
  }
}
