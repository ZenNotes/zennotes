import type {
  NoteFolder,
  PrimaryNotesLocation,
  ShareLocationSetting
} from '@zennotes/bridge-contract/ipc'

/**
 * Where a share from the macOS Share menu is filed, per vault
 * (`VaultSettings.sharesLocation`). The app's main process files shares with
 * it and Settings describes it, so both read it the same way.
 */

/** A stored setting made safe to use: an unknown mode is Quick Notes, and a
 *  folder loses surrounding slashes. `folder` mode is kept with an empty
 *  folder so Settings can show the folder input while it is being typed;
 *  until a folder is named it files like `primary`. */
export function normalizeShareLocation(value: unknown): ShareLocationSetting {
  const v = value as { mode?: unknown; folder?: unknown } | null | undefined
  if (v?.mode === 'primary') return { mode: 'primary' }
  if (v?.mode === 'folder') {
    const folder = (typeof v.folder === 'string' ? v.folder : '').trim().replace(/^\/+|\/+$/g, '')
    return { mode: 'folder', folder }
  }
  return { mode: 'quick' }
}

/** The `(folder, subpath)` pair the vault's createNote takes for a share. A
 *  folder is inside the primary notes location, like the other location
 *  settings; the vault's own path checks still apply to it. */
export function resolveShareLocation(value: unknown): { folder: NoteFolder; subpath: string } {
  const setting = normalizeShareLocation(value)
  if (setting.mode === 'quick') return { folder: 'quick', subpath: '' }
  if (setting.mode === 'folder' && setting.folder) return { folder: 'inbox', subpath: setting.folder }
  return { folder: 'inbox', subpath: '' }
}

/** What the share sheet calls the place a share goes ("Save to …"). */
export function shareLocationLabel(
  value: unknown,
  primaryNotesLocation: PrimaryNotesLocation,
  vaultName: string
): string {
  const setting = normalizeShareLocation(value)
  if (setting.mode === 'folder' && setting.folder) return setting.folder
  if (setting.mode === 'quick') return 'Quick Notes'
  return primaryNotesLocation === 'root' ? vaultName : 'Inbox'
}
