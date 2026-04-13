// Shared IPC channel names and types between main + renderer.
// Keeping these in one file gives us a single source of truth.

export const IPC = {
  VAULT_PICK: 'vault:pick',
  VAULT_GET_CURRENT: 'vault:get-current',
  VAULT_LIST_NOTES: 'vault:list-notes',
  VAULT_LIST_FOLDERS: 'vault:list-folders',
  VAULT_READ_NOTE: 'vault:read-note',
  VAULT_WRITE_NOTE: 'vault:write-note',
  VAULT_CREATE_NOTE: 'vault:create-note',
  VAULT_RENAME_NOTE: 'vault:rename-note',
  VAULT_DELETE_NOTE: 'vault:delete-note',
  VAULT_MOVE_TO_TRASH: 'vault:move-to-trash',
  VAULT_RESTORE_FROM_TRASH: 'vault:restore-from-trash',
  VAULT_EMPTY_TRASH: 'vault:empty-trash',
  VAULT_ARCHIVE_NOTE: 'vault:archive-note',
  VAULT_UNARCHIVE_NOTE: 'vault:unarchive-note',
  VAULT_DUPLICATE_NOTE: 'vault:duplicate-note',
  VAULT_REVEAL_NOTE: 'vault:reveal-note',
  VAULT_MOVE_NOTE: 'vault:move-note',
  VAULT_IMPORT_FILES: 'vault:import-files',
  VAULT_CREATE_FOLDER: 'vault:create-folder',
  VAULT_RENAME_FOLDER: 'vault:rename-folder',
  VAULT_DELETE_FOLDER: 'vault:delete-folder',
  VAULT_DUPLICATE_FOLDER: 'vault:duplicate-folder',
  VAULT_REVEAL_FOLDER: 'vault:reveal-folder',
  APP_LIST_FONTS: 'app:list-fonts',
  VAULT_ON_CHANGE: 'vault:on-change',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_CLOSE: 'window:close',
  APP_PLATFORM: 'app:platform'
} as const

export type NoteFolder = 'inbox' | 'archive' | 'trash'

export interface NoteMeta {
  /** Path relative to the vault root, always POSIX-style. */
  path: string
  /** File name without extension. */
  title: string
  folder: NoteFolder
  /** Zero-based order within the parent directory as read from disk. */
  siblingOrder: number
  createdAt: number
  updatedAt: number
  size: number
  /** Extracted #tags (unique, lowercase not enforced). */
  tags: string[]
  /** Outbound [[wikilink]] targets (note titles), unique. */
  wikilinks: string[]
  /** First ~200 chars of the body stripped of markdown noise, for list previews. */
  excerpt: string
}

export interface NoteContent extends NoteMeta {
  /** Raw markdown body including any frontmatter. */
  body: string
}

export type ImportedAssetKind = 'image' | 'pdf' | 'audio' | 'video' | 'file'

export interface ImportedAsset {
  /** File name stored under the vault-root `_assets` directory. */
  name: string
  /** Vault-relative path to the imported asset, POSIX-style. */
  path: string
  /** Markdown snippet to insert into the note. */
  markdown: string
  kind: ImportedAssetKind
}

export interface VaultInfo {
  root: string
  name: string
}

export interface FolderEntry {
  /** Top-level folder (inbox / archive / trash). */
  folder: NoteFolder
  /** POSIX subpath relative to the top-level folder, "" for the top-level itself. */
  subpath: string
  /** Zero-based order within the parent directory as read from disk. */
  siblingOrder: number
}

export type VaultChangeKind = 'add' | 'change' | 'unlink'

export interface VaultChangeEvent {
  kind: VaultChangeKind
  path: string
  folder: NoteFolder
}
