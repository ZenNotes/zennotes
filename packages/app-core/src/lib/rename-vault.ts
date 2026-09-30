/**
 * Renaming a vault's display name (#692): the name the sidebar header, the
 * vault switcher and the title bar use, kept in the vault's own vault.json so
 * it follows the folder wherever it is opened, while the folder keeps its
 * name on disk. The palette command and the sidebar's vault menu share this
 * prompt; Settings has a field instead.
 */
import type { VaultInfo, WorkspaceMode } from '@shared/ipc'
import { vaultFolderName } from '@shared/vault-display-name'
import { promptApp } from './prompt-requests'
import { useStore } from '../store'

export { vaultFolderName }

/**
 * Whether the open vault can take a display name: a local vault that is not
 * a temporary folder session (nothing is written into those) and not a remote
 * workspace, whose settings belong to its server.
 */
export function canRenameVault(state: {
  vault: VaultInfo | null
  workspaceMode: WorkspaceMode
}): boolean {
  return !!state.vault && !state.vault.temporary && state.workspaceMode !== 'remote'
}

/** Ask for the vault's display name and save it. Resolves to false when the
 *  prompt was cancelled, the vault cannot be renamed, or the save failed. An
 *  empty answer is an answer: it takes the vault back to its folder name. */
export async function renameVaultWithPrompt(): Promise<boolean> {
  const state = useStore.getState()
  const vault = state.vault
  if (!vault || !canRenameVault(state)) return false
  const folder = vaultFolderName(vault)
  const next = await promptApp({
    title: 'Rename vault',
    description: `Shown in the sidebar and the vault switcher. The folder stays ${folder} on disk; leave the name empty to go back to it.`,
    initialValue: state.vaultSettings.displayName ?? '',
    placeholder: folder,
    okLabel: 'Rename',
    allowEmptySubmit: true
  })
  if (next === null) return false
  // The prompt outlived a vault switch: the answer was for the vault that
  // asked, not whatever is open now.
  if (useStore.getState().vault?.root !== vault.root) return false
  return useStore.getState().renameVault(next)
}
