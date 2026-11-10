/**
 * The actions ZenNotes in the browser adds around ZenNotes Cloud, for the
 * command palette: attachments kept in this browser or downloaded on open,
 * freeing space, opening another Cloud vault here, and keeping Try mode's
 * vault in Cloud. Each is present only where the host has the bridge method
 * (the browser), and each reports what happened in a toast.
 */
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
