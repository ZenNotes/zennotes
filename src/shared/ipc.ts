// Shared IPC channel names and types between main + renderer.
// Keeping these in one file gives us a single source of truth.

export const IPC = {
  VAULT_PICK: 'vault:pick',
  VAULT_GET_CURRENT: 'vault:get-current',
  VAULT_LIST_NOTES: 'vault:list-notes',
  VAULT_LIST_FOLDERS: 'vault:list-folders',
  VAULT_LIST_ASSETS: 'vault:list-assets',
  VAULT_HAS_ASSETS_DIR: 'vault:has-assets-dir',
  VAULT_TEXT_SEARCH_CAPABILITIES: 'vault:text-search-capabilities',
  VAULT_SEARCH_TEXT: 'vault:search-text',
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
  VAULT_REVEAL_ASSETS_DIR: 'vault:reveal-assets-dir',
  VAULT_SCAN_TASKS: 'vault:scan-tasks',
  VAULT_SCAN_TASKS_FOR: 'vault:scan-tasks-for',
  APP_LIST_FONTS: 'app:list-fonts',
  VAULT_ON_CHANGE: 'vault:on-change',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_OPEN_NOTE: 'window:open-note',
  APP_PLATFORM: 'app:platform'
} as const

export type NoteFolder = 'inbox' | 'quick' | 'archive' | 'trash'

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
  /** True when the body references at least one local non-text asset
   *  (PDF, image, audio, video, generic file). Surfaced in the sidebar
   *  as a small paperclip hint so attachments are discoverable. */
  hasAttachments: boolean
  /** First ~200 chars of the body stripped of markdown noise, for list previews. */
  excerpt: string
}

export interface NoteContent extends NoteMeta {
  /** Raw markdown body including any frontmatter. */
  body: string
}

export type VaultTextSearchBackendPreference = 'auto' | 'builtin' | 'ripgrep' | 'fzf'
export type VaultTextSearchBackendResolved = 'builtin' | 'ripgrep' | 'fzf'

export interface VaultTextSearchToolPaths {
  ripgrepPath?: string | null
  fzfPath?: string | null
}

export interface VaultTextSearchCapabilities {
  ripgrep: boolean
  fzf: boolean
}

export interface VaultTextSearchMatch {
  /** Path relative to the vault root, always POSIX-style. */
  path: string
  /** File name without extension. */
  title: string
  folder: NoteFolder
  /** 1-based line number of the match inside the note body. */
  lineNumber: number
  /** Zero-based character offset into the raw markdown body. */
  offset: number
  /** Single-line preview of the matched line. */
  lineText: string
}

export type ImportedAssetKind = 'image' | 'pdf' | 'audio' | 'video' | 'file'

export interface AssetMeta {
  /** Vault-relative path to the asset, POSIX-style. */
  path: string
  /** File name only. */
  name: string
  kind: ImportedAssetKind
  size: number
  updatedAt: number
}

export interface ImportedAsset {
  /** File name stored under the vault-root attachments directory. */
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
  /** Top-level folder (inbox / quick / archive / trash). */
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
