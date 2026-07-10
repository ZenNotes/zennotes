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
  VAULT_LIST_LOCAL: 'vault:list-local',
  VAULT_OPEN_LOCAL: 'vault:open-local',
  VAULT_CLOSE: 'vault:close',
  VAULT_PICK: 'vault:pick',
  VAULT_SELECT_PATH: 'vault:select-path',
  VAULT_BROWSE_SERVER_DIRECTORIES: 'vault:browse-server-directories',
  VAULT_GET_CURRENT: 'vault:get-current',
  VAULT_GET_SETTINGS: 'vault:get-settings',
  VAULT_SET_SETTINGS: 'vault:set-settings',
  VAULT_ROOT_CONTENT_HIDDEN: 'vault:root-content-hidden',
  VAULT_LIST_NOTES: 'vault:list-notes',
  VAULT_LIST_NOTES_STREAM: 'vault:list-notes-stream',
  VAULT_LIST_FOLDERS: 'vault:list-folders',
  VAULT_LIST_ASSETS: 'vault:list-assets',
  VAULT_HAS_ASSETS_DIR: 'vault:has-assets-dir',
  VAULT_GENERATE_DEMO_TOUR: 'vault:generate-demo-tour',
  VAULT_REMOVE_DEMO_TOUR: 'vault:remove-demo-tour',
  VAULT_LIST_TEMPLATES: 'vault:list-templates',
  VAULT_READ_TEMPLATE: 'vault:read-template',
  VAULT_WRITE_TEMPLATE: 'vault:write-template',
  VAULT_DELETE_TEMPLATE: 'vault:delete-template',
  VAULT_TEXT_SEARCH_CAPABILITIES: 'vault:text-search-capabilities',
  VAULT_SEARCH_TEXT: 'vault:search-text',
  VAULT_READ_NOTE: 'vault:read-note',
  VAULT_READ_COMMENTS: 'vault:read-comments',
  VAULT_WRITE_COMMENTS: 'vault:write-comments',
  VAULT_WRITE_NOTE: 'vault:write-note',
  VAULT_APPEND_NOTE: 'vault:append-note',
  VAULT_CREATE_NOTE: 'vault:create-note',
  VAULT_CREATE_EXCALIDRAW: 'vault:create-excalidraw',
  VAULT_CONVERT_OBSIDIAN_EXCALIDRAW: 'vault:convert-obsidian-excalidraw',
  VAULT_RENAME_NOTE: 'vault:rename-note',
  VAULT_DELETE_NOTE: 'vault:delete-note',
  VAULT_MOVE_TO_TRASH: 'vault:move-to-trash',
  VAULT_RESTORE_FROM_TRASH: 'vault:restore-from-trash',
  VAULT_EMPTY_TRASH: 'vault:empty-trash',
  VAULT_ARCHIVE_NOTE: 'vault:archive-note',
  VAULT_UNARCHIVE_NOTE: 'vault:unarchive-note',
  VAULT_DUPLICATE_NOTE: 'vault:duplicate-note',
  VAULT_EXPORT_NOTE_PDF: 'vault:export-note-pdf',
  VAULT_REVEAL_NOTE: 'vault:reveal-note',
  VAULT_REVEAL_NOTE_TARGET: 'vault:reveal-note-target',
  VAULT_MOVE_NOTE: 'vault:move-note',
  VAULT_IMPORT_FILES: 'vault:import-files',
  VAULT_IMPORT_PASTED_IMAGE: 'vault:import-pasted-image',
  VAULT_RENAME_ASSET: 'vault:rename-asset',
  VAULT_MOVE_ASSET: 'vault:move-asset',
  VAULT_DUPLICATE_ASSET: 'vault:duplicate-asset',
  VAULT_DELETE_ASSET: 'vault:delete-asset',
  VAULT_RESTORE_DELETED_ASSET: 'vault:restore-deleted-asset',
  VAULT_LIST_DELETED_ASSETS: 'vault:list-deleted-assets',
  VAULT_PURGE_DELETED_ASSET: 'vault:purge-deleted-asset',
  VAULT_EMPTY_DELETED_ASSETS: 'vault:empty-deleted-assets',
  VAULT_CREATE_FOLDER: 'vault:create-folder',
  VAULT_RENAME_FOLDER: 'vault:rename-folder',
  VAULT_DELETE_FOLDER: 'vault:delete-folder',
  VAULT_DUPLICATE_FOLDER: 'vault:duplicate-folder',
  VAULT_REVEAL_FOLDER: 'vault:reveal-folder',
  VAULT_REVEAL_FILE_PATH: 'vault:reveal-file-path',
  VAULT_REVEAL_FOLDER_TARGET: 'vault:reveal-folder-target',
  VAULT_REVEAL_ASSETS_DIR: 'vault:reveal-assets-dir',
  VAULT_SCAN_TASKS: 'vault:scan-tasks',
  VAULT_SCAN_TASKS_FOR: 'vault:scan-tasks-for',
  VAULT_OPEN_DATABASE: 'vault:open-database',
  VAULT_WRITE_DATABASE_ROWS: 'vault:write-database-rows',
  VAULT_WRITE_DATABASE_SCHEMA: 'vault:write-database-schema',
  VAULT_CREATE_DATABASE: 'vault:create-database',
  VAULT_RENAME_DATABASE: 'vault:rename-database',
  VAULT_CREATE_RECORD_PAGE: 'vault:create-record-page',
  VAULT_LIST_DATABASES: 'vault:list-databases',
  APP_LIST_FONTS: 'app:list-fonts',
  APP_ICON_DATA_URL: 'app:icon-data-url',
  APP_OPEN_SETTINGS: 'app:open-settings',
  APP_OPEN_NOTE_REQUESTED: 'app:open-note-requested',
  APP_RENDERER_READY: 'app:renderer-ready',
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
  WINDOW_OPEN_VAULT: 'window:open-vault',
  WINDOW_TOGGLE_QUICK_CAPTURE: 'window:toggle-quick-capture',
  APP_PLATFORM: 'app:platform',
  APP_GET_QUICK_CAPTURE_HOTKEY: 'app:get-quick-capture-hotkey',
  APP_SET_QUICK_CAPTURE_HOTKEY: 'app:set-quick-capture-hotkey',
  APP_GET_QUICK_CAPTURE_PINNED: 'app:get-quick-capture-pinned',
  APP_SET_QUICK_CAPTURE_PINNED: 'app:set-quick-capture-pinned',
  APP_READ_EXTERNAL_FILE: 'app:read-external-file',
  APP_WRITE_EXTERNAL_FILE: 'app:write-external-file',
  APP_MOVE_EXTERNAL_FILE_TO_VAULT: 'app:move-external-file-to-vault',
  APP_OPEN_MARKDOWN_FILE: 'app:open-markdown-file',
  TIKZ_RENDER: 'tikz:render',
  MCP_STATUS: 'mcp:status',
  MCP_INSTALL: 'mcp:install',
  MCP_UNINSTALL: 'mcp:uninstall',
  MCP_RUNTIME: 'mcp:runtime',
  MCP_GET_INSTRUCTIONS: 'mcp:get-instructions',
  MCP_SET_INSTRUCTIONS: 'mcp:set-instructions',
  CLI_GET_STATUS: 'cli:get-status',
  CLI_INSTALL: 'cli:install',
  CLI_UNINSTALL: 'cli:uninstall',
  RAYCAST_GET_STATUS: 'raycast:get-status',
  RAYCAST_INSTALL: 'raycast:install',
  CONFIG_GET_SYNC: 'config:get-sync',
  CONFIG_SET: 'config:set',
  CONFIG_GET_PATH: 'config:get-path',
  CONFIG_REVEAL: 'config:reveal',
  CONFIG_ON_CHANGE: 'config:on-change',
  CUSTOM_THEMES_LIST: 'custom-themes:list',
  CUSTOM_THEMES_GET_DIR: 'custom-themes:get-dir',
  CUSTOM_THEMES_REVEAL: 'custom-themes:reveal',
  CUSTOM_THEMES_DELETE: 'custom-themes:delete',
  CUSTOM_THEMES_CREATE: 'custom-themes:create',
  CUSTOM_THEMES_ON_CHANGE: 'custom-themes:on-change',
  OVERRIDES_LIST: 'overrides:list',
  OVERRIDES_REVEAL: 'overrides:reveal',
  OVERRIDES_DELETE: 'overrides:delete',
  OVERRIDES_ON_CHANGE: 'overrides:on-change',
  DEVTOOLS_TOGGLE: 'devtools:toggle',
  // Per-vault workspace state (open tabs, layout, cursor) persisted to
  // <vault>/.zennotes/workspace.json so it syncs with the vault. (#292)
  WORKSPACE_STATE_READ: 'workspace-state:read',
  WORKSPACE_STATE_WRITE: 'workspace-state:write'
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

/** Where on disk the `zen` shim is currently installed (or could be). */
export interface CliInstallStatus {
  /** True if the wrapper script is shipped with this build. False in
   *  dev runs where electron-vite has not bundled the CLI yet. */
  available: boolean
  /** Reason the wrapper is unavailable, if available is false. */
  reason: string | null
  /** Where the next install would land. Picked dynamically from the
   *  user's PATH preferring user-writable locations like ~/.local/bin
   *  so installs don't need a sudo prompt. */
  defaultTarget: string
  /** True when defaultTarget is not user-writable and we'd need to
   *  invoke osascript / pkexec to symlink there. */
  requiresSudo: boolean
  /** Whether the directory containing defaultTarget is on the user's
   *  $PATH. False means we'd install but the binary wouldn't be
   *  callable until the user updates their shell config. */
  targetOnPath: boolean
  /** Shell override the user can paste into ~/.zshrc / ~/.bashrc to
   *  put the chosen directory on PATH. Null when targetOnPath is true
   *  or when nothing helpful applies. */
  pathHint: string | null
  /** Absolute path of an existing install if found. Null when none. */
  installedAt: string | null
  /** True when an install exists AND points at the wrapper for this
   *  build. False when something else owns the symlink. */
  installedByThisApp: boolean
  /** Whether this platform supports installing the CLI from Settings.
   *  False on Windows for now (different install model). */
  supportedPlatform: boolean
}

export interface RaycastExtensionStatus {
  /** True when this build can attempt a local Raycast extension install. */
  available: boolean
  /** Reason installation is unavailable, if available is false. */
  reason: string | null
  /** Raycast extensions are macOS-only. */
  supportedPlatform: boolean
  /** True when the copied local extension exists in app data. */
  installed: boolean
  /** True when the local copy was installed from the current app version. */
  upToDate: boolean
  /** App-data path where ZenNotes copies the local Raycast extension. */
  extensionPath: string
  /** Bundled extension source path used for the next install, if present. */
  sourcePath: string | null
  /** Whether Raycast.app was found on this Mac. */
  raycastInstalled: boolean
  /** Whether a user-installed Node.js binary is visible to login shells. */
  nodeAvailable: boolean
  /** Whether a user-installed npm binary is visible to login shells. */
  npmAvailable: boolean
  nodePath: string | null
  npmPath: string | null
  nodeVersion: string | null
  npmVersion: string | null
  /** True when the user Node.js version meets Raycast's extension tooling requirements. */
  nodeMeetsMinimum: boolean
  /** True when npm meets Raycast's extension tooling requirements. */
  npmMeetsMinimum: boolean
  installedVersion: string | null
  bundledVersion: string
  lastInstalledAt: string | null
}

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
export type FolderIconId =
  | 'folder'
  | 'bolt'
  | 'tray'
  | 'archive'
  | 'trash'
  | 'book'
  | 'bookmark'
  | 'calendar'
  | 'briefcase'
  | 'tag'
  | 'document'
  | 'sparkle'
  | 'code'
  | 'user'
  | 'star'
  | 'heart'
  | 'link'
  | 'lightbulb'
  | 'flask'
  | 'graduation'
  | 'music'
  | 'image'
  | 'palette'
  | 'terminal'
  | 'wrench'
  | 'globe'
  | 'map'
  | 'chart'
  | 'home'

/** Preset folder accent colors (tints the folder's sidebar icon). */
export type FolderColorId =
  | 'red'
  | 'orange'
  | 'amber'
  | 'green'
  | 'teal'
  | 'sky'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'pink'

export interface DateNotePatternSettings {
  /** Directory or date-based directory pattern inside the primary notes area. */
  directory: string
  /** Date-based title/filename pattern. */
  titlePattern?: string
  /** BCP 47 locale used for localized pattern tokens. `system` = OS/browser locale. */
  locale?: string
}

export interface DailyNotesSettings {
  enabled: boolean
  /** Directory or date-based directory pattern inside the primary notes area. */
  directory: string
  /** Date-based title/filename pattern for new daily notes. */
  titlePattern?: string
  /** BCP 47 locale used for localized pattern tokens. `system` = OS/browser locale. */
  locale?: string
  /** Prior patterns used only to recognize existing daily notes after settings changes. */
  legacyPatterns?: DateNotePatternSettings[]
  /** Template applied to new daily notes. Empty/undefined = blank note. */
  templateId?: string
  /**
   * Treat a task written inside a daily note as due on that note's date, so it
   * shows up on the calendar without typing `due:`. The line is left untouched —
   * the due date is derived. An explicit `due:` token still wins. Default `true`.
   */
  tasksDueOnNoteDate?: boolean
  /**
   * When today's daily note opens, move every unfinished task from previous
   * daily notes into it (Obsidian-style). Off by default. */
  rolloverUnfinishedTasks?: boolean
}

export interface WeeklyNotesSettings {
  enabled: boolean
  /** Directory or date-based directory pattern inside the primary notes area. */
  directory: string
  /** Date-based title/filename pattern for new weekly notes. */
  titlePattern?: string
  /** BCP 47 locale used for localized pattern tokens. `system` = OS/browser locale. */
  locale?: string
  /** Prior patterns used only to recognize existing weekly notes after settings changes. */
  legacyPatterns?: DateNotePatternSettings[]
  /** Template applied to new weekly notes. Empty/undefined = blank note. */
  templateId?: string
}

export interface MonthlyNotesSettings {
  enabled: boolean
  /** Directory or date-based directory pattern inside the primary notes area. */
  directory: string
  /** Date-based title/filename pattern for new monthly notes. */
  titlePattern?: string
  /** BCP 47 locale used for localized pattern tokens. `system` = OS/browser locale. */
  locale?: string
  /** Prior patterns used only to recognize existing monthly notes after settings changes. */
  legacyPatterns?: DateNotePatternSettings[]
  /** Template applied to new monthly notes. Empty/undefined = blank note. */
  templateId?: string
}

/**
 * Per-vault overrides for "how this vault looks" — sort order, grouping, the
 * tasks view, etc. Each key falls back to the matching global preference
 * (config.toml) when unset, so a fresh vault inherits the global default and a
 * customized one keeps its own look. Stored in `<vault>/.zennotes/vault.json`
 * so it travels with the vault. Values are kept loose here (the IPC boundary)
 * and validated in the renderer's normalizer. (#292)
 */
export interface VaultViewSettings {
  noteSortOrder?: string
  groupByKind?: boolean
  tasksViewMode?: string
  kanbanGroupBy?: string
  kanbanColumnTitles?: Record<string, string>
  kanbanStatuses?: string[]
  autoReveal?: boolean
  systemFolderLabels?: Record<string, unknown>
  unifiedSidebar?: boolean
}

export interface VaultSettings {
  primaryNotesLocation: PrimaryNotesLocation
  dailyNotes: DailyNotesSettings
  weeklyNotes: WeeklyNotesSettings
  monthlyNotes: MonthlyNotesSettings
  /** Per-vault view overrides (#292); absent/empty means "inherit global". */
  view?: VaultViewSettings
  folderIcons: Record<string, FolderIconId>
  /** Per-folder accent color, keyed by `folder:subpath` (same key as folderIcons). */
  folderColors: Record<string, FolderColorId>
  /**
   * Favorited notes and folders, pinned to the top of the sidebar. Each entry is
   * either a note's vault-relative path (e.g. `inbox/Idea.md`) or a folder key
   * `folder:subpath` (e.g. `inbox:Projects`). Folder keys always contain a `:`;
   * note paths never do (`:` is a forbidden filename char), so the two are
   * distinguishable. Order is the display order in the Favorites section.
   */
  favorites: string[]
}

export const DEFAULT_DAILY_NOTES_DIRECTORY = 'Daily Notes'
export const DEFAULT_DAILY_NOTE_TITLE_PATTERN = 'yyyy-MM-dd'
export const DEFAULT_DAILY_NOTE_LOCALE = 'system'
export const DEFAULT_WEEKLY_NOTES_DIRECTORY = 'Weekly Notes'
export const DEFAULT_WEEKLY_NOTE_TITLE_PATTERN = "yyyy-'W'ww"
export const DEFAULT_WEEKLY_NOTE_LOCALE = 'system'
export const DEFAULT_MONTHLY_NOTES_DIRECTORY = 'Monthly Notes'
export const DEFAULT_MONTHLY_NOTE_TITLE_PATTERN = 'yyyy-MM'
export const DEFAULT_MONTHLY_NOTE_LOCALE = 'system'

export const DEFAULT_VAULT_SETTINGS: VaultSettings = {
  primaryNotesLocation: 'inbox',
  dailyNotes: {
    enabled: false,
    directory: DEFAULT_DAILY_NOTES_DIRECTORY,
    titlePattern: DEFAULT_DAILY_NOTE_TITLE_PATTERN,
    locale: DEFAULT_DAILY_NOTE_LOCALE,
    tasksDueOnNoteDate: true,
    rolloverUnfinishedTasks: false
  },
  weeklyNotes: {
    enabled: false,
    directory: DEFAULT_WEEKLY_NOTES_DIRECTORY,
    titlePattern: DEFAULT_WEEKLY_NOTE_TITLE_PATTERN,
    locale: DEFAULT_WEEKLY_NOTE_LOCALE
  },
  monthlyNotes: {
    enabled: false,
    directory: DEFAULT_MONTHLY_NOTES_DIRECTORY,
    titlePattern: DEFAULT_MONTHLY_NOTE_TITLE_PATTERN,
    locale: DEFAULT_MONTHLY_NOTE_LOCALE
  },
  folderIcons: {},
  folderColors: {},
  favorites: []
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
  /** Outbound asset-embed targets (`![[asset]]` / `![](asset)`), unique. Used to
   *  show which notes use a given asset in the Assets view. */
  assetEmbeds: string[]
  /** True when the body references at least one local non-text asset
   *  (PDF, image, audio, video, generic file). Surfaced in the sidebar
   *  as a small paperclip hint so attachments are discoverable. */
  hasAttachments: boolean
  /** First ~200 chars of the body stripped of markdown noise, for list previews. */
  excerpt: string
  /** True when this note's own directory entry is a symlink (the file itself
   *  is linked into the vault). Notes that merely live inside a symlinked
   *  folder are not flagged — the folder carries the marker instead. */
  isSymlink?: boolean
}

export interface ListNotesPageRequest {
  requestId: string
  offset: number
  chunkSize?: number
}

export interface ListNotesPageResponse {
  notes: NoteMeta[]
  nextOffset: number
  done: boolean
  total: number
}

export interface NoteContent extends NoteMeta {
  /** Raw markdown body including any frontmatter. */
  body: string
}

export interface NoteComment {
  id: string
  /** Path relative to the vault root for the note this comment belongs to. */
  notePath: string
  /** Zero-based editor offsets captured when the comment was created. */
  anchorStart: number
  anchorEnd: number
  /** Exact text selected when the comment was created. Used to re-anchor after edits. */
  anchorText: string
  body: string
  createdAt: number
  updatedAt: number
  resolvedAt: number | null
}

export interface NoteCommentInput {
  id?: string
  notePath: string
  anchorStart: number
  anchorEnd: number
  anchorText: string
  body: string
  createdAt?: number
  updatedAt?: number
  resolvedAt?: number | null
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

export interface DeletedAsset {
  /** Original vault-relative path before the asset was removed. */
  path: string
  /** Original file name. */
  name: string
  /** Opaque restore token returned by the desktop bridge. */
  undoToken: string
  /** ISO timestamp of when the asset was deleted (present for 2.11+ deletes). */
  deletedAt?: string
}

export interface ImportedAsset {
  /** File name stored under the vault-root attachments directory. */
  name: string
  /** Vault-relative path to the imported asset, POSIX-style. */
  path: string
  /** Markdown override to insert into the note. */
  markdown: string
  kind: ImportedAssetKind
}

export interface PastedImageInput {
  /** Raw image bytes copied from the clipboard. */
  data: ArrayBuffer | Uint8Array
  /** Browser-provided MIME type, for example `image/png`. */
  mimeType: string
  /** Optional clipboard/file name, when the source provides one. */
  suggestedName?: string | null
}

export interface VaultInfo {
  root: string
  name: string
}

/** A markdown file opened from outside any vault (standalone editor window). */
export interface ExternalFileContent {
  /** Absolute path on disk. */
  path: string
  /** File name including extension. */
  name: string
  /** Raw markdown body. */
  body: string
}

export interface MoveExternalFileResult {
  /** Vault root the file was moved into. */
  vaultRoot: string
  /** Vault-relative path of the moved note, POSIX-style. */
  relPath: string
}

export interface LocalVaultEntry extends VaultInfo {
  lastOpenedAt: number
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
  /** True when this folder's own directory entry is a symlink into the vault. */
  isSymlink?: boolean
}

export type VaultChangeKind = 'add' | 'change' | 'unlink'
export type VaultChangeScope = 'content' | 'vault-settings' | 'comments' | 'database' | 'folder'

export interface VaultChangeEvent {
  kind: VaultChangeKind
  path: string
  folder: NoteFolder
  scope?: VaultChangeScope
}
