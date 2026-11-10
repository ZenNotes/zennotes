import type { VaultInfo, WorkspaceMode } from '@shared/ipc'
import { humanIpcError } from './ipc-error'
import { useToastStore } from './toast'

/** What this platform calls its file manager, as a menu or a button says it. */
export function fileManagerName(): string {
  const platform = window.zen.platformSync()
  if (platform === 'darwin') return 'Finder'
  if (platform === 'win32') return 'File Explorer'
  return 'File Manager'
}

/** Whether this host can show a local vault's folder at all. Says nothing about
 *  the vault: a remote workspace has no local folder, so callers check that too. */
export function canOpenVaultFolders(): boolean {
  return (
    typeof window.zen.openVaultInFileManager === 'function' &&
    window.zen.getAppInfo().runtime === 'desktop' &&
    window.zen.getCapabilities().supportsLocalFilesystemPickers
  )
}

/** Whether the open vault has a folder here to show. A temporary folder session
 *  does; a remote workspace's lives on its server. */
export function canOpenCurrentVaultFolder(state: {
  vault: VaultInfo | null
  workspaceMode: WorkspaceMode
}): boolean {
  return !!state.vault && state.workspaceMode !== 'remote' && canOpenVaultFolders()
}

/** Whether this host saves the open vault as a download instead of showing a
 *  folder (the browser, whose vault lives in the origin's private storage).
 *  It takes the open-folder key there: Leader F reaches the vault's files in
 *  each host. */
export function canDownloadVaultArchive(): boolean {
  return typeof window.zen.downloadVaultArchive === 'function'
}

export function canDownloadCurrentVault(state: {
  vault: VaultInfo | null
  workspaceMode: WorkspaceMode
}): boolean {
  return !!state.vault && state.workspaceMode !== 'remote' && canDownloadVaultArchive()
}

export async function downloadVaultArchive(): Promise<void> {
  try {
    await window.zen.downloadVaultArchive?.()
  } catch (err) {
    useToastStore
      .getState()
      .addToast(humanIpcError(err, 'Could not download the vault.'), 'error')
  }
}

/** Open a vault's folder in the file manager. A listed vault's folder can be
 *  gone (moved, or on a drive that is not mounted), and the switcher offers it
 *  anyway, so the answer has to reach the screen. */
export async function openVaultFolder(root: string): Promise<void> {
  try {
    await window.zen.openVaultInFileManager?.(root)
  } catch (err) {
    useToastStore
      .getState()
      .addToast(humanIpcError(err, `Could not open ${root}`), 'error')
  }
}
