// Shared IPC channel names and types between main + renderer.
// Keeping these in one file gives us a single source of truth.

export const IPC = {
  WORKSPACE_GET_INFO: 'workspace:get-info',
  WORKSPACE_CONNECT_REMOTE: 'workspace:connect-remote',
  WORKSPACE_DISCONNECT_REMOTE: 'workspace:disconnect-remote',
  WORKSPACE_LIST_REMOTE_PROFILES: 'workspace:list-remote-profiles',
  WORKSPACE_SAVE_REMOTE_PROFILE: 'workspace:save-remote-profile',
  WORKSPACE_DELETE_REMOTE_PROFILE: 'workspace:delete-remote-profile',
  WORKSPACE_CONNECT_REMOTE_PROFILE: 'workspace:connect-remote-profile',
  VAULT_PICK: 'vault:pick',
  VAULT_SELECT_PATH: 'vault:select-path',
  VAULT_BROWSE_SERVER_DIRECTORIES: 'vault:browse-server-directories',
  VAULT_GET_CURRENT: 'vault:get-current',
  VAULT_GET_SETTINGS: 'vault:get-settings',
  VAULT_SET_SETTINGS: 'vault:set-settings',
  VAULT_LIST_NOTES: 'vault:list-notes',
  VAULT_LIST_FOLDERS: 'vault:list-folders',
  VAULT_LIST_ASSETS: 'vault:list-assets',
  VAULT_HAS_ASSETS_DIR: 'vault:has-assets-dir',
  VAULT_GENERATE_DEMO_TOUR: 'vault:generate-demo-tour',
  VAULT_REMOVE_DEMO_TOUR: 'vault:remove-demo-tour',
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
  APP_ICON_DATA_URL: 'app:icon-data-url',
  APP_OPEN_SETTINGS: 'app:open-settings',
  APP_ZOOM_IN: 'app:zoom-in',
  APP_ZOOM_OUT: 'app:zoom-out',
  APP_ZOOM_RESET: 'app:zoom-reset',
  APP_UPDATER_GET_STATE: 'app-updater:get-state',
  APP_UPDATER_CHECK: 'app-updater:check',
  APP_UPDATER_CHECK_WITH_UI: 'app-updater:check-with-ui',
  APP_UPDATER_DOWNLOAD: 'app-updater:download',
  APP_UPDATER_INSTALL: 'app-updater:install',
  APP_UPDATER_ON_STATE: 'app-updater:on-state',
  VAULT_ON_CHANGE: 'vault:on-change',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_OPEN_NOTE: 'window:open-note',
  APP_PLATFORM: 'app:platform',
  TIKZ_RENDER: 'tikz:render',
  MCP_STATUS: 'mcp:status',
  MCP_INSTALL: 'mcp:install',
  MCP_UNINSTALL: 'mcp:uninstall',
  MCP_RUNTIME: 'mcp:runtime',
  MCP_GET_INSTRUCTIONS: 'mcp:get-instructions',
  MCP_SET_INSTRUCTIONS: 'mcp:set-instructions'
} as const

export interface TikzRenderResponse {
  ok: boolean
  svg?: string
  error?: string
}

export type AppUpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  availableVersion: string | null
  releaseName: string | null
  releaseDate: string | null
  releaseNotes: string | null
  progressPercent: number | null
  transferredBytes: number | null
  totalBytes: number | null
  bytesPerSecond: number | null
  message: string
}

export type NoteFolder = 'inbox' | 'quick' | 'archive' | 'trash'

export type PrimaryNotesLocation = 'inbox' | 'root'

export interface DailyNotesSettings {
  enabled: boolean
  directory: string
}

export interface VaultSettings {
  primaryNotesLocation: PrimaryNotesLocation
  dailyNotes: DailyNotesSettings
}

export const DEFAULT_DAILY_NOTES_DIRECTORY = 'Daily Notes'

export const DEFAULT_VAULT_SETTINGS: VaultSettings = {
  primaryNotesLocation: 'inbox',
  dailyNotes: {
    enabled: false,
    directory: DEFAULT_DAILY_NOTES_DIRECTORY
  }
}

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

export interface VaultDemoTourResult {
  notePaths: string[]
  assetPaths: string[]
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
  /** Zero-based order within the parent directory as read from disk. */
  siblingOrder: number
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

export interface ServerCapabilities {
  version: string
  platform: NodeJS.Platform
  authRequired: boolean
  supportsSessionLogin: boolean
  browseRootsEnforced: boolean
  supportsVaultSelection: boolean
  supportsDirectoryBrowsing: boolean
  supportsWatch: boolean
}

export interface ServerSessionStatus {
  authenticated: boolean
  authRequired: boolean
  supportsSessionLogin: boolean
}

export type WorkspaceMode = 'local' | 'remote'

export interface RemoteWorkspaceInfo {
  mode: WorkspaceMode
  baseUrl: string | null
  authConfigured: boolean
  capabilities: ServerCapabilities | null
  profileId: string | null
}

export interface RemoteWorkspaceProfile {
  id: string
  name: string
  baseUrl: string
  hasCredential: boolean
  vaultPath: string | null
  lastConnectedAt: number | null
}

export interface RemoteWorkspaceProfileInput {
  id?: string
  name?: string
  baseUrl: string
  authToken?: string | null
  clearAuthToken?: boolean
  vaultPath?: string | null
}

export interface DirectoryBrowseEntry {
  name: string
  path: string
}

export interface DirectoryBrowseShortcut {
  label: string
  path: string
}

export interface DirectoryBrowseResult {
  currentPath: string
  parentPath: string | null
  entries: DirectoryBrowseEntry[]
  shortcuts: DirectoryBrowseShortcut[]
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
export type VaultChangeScope = 'content' | 'vault-settings'

export interface VaultChangeEvent {
  kind: VaultChangeKind
  path: string
  folder: NoteFolder
  scope?: VaultChangeScope
}
