/**
 * Physical-layout reconciliation for "Open on this device" (zennotesandroid#17).
 *
 * Cloud sync mirrors vault-relative paths verbatim, it has no notion of
 * primary-notes mode. A fresh phone vault keeps its notes under `inbox/`,
 * while most desktop-created vaults keep them at the vault root, so linking
 * one to the other used to merge two parallel trees: the device's
 * `inbox/Daily Notes` and the cloud's `Daily Notes` both classify as the
 * inbox subpath "Daily Notes" (folderForRelativePath), and every daily note
 * showed up twice.
 *
 * Before the first sync of a newly linked vault, this module reads the cloud
 * vault's manifest (paths only, no content), infers which layout the cloud
 * tree uses, and moves the local vault's primary notes to match. The move is
 * invisible in the app, `inbox/X` and root `X` render identically, but it
 * makes the first sync merge one tree instead of two. Android's since
 * 1.1.11; with the lift the iPhone, whose vaults start the same way, gets it.
 *
 * Known limit: a cloud vault whose inbox was remapped (`systemFolderPaths`)
 * and that has no literal `inbox/` directory reads as root-mode here, because
 * the manifest listing carries no settings content. That combination requires
 * deliberate desktop configuration and self-corrects once the settings
 * conflict is resolved; the common shapes (fresh device joining a desktop
 * root vault, or two default vaults) reconcile exactly.
 */
import { resolveFolderPath, type SystemFolderPaths } from '@zennotes/shared-domain/system-folder-paths'
import { authenticatedClient } from './mobile-cloud-auth'
import { emitVaultChange } from './events'
import {
  ATTACHMENTS_DIRS,
  DELETED_ASSETS_DIR,
  INTERNAL_VAULT_DIR,
  NOTE_COMMENTS_DIR,
  isMarkdownPath
} from './vault-core'
import type { PortableVault } from './vault-fs'

type CloudLayout = 'inbox' | 'root' | 'indeterminate'

/** Lowercased top-level names that belong to the vault machinery in either
 *  layout: asset dirs, the internal dir, and the resolved non-inbox system
 *  folders. These never move during a relayout and never count as content. */
function neutralTopNames(systemFolderPaths?: SystemFolderPaths | null): Set<string> {
  const names = [
    ...ATTACHMENTS_DIRS,
    INTERNAL_VAULT_DIR,
    DELETED_ASSETS_DIR,
    NOTE_COMMENTS_DIR,
    ...(['quick', 'archive', 'trash'] as const).map((folder) =>
      resolveFolderPath(folder, systemFolderPaths)
    )
  ]
  return new Set(names.map((name) => name.toLowerCase()))
}

/** Infer the cloud vault's primary-notes layout from its manifest paths. */
export async function cloudPrimaryLayout(vaultId: string): Promise<CloudLayout> {
  const client = await authenticatedClient()
  const paths: string[] = []
  let page = 1
  for (;;) {
    const response = await client.manifest(vaultId, {
      includeContent: false,
      page,
      perPage: 250
    })
    for (const item of response.data) paths.push(item.path)
    if (response.next_page === null) break
    page = response.next_page
  }

  // The cloud tree carries no settings context of its own; classify against
  // the default machinery names (a remapped quick/archive on the cloud side
  // would count as root content, which errs toward root, see header note).
  const neutral = neutralTopNames(null)
  let sawRootContent = false
  for (const path of paths) {
    const slash = path.indexOf('/')
    const top = (slash === -1 ? path : path.slice(0, slash)).toLowerCase()
    if (!top || top.startsWith('.')) continue
    if (top === 'inbox') return 'inbox'
    if (neutral.has(top)) continue
    // A top-level directory, or a loose markdown file at the root.
    if (slash !== -1 || isMarkdownPath(top)) sawRootContent = true
  }
  return sawRootContent ? 'root' : 'indeterminate'
}

/**
 * Move the local vault's primary notes to the cloud vault's layout, then
 * flip `primaryNotesLocation` to match. Collisions and per-entry failures
 * leave that entry where it is, sync merges whatever remains, which is
 * never worse than not reconciling at all.
 */
export async function reconcileLayoutForCloudJoin(
  vault: PortableVault,
  vaultId: string
): Promise<void> {
  const cloud = await cloudPrimaryLayout(vaultId)
  if (cloud === 'indeterminate') return

  const settings = await vault.getVaultSettings()
  if (settings.primaryNotesLocation === cloud) return

  const inboxDir = resolveFolderPath('inbox', settings.systemFolderPaths)
  const blocked = neutralTopNames(settings.systemFolderPaths)
  blocked.add(inboxDir.toLowerCase())
  let moved = false

  if (cloud === 'root') {
    const entries = await vault.fs.readdir(inboxDir).catch(() => [])
    for (const entry of entries) {
      if (blocked.has(entry.name.toLowerCase())) continue
      if ((await vault.fs.statOrNull(entry.name)) !== null) continue
      await vault.fs
        .rename(`${inboxDir}/${entry.name}`, entry.name)
        .then(() => {
          moved = true
        })
        .catch(() => {})
    }
    const remaining = await vault.fs.readdir(inboxDir).catch(() => null)
    if (remaining !== null && remaining.length === 0) {
      await vault.fs.rmdir(inboxDir).catch(() => {})
    }
  } else {
    await vault.fs.mkdir(inboxDir).catch(() => {})
    const entries = await vault.fs.readdir('').catch(() => [])
    for (const entry of entries) {
      const lower = entry.name.toLowerCase()
      if (lower.startsWith('.') || blocked.has(lower)) continue
      if (entry.type === 'file' && !isMarkdownPath(entry.name)) continue
      if ((await vault.fs.statOrNull(`${inboxDir}/${entry.name}`)) !== null) continue
      await vault.fs
        .rename(entry.name, `${inboxDir}/${entry.name}`)
        .then(() => {
          moved = true
        })
        .catch(() => {})
    }
  }

  await vault.setVaultSettings({ ...settings, primaryNotesLocation: cloud })
  if (moved) {
    await vault.rescan()
    emitVaultChange({ kind: 'change', path: '', folder: 'inbox', scope: 'resync' })
  }
}
