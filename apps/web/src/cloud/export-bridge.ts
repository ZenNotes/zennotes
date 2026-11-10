/**
 * The bridge of the PDF export window (`?exportNote=`, export-window.tsx).
 * That window is not an owner of the vault: it reads OPFS through `getFile()`
 * on its own main thread, which works while the owner's worker holds sync
 * handles (spike F1a), and never takes the vault lock, never writes and
 * never syncs.
 *
 * It is the portable bridge with no vault opened, so every method that would
 * act on a vault fails ("No vault is open"), plus the reads the export
 * window makes, served by a PortableVault over a read-only store.
 */
import type { ZenBridge } from '@zennotes/bridge-contract/bridge'
import type { VaultInfo } from '@zennotes/bridge-contract/ipc'
import { createPortableBridge } from '@zennotes/portable-vault/bridge'
import { posixNormalize } from '@zennotes/portable-vault/vault-core'
import { PortableVault } from '@zennotes/portable-vault/vault'
import { createBrowserHost, rootOf } from './browser-host'
import { createOpfsDispatcher } from './opfs-dispatch'
import { OpfsVaultFileSystem, directTransport } from './opfs-fs'
import { originOpfsRoot } from './opfs-handles'
import { vaultAssetUrl } from './opfs-paths'

function resolveAgainstNote(notePath: string, href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null
  const cut = trimmed.search(/[?#]/)
  let decoded = cut === -1 ? trimmed : trimmed.slice(0, cut)
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // keep raw
  }
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  const joined = decoded.startsWith('/') ? decoded.replace(/^\/+/, '') : noteDir ? `${noteDir}/${decoded}` : decoded
  const target = posixNormalize(joined)
  return target === '..' || target.startsWith('../') ? null : target
}

export async function createExportBridge(vaultKey: string, vaultName: string): Promise<ZenBridge> {
  const fs = new OpfsVaultFileSystem(
    vaultKey,
    directTransport(createOpfsDispatcher({ root: originOpfsRoot, readOnly: true })),
    { generation: 0 }
  )
  await fs.init()
  const vault = new PortableVault(vaultName, fs)
  const info: VaultInfo = { root: rootOf(vaultKey), name: vaultName, folderName: vaultName }
  const base = createPortableBridge(
    createBrowserHost(
      async () => {
        throw new Error('The export window does not open vaults.')
      },
      {
        beforeLeavingForSignIn: async () => {},
        leftApp: () => {},
        returnedToApp: () => {},
        revoked: () => {},
        switchTo: () => {}
      }
    )
  )
  const assetUrl = (relPath: string | null): string | null => {
    if (!relPath) return null
    try {
      return vaultAssetUrl(vaultKey, relPath)
    } catch {
      return null
    }
  }
  return {
    ...base,
    getCurrentVault: async () => info,
    getVaultSettings: () => vault.getVaultSettings(),
    listNotes: () => vault.listNotes(),
    listFolders: () => vault.listFolders(),
    listAssets: () => vault.listAssets(),
    readNote: (relPath) => vault.readNote(relPath),
    readVaultAssetBase64: (relPath) => fs.readBase64(posixNormalize(relPath.replace(/^\/+/, ''))),
    resolveLocalAssetUrl: (_root, notePath, href) => assetUrl(resolveAgainstNote(notePath, href)),
    resolveVaultAssetUrl: (_root, assetPath) => assetUrl(resolveAgainstNote('', assetPath))
  }
}
