import { create } from 'zustand'
import type { EditorView } from '@codemirror/view'
import {
  editorCursorPosition,
  type EditorCursorPosition
} from './lib/editor-cursor-position'
import { DEFAULT_VAULT_SETTINGS } from '@shared/ipc'
import {
  DEFAULT_HARPER_DIALECT,
  isHarperDialect,
  normalizeHarperLintConfig,
  type HarperDialect,
  type HarperLintConfig,
  type HarperVaultState
} from '@shared/harper-settings'
import { resolveFolderPath } from '@shared/system-folder-paths'
import { normalizeTasksExcludedFolder } from '@shared/tasks-excluded-folders'
import { cloudSyncPathKey } from '@zennotes/shared-domain/cloud-sync'
import { useCloudSyncStatusStore } from './lib/cloud-auto-sync'
import type {
  AssetMeta,
  DateNotePatternSettings,
  DeletedAsset,
  FolderEntry,
  LocalVaultEntry,
  NoteComment,
  NoteCommentInput,
  NoteContent,
  NoteFolder,
  NoteMeta,
  RemoteWorkspaceInfo,
  RemoteWorkspaceProfile,
  RemoteWorkspaceProfileInput,
  ServerCapabilities,
  VaultSettings,
  VaultViewSettings,
  VaultTextSearchBackendPreference,
  VaultChangeEvent,
  VaultInfo,
  WorkspaceMode
} from '@shared/ipc'
import type { VaultTask } from '@shared/tasks'
import {
  isExcalidrawPath,
  isObsidianExcalidrawMarkdown,
  isObsidianExcalidrawPath
} from '@shared/excalidraw'
import { TASKS_TAB_PATH, isTasksTabPath, parseTasksFromBody, toIsoDateLocal } from '@shared/tasks'
import {
  TYPST_PREAMBLE_FOLDER,
  isTypstPreamblePath,
  preambleKeyFromTitle,
  resolveTypstPreamble,
  resolveTypstPreambleFolder,
  type TypstPreambleNote
} from './lib/typst-preamble'
import { normalizeTypstPreambleFolder } from '@shared/typst-preamble-folder'
import {
  composeTaskFile,
  setTaskFileStatus,
  setTaskFileCancelled,
  setTaskFileInProgress,
  taskFilePriorityValue,
  updateFrontmatterFields
} from '@shared/frontmatter'
import type { DatabaseDoc, DatabaseSidecar } from '@shared/databases'
import {
  databaseTabPath,
  formTitleFromCsvPath,
  isDatabaseInternalPath,
  isDatabaseTabPath,
  isDatabaseCsvPath
} from '@shared/databases'
import { parseFrontmatter } from '@shared/template-files'
import { recordTitle, composePageBody } from './lib/database-cells'
import { applyManualMove, manualOrderCompare, parentDirOf } from './lib/manual-order'
import { TAGS_TAB_PATH, isTagsTabPath } from '@shared/tags'
import { WORKFLOWS_TAB_PATH, isWorkflowsTabPath } from '@shared/workflows-view'
import { ATLAS_TAB_PATH, isAtlasTabPath } from '@shared/atlas-view'
import { HELP_TAB_PATH, isHelpTabPath } from '@shared/help'
import { ARCHIVE_TAB_PATH, isArchiveTabPath } from '@shared/archive'
import { TRASH_TAB_PATH, isTrashTabPath } from '@shared/trash'
import { ASSETS_VIEW_TAB_PATH, isAssetsViewTabPath } from '@shared/assets-view'
import { QUICK_NOTES_TAB_PATH, isQuickNotesTabPath } from '@shared/quick-notes'
import { isAssetTabPath, assetPathFromTab, assetTabPath } from './lib/asset-tabs'
import {
  invalidateAllExcalidrawPreviews,
  invalidateExcalidrawPreview
} from './lib/excalidraw-preview'
import {
  FENCE_RE,
  TASK_LINE_RE,
  extractOpenTaskBlocks,
  forwardTaskSubtreeAtIndex,
  insertTasksUnderTasksHeading,
  moveTaskLine,
  removeTaskAtIndex,
  takeTaskLineAtIndex,
  setTaskCheckedAtIndex,
  setTaskDueAtIndex,
  setTaskCancelledAtIndex,
  setTaskInProgressAtIndex,
  setTaskPriorityAtIndex,
  setTaskFieldAtIndex,
  setTaskTextAtIndex,
  setTaskWaitingAtIndex,
  toggleTaskAtIndex,
  type TaskPriority as TaskLinePriority
} from '@shared/tasklists'
import { DEFAULT_THEME_ID, THEMES, type ThemeFamily, type ThemeMode } from './lib/themes'
import { isCustomThemeId } from './lib/custom-themes'
import { customThemeSlugFromId, type CustomTheme } from '@shared/custom-themes'
import type { Override } from '@shared/overrides'
import type { CustomCodeLanguage } from '@shared/custom-code-languages'
import { customCodeLanguageRegistry } from './lib/custom-code-languages'
import { formatMarkdown } from './lib/format-markdown'
import { confirmDeletePermanently, confirmMoveToTrash } from './lib/confirm-trash'
import { humanIpcError } from './lib/ipc-error'
import { deleteNotePermanently, moveNoteToTrash } from './lib/trash-note'
import { confirmApp } from './lib/confirm-requests'
import { pickServerDirectoryApp } from './lib/server-directory-picker-requests'
import { promptApp } from './lib/prompt-requests'
import {
  buildNoteDestinationPrompt,
  buildTemplateDestinationPrompt,
  parseTemplateDestination
} from './lib/move-note'
import type { KeymapId, KeymapOverrides } from './lib/keymaps'
import { normalizeKeymapOverrides } from './lib/keymaps'
import {
  PORTABLE_PREF_KEYS,
  pickPortablePrefs,
  defaultTimeFormat,
  type AppConfigPortable,
  type CompletedTaskStyle,
  type MathRenderer,
  type TimeFormat,
  type VimWrappedLineMotionMode
} from '@shared/app-config'
import {
  type LabelKey,
  type SystemFolderLabels,
  normalizeSystemFolderLabels
} from './lib/system-folder-labels'
import { recordRendererPerf } from './lib/perf'
import {
  initialWorkspaceRestoreContentPaths,
  isWorkspaceVirtualTabPath,
  workspaceRestorePrefetchContentPaths
} from './lib/workspace-tabs'
import {
  classifyDateNote,
  duplicateFolderColors,
  duplicateFolderIcons,
  dailyNoteLocationForDate,
  folderForVaultRelativePath,
  findDailyNoteForDate,
  findWeeklyNoteForDate,
  findMonthlyNoteForDate,
  noteTitleForDate,
  isPrimaryNotesAtRoot,
  removeFavoritesForFolder,
  removeFolderColors,
  removeFolderIcons,
  normalizeVaultSettings,
  noteFolderSubpath,
  resolveCreateLocation,
  rewriteFavoriteNotePath,
  rewriteFavoritesForFolderRename,
  toggleFavorite as toggleFavoriteKey,
  weeklyNoteLocationForDate,
  monthlyNoteLocationForDate,
  rewriteFolderColorsForRename,
  rewriteFolderIconsForRename
} from './lib/vault-layout'
import { releaseSelfKeyedSurfaceFocus } from './lib/self-keyed-surfaces'
import { renderTemplate, renderTitle } from './lib/template-render'
import type { NoteTemplate } from '@bridge-contract/templates'
import type { WorkflowRunReceipt, WorkflowUndoResult } from '@bridge-contract/workflows'
import { BUILTIN_TEMPLATES } from '@shared/builtin-templates'
import {
  composeTemplateFile,
  mergeTemplates,
  parseCustomTemplate,
  slugifyTemplateName
} from '@shared/template-files'
import { buildWorkflowIndex } from './lib/workflow-index'
import type { WorkflowIndexEntry } from './lib/workflow-index'
import {
  INITIAL_VISIBLE_NOTE_PREFETCH_BATCH_SIZE,
  selectInitialVisibleNotePrefetchPaths
} from './lib/note-prefetch'
import { retitleLeadingHeading } from './lib/note-heading-sync'
import type { Panel } from './lib/vim-nav'
import {
  allLeaves,
  findLeaf,
  findLeavesContaining,
  leafWithAddedTab,
  leafWithPinnedTab,
  leafWithPreviewTab,
  leafWithPromotedTab,
  leafWithReorderedTab,
  leafWithUnpinnedTab,
  leafWithoutTab,
  makeLeaf,
  mapLeaves,
  replaceLeaf,
  rewritePathsInTree,
  preserveLayoutIfPruneEmptiesNoteTabs,
  splitLeaf,
  updateLeaf,
  updateSplitSizes,
  nextPaneId,
  type PaneEdge,
  type PaneLayout,
  type PaneLeaf
} from './lib/pane-layout'
import {
  isPaneMode,
  paneModesWithPathMode,
  type PaneMode,
  type PaneModesByPath
} from './lib/pane-mode'
import {
  normalizeTextReplacements,
  type TextReplacements
} from './lib/cm-text-replacements'
import { normalizeEditorTabSize } from './lib/editor-tab-size'
import { recentNoteToggleTarget } from './lib/recent-note-toggle'

export type NoteSortOrder =
  | 'none'
  | 'manual'
  | 'updated-desc'
  | 'updated-asc'
  | 'created-desc'
  | 'created-asc'
  | 'name-asc'
  | 'name-desc'

/** Which column the Assets view sorts by, and in which direction. Stored as one
 *  `<column>-<dir>` string so it maps onto a single portable pref, the same
 *  shape as `NoteSortOrder`. (#473) */
export type AssetSortColumn = 'name' | 'used' | 'type' | 'size' | 'modified'
export type AssetSortOrder =
  | 'name-asc'
  | 'name-desc'
  | 'used-asc'
  | 'used-desc'
  | 'type-asc'
  | 'type-desc'
  | 'size-asc'
  | 'size-desc'
  | 'modified-asc'
  | 'modified-desc'

export type LineNumberMode = 'off' | 'absolute' | 'relative'

/** Where the line-number gutter sits when content is centered: glued to the
 *  left of the text column ('text', default) or pinned to the editor's far-left
 *  edge ('edge'). No visible effect when content is left-aligned. (#228) */
export type LineNumberPosition = 'edge' | 'text'
export type WhichKeyHintMode = 'timed' | 'sticky'
export type CommandPaletteInitialMode = 'main' | 'vault'

const PREFS_KEY = 'zen:prefs:v2'
const WORKSPACE_KEY = 'zen:workspace:v1'

/** Ask the active editor pane to reclaim keyboard focus. Dispatched as a DOM
 *  event (handled in App.tsx via `focusEditorNormalMode`) so the store doesn't
 *  have to import editor-focus, which imports the store. Used when a focused
 *  panel (Tasks/Tags) closes so typing lands in the editor again. (#353) */
function requestEditorFocus(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('zen:focus-editor'))
}
/** Debounce for mirroring the workspace snapshot to the synced vault file —
 *  localStorage updates immediately; the file lags to bound sync churn. (#292) */
const WORKSPACE_FILE_DEBOUNCE_MS = 1500
const VALID_FAMILIES: ThemeFamily[] = [
  'apple',
  'gruvbox',
  'catppuccin',
  'github',
  'solarized',
  'one',
  'nord',
  'tokyo-night',
  'kanagawa',
  'black-metal',
  'rose-pine',
  'custom'
]
const VALID_MODES: ThemeMode[] = ['light', 'dark', 'auto']
const VALID_SORTS: NoteSortOrder[] = [
  'none',
  'manual',
  'updated-desc',
  'updated-asc',
  'created-desc',
  'created-asc',
  'name-asc',
  'name-desc'
]
const VALID_ASSET_SORTS: AssetSortOrder[] = [
  'name-asc',
  'name-desc',
  'used-asc',
  'used-desc',
  'type-asc',
  'type-desc',
  'size-asc',
  'size-desc',
  'modified-asc',
  'modified-desc'
]
const VALID_LINE_NUMBER_MODES: LineNumberMode[] = ['off', 'absolute', 'relative']
const VALID_LINE_NUMBER_POSITIONS: LineNumberPosition[] = ['edge', 'text']
const VALID_WHICH_KEY_HINT_MODES: WhichKeyHintMode[] = ['timed', 'sticky']
const VALID_VAULT_TEXT_SEARCH_BACKENDS: VaultTextSearchBackendPreference[] = [
  'auto',
  'builtin',
  'ripgrep',
  'fzf'
]
const MAX_NOTE_JUMP_HISTORY = 100
const DEFAULT_SIDEBAR_WIDTH = 336
const LEGACY_DEFAULT_SIDEBAR_WIDTHS = new Set([232, 260, 288])
// Matches the desktop main process's own default/preferred stream chunk size
// (capped at 1000 there). 500 halves the number of boot-time IPC round-trips
// and inter-page yields for large vaults versus the old 250, while keeping each
// page small enough to stay responsive. Identical note set, fewer trips.
const LIST_NOTES_BRIDGE_PAGE_SIZE = 500

function nextRendererTask(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

async function listNotesFromBridge(): Promise<NoteMeta[]> {
  if (!window.zen.listNotesPage) return await window.zen.listNotes()

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const notes: NoteMeta[] = []
  let offset = 0

  for (;;) {
    const page = await window.zen.listNotesPage({
      requestId,
      offset,
      chunkSize: LIST_NOTES_BRIDGE_PAGE_SIZE
    })
    if (page.notes.length > 0) notes.push(...page.notes)
    if (page.done) return notes
    if (page.nextOffset <= offset) {
      throw new Error('listNotesPage returned a non-advancing offset')
    }
    offset = page.nextOffset
    await nextRendererTask()
  }
}

// Coalesce full note-list refreshes triggered by vault-change (watcher) events.
// A bulk external change — git pull, cloud sync, bulk move/import — fires one
// watcher event per file; routing each straight to refreshNotes() would re-walk
// the entire vault N times. This collapses a burst into a single in-flight
// refresh plus at most one trailing refresh, so the *final* state is identical
// (refreshNotes is idempotent) but the vault is listed once or twice, not N
// times. Isolated changes still refresh immediately with no added latency.
let coalescedNotesRefreshInFlight: Promise<void> | null = null
let coalescedNotesRefreshPending = false

/**
 * How to drop the vault watcher `init` installed, kept because `init` can run
 * more than once: `retryWorkspaceBoot` re-enters it deliberately, and every
 * re-entry that subscribed without disposing the previous one left a duplicate
 * IPC listener behind for the rest of the session.
 */
let vaultChangeUnsubscribe: (() => void) | null = null

function refreshNotesCoalesced(): Promise<void> {
  if (coalescedNotesRefreshInFlight) {
    coalescedNotesRefreshPending = true
    return coalescedNotesRefreshInFlight
  }
  coalescedNotesRefreshInFlight = (async () => {
    try {
      do {
        coalescedNotesRefreshPending = false
        await useStore.getState().refreshNotes()
      } while (coalescedNotesRefreshPending)
    } finally {
      coalescedNotesRefreshInFlight = null
    }
  })()
  return coalescedNotesRefreshInFlight
}

/** A note the user just created is for typing: with the Default view mode
 *  preference set to Preview, the fallback would open it read-only with no
 *  editor mounted, breaking the create-then-type flow (#543 follow-up).
 *  Remembering 'edit' for the new path wins over the fallback; a later
 *  explicit mode switch still overwrites it. Written straight into
 *  paneModes (not via setPaneModeForPath) so the pane's sticky mode is
 *  untouched, and skipped entirely when the default is already 'edit'. */
function rememberEditModeForCreatedNote(path: string): void {
  const s = useStore.getState()
  if (s.defaultPaneMode === 'edit') return
  useStore.setState((cur) => ({
    paneModes: {
      ...cur.paneModes,
      [cur.activePaneId]: paneModesWithPathMode(
        cur.paneModes[cur.activePaneId] ?? {},
        path,
        'edit'
      )
    }
  }))
}

async function refreshVaultIndexes(): Promise<void> {
  const state = useStore.getState()
  await Promise.all([
    state.refreshNotes(),
    state.refreshAssets(),
    state.loadCustomTemplates(),
    state.loadWorkflowIndex(),
    state.refreshRootContentHidden()
  ])
  // A run the app died in the middle of left changes nobody was told about,
  // and this is the first moment anyone is back to be told. Dynamically
  // imported (the module imports this one) and never awaited: nothing about
  // opening a vault waits on a message.
  void import('./lib/workflow-trigger')
    .then((mod) => mod.announceInterruptedWorkflowRun())
    .catch(() => {
      /* a message that cannot be raised is not a vault that failed to open */
    })
}

/** Find a template (built-in or custom) by id, or undefined if it's gone. */
function resolveTemplate(
  customTemplates: NoteTemplate[],
  id: string | undefined
): NoteTemplate | undefined {
  if (!id) return undefined
  return mergeTemplates(BUILTIN_TEMPLATES, customTemplates).find((t) => t.id === id)
}

function isDeletedAssetRecord(value: unknown): value is DeletedAsset {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.undoToken === 'string'
  )
}

/** Which weekday the calendar grid starts on. `locale` derives it from the
 *  user's locale (falling back to Monday). */
export type CalendarWeekStart = 'monday' | 'sunday' | 'locale'
const VALID_CALENDAR_WEEK_STARTS: CalendarWeekStart[] = ['monday', 'sunday', 'locale']

/** The editor-pane right-side panels whose width the user can drag-resize. */
export type RightPanelId = 'outline' | 'connections' | 'comments' | 'calendar'
export interface PanelWidths {
  outline: number
  connections: number
  comments: number
  calendar: number
}
export const MIN_RIGHT_PANEL_WIDTH = 200
export const MAX_RIGHT_PANEL_WIDTH = 640
export const DEFAULT_PANEL_WIDTHS: PanelWidths = {
  outline: 260,
  connections: 288,
  comments: 360,
  calendar: 280
}

function clampPanelWidth(px: number): number {
  return Math.min(MAX_RIGHT_PANEL_WIDTH, Math.max(MIN_RIGHT_PANEL_WIDTH, Math.round(px)))
}

function normalizePanelWidths(value: unknown): PanelWidths {
  const v = (value ?? {}) as Partial<Record<RightPanelId, unknown>>
  const pick = (key: RightPanelId): number =>
    typeof v[key] === 'number' ? clampPanelWidth(v[key] as number) : DEFAULT_PANEL_WIDTHS[key]
  return {
    outline: pick('outline'),
    connections: pick('connections'),
    comments: pick('comments'),
    calendar: pick('calendar')
  }
}

interface Prefs {
  vimMode: boolean
  /** Key sequence that exits insert mode (maps to <Esc>), e.g. "jk".
   *  Empty disables it. */
  vimInsertEscape: string
  /** When true, Vim yank/delete/change also copy to the system clipboard and
   *  `p` / `P` paste from it (like `set clipboard=unnamed`). */
  vimYankToClipboard: boolean
  /** Make the editor non-editable outside Vim insert mode so a CJK input
   *  method cannot compose over normal-mode keys (#84, #464). */
  vimBlockImeInNormalMode: boolean
  /** Whether unprefixed Vim line-boundary motions follow visible display rows
   *  or the complete logical line when word wrap is enabled. */
  vimWrappedLineMotions: VimWrappedLineMotionMode
  keymapOverrides: KeymapOverrides
  /** Enabled CSS overrides, keyed by filename (e.g. `"focus.css": "on"`). Persisted. */
  enabledOverrides: Record<string, string>
  /** Visual color tweaks from the picker UI, keyed by token slug (e.g. `"accent": "#ff3b30"`). Persisted. */
  themeTweaks: Record<string, string>
  /** When true, pressing the leader key shows the next available Vim-style actions. */
  whichKeyHints: boolean
  /** Whether leader hints auto-hide after a timeout or stay open until dismissed. */
  whichKeyHintMode: WhichKeyHintMode
  /** How long the leader hint overlay and pending leader sequence stay visible/armed. */
  whichKeyHintTimeoutMs: number
  /** Which engine powers vault-wide text search. */
  vaultTextSearchBackend: VaultTextSearchBackendPreference
  /** Optional explicit binary path for ripgrep. Blank uses PATH lookup. */
  ripgrepBinaryPath: string | null
  /** Optional explicit binary path for fzf. Blank uses PATH lookup. */
  fzfBinaryPath: string | null
  livePreview: boolean      // hide markdown syntax on inactive lines
  /** Show an H1 through H6 badge before Markdown headings in the editor. */
  showHeadingLevelLabels: boolean
  /** Vertical guide lines at each nested-list level in the editor (#491). */
  listIndentGuides: boolean
  /** Render Markdown tables as interactive WYSIWYG widgets in live preview.
   *  Off keeps tables as plain editable markdown — full keyboard/Vim editing. */
  renderTablesInLivePreview: boolean
  /** How a completed task's text is styled (strike / gray / both / none) in the
   *  editor and preview. Applied via `html[data-completed-task-style]`. */
  completedTaskStyle: CompletedTaskStyle
  /** Typesetter for `$…$` / `$$…$$` math (KaTeX or Typst), in both the editor
   *  live preview and the reading view. */
  mathRenderer: MathRenderer
  /** Prepend Typst definitions to a note's formulas based on its tags (#486). */
  typstTagPreambles: boolean
  /** Grammar and spelling with Harper, checked on this device. Off by default. */
  harperEnabled: boolean
  harperDialect: HarperDialect
  /** Per-rule Harper overrides; empty means Harper's defaults. Kept on the
   *  device (not in config.toml) until the rules have a settings surface. */
  harperLintConfig: HarperLintConfig
  /** Relax `$$…$$` display math so prose before the open fence (`Note: $$…$$`)
   *  or after the close fence (`$$…$$ done`) still renders in the reading view.
   *  Off by default; the editor keeps showing source for those shapes. */
  looseMathDelimiters: boolean
  /** Keep the current view mode (Edit / Split / Preview) when switching notes
   *  instead of resolving each note's own last mode. Off = per-note (default). */
  keepViewModeAcrossNotes: boolean
  /** The mode a note opens in before the user has picked one for it: Edit
   *  (default), Split, or Preview for read-first workflows. (#543) */
  defaultPaneMode: PaneMode
  /** Renaming a note also rewrites its leading `# Heading` to the new title,
   *  so the title line stops drifting from the filename. Never adds a heading
   *  to a note that has none. (#455) */
  syncTitleHeadingOnRename: boolean
  /** Auto-close markdown delimiters while typing: `**`+Space → `**|**`,
   *  ```` ``` ````+Enter expands a fenced block. Off restores plain typing. */
  markdownSnippets: boolean
  /** Expand user-defined text triggers while typing. */
  textReplacementsEnabled: boolean
  /** Trigger to replacement mappings, such as `->` to `→`. */
  textReplacements: TextReplacements
  /** Auto-insert matching `[]`, `()`, and `{}` delimiters while typing. */
  autoPairs: boolean
  /** Also auto-insert matching quotes outside Markdown code spans and blocks. */
  autoPairQuotesInProse: boolean
  hideBuiltinTemplates: boolean // hide shipped built-in templates from the pickers
  tabsEnabled: boolean
  wrapTabs: boolean
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  editorFontSize: number    // px — affects editor + preview
  mathFontScale: number     // percent — inline + block math, both renderers (#623)
  editorLineHeight: number  // unitless multiplier
  editorTabSize: number     // columns used to render and indent a tab
  editorScrollOff: number   // vim scrolloff — lines kept above/below the cursor (0 = off)
  timeFormat: TimeFormat    // clock format for the @time macro
  previewMaxWidth: number   // px — max reading width for preview surfaces
  lineNumberMode: LineNumberMode
  lineNumberPosition: LineNumberPosition
  /** Whether note-list/view prefs (sort, grouping, tasks view, …) apply the
   *  same everywhere ('global') or independently per vault ('vault'). (#292) */
  viewSettingsScope: 'global' | 'vault'
  /** Export PDFs using the current theme (colors + dark/light, incl. custom
   *  themes) instead of the default clean light-for-print theme. */
  pdfExportUseTheme: boolean
  /** Font used by the whole app chrome (sidebar, menus, title bar). */
  interfaceFont: string | null
  /** Font used inside the editor + preview content. */
  textFont: string | null
  /** Font used for inline code + fenced code blocks + frontmatter. */
  monoFont: string | null
  /** Optional display-only label overrides for the built-in top-level folders. */
  systemFolderLabels: SystemFolderLabels
  sidebarWidth: number
  noteListWidth: number
  noteSortOrder: NoteSortOrder
  /** Sort column + direction for the Assets view, kept across visits. (#473) */
  assetSortOrder: AssetSortOrder
  groupByKind: boolean
  /** Auto-expand the sidebar tree to reveal the currently open note. */
  autoReveal: boolean
  /** Collapse the dedicated note list column and render notes inside
   *  the sidebar tree (Obsidian "File Explorer" layout). */
  unifiedSidebar: boolean
  /** Tint the sidebar surface a step darker than the main canvas. */
  darkSidebar: boolean
  /** Show disclosure arrows for collapsible sidebar folders and sections. */
  showSidebarChevrons: boolean
  /** Keys of collapsed folders in the sidebar tree. */
  collapsedFolders: string[]
  /** Pinned reference pane — an always-visible companion note panel
   *  for research / drafting. Stored at the prefs layer so pins
   *  survive app restarts. */
  pinnedRefPath: string | null
  pinnedRefVisible: boolean
  pinnedRefWidth: number
  panelWidths: PanelWidths
  pinnedRefMode: 'edit' | 'preview'
  /** When true, "New Quick Note" auto-titles to today's date
   *  (YYYY-MM-DD), appending " (2)", " (3)" etc. for collisions. */
  quickNoteDateTitle: boolean
  /** Optional prefix used for new Quick Note titles. Blank falls back
   *  to a bare timestamp/date. */
  quickNoteTitlePrefix: string | null
  /** When true, long lines wrap inside the editor. When false they
   *  scroll horizontally — same as a coding editor's "Word Wrap". */
  wordWrap: boolean
  /** When false the editor caret (and the Vim block cursor) stay solid
   *  instead of blinking. */
  cursorBlink: boolean
  /** Ctrl+D / Ctrl+U half-page scroll in preview mode. When true the
   *  jumps animate; when false they snap instantly. Vim users often
   *  prefer the instant flavor because it keeps the position
   *  predictable. */
  previewSmoothScroll: boolean
  /** Max width (px) for the editor's content column. */
  editorMaxWidth: number
  /** Inline PDF embeds in the live-preview editor render compact by
   *  default (the same card the reference pane uses); set to 'full'
   *  to get an inline iframe of the PDF inside the editor. */
  pdfEmbedInEditMode: 'compact' | 'full'
  /** What the pinned reference points at — a markdown note (loaded
   *  into the editor) or a non-text asset like a PDF (loaded into an
   *  iframe). Defaults to 'note'. */
  pinnedRefKind: 'note' | 'asset'

  /** Per-note reference pins. Keyed by the note's vault-relative path.
   *  When the active note has an entry here it overrides the global
   *  pinned reference — switching notes hides it; coming back shows
   *  it again. */
  noteRefs: Record<string, { path: string; kind: 'note' | 'asset' }>
  /** Whether the editor and preview content sit centered (with the
   *  width capped) or are left-aligned to the pane edge. */
  contentAlign: 'center' | 'left'
  /** Sidebar Tags section collapsed — keeps the tag pills hidden
   *  without removing the section entirely. */
  tagsCollapsed: boolean
  /** Show `/`-separated tags as a collapsible tree (sidebar + Tags view)
   *  instead of a flat list. Degrades to a flat list when no tag nests. (#439) */
  nestedTags: boolean
  /** Master switch for the Workflows feature. Off hides the `zen://workflows`
   *  view together with every way in (sidebar row, command, leader binding) and
   *  closes any tab already showing it. OFF by default, deliberately: it can
   *  rewrite notes in bulk, so it is a one-time opt-in under Settings. */
  workflowsEnabled: boolean
  atlasEnabled: boolean
  /** Built-in workflow recipes hidden from the gallery, by preset id. Unknown
   *  ids are kept rather than pruned, so hiding a preset survives the preset
   *  itself being renamed away and back across versions. */
  hiddenWorkflowPresets: string[]
  /** Full paths of collapsed nodes in the nested-tag tree. */
  collapsedTagNodes: string[]
  /** Auto-show the calendar panel when the active note is a daily or
   *  weekly note. Persisted. */
  autoCalendarPanel: boolean
  /** Which weekday the calendar grid starts on. Persisted. */
  calendarWeekStart: CalendarWeekStart
  /** Show the ISO week-number column in the calendar. Persisted. */
  calendarShowWeekNumbers: boolean
  /** Last selected view inside the Tasks tab. List is the v1 default. */
  tasksViewMode: TasksViewMode
  /** Keep tasks from archived notes on the Tasks surfaces. Off by default:
   *  archiving a note retires its tasks from the list, boards, and calendars
   *  (the markdown is untouched; un-archiving brings them back). (#540) */
  showArchivedTasks: boolean
  /** Column source used when the Tasks Kanban view is active. */
  kanbanGroupBy: KanbanGroupBy
  /** Display-only Kanban column title overrides. Keyed by `${groupBy}:${columnId}`. */
  kanbanColumnTitles: Record<string, string>
  /** Manual Kanban column arrangement per board. Keyed by groupBy → ordered
   *  column ids; unlisted columns fall to the end in their built order. */
  kanbanColumnOrder: Record<string, string[]>
  /** Manual card arrangement inside Kanban columns. Keyed by
   *  `${groupBy}:${columnId}` → ordered task identity keys
   *  (`${sourcePath}\0${taskIndex}`). Listed cards sort first, unlisted ones
   *  keep their built order after them, so entries whose task moved or vanished
   *  decay toward the default sort instead of misplacing cards. */
  kanbanCardOrder: Record<string, string[]>
  /** Ordered status ids for the custom-status Kanban board (group-by "custom").
   *  Each id matches an inline `@status:<id>` task token. Config-driven. (#354) */
  kanbanStatuses: string[]
  /** True once the user has dismissed the first-run onboarding wizard. */
  hasCompletedOnboarding: boolean
}

export type TasksViewMode = 'list' | 'calendar' | 'kanban'
export type KanbanGroupBy = 'status' | 'priority' | 'folder' | `field:${string}`
/** How the Tags view combines multiple selected tags: `all` = intersection
 *  (AND, narrows), `any` = union (OR, widens). */
export type TagMatchMode = 'all' | 'any'

export type TaskMutation =
  | { kind: 'set-checked'; checked: boolean }
  | { kind: 'set-waiting'; waiting: boolean }
  | { kind: 'set-in-progress'; inProgress: boolean }
  | { kind: 'set-priority'; priority: TaskLinePriority | null }
  | { kind: 'set-due'; due: string | null }
  | { kind: 'set-field'; key: string; value: string | null }
  | { kind: 'set-text'; text: string }

type AssetUndoEntry = { kind: 'delete-asset'; deleted: DeletedAsset; createdAt: number }
type ClosedTabEntry = {
  paneId: string
  path: string
  index: number
  pinned: boolean
}

const VALID_TASKS_VIEW_MODES: TasksViewMode[] = ['list', 'calendar', 'kanban']
// The static, always-present group-bys. Field group-bys (`field:<key>`) are
// dynamic and validated by shape. Column-title overrides only apply to these
// static boards.
const STATIC_KANBAN_GROUP_BYS = ['status', 'priority', 'folder'] as const
const FIELD_GROUP_BY_RE = /^field:[a-z][a-z0-9_-]*$/

export function isKanbanGroupBy(value: unknown): value is KanbanGroupBy {
  return (
    value === 'status' ||
    value === 'priority' ||
    value === 'folder' ||
    (typeof value === 'string' && FIELD_GROUP_BY_RE.test(value))
  )
}

/** Coerce a persisted group-by, migrating the pre-release `custom` id to
 *  `field:status`. Falls back to `status`. */
export function normalizeKanbanGroupBy(raw: unknown): KanbanGroupBy {
  if (raw === 'custom') return 'field:status'
  return isKanbanGroupBy(raw) ? raw : 'status'
}
const MAX_KANBAN_STATUSES = 24
const MAX_KANBAN_STATUS_ID_LENGTH = 32
const MAX_KANBAN_COLUMN_TITLE_LENGTH = 48
const MAX_ASSET_UNDO_STACK = 20
const MAX_CLOSED_TAB_STACK = 50

function normalizeKanbanColumnTitle(title: string): string | null {
  const normalized = title.trim().replace(/\s+/g, ' ').slice(0, MAX_KANBAN_COLUMN_TITLE_LENGTH)
  return normalized.length > 0 ? normalized : null
}

// A static-board column-title key is `<status|priority|folder>:<columnId>`; a
// field-board one is `field:<key>:<value>` (two colons). Accept both so inline
// column renames survive a config round-trip on every board. The field-value
// part also accepts the `__none__` sentinel (NO_VALUE_COLUMN_ID in
// TasksKanban) so renaming the "No <field>" bucket persists too — its underscore
// prefix would otherwise fail the value grammar and get silently dropped. (#389)
const STATIC_COLUMN_TITLE_KEY_RE = /^[a-z-]+:[A-Za-z0-9_-]+$/
const FIELD_COLUMN_TITLE_KEY_RE = /^field:[a-z][a-z0-9_-]*:(?:__none__|[\p{L}\d][\p{L}\d/_-]*)$/u

function normalizeKanbanColumnTitles(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}

  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue
    const isStatic =
      STATIC_COLUMN_TITLE_KEY_RE.test(key) &&
      STATIC_KANBAN_GROUP_BYS.some((group) => key.startsWith(`${group}:`))
    const isField = FIELD_COLUMN_TITLE_KEY_RE.test(key)
    if (!isStatic && !isField) continue
    const normalized = normalizeKanbanColumnTitle(value)
    if (normalized) out[key] = normalized
  }
  return out
}

const MAX_KANBAN_ORDERED_COLUMNS = 64

// Manual column arrangement per board: `{ "<groupBy>": ["<columnId>", ...] }`.
// Column ids are validated loosely (the same tag-like slugs the boards use);
// unknown ids are dropped so a stale order can't resurrect vanished columns.
function normalizeKanbanColumnOrder(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string[]> = {}
  for (const [group, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isKanbanGroupBy(group) || !Array.isArray(value)) continue
    const ids: string[] = []
    const seen = new Set<string>()
    for (const entry of value) {
      if (typeof entry !== 'string') continue
      const id = entry.trim().slice(0, MAX_KANBAN_STATUS_ID_LENGTH)
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
      if (ids.length >= MAX_KANBAN_ORDERED_COLUMNS) break
    }
    if (ids.length) out[group] = ids
  }
  return out
}

const MAX_KANBAN_CARD_ORDER_COLUMNS = 64
const MAX_KANBAN_CARD_ORDER_CARDS = 512
const MAX_TASK_IDENTITY_KEY_LENGTH = 1024

// Manual card arrangement inside Kanban columns:
// `{ "<groupBy>:<columnId>": ["<sourcePath>\0<taskIndex>", ...] }`. Column keys
// share the column-title key grammar; card entries are opaque task identity
// keys (note paths are free-form, so only length is validated). Entries that no
// longer match a task are harmless: replay ranks listed cards first and leaves
// the rest in built order, so stale entries decay instead of misplacing cards.
export function normalizeKanbanCardOrder(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string[]> = {}
  let columns = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const isStatic =
      STATIC_COLUMN_TITLE_KEY_RE.test(key) &&
      STATIC_KANBAN_GROUP_BYS.some((group) => key.startsWith(`${group}:`))
    const isField = FIELD_COLUMN_TITLE_KEY_RE.test(key)
    if (!isStatic && !isField) continue
    const cards: string[] = []
    const seen = new Set<string>()
    for (const entry of value) {
      if (typeof entry !== 'string') continue
      if (!entry || entry.length > MAX_TASK_IDENTITY_KEY_LENGTH || seen.has(entry)) continue
      seen.add(entry)
      cards.push(entry)
      if (cards.length >= MAX_KANBAN_CARD_ORDER_CARDS) break
    }
    if (!cards.length) continue
    out[key] = cards
    columns += 1
    if (columns >= MAX_KANBAN_CARD_ORDER_COLUMNS) break
  }
  return out
}

// A status id is a tag-like slug, matching the `@status:<id>` grammar the task
// parser accepts (see INLINE_STATUS_RE). Lower-cased, de-duplicated, capped. (#354)
const KANBAN_STATUS_ID_RE = /^[\p{L}\d][\p{L}\d/_-]*$/u

/** A workflow run as the Workflows view reports and remembers it. */
export interface WorkflowRunRecord {
  /** The workflow it belongs to, so it is never shown over a different graph. */
  workflowId: string
  receipt: WorkflowRunReceipt
  /** Set once undone. The record stays; the offer to undo it does not. */
  undone: WorkflowUndoResult | null
  /** An undo that failed must not read as one that worked. */
  undoError: string | null
}

/** Hidden gallery preset ids: strings, trimmed, deduped, order kept. Unknown
 *  ids survive on purpose (see the Prefs doc); the cap is a config-file
 *  hygiene bound, far above the built-in count. */
export function normalizeHiddenWorkflowPresets(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= 64) break
  }
  return out
}

export function normalizeKanbanStatuses(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const id = entry.trim().toLowerCase().slice(0, MAX_KANBAN_STATUS_ID_LENGTH)
    if (!KANBAN_STATUS_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_KANBAN_STATUSES) break
  }
  return out
}

/**
 * Build the store patch that overlays a vault's per-vault view overrides (#292)
 * onto the view prefs. Unset/invalid keys are omitted, so the live (global)
 * value is kept for them. Applied on every vault open.
 */
export function viewPrefsFromVault(settings: VaultSettings | null | undefined): Partial<Store> {
  const v = settings?.view
  if (!v || typeof v !== 'object') return {}
  const patch: Partial<Store> = {}
  if (typeof v.noteSortOrder === 'string' && VALID_SORTS.includes(v.noteSortOrder as NoteSortOrder)) {
    patch.noteSortOrder = v.noteSortOrder as NoteSortOrder
  }
  if (
    typeof v.assetSortOrder === 'string' &&
    VALID_ASSET_SORTS.includes(v.assetSortOrder as AssetSortOrder)
  ) {
    patch.assetSortOrder = v.assetSortOrder as AssetSortOrder
  }
  if (typeof v.groupByKind === 'boolean') patch.groupByKind = v.groupByKind
  if (
    typeof v.tasksViewMode === 'string' &&
    VALID_TASKS_VIEW_MODES.includes(v.tasksViewMode as TasksViewMode)
  ) {
    patch.tasksViewMode = v.tasksViewMode as TasksViewMode
  }
  if (
    typeof v.kanbanGroupBy === 'string' &&
    (isKanbanGroupBy(v.kanbanGroupBy) || v.kanbanGroupBy === 'custom')
  ) {
    patch.kanbanGroupBy = normalizeKanbanGroupBy(v.kanbanGroupBy)
  }
  if (v.kanbanColumnTitles && typeof v.kanbanColumnTitles === 'object') {
    patch.kanbanColumnTitles = normalizeKanbanColumnTitles(v.kanbanColumnTitles)
  }
  if (v.kanbanColumnOrder && typeof v.kanbanColumnOrder === 'object') {
    patch.kanbanColumnOrder = normalizeKanbanColumnOrder(v.kanbanColumnOrder)
  }
  if (v.kanbanCardOrder && typeof v.kanbanCardOrder === 'object') {
    patch.kanbanCardOrder = normalizeKanbanCardOrder(v.kanbanCardOrder)
  }
  if (Array.isArray(v.kanbanStatuses)) {
    patch.kanbanStatuses = normalizeKanbanStatuses(v.kanbanStatuses)
  }
  if (typeof v.autoReveal === 'boolean') patch.autoReveal = v.autoReveal
  if (v.systemFolderLabels && typeof v.systemFolderLabels === 'object') {
    patch.systemFolderLabels = normalizeSystemFolderLabels(v.systemFolderLabels)
  }
  if (typeof v.unifiedSidebar === 'boolean') patch.unifiedSidebar = v.unifiedSidebar
  return patch
}

let viewPersistTimer: ReturnType<typeof setTimeout> | null = null
let pendingViewPatch: VaultViewSettings = {}

/** Persist a view-pref change to the CURRENT vault's `vault.json` `view` block
 *  (debounced + coalesced) so the choice is per-vault. The global pref keeps
 *  being written too (it's the floating default for vaults with no override). (#292) */
function persistVaultViewOverride(patch: VaultViewSettings): void {
  // Only persist per-vault when the user opted into per-vault scope; in 'global'
  // scope those setters keep writing the global config only. (#292)
  if (useStore.getState().viewSettingsScope !== 'vault') return
  pendingViewPatch = { ...pendingViewPatch, ...patch }
  if (viewPersistTimer) clearTimeout(viewPersistTimer)
  viewPersistTimer = setTimeout(() => {
    viewPersistTimer = null
    const toApply = pendingViewPatch
    pendingViewPatch = {}
    const current = useStore.getState().vaultSettings
    void useStore.getState().setVaultSettings({
      ...current,
      view: { ...(current.view ?? {}), ...toApply }
    })
  }, 400)
}

export const DEFAULT_PREFS: Prefs = {
  vimMode: true,
  vimInsertEscape: '',
  vimYankToClipboard: false,
  vimBlockImeInNormalMode: true,
  vimWrappedLineMotions: 'display',
  keymapOverrides: {},
  whichKeyHints: true,
  whichKeyHintMode: 'timed',
  whichKeyHintTimeoutMs: 900,
  vaultTextSearchBackend: 'auto',
  ripgrepBinaryPath: null,
  fzfBinaryPath: null,
  livePreview: true,
  showHeadingLevelLabels: false,
  listIndentGuides: true,
  renderTablesInLivePreview: true,
  completedTaskStyle: 'none',
  mathRenderer: 'katex',
  typstTagPreambles: false,
  harperEnabled: false,
  harperDialect: DEFAULT_HARPER_DIALECT,
  harperLintConfig: {},
  looseMathDelimiters: false,
  keepViewModeAcrossNotes: false,
  defaultPaneMode: 'edit',
  syncTitleHeadingOnRename: true,
  markdownSnippets: true,
  textReplacementsEnabled: true,
  textReplacements: { '->': '→' },
  autoPairs: true,
  autoPairQuotesInProse: false,
  hideBuiltinTemplates: false,
  tabsEnabled: true,
  wrapTabs: false,
  themeId: DEFAULT_THEME_ID,
  themeFamily: 'gruvbox',
  themeMode: 'dark',
  enabledOverrides: {},
  themeTweaks: {},
  editorFontSize: 16,
  mathFontScale: 100,
  editorLineHeight: 1.7,
  editorTabSize: 4,
  editorScrollOff: 0,
  timeFormat: defaultTimeFormat(),
  previewMaxWidth: 920,
  lineNumberMode: 'off',
  lineNumberPosition: 'text',
  viewSettingsScope: 'global',
  pdfExportUseTheme: false,
  // Leave all font slots on the built-in "Default" path. That lets the
  // shipped CSS fallbacks choose sensible system fonts on each machine
  // instead of forcing a specific family that may not exist.
  interfaceFont: null,
  textFont: null,
  monoFont: null,
  systemFolderLabels: {},
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  noteListWidth: 300,
  noteSortOrder: 'none',
  assetSortOrder: 'name-asc',
  groupByKind: true,
  autoReveal: false,
  unifiedSidebar: true,
  darkSidebar: true,
  showSidebarChevrons: true,
  collapsedFolders: [],
  pinnedRefPath: null,
  pinnedRefVisible: true,
  pinnedRefWidth: 420,
  panelWidths: DEFAULT_PANEL_WIDTHS,
  pinnedRefMode: 'edit',
  quickNoteDateTitle: false,
  quickNoteTitlePrefix: 'Quick Note',
  wordWrap: true,
  cursorBlink: true,
  previewSmoothScroll: true,
  editorMaxWidth: 920,
  pdfEmbedInEditMode: 'compact',
  pinnedRefKind: 'note',
  noteRefs: {},
  contentAlign: 'center',
  tagsCollapsed: false,
  nestedTags: true,
  // Off by default, deliberately: workflows can rewrite notes in bulk, and the
  // graph editor asks more of a new user than any other view. The feature is
  // opted into once in Settings -> Workflows, not stumbled into.
  workflowsEnabled: false,
  atlasEnabled: true,
  hiddenWorkflowPresets: [],
  collapsedTagNodes: [],
  autoCalendarPanel: true,
  calendarWeekStart: 'monday',
  calendarShowWeekNumbers: true,
  tasksViewMode: 'list',
  showArchivedTasks: false,
  kanbanGroupBy: 'status',
  kanbanColumnTitles: {},
  kanbanColumnOrder: {},
  kanbanCardOrder: {},
  kanbanStatuses: [],
  hasCompletedOnboarding: false
}
/** Coerce any loaded prefs blob into a valid Prefs object, dropping
 *  anything unknown (e.g. tokyo-night left over from earlier versions). */
function normalizePrefs(p: Partial<Prefs>): Prefs {
  const themeFamily: ThemeFamily =
    p.themeFamily && VALID_FAMILIES.includes(p.themeFamily)
      ? p.themeFamily
      : DEFAULT_PREFS.themeFamily
  const themeMode: ThemeMode =
    p.themeMode && VALID_MODES.includes(p.themeMode)
      ? p.themeMode
      : DEFAULT_PREFS.themeMode
  const themeId =
    p.themeId && (THEMES.some((t) => t.id === p.themeId) || isCustomThemeId(p.themeId))
      ? p.themeId
      : DEFAULT_PREFS.themeId
  return {
    vimMode: typeof p.vimMode === 'boolean' ? p.vimMode : DEFAULT_PREFS.vimMode,
    vimInsertEscape:
      typeof p.vimInsertEscape === 'string'
        ? p.vimInsertEscape.trim().slice(0, 5)
        : DEFAULT_PREFS.vimInsertEscape,
    vimYankToClipboard:
      typeof p.vimYankToClipboard === 'boolean'
        ? p.vimYankToClipboard
        : DEFAULT_PREFS.vimYankToClipboard,
    vimBlockImeInNormalMode:
      typeof p.vimBlockImeInNormalMode === 'boolean'
        ? p.vimBlockImeInNormalMode
        : DEFAULT_PREFS.vimBlockImeInNormalMode,
    vimWrappedLineMotions:
      p.vimWrappedLineMotions === 'logical' || p.vimWrappedLineMotions === 'display'
        ? p.vimWrappedLineMotions
        : DEFAULT_PREFS.vimWrappedLineMotions,
    keymapOverrides: normalizeKeymapOverrides(p.keymapOverrides),
    enabledOverrides: normalizeEnabledOverrides(p.enabledOverrides),
    themeTweaks: normalizeThemeTweaks(p.themeTweaks),
    whichKeyHints:
      typeof p.whichKeyHints === 'boolean'
        ? p.whichKeyHints
        : DEFAULT_PREFS.whichKeyHints,
    whichKeyHintMode:
      p.whichKeyHintMode && VALID_WHICH_KEY_HINT_MODES.includes(p.whichKeyHintMode)
        ? p.whichKeyHintMode
        : DEFAULT_PREFS.whichKeyHintMode,
    whichKeyHintTimeoutMs:
      typeof p.whichKeyHintTimeoutMs === 'number'
        ? Math.min(3000, Math.max(400, Math.round(p.whichKeyHintTimeoutMs)))
        : DEFAULT_PREFS.whichKeyHintTimeoutMs,
    vaultTextSearchBackend:
      p.vaultTextSearchBackend &&
      VALID_VAULT_TEXT_SEARCH_BACKENDS.includes(p.vaultTextSearchBackend)
        ? p.vaultTextSearchBackend
        : DEFAULT_PREFS.vaultTextSearchBackend,
    ripgrepBinaryPath:
      typeof p.ripgrepBinaryPath === 'string' || p.ripgrepBinaryPath === null
        ? (p.ripgrepBinaryPath as string | null)
        : DEFAULT_PREFS.ripgrepBinaryPath,
    fzfBinaryPath:
      typeof p.fzfBinaryPath === 'string' || p.fzfBinaryPath === null
        ? (p.fzfBinaryPath as string | null)
        : DEFAULT_PREFS.fzfBinaryPath,
    livePreview:
      typeof p.livePreview === 'boolean' ? p.livePreview : DEFAULT_PREFS.livePreview,
    showHeadingLevelLabels:
      typeof p.showHeadingLevelLabels === 'boolean'
        ? p.showHeadingLevelLabels
        : DEFAULT_PREFS.showHeadingLevelLabels,
    listIndentGuides:
      typeof p.listIndentGuides === 'boolean'
        ? p.listIndentGuides
        : DEFAULT_PREFS.listIndentGuides,
    renderTablesInLivePreview:
      typeof p.renderTablesInLivePreview === 'boolean'
        ? p.renderTablesInLivePreview
        : DEFAULT_PREFS.renderTablesInLivePreview,
    completedTaskStyle:
      p.completedTaskStyle === 'strikethrough' ||
      p.completedTaskStyle === 'gray' ||
      p.completedTaskStyle === 'gray-strikethrough' ||
      p.completedTaskStyle === 'none'
        ? p.completedTaskStyle
        : DEFAULT_PREFS.completedTaskStyle,
    mathRenderer:
      p.mathRenderer === 'typst' || p.mathRenderer === 'katex'
        ? p.mathRenderer
        : DEFAULT_PREFS.mathRenderer,
    typstTagPreambles:
      typeof p.typstTagPreambles === 'boolean'
        ? p.typstTagPreambles
        : DEFAULT_PREFS.typstTagPreambles,
    harperEnabled:
      typeof p.harperEnabled === 'boolean' ? p.harperEnabled : DEFAULT_PREFS.harperEnabled,
    harperDialect: isHarperDialect(p.harperDialect) ? p.harperDialect : DEFAULT_PREFS.harperDialect,
    harperLintConfig: normalizeHarperLintConfig(p.harperLintConfig),
    looseMathDelimiters:
      typeof p.looseMathDelimiters === 'boolean'
        ? p.looseMathDelimiters
        : DEFAULT_PREFS.looseMathDelimiters,
    keepViewModeAcrossNotes:
      typeof p.keepViewModeAcrossNotes === 'boolean'
        ? p.keepViewModeAcrossNotes
        : DEFAULT_PREFS.keepViewModeAcrossNotes,
    defaultPaneMode: isPaneMode(p.defaultPaneMode) ? p.defaultPaneMode : DEFAULT_PREFS.defaultPaneMode,
    syncTitleHeadingOnRename:
      typeof p.syncTitleHeadingOnRename === 'boolean'
        ? p.syncTitleHeadingOnRename
        : DEFAULT_PREFS.syncTitleHeadingOnRename,
    markdownSnippets:
      typeof p.markdownSnippets === 'boolean'
        ? p.markdownSnippets
        : DEFAULT_PREFS.markdownSnippets,
    textReplacementsEnabled:
      typeof p.textReplacementsEnabled === 'boolean'
        ? p.textReplacementsEnabled
        : DEFAULT_PREFS.textReplacementsEnabled,
    textReplacements: normalizeTextReplacements(
      p.textReplacements ?? DEFAULT_PREFS.textReplacements
    ),
    autoPairs: typeof p.autoPairs === 'boolean' ? p.autoPairs : DEFAULT_PREFS.autoPairs,
    autoPairQuotesInProse:
      typeof p.autoPairQuotesInProse === 'boolean'
        ? p.autoPairQuotesInProse
        : DEFAULT_PREFS.autoPairQuotesInProse,
    hideBuiltinTemplates:
      typeof p.hideBuiltinTemplates === 'boolean'
        ? p.hideBuiltinTemplates
        : DEFAULT_PREFS.hideBuiltinTemplates,
    tabsEnabled:
      typeof p.tabsEnabled === 'boolean' ? p.tabsEnabled : DEFAULT_PREFS.tabsEnabled,
    wrapTabs:
      typeof p.wrapTabs === 'boolean' ? p.wrapTabs : DEFAULT_PREFS.wrapTabs,
    themeId,
    themeFamily,
    themeMode,
    editorFontSize:
      typeof p.editorFontSize === 'number'
        ? p.editorFontSize
        : DEFAULT_PREFS.editorFontSize,
    mathFontScale:
      typeof p.mathFontScale === 'number' && Number.isFinite(p.mathFontScale)
        ? Math.min(200, Math.max(50, Math.round(p.mathFontScale)))
        : DEFAULT_PREFS.mathFontScale,
    editorLineHeight:
      typeof p.editorLineHeight === 'number'
        ? p.editorLineHeight
        : DEFAULT_PREFS.editorLineHeight,
    editorTabSize: normalizeEditorTabSize(p.editorTabSize),
    editorScrollOff:
      typeof p.editorScrollOff === 'number' && p.editorScrollOff >= 0
        ? Math.floor(p.editorScrollOff)
        : DEFAULT_PREFS.editorScrollOff,
    timeFormat:
      p.timeFormat === '12h' || p.timeFormat === '24h'
        ? p.timeFormat
        : DEFAULT_PREFS.timeFormat,
    previewMaxWidth:
      typeof p.previewMaxWidth === 'number'
        ? Math.min(1600, Math.max(640, p.previewMaxWidth))
        : DEFAULT_PREFS.previewMaxWidth,
    lineNumberMode:
      p.lineNumberMode && VALID_LINE_NUMBER_MODES.includes(p.lineNumberMode)
        ? p.lineNumberMode
        : DEFAULT_PREFS.lineNumberMode,
    viewSettingsScope: p.viewSettingsScope === 'vault' ? 'vault' : 'global',
    pdfExportUseTheme:
      typeof p.pdfExportUseTheme === 'boolean'
        ? p.pdfExportUseTheme
        : DEFAULT_PREFS.pdfExportUseTheme,
    lineNumberPosition:
      p.lineNumberPosition && VALID_LINE_NUMBER_POSITIONS.includes(p.lineNumberPosition)
        ? p.lineNumberPosition
        : DEFAULT_PREFS.lineNumberPosition,
    interfaceFont:
      typeof p.interfaceFont === 'string' || p.interfaceFont === null
        ? (p.interfaceFont as string | null)
        : DEFAULT_PREFS.interfaceFont,
    textFont:
      typeof p.textFont === 'string' || p.textFont === null
        ? (p.textFont as string | null)
        : DEFAULT_PREFS.textFont,
    monoFont:
      typeof p.monoFont === 'string' || p.monoFont === null
        ? (p.monoFont as string | null)
        : DEFAULT_PREFS.monoFont,
    systemFolderLabels: normalizeSystemFolderLabels(p.systemFolderLabels),
    sidebarWidth:
      typeof p.sidebarWidth === 'number'
        ? LEGACY_DEFAULT_SIDEBAR_WIDTHS.has(Math.round(p.sidebarWidth))
          ? DEFAULT_PREFS.sidebarWidth
          : Math.min(520, Math.max(160, p.sidebarWidth))
        : DEFAULT_PREFS.sidebarWidth,
    noteListWidth:
      typeof p.noteListWidth === 'number'
        ? Math.min(560, Math.max(200, p.noteListWidth))
        : DEFAULT_PREFS.noteListWidth,
  noteSortOrder:
      p.noteSortOrder && VALID_SORTS.includes(p.noteSortOrder)
        ? p.noteSortOrder
        : DEFAULT_PREFS.noteSortOrder,
    assetSortOrder:
      p.assetSortOrder && VALID_ASSET_SORTS.includes(p.assetSortOrder)
        ? p.assetSortOrder
        : DEFAULT_PREFS.assetSortOrder,
    groupByKind:
      typeof p.groupByKind === 'boolean' ? p.groupByKind : DEFAULT_PREFS.groupByKind,
    autoReveal:
      typeof p.autoReveal === 'boolean'
        ? p.autoReveal
        : DEFAULT_PREFS.autoReveal,
    unifiedSidebar: true,
    darkSidebar:
      typeof p.darkSidebar === 'boolean'
        ? p.darkSidebar
        : DEFAULT_PREFS.darkSidebar,
    showSidebarChevrons:
      typeof p.showSidebarChevrons === 'boolean'
        ? p.showSidebarChevrons
        : DEFAULT_PREFS.showSidebarChevrons,
    collapsedFolders:
      Array.isArray(p.collapsedFolders)
        ? p.collapsedFolders.filter((k): k is string => typeof k === 'string')
        : DEFAULT_PREFS.collapsedFolders,
    pinnedRefPath:
      typeof p.pinnedRefPath === 'string' || p.pinnedRefPath === null
        ? (p.pinnedRefPath as string | null)
        : DEFAULT_PREFS.pinnedRefPath,
    pinnedRefVisible:
      typeof p.pinnedRefVisible === 'boolean'
        ? p.pinnedRefVisible
        : DEFAULT_PREFS.pinnedRefVisible,
    pinnedRefWidth:
      typeof p.pinnedRefWidth === 'number'
        ? Math.min(800, Math.max(280, p.pinnedRefWidth))
        : DEFAULT_PREFS.pinnedRefWidth,
    panelWidths: normalizePanelWidths(p.panelWidths),
    pinnedRefMode:
      p.pinnedRefMode === 'edit' || p.pinnedRefMode === 'preview'
        ? p.pinnedRefMode
        : DEFAULT_PREFS.pinnedRefMode,
    quickNoteDateTitle:
      typeof p.quickNoteDateTitle === 'boolean'
        ? p.quickNoteDateTitle
        : DEFAULT_PREFS.quickNoteDateTitle,
    quickNoteTitlePrefix:
      typeof p.quickNoteTitlePrefix === 'string' || p.quickNoteTitlePrefix === null
        ? (p.quickNoteTitlePrefix as string | null)
        : DEFAULT_PREFS.quickNoteTitlePrefix,
    wordWrap:
      typeof p.wordWrap === 'boolean' ? p.wordWrap : DEFAULT_PREFS.wordWrap,
    cursorBlink:
      typeof p.cursorBlink === 'boolean'
        ? p.cursorBlink
        : DEFAULT_PREFS.cursorBlink,
    previewSmoothScroll:
      typeof p.previewSmoothScroll === 'boolean'
        ? p.previewSmoothScroll
        : DEFAULT_PREFS.previewSmoothScroll,
    editorMaxWidth:
      typeof p.editorMaxWidth === 'number'
        ? Math.min(2000, Math.max(560, p.editorMaxWidth))
        : DEFAULT_PREFS.editorMaxWidth,
    pdfEmbedInEditMode:
      p.pdfEmbedInEditMode === 'full' || p.pdfEmbedInEditMode === 'compact'
        ? p.pdfEmbedInEditMode
        : DEFAULT_PREFS.pdfEmbedInEditMode,
    pinnedRefKind:
      p.pinnedRefKind === 'asset' || p.pinnedRefKind === 'note'
        ? p.pinnedRefKind
        : DEFAULT_PREFS.pinnedRefKind,
    noteRefs:
      p.noteRefs && typeof p.noteRefs === 'object'
        ? Object.fromEntries(
            Object.entries(p.noteRefs as Record<string, unknown>).flatMap(
              ([k, v]) => {
                if (!v || typeof v !== 'object') return []
                const r = v as { path?: unknown; kind?: unknown }
                if (typeof r.path !== 'string') return []
                const kind = r.kind === 'asset' ? 'asset' : 'note'
                return [[k, { path: r.path, kind }]] as const
              }
            )
          )
        : {},
    contentAlign:
      p.contentAlign === 'left' || p.contentAlign === 'center'
        ? p.contentAlign
        : DEFAULT_PREFS.contentAlign,
    tagsCollapsed:
      typeof p.tagsCollapsed === 'boolean' ? p.tagsCollapsed : DEFAULT_PREFS.tagsCollapsed,
    nestedTags: typeof p.nestedTags === 'boolean' ? p.nestedTags : DEFAULT_PREFS.nestedTags,
    workflowsEnabled:
      typeof p.workflowsEnabled === 'boolean'
        ? p.workflowsEnabled
        : DEFAULT_PREFS.workflowsEnabled,
    atlasEnabled:
      typeof p.atlasEnabled === 'boolean' ? p.atlasEnabled : DEFAULT_PREFS.atlasEnabled,
    hiddenWorkflowPresets: normalizeHiddenWorkflowPresets(p.hiddenWorkflowPresets),
    collapsedTagNodes: Array.isArray(p.collapsedTagNodes)
      ? p.collapsedTagNodes.filter((k): k is string => typeof k === 'string')
      : DEFAULT_PREFS.collapsedTagNodes,
    autoCalendarPanel:
      typeof p.autoCalendarPanel === 'boolean'
        ? p.autoCalendarPanel
        : DEFAULT_PREFS.autoCalendarPanel,
    calendarWeekStart:
      p.calendarWeekStart && VALID_CALENDAR_WEEK_STARTS.includes(p.calendarWeekStart)
        ? p.calendarWeekStart
        : DEFAULT_PREFS.calendarWeekStart,
    calendarShowWeekNumbers:
      typeof p.calendarShowWeekNumbers === 'boolean'
        ? p.calendarShowWeekNumbers
        : DEFAULT_PREFS.calendarShowWeekNumbers,
    tasksViewMode:
      p.tasksViewMode && VALID_TASKS_VIEW_MODES.includes(p.tasksViewMode)
        ? p.tasksViewMode
        : DEFAULT_PREFS.tasksViewMode,
    showArchivedTasks:
      typeof p.showArchivedTasks === 'boolean'
        ? p.showArchivedTasks
        : DEFAULT_PREFS.showArchivedTasks,
    kanbanGroupBy: normalizeKanbanGroupBy(p.kanbanGroupBy),
    kanbanColumnTitles: normalizeKanbanColumnTitles(p.kanbanColumnTitles),
    kanbanColumnOrder: normalizeKanbanColumnOrder(p.kanbanColumnOrder),
    kanbanCardOrder: normalizeKanbanCardOrder(p.kanbanCardOrder),
    kanbanStatuses: normalizeKanbanStatuses(p.kanbanStatuses),
    hasCompletedOnboarding:
      typeof p.hasCompletedOnboarding === 'boolean'
        ? p.hasCompletedOnboarding
        : DEFAULT_PREFS.hasCompletedOnboarding
  }
}
// --- Portable config file integration (desktop) -----------------------------
// On desktop, the portable subset of prefs is mirrored to a plain-text
// config.toml (issue #203) so it can be synced across machines. The file is
// the source of truth for portable keys; localStorage stays as a fast cache
// and the web fallback. `getConfigSync()` returns null on web (and when the
// bridge is absent, e.g. tests) — we then behave exactly as before.
let cachedInitialPrefs: Prefs | null = null
// True when a config file is available on this platform (desktop). Gates
// whether savePrefs mirrors changes out to the file.
let configFileEnabled = false
// True when the config file already had content at load — i.e. this isn't a
// first run, so we must NOT clobber it by seeding from localStorage.
let configFileHadContent = false

function readConfigFromBridge(): AppConfigPortable | null {
  try {
    const bridge = typeof window !== 'undefined' ? window.zen : undefined
    if (!bridge || typeof bridge.getConfigSync !== 'function') return null
    return bridge.getConfigSync()
  } catch {
    return null
  }
}

function loadPrefs(): Prefs {
  if (cachedInitialPrefs) return cachedInitialPrefs

  let base: Partial<Prefs> = {}
  let hadLocalStorage = false
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      base = JSON.parse(raw) as Partial<Prefs>
      hadLocalStorage = true
    }
  } catch {
    /* ignore */
  }

  const fileConfig = readConfigFromBridge()
  configFileEnabled = fileConfig !== null
  configFileHadContent = !!fileConfig && Object.keys(fileConfig).length > 0

  // The file wins for portable keys; localStorage supplies machine-local keys.
  const merged: Partial<Prefs> = configFileHadContent
    ? { ...base, ...(fileConfig as Partial<Prefs>) }
    : base

  const normalized = normalizePrefs(merged)

  // Don't greet returning users with the onboarding wizard: an existing prefs
  // blob or a populated config file both mean they've been here before.
  if (
    (hadLocalStorage && typeof base.hasCompletedOnboarding !== 'boolean') ||
    configFileHadContent
  ) {
    normalized.hasCompletedOnboarding = true
  }

  // When the config file is authoritative, refresh the localStorage cache so
  // other same-origin renderers (e.g. the quick-capture window) and the next
  // launch see the synced values immediately.
  if (configFileHadContent) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(normalized))
    } catch {
      /* ignore */
    }
  }

  cachedInitialPrefs = hadLocalStorage || configFileHadContent ? normalized : DEFAULT_PREFS
  return cachedInitialPrefs
}

let configPushTimer: ReturnType<typeof setTimeout> | null = null
const CONFIG_PUSH_DEBOUNCE_MS = 400

function pushPortableConfig(p: Prefs): void {
  if (!configFileEnabled) return
  const bridge = typeof window !== 'undefined' ? window.zen : undefined
  if (!bridge || typeof bridge.setConfig !== 'function') return
  if (configPushTimer) clearTimeout(configPushTimer)
  configPushTimer = setTimeout(() => {
    configPushTimer = null
    try {
      void bridge.setConfig(pickPortablePrefs(p as unknown as Record<string, unknown>))
    } catch {
      /* ignore */
    }
  }, CONFIG_PUSH_DEBOUNCE_MS)
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
  cachedInitialPrefs = p
  pushPortableConfig(p)
}

function replaceNoteMeta(notes: NoteMeta[], oldPath: string, next: NoteMeta): NoteMeta[] {
  const idx = notes.findIndex((n) => n.path === oldPath)
  if (idx === -1) return notes
  const copy = notes.slice()
  copy[idx] = next
  return copy
}

function mergeNotesPreservingOrder(prev: NoteMeta[], next: NoteMeta[]): NoteMeta[] {
  const nextByPath = new Map(next.map((n) => [n.path, n] as const))
  const merged: NoteMeta[] = []
  const seen = new Set<string>()

  for (const note of prev) {
    const fresh = nextByPath.get(note.path)
    if (!fresh) continue
    merged.push(fresh)
    seen.add(note.path)
  }
  for (const note of next) {
    if (seen.has(note.path)) continue
    merged.push(note)
    seen.add(note.path)
  }
  return merged
}

function mergeFoldersPreservingOrder(prev: FolderEntry[], next: FolderEntry[]): FolderEntry[] {
  const keyOf = (folder: FolderEntry): string => `${folder.folder}:${folder.subpath}`
  const nextByKey = new Map(next.map((f) => [keyOf(f), f] as const))
  const merged: FolderEntry[] = []
  const seen = new Set<string>()

  for (const folder of prev) {
    const key = keyOf(folder)
    const fresh = nextByKey.get(key)
    if (!fresh) continue
    merged.push(fresh)
    seen.add(key)
  }
  for (const folder of next) {
    const key = keyOf(folder)
    if (seen.has(key)) continue
    merged.push(folder)
    seen.add(key)
  }
  return merged
}

function computeStartupCollapsedFolders(
  folders: FolderEntry[],
  settings: VaultSettings | null | undefined,
  activePath: string | null
): string[] {
  const normalizedSettings = normalizeVaultSettings(settings)
  const primaryNotesAtRoot = isPrimaryNotesAtRoot(normalizedSettings)
  const orderedKeys: string[] = []
  const seen = new Set<string>()
  const pushKey = (key: string): void => {
    if (seen.has(key)) return
    seen.add(key)
    orderedKeys.push(key)
  }

  pushKey('quick:')
  if (!primaryNotesAtRoot) pushKey('inbox:')
  for (const folder of folders) {
    if (!folder.subpath) continue
    pushKey(`${folder.folder}:${folder.subpath}`)
  }

  if (!activePath || activePath.startsWith('zen://')) return orderedKeys

  const folder = folderForVaultRelativePath(activePath, normalizedSettings)
  if (!folder) return orderedKeys

  const expandedKeys = new Set<string>()
  if (folder === 'quick') {
    expandedKeys.add('quick:')
  } else if (folder === 'inbox' && !primaryNotesAtRoot) {
    expandedKeys.add('inbox:')
  }

  const parentSubpath = noteFolderSubpath({ folder, path: activePath }, normalizedSettings)
  if (parentSubpath) {
    let acc = ''
    for (const segment of parentSubpath.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${segment}` : segment
      expandedKeys.add(`${folder}:${acc}`)
    }
  }

  return orderedKeys.filter((key) => !expandedKeys.has(key))
}

export interface NoteJumpLocation {
  path: string
  editorSelectionAnchor: number
  editorSelectionHead: number
  editorScrollTop: number
  previewScrollTop: number
  editorScrollMode?: 'preserve' | 'center' | 'start'
  highlightLine?: boolean
}

export interface PreviewAnchorRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface ConnectionPreviewState {
  path: string
  title: string
  anchorRect: PreviewAnchorRect
}

function getVisiblePreviewScrollElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return [...document.querySelectorAll<HTMLElement>('[data-preview-scroll]')].find(
    (el) => el.getClientRects().length > 0
  ) ?? null
}

/**
 * A database surface that can be the active tab: either a `zen://database/…`
 * tab (opened via "New Database") or a `.csv` opened directly as an asset tab
 * (`zen://asset/Foo.csv`), which EditorPane renders as a database grid. Both
 * must round-trip through the note jump history so Ctrl+O returns to the grid.
 */
function isDatabaseSurfaceTabPath(path: string | null | undefined): path is string {
  if (!path) return false
  if (isDatabaseTabPath(path)) return true
  return isAssetTabPath(path) && isDatabaseCsvPath(assetPathFromTab(path) ?? '')
}

/**
 * Tabs worth recording in the note jump history (Ctrl+O / Ctrl+I): real notes,
 * database surfaces — so opening a row's record page and pressing Ctrl+O jumps
 * back to the grid — and the Tasks and Tags views, which are destinations the
 * user navigates to on purpose and expects the jumplist to return to (#633).
 * Other virtual tabs (plain assets, help, trash…) stay excluded.
 */
function isJumpHistoryTabPath(path: string | null | undefined): path is string {
  if (!path) return false
  if (!isWorkspaceVirtualTabPath(path)) return true
  return isDatabaseSurfaceTabPath(path) || isTasksTabPath(path) || isTagsTabPath(path)
}

function captureNoteJumpLocation(state: {
  selectedPath: string | null
  editorViewRef: EditorView | null
}): NoteJumpLocation | null {
  if (!isJumpHistoryTabPath(state.selectedPath)) return null
  // Panel surfaces (Tasks, Tags, a database grid) render no editor, so a
  // lingering editorViewRef belongs to some other note; capturing its scroll
  // would smuggle meaningless numbers into the entry and defeat the
  // consecutive-duplicate dedup. Only the place itself is worth recording.
  if (isWorkspaceVirtualTabPath(state.selectedPath)) {
    return {
      path: state.selectedPath,
      editorSelectionAnchor: 0,
      editorSelectionHead: 0,
      editorScrollTop: 0,
      previewScrollTop: 0,
      editorScrollMode: 'preserve'
    }
  }
  const selection = state.editorViewRef?.state.selection.main
  return {
    path: state.selectedPath,
    editorSelectionAnchor: selection?.anchor ?? 0,
    editorSelectionHead: selection?.head ?? 0,
    editorScrollTop: state.editorViewRef?.scrollDOM.scrollTop ?? 0,
    previewScrollTop: getVisiblePreviewScrollElement()?.scrollTop ?? 0,
    editorScrollMode: 'preserve'
  }
}

function resolveTaskLineNumber(body: string, task: VaultTask): number {
  const lines = body.split('\n')
  let currentTaskIndex = 0
  let inFence = false
  let fenceMarker: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(FENCE_RE)
    if (fenceMatch) {
      const marker = fenceMatch[2]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
        fenceMarker = null
      }
      continue
    }
    if (inFence) continue

    if (!line.match(TASK_LINE_RE)) continue
    if (currentTaskIndex === task.taskIndex) return i
    currentTaskIndex += 1
  }

  return task.lineNumber
}

/** Parse a `YYYY-MM-DD` string to a local-midnight Date, or null if malformed. */
function parseIsoDateLocal(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

// Per-vault "we already rolled over today" marker, persisted in localStorage so
// opening today's daily note across sessions doesn't re-scan past notes once
// it's done for the day. Keyed by vault root so multiple vaults don't collide.
function rolloverMarkerKey(root: string): string {
  return `zen.tasks.rollover.${root || 'default'}`
}
function readRolloverMarker(root: string): string | null {
  try {
    return typeof localStorage !== 'undefined'
      ? localStorage.getItem(rolloverMarkerKey(root))
      : null
  } catch {
    return null
  }
}
function writeRolloverMarker(root: string, iso: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(rolloverMarkerKey(root), iso)
    }
  } catch {
    // localStorage may be unavailable (private mode); the in-session flow still works.
  }
}

// Per-vault "the user dismissed the inbox-mode/vault-root notice" marker (#216).
// Some vaults intentionally keep extra material at the root (e.g. AI tooling),
// so once dismissed the banner stays hidden for that vault. Keyed by root.
function rootBannerDismissKey(root: string): string {
  return `zen.sidebar.rootBannerDismissed.${root || 'default'}`
}
function readRootBannerDismissed(root: string): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(rootBannerDismissKey(root)) === '1'
    )
  } catch {
    return false
  }
}
function writeRootBannerDismissed(root: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(rootBannerDismissKey(root), '1')
    }
  } catch {
    // localStorage may be unavailable; the banner just reappears next session.
  }
}

// Per-vault manual note order (#224): `parentDir -> ordered note paths`. Stored
// in localStorage keyed by vault root, like the rollover marker. Not a vault
// sidecar yet, so it's per-machine — a portable `.zennotes` file is a follow-up.
type ManualNoteOrder = Record<string, string[]>
function manualOrderKey(root: string): string {
  return `zen.notes.manualOrder.${root || 'default'}`
}
function readManualOrder(root: string): ManualNoteOrder {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(manualOrderKey(root)) : null
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: ManualNoteOrder = {}
    for (const [dir, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(list)) out[dir] = list.filter((p): p is string => typeof p === 'string')
    }
    return out
  } catch {
    return {}
  }
}
function writeManualOrder(root: string, order: ManualNoteOrder): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(manualOrderKey(root), JSON.stringify(order))
    }
  } catch {
    // localStorage may be unavailable; the manual order is best-effort.
  }
}
// Which vault root the in-memory manual order was loaded for; reloaded on switch.
let manualOrderLoadedForRoot: string | null = null

/** Roughly 8 MB of image per picture; larger ones fall back to alt text so a
 *  paste never stalls a mail client. */
const EMAIL_IMAGE_MAX_BASE64 = 11_000_000
const EMAIL_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}
function emailImageMime(relPath: string): string {
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase()
  return EMAIL_IMAGE_MIME[ext] ?? 'application/octet-stream'
}

type InlineTaskMarker = 'open' | 'done' | 'forwarded' | 'cancelled' | 'in-progress'

/** A checkbox line has exactly one state character. Mirror that exclusivity in
 * the optimistic task object so grouping and styling cannot observe both the
 * old and new state while the watcher catches up. `waiting` is an independent
 * inline metadata token and intentionally survives marker changes. */
function withInlineTaskMarker(task: VaultTask, marker: InlineTaskMarker): VaultTask {
  return {
    ...task,
    checked: marker === 'done',
    forwarded: marker === 'forwarded',
    cancelled: marker === 'cancelled',
    inProgress: marker === 'in-progress'
  }
}

type FileTaskStatus = 'open' | 'done' | 'cancelled' | 'in-progress' | 'waiting'

/** Whole-note tasks encode their one workflow state in frontmatter `status`.
 * Keep all derived booleans and the Kanban field in sync in one operation. */
function withFileTaskStatus(task: VaultTask, status: FileTaskStatus): VaultTask {
  return {
    ...task,
    checked: status === 'done',
    forwarded: false,
    cancelled: status === 'cancelled',
    inProgress: status === 'in-progress',
    waiting: status === 'waiting',
    status,
    fields: { ...task.fields, status }
  }
}

function applyTaskMutationsToTask(task: VaultTask, mutations: TaskMutation[]): VaultTask {
  let next = task
  for (const m of mutations) {
    switch (m.kind) {
      case 'set-checked':
        if (next.checked !== m.checked) {
          next =
            next.kind === 'file'
              ? withFileTaskStatus(next, m.checked ? 'done' : 'open')
              : withInlineTaskMarker(next, m.checked ? 'done' : 'open')
        }
        break
      case 'set-waiting':
        if (next.waiting !== m.waiting) {
          next =
            next.kind === 'file'
              ? withFileTaskStatus(next, m.waiting ? 'waiting' : 'open')
              : { ...next, waiting: m.waiting }
        }
        break
      case 'set-in-progress':
        if (next.inProgress !== m.inProgress) {
          next =
            next.kind === 'file'
              ? withFileTaskStatus(next, m.inProgress ? 'in-progress' : 'open')
              : withInlineTaskMarker(next, m.inProgress ? 'in-progress' : 'open')
        }
        break
      case 'set-priority': {
        const priority = m.priority ?? undefined
        if (next.priority !== priority) next = { ...next, priority }
        break
      }
      case 'set-due': {
        const due = m.due ?? undefined
        if (next.due !== due) next = { ...next, due }
        break
      }
      case 'set-field': {
        const value = m.value ?? undefined
        const fields = { ...next.fields }
        if (value == null) delete fields[m.key]
        else fields[m.key] = value
        next = { ...next, fields }
        if (m.key === 'status') next = { ...next, status: value }
        break
      }
      case 'set-text': {
        const content = m.text.trim()
        if (next.content !== content) next = { ...next, content }
        break
      }
    }
  }
  return next
}

/** Map task mutations onto frontmatter scalar updates for a whole-note file
 *  task (which has no inline checkbox to edit). Mirrors the inline mutators in
 *  `applyTaskMutation`. `todayIso` stamps the completion date. */
function fileTaskMutationUpdates(
  mutations: TaskMutation[],
  todayIso: string
): Record<string, string | null> {
  const updates: Record<string, string | null> = {}
  for (const m of mutations) {
    switch (m.kind) {
      case 'set-checked':
        updates.status = m.checked ? 'done' : 'open'
        updates.completedDate = m.checked ? todayIso : null
        break
      case 'set-waiting':
        updates.status = m.waiting ? 'waiting' : 'open'
        break
      case 'set-in-progress':
        updates.status = m.inProgress ? 'in-progress' : 'open'
        break
      case 'set-priority':
        updates.priority = taskFilePriorityValue(m.priority)
        break
      case 'set-due':
        updates.due = m.due
        break
      case 'set-field':
        updates[m.key] = m.value
        break
      case 'set-text':
        updates.title = m.text.trim()
        break
    }
  }
  return updates
}

function yieldForOptimisticPaint(): Promise<void> {
  return new Promise((resolve) => {
    const scheduleAfterPaint = (): void => {
      window.setTimeout(resolve, 0)
    }

    if (
      typeof window.requestAnimationFrame === 'function' &&
      document.visibilityState === 'visible'
    ) {
      window.requestAnimationFrame(scheduleAfterPaint)
    } else {
      window.setTimeout(resolve, 0)
    }
  })
}

/**
 * One write chain per note path for task mutations (#503, the disk half). A
 * mutation reads the body, computes its edit, and AWAITS the disk write; two
 * rapid moves on the same note (Shift+H at key-repeat speed is ~30ms apart)
 * both read the pre-first body inside that window, and the second write then
 * puts the first move's line back the way it was. Chained per path, a
 * mutation reads only after the previous write settled. Links are stored
 * settled so one failed write cannot wedge a note's chain, and the tail
 * cleans itself up so closed notes do not accumulate entries.
 */
const taskMutationQueues = new Map<string, Promise<void>>()

function queueTaskMutation(path: string, run: () => Promise<void>): Promise<void> {
  const prev = taskMutationQueues.get(path) ?? Promise.resolve()
  const next = prev.then(run)
  const tracked: Promise<void> = next
    .then(
      () => undefined,
      () => undefined
    )
    .finally(() => {
      if (taskMutationQueues.get(path) === tracked) taskMutationQueues.delete(path)
    })
  taskMutationQueues.set(path, tracked)
  return next
}

/**
 * Task mutations that have been asked for but have not finished, from the call
 * itself rather than from the queue above. The optimistic paint yields a frame
 * before anything is queued, so the queue alone has a blind spot exactly where
 * a close is most likely to land.
 */
const inFlightTaskMutations = new Set<Promise<void>>()

/**
 * Wait for every task write in flight to settle.
 *
 * These writes go to notes that are NOT dirty (see `applyTaskMutation`), so
 * `flushDirtyNotes` cannot see them on its own: a Kanban move still in flight
 * when the window closes or the vault switches would simply be dropped. The
 * queue tails are stored settled, so awaiting them cannot throw, and each entry
 * removes itself once it resolves; the loop is for a mutation that queued
 * another behind itself while we waited, and it is bounded so a pathological
 * chain can never hold a quit open forever.
 */
async function drainTaskMutationQueues(): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) {
    if (inFlightTaskMutations.size === 0 && taskMutationQueues.size === 0) return
    await Promise.all(
      [...inFlightTaskMutations, ...taskMutationQueues.values()].map(async (pending) => {
        try {
          await pending
        } catch {
          /* a write that failed already reported itself */
        }
      })
    )
  }
}

function sameNoteJumpLocation(a: NoteJumpLocation | null, b: NoteJumpLocation | null): boolean {
  if (!a || !b) return false
  return (
    a.path === b.path &&
    a.editorSelectionAnchor === b.editorSelectionAnchor &&
    a.editorSelectionHead === b.editorSelectionHead &&
    a.editorScrollTop === b.editorScrollTop &&
    a.previewScrollTop === b.previewScrollTop
  )
}

function appendNoteJumpHistory(
  history: NoteJumpLocation[],
  location: NoteJumpLocation | null
): NoteJumpLocation[] {
  if (!location) return history
  if (sameNoteJumpLocation(history[history.length - 1] ?? null, location)) return history
  const next = [...history, location]
  return next.length > MAX_NOTE_JUMP_HISTORY
    ? next.slice(next.length - MAX_NOTE_JUMP_HISTORY)
    : next
}

/**
 * The jump stacks after a user-initiated navigation from wherever they are to
 * `nextPath`: the current spot goes on the backstack and the forward stack is
 * dropped, exactly as `Ctrl+O` / `Ctrl+I` expect.
 *
 * Every path that opens a note *because the user asked to go somewhere* runs
 * through this. Opening at an offset (a template's `{{cursor}}`, a vault-search
 * hit, a `[[note#heading]]` link) used to bypass it by going straight to
 * `openNoteInPane`, the low-level "add a tab" primitive, so those jumps left no
 * trail — creating a note from a template stranded you with a dead Ctrl+O. (#484)
 */
function noteHistoryAfterJump(
  state: {
    selectedPath: string | null
    editorViewRef: EditorView | null
    noteBackstack: NoteJumpLocation[]
    noteForwardstack: NoteJumpLocation[]
  },
  nextPath: string
): { noteBackstack: NoteJumpLocation[]; noteForwardstack: NoteJumpLocation[] } {
  if (!isJumpHistoryTabPath(state.selectedPath) || state.selectedPath === nextPath) {
    return { noteBackstack: state.noteBackstack, noteForwardstack: state.noteForwardstack }
  }
  return {
    noteBackstack: appendNoteJumpHistory(state.noteBackstack, captureNoteJumpLocation(state)),
    noteForwardstack: []
  }
}

function rewriteNoteJumpHistory(
  history: NoteJumpLocation[],
  rewrite: (path: string) => string
): NoteJumpLocation[] {
  const next: NoteJumpLocation[] = []
  for (const entry of history) {
    const mapped = { ...entry, path: rewrite(entry.path) }
    if (sameNoteJumpLocation(next[next.length - 1] ?? null, mapped)) continue
    next.push(mapped)
  }
  return next.length > MAX_NOTE_JUMP_HISTORY
    ? next.slice(next.length - MAX_NOTE_JUMP_HISTORY)
    : next
}

/**
 * Rewrite every occurrence of `#oldTag` across all non-trash notes.
 * When `newTag` is null the hashtag is stripped (delete semantics);
 * otherwise it's replaced with `#newTag`.
 *
 * We only rewrite notes whose cached tag list contains `oldTag` (so
 * the iteration is bounded by the sidebar index) and we match tags
 * with a word-boundary regex so `#test` doesn't accidentally chew
 * into `#testing`. Fenced / inline code spans are left alone.
 */
async function rewriteTagAcrossVault(
  get: () => { notes: NoteMeta[]; activeNote: NoteContent | null },
  oldTag: string,
  newTag: string | null
): Promise<void> {
  const { notes, activeNote } = get()
  const escaped = oldTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match `#tag` preceded by start/whitespace and followed by a non
  // tag-character or end-of-string, keeping the leading separator. The
  // boundary excludes any Unicode letter so Cyrillic/CJK tags rename too (#205).
  const pattern = new RegExp(`(^|\\s)#${escaped}(?=[^\\p{L}\\d_/-]|$)`, 'gmu')

  const rewriteBody = (src: string): string => {
    // Preserve code fences and inline code exactly. Split the body
    // into alternating "safe" and "code" segments, rewrite only the
    // safe ones, then re-stitch.
    const fenceRe = /(```[\s\S]*?```|`[^`\n]*`)/g
    const parts: string[] = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = fenceRe.exec(src)) !== null) {
      parts.push(src.slice(last, m.index)) // prose
      parts.push(m[0]) // code (kept as-is)
      last = fenceRe.lastIndex
    }
    parts.push(src.slice(last))
    for (let i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(
        pattern,
        newTag === null ? '$1' : `$1#${newTag}`
      )
    }
    return parts.join('')
  }

  for (const note of notes) {
    if (note.folder === 'trash') continue
    if (!note.tags.includes(oldTag)) continue
    try {
      const content = await window.zen.readNote(note.path)
      const next = rewriteBody(content.body)
      if (next !== content.body) {
        await window.zen.writeNote(note.path, next)
      }
    } catch (err) {
      console.error('rewriteTagAcrossVault: failed on', note.path, err)
    }
  }

  // Keep the currently-edited note's in-memory body in sync so the
  // editor reflects the change without a reload.
  if (activeNote) {
    try {
      const fresh = await window.zen.readNote(activeNote.path)
      useStore.setState({ activeNote: fresh })
    } catch {
      /* ignore — note may have been moved/deleted */
    }
  }

  // Refresh the sidebar tag index.
  await useStore.getState().refreshNotes()
}

/** Snapshot prefs-shaped fields out of the live store. */
function collectPrefs(s: {
  vimMode: boolean
  vimInsertEscape: string
  vimYankToClipboard: boolean
  vimBlockImeInNormalMode: boolean
  vimWrappedLineMotions: VimWrappedLineMotionMode
  keymapOverrides: KeymapOverrides
  enabledOverrides: Record<string, string>
  themeTweaks: Record<string, string>
  whichKeyHints: boolean
  whichKeyHintMode: WhichKeyHintMode
  whichKeyHintTimeoutMs: number
  vaultTextSearchBackend: VaultTextSearchBackendPreference
  ripgrepBinaryPath: string | null
  fzfBinaryPath: string | null
  livePreview: boolean
  showHeadingLevelLabels: boolean
  listIndentGuides: boolean
  renderTablesInLivePreview: boolean
  completedTaskStyle: CompletedTaskStyle
  mathRenderer: MathRenderer
  typstTagPreambles: boolean
  harperEnabled: boolean
  harperDialect: HarperDialect
  harperLintConfig: HarperLintConfig
  looseMathDelimiters: boolean
  keepViewModeAcrossNotes: boolean
  defaultPaneMode: PaneMode
  syncTitleHeadingOnRename: boolean
  markdownSnippets: boolean
  textReplacementsEnabled: boolean
  textReplacements: TextReplacements
  autoPairs: boolean
  autoPairQuotesInProse: boolean
  hideBuiltinTemplates: boolean
  tabsEnabled: boolean
  wrapTabs: boolean
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  editorFontSize: number
  mathFontScale: number
  editorLineHeight: number
  editorTabSize: number
  editorScrollOff: number
  timeFormat: TimeFormat
  previewMaxWidth: number
  lineNumberMode: LineNumberMode
  lineNumberPosition: LineNumberPosition
  viewSettingsScope: 'global' | 'vault'
  pdfExportUseTheme: boolean
  interfaceFont: string | null
  textFont: string | null
  monoFont: string | null
  systemFolderLabels: SystemFolderLabels
  sidebarWidth: number
  noteListWidth: number
  noteSortOrder: NoteSortOrder
  assetSortOrder: AssetSortOrder
  groupByKind: boolean
  autoReveal: boolean
  unifiedSidebar: boolean
  darkSidebar: boolean
  showSidebarChevrons: boolean
  collapsedFolders: string[]
  pinnedRefPath: string | null
  pinnedRefVisible: boolean
  pinnedRefWidth: number
  panelWidths: PanelWidths
  pinnedRefMode: 'edit' | 'preview'
  quickNoteDateTitle: boolean
  quickNoteTitlePrefix: string | null
  wordWrap: boolean
  cursorBlink: boolean
  previewSmoothScroll: boolean
  editorMaxWidth: number
  pdfEmbedInEditMode: 'compact' | 'full'
  pinnedRefKind: 'note' | 'asset'
  noteRefs: Record<string, { path: string; kind: 'note' | 'asset' }>
  contentAlign: 'center' | 'left'
  tagsCollapsed: boolean
  nestedTags: boolean
  workflowsEnabled: boolean
  atlasEnabled: boolean
  hiddenWorkflowPresets: string[]
  collapsedTagNodes: string[]
  autoCalendarPanel: boolean
  calendarWeekStart: CalendarWeekStart
  calendarShowWeekNumbers: boolean
  tasksViewMode: TasksViewMode
  showArchivedTasks: boolean
  kanbanGroupBy: KanbanGroupBy
  kanbanColumnTitles: Record<string, string>
  kanbanColumnOrder: Record<string, string[]>
  kanbanCardOrder: Record<string, string[]>
  kanbanStatuses: string[]
  hasCompletedOnboarding: boolean
}): Prefs {
  return {
    vimMode: s.vimMode,
    vimInsertEscape: s.vimInsertEscape,
    vimYankToClipboard: s.vimYankToClipboard,
    vimBlockImeInNormalMode: s.vimBlockImeInNormalMode,
    vimWrappedLineMotions: s.vimWrappedLineMotions,
    keymapOverrides: s.keymapOverrides,
    enabledOverrides: s.enabledOverrides,
    themeTweaks: s.themeTweaks,
    whichKeyHints: s.whichKeyHints,
    whichKeyHintMode: s.whichKeyHintMode,
    whichKeyHintTimeoutMs: s.whichKeyHintTimeoutMs,
    vaultTextSearchBackend: s.vaultTextSearchBackend,
    ripgrepBinaryPath: s.ripgrepBinaryPath,
    fzfBinaryPath: s.fzfBinaryPath,
    livePreview: s.livePreview,
    showHeadingLevelLabels: s.showHeadingLevelLabels,
    listIndentGuides: s.listIndentGuides,
    renderTablesInLivePreview: s.renderTablesInLivePreview,
    completedTaskStyle: s.completedTaskStyle,
    mathRenderer: s.mathRenderer,
    typstTagPreambles: s.typstTagPreambles,
    harperEnabled: s.harperEnabled,
    harperDialect: s.harperDialect,
    harperLintConfig: s.harperLintConfig,
    looseMathDelimiters: s.looseMathDelimiters,
    keepViewModeAcrossNotes: s.keepViewModeAcrossNotes,
    defaultPaneMode: s.defaultPaneMode,
    syncTitleHeadingOnRename: s.syncTitleHeadingOnRename,
    markdownSnippets: s.markdownSnippets,
    textReplacementsEnabled: s.textReplacementsEnabled,
    textReplacements: s.textReplacements,
    autoPairs: s.autoPairs,
    autoPairQuotesInProse: s.autoPairQuotesInProse,
    hideBuiltinTemplates: s.hideBuiltinTemplates,
    tabsEnabled: s.tabsEnabled,
    wrapTabs: s.wrapTabs,
    themeId: s.themeId,
    themeFamily: s.themeFamily,
    themeMode: s.themeMode,
    editorFontSize: s.editorFontSize,
    mathFontScale: s.mathFontScale,
    editorLineHeight: s.editorLineHeight,
    editorTabSize: s.editorTabSize,
    editorScrollOff: s.editorScrollOff,
    timeFormat: s.timeFormat,
    previewMaxWidth: s.previewMaxWidth,
    lineNumberMode: s.lineNumberMode,
    viewSettingsScope: s.viewSettingsScope,
    pdfExportUseTheme: s.pdfExportUseTheme,
    lineNumberPosition: s.lineNumberPosition,
    interfaceFont: s.interfaceFont,
    textFont: s.textFont,
    monoFont: s.monoFont,
    systemFolderLabels: s.systemFolderLabels,
    sidebarWidth: s.sidebarWidth,
    noteListWidth: s.noteListWidth,
    noteSortOrder: s.noteSortOrder,
    assetSortOrder: s.assetSortOrder,
    groupByKind: s.groupByKind,
    autoReveal: s.autoReveal,
    unifiedSidebar: s.unifiedSidebar,
    darkSidebar: s.darkSidebar,
    showSidebarChevrons: s.showSidebarChevrons,
    collapsedFolders: s.collapsedFolders,
    pinnedRefPath: s.pinnedRefPath,
    pinnedRefVisible: s.pinnedRefVisible,
    pinnedRefWidth: s.pinnedRefWidth,
    panelWidths: s.panelWidths,
    pinnedRefMode: s.pinnedRefMode,
    quickNoteDateTitle: s.quickNoteDateTitle,
    quickNoteTitlePrefix: s.quickNoteTitlePrefix,
    wordWrap: s.wordWrap,
    cursorBlink: s.cursorBlink,
    previewSmoothScroll: s.previewSmoothScroll,
    editorMaxWidth: s.editorMaxWidth,
    pdfEmbedInEditMode: s.pdfEmbedInEditMode,
    pinnedRefKind: s.pinnedRefKind,
    noteRefs: s.noteRefs,
    contentAlign: s.contentAlign,
    tagsCollapsed: s.tagsCollapsed,
    nestedTags: s.nestedTags,
    workflowsEnabled: s.workflowsEnabled,
    atlasEnabled: s.atlasEnabled,
    hiddenWorkflowPresets: s.hiddenWorkflowPresets,
    collapsedTagNodes: s.collapsedTagNodes,
    autoCalendarPanel: s.autoCalendarPanel,
    calendarWeekStart: s.calendarWeekStart,
    calendarShowWeekNumbers: s.calendarShowWeekNumbers,
    tasksViewMode: s.tasksViewMode,
    showArchivedTasks: s.showArchivedTasks,
    kanbanGroupBy: s.kanbanGroupBy,
    kanbanColumnTitles: s.kanbanColumnTitles,
    kanbanColumnOrder: s.kanbanColumnOrder,
    kanbanCardOrder: s.kanbanCardOrder,
    kanbanStatuses: s.kanbanStatuses,
    hasCompletedOnboarding: s.hasCompletedOnboarding
  }
}

export type View =
  | {
      kind: 'folder'
      folder: NoteFolder
      /**
       * Subfolder path relative to the top-level folder, POSIX-style.
       * Empty = the top-level itself. Examples: "", "Work",
       * "Work/Research".
       */
      subpath: string
    }
  | { kind: 'assets' }

interface WorkspaceSnapshot {
  paneLayout: PaneLayout
  activePaneId: string
  view: View
  sidebarOpen: boolean
  noteListOpen: boolean
  selectedTags: string[]
  /** Epoch ms of the last write — drives newest-wins when the synced file and
   *  the local cache disagree (e.g. after working in this vault on another
   *  machine). (#292) */
  savedAt?: number
}

interface ZenRestoreState {
  sidebarOpen: boolean
  noteListOpen: boolean
  pinnedRefVisible: boolean
}

function loadWorkspaceSnapshots(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeWorkspaceSnapshotToCache(root: string, snapshot: unknown): void {
  try {
    const allSnapshots = loadWorkspaceSnapshots()
    allSnapshots[root] = snapshot
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(allSnapshots))
  } catch {
    /* ignore */
  }
}

let workspaceFileWriteTimer: ReturnType<typeof setTimeout> | null = null

function saveWorkspaceSnapshot(root: string, snapshot: WorkspaceSnapshot): void {
  const stamped: WorkspaceSnapshot = { ...snapshot, savedAt: Date.now() }
  // localStorage stays the fast, synchronous local cache.
  writeWorkspaceSnapshotToCache(root, stamped)
  // Mirror to <vault>/.zennotes/workspace.json (debounced) so the workspace
  // syncs with the vault across machines. The IPC targets the CURRENT window's
  // vault, so drop the write if the vault changed during the debounce. (#292)
  if (workspaceFileWriteTimer) clearTimeout(workspaceFileWriteTimer)
  workspaceFileWriteTimer = setTimeout(() => {
    workspaceFileWriteTimer = null
    if (useStore.getState().vault?.root !== root) return
    try {
      void window.zen?.writeWorkspaceState?.(JSON.stringify(stamped))
    } catch {
      /* ignore */
    }
  }, WORKSPACE_FILE_DEBOUNCE_MS)
}

function loadWorkspaceSnapshot(root: string): unknown {
  return loadWorkspaceSnapshots()[root] ?? null
}

/** Pick the freshest workspace snapshot between the local cache and the synced
 *  file (newest-wins by `savedAt`), refreshing the cache when the file wins. The
 *  file IPC targets the current window's vault, which matches `root` at restore
 *  time. (#292) */
async function loadBestWorkspaceSnapshot(root: string): Promise<unknown> {
  const local = loadWorkspaceSnapshot(root) as { savedAt?: unknown } | null
  let fileSnap: { savedAt?: unknown } | null = null
  try {
    const raw = await window.zen?.readWorkspaceState?.()
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object') fileSnap = parsed as { savedAt?: unknown }
    }
  } catch {
    /* ignore — fall back to the local cache */
  }
  if (!fileSnap) return local
  const fileAt = typeof fileSnap.savedAt === 'number' ? fileSnap.savedAt : 0
  const localAt = local && typeof local.savedAt === 'number' ? local.savedAt : -1
  if (fileAt >= localAt) {
    writeWorkspaceSnapshotToCache(root, fileSnap)
    return fileSnap
  }
  return local
}

function normalizeWorkspaceView(raw: unknown): View {
  if (!raw || typeof raw !== 'object') {
    return { kind: 'folder', folder: 'inbox', subpath: '' }
  }
  const view = raw as Record<string, unknown>
  if (view.kind === 'assets') return { kind: 'assets' }
  if (
    view.kind === 'folder' &&
    (view.folder === 'inbox' ||
      view.folder === 'quick' ||
      view.folder === 'archive' ||
      view.folder === 'trash') &&
    typeof view.subpath === 'string'
  ) {
    return { kind: 'folder', folder: view.folder, subpath: view.subpath }
  }
  return { kind: 'folder', folder: 'inbox', subpath: '' }
}

function normalizeWorkspaceTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || seen.has(value)) continue
    seen.add(value)
    tags.push(value)
  }
  return tags
}

function normalizeWorkspaceSizes(raw: unknown, length: number): number[] {
  if (!Array.isArray(raw) || raw.length !== length) {
    return Array.from({ length }, () => 1 / length)
  }
  const sizes = raw
    .map((value) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    )
    .filter((value) => value > 0)
  if (sizes.length !== length) {
    return Array.from({ length }, () => 1 / length)
  }
  const total = sizes.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return Array.from({ length }, () => 1 / length)
  return sizes.map((value) => value / total)
}

/** Shape-checks a saved pane layout without consulting the notes index: the
 *  snapshot is restored before the vault listing exists (#564). Tabs whose
 *  notes are gone survive this pass and are pruned later, by the eager
 *  restore read for active tabs and by `refreshNotes` once the index lands. */
function sanitizeWorkspaceLayout(raw: unknown): PaneLayout {
  const usedIds = new Set<string>()

  const nextId = (rawId: unknown): string => {
    if (typeof rawId === 'string' && rawId && !usedIds.has(rawId)) {
      usedIds.add(rawId)
      return rawId
    }
    let fresh = nextPaneId()
    while (usedIds.has(fresh)) fresh = nextPaneId()
    usedIds.add(fresh)
    return fresh
  }

  const sanitizePath = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null
    return value
  }

  const visit = (value: unknown): PaneLayout | null => {
    if (!value || typeof value !== 'object') return null
    const node = value as Record<string, unknown>

    if (node.kind === 'leaf') {
      const seenTabs = new Set<string>()
      const tabs: string[] = []
      const rawTabs = Array.isArray(node.tabs) ? node.tabs : []
      for (const rawTab of rawTabs) {
        const tab = sanitizePath(rawTab)
        if (!tab || seenTabs.has(tab)) continue
        seenTabs.add(tab)
        tabs.push(tab)
      }

      const pinnedSeen = new Set<string>()
      const pinnedTabs: string[] = []
      const rawPinnedTabs = Array.isArray(node.pinnedTabs) ? node.pinnedTabs : []
      for (const rawPinnedTab of rawPinnedTabs) {
        const tab = sanitizePath(rawPinnedTab)
        if (!tab || !seenTabs.has(tab) || pinnedSeen.has(tab)) continue
        pinnedSeen.add(tab)
        pinnedTabs.push(tab)
      }

      const orderedTabs = [...pinnedTabs, ...tabs.filter((tab) => !pinnedSeen.has(tab))]
      if (orderedTabs.length === 0) return null

      const activeCandidate = sanitizePath(node.activeTab)
      const activeTab =
        activeCandidate && orderedTabs.includes(activeCandidate)
          ? activeCandidate
          : orderedTabs[0]

      return {
        kind: 'leaf',
        id: nextId(node.id),
        tabs: orderedTabs,
        pinnedTabs,
        activeTab
      }
    }

    if (node.kind === 'split') {
      const rawChildren = Array.isArray(node.children) ? node.children : []
      const children = rawChildren.flatMap((child) => {
        const next = visit(child)
        return next ? [next] : []
      })
      if (children.length === 0) return null
      if (children.length === 1) return children[0]

      return {
        kind: 'split',
        id: nextId(node.id),
        direction: node.direction === 'column' ? 'column' : 'row',
        children,
        sizes: normalizeWorkspaceSizes(node.sizes, children.length)
      }
    }

    return null
  }

  return visit(raw) ?? makeLeaf()
}

/** True if any pane currently has the virtual Tasks tab open. The Tasks
 *  panel lives as a tab in the pane layout, so this is how callers detect
 *  "user is on the Tasks view" (there's no `view.kind === 'tasks'`). */
export function isTasksViewActive(state: {
  paneLayout: PaneLayout
  activePaneId: string
}): boolean {
  const leaf = findLeaf(state.paneLayout, state.activePaneId)
  return leaf?.activeTab === TASKS_TAB_PATH
}

/** True when the active pane is showing the Workflows canvas. Mirrors
 *  `isTasksViewActive`; the sidebar row uses it for its selected state. */
export function isWorkflowsViewActive(state: {
  paneLayout: PaneLayout
  activePaneId: string
}): boolean {
  const leaf = findLeaf(state.paneLayout, state.activePaneId)
  return leaf?.activeTab === WORKFLOWS_TAB_PATH
}

/** True when the active pane is showing the Atlas map. Mirrors
 *  `isTasksViewActive`; the sidebar row uses it for its selected state. */
export function isAtlasViewActive(state: {
  paneLayout: PaneLayout
  activePaneId: string
}): boolean {
  const leaf = findLeaf(state.paneLayout, state.activePaneId)
  return leaf?.activeTab === ATLAS_TAB_PATH
}

function hasTasksViewOpen(state: { paneLayout: PaneLayout }): boolean {
  return allLeaves(state.paneLayout).some((leaf) => leaf.tabs.includes(TASKS_TAB_PATH))
}

/** True when a surface backed by `vaultTasks` is on screen and therefore needs
 *  the shared task cache kept fresh on note edits. Covers the Tasks view and the
 *  calendar panel — the latter is per-pane local state exposed via a DOM marker
 *  (the same one VimNav reads for pane navigation), so editing a daily note with
 *  only the calendar open still refreshes its tasks. */
function tasksSurfaceVisible(state: { paneLayout: PaneLayout }): boolean {
  if (hasTasksViewOpen(state)) return true
  return (
    typeof document !== 'undefined' &&
    document.querySelector('[data-calendar-panel]') !== null
  )
}

let isolatedCloudTaskPaths = new Set(
  (useCloudSyncStatusStore.getState().lastSummary?.pending_conflicts ?? []).flatMap(
    (conflict) => [conflict.path, conflict.cloud_path].filter((path): path is string => Boolean(path))
  ).map(cloudSyncPathKey)
)

function withoutPendingCloudConflictTasks(tasks: VaultTask[]): VaultTask[] {
  if (isolatedCloudTaskPaths.size === 0) return tasks
  return tasks.filter((task) => !isolatedCloudTaskPaths.has(cloudSyncPathKey(task.sourcePath)))
}

/** True when the active pane's active tab is the vault-wide Tags view. */
export function isTagsViewActive(state: {
  paneLayout: PaneLayout
  activePaneId: string
}): boolean {
  const leaf = findLeaf(state.paneLayout, state.activePaneId)
  return leaf?.activeTab === TAGS_TAB_PATH
}

/** True when the active pane's active tab is the built-in Help view. */
export function isHelpViewActive(state: {
  paneLayout: PaneLayout
  activePaneId: string
}): boolean {
  const leaf = findLeaf(state.paneLayout, state.activePaneId)
  return leaf?.activeTab === HELP_TAB_PATH
}

/** True when the active pane's active tab is the built-in Trash view. */
export function isTrashViewActive(state: {
  paneLayout: PaneLayout
  activePaneId: string
}): boolean {
  const leaf = findLeaf(state.paneLayout, state.activePaneId)
  return leaf?.activeTab === TRASH_TAB_PATH
}

/** True when the active pane's active tab is the built-in Archive view. */
export function isArchiveViewActive(state: {
  paneLayout: PaneLayout
  activePaneId: string
}): boolean {
  const leaf = findLeaf(state.paneLayout, state.activePaneId)
  return leaf?.activeTab === ARCHIVE_TAB_PATH
}

/** True when the active pane's active tab is the built-in Assets view. */
export function isAssetsViewActive(state: {
  paneLayout: PaneLayout
  activePaneId: string
}): boolean {
  const leaf = findLeaf(state.paneLayout, state.activePaneId)
  return leaf?.activeTab === ASSETS_VIEW_TAB_PATH
}

/** True when the active pane's active tab is the built-in Quick Notes view. */
export function isQuickNotesViewActive(state: {
  paneLayout: PaneLayout
  activePaneId: string
}): boolean {
  const leaf = findLeaf(state.paneLayout, state.activePaneId)
  return leaf?.activeTab === QUICK_NOTES_TAB_PATH
}

interface Store {
  vault: VaultInfo | null
  workspaceMode: WorkspaceMode
  remoteWorkspaceInfo: RemoteWorkspaceInfo | null
  remoteWorkspaceProfiles: RemoteWorkspaceProfile[]
  localVaults: LocalVaultEntry[]
  workspaceSetupError: string | null
  vaultSettings: VaultSettings
  /** Vault is in `inbox` mode but its root holds notes only `root` mode shows. */
  rootContentHiddenByInboxMode: boolean
  /** The user dismissed the vault-root notice for the current vault (#216). */
  rootContentBannerDismissed: boolean
  notes: NoteMeta[]
  /** Bodies of the vault's Typst preamble notes, loaded when the tag-preamble
   *  setting is on. Empty otherwise, so the feature costs nothing when off. */
  typstPreambleNotes: TypstPreambleNote[]
  folders: FolderEntry[]
  assetFiles: AssetMeta[]
  assetUndoStack: AssetUndoEntry[]
  hasAssetsDir: boolean
  view: View
  selectedPath: string | null
  activeNote: NoteContent | null
  activeDirty: boolean
  noteBackstack: NoteJumpLocation[]
  noteForwardstack: NoteJumpLocation[]
  pendingJumpLocation: NoteJumpLocation | null
  /** Notes still loading the full content. */
  loadingNote: boolean
  searchOpen: boolean
  vaultTextSearchOpen: boolean
  commandPaletteOpen: boolean
  commandPaletteInitialMode: CommandPaletteInitialMode
  bufferPaletteOpen: boolean
  outlinePaletteOpen: boolean
  templatePaletteOpen: boolean
  /** "Embed existing drawing" picker visibility. */
  embedDrawingPaletteOpen: boolean
  /** Bumped whenever an Excalidraw drawing changes on disk so embed widgets
   *  and preview components invalidate their cached PNG and re-render. */
  excalidrawPreviewVersion: number
  /** 'create' makes a new note from the picked template; 'insert' renders it
   *  into the active note instead. */
  templatePaletteMode: 'create' | 'insert'
  /** When set, the template picker creates in this folder (set by right-click);
   *  null means prompt the user for a destination. */
  templatePaletteTarget: { folder: NoteFolder; subpath: string } | null
  /** Custom templates loaded from `.zennotes/templates/` (built-ins are constants). */
  customTemplates: NoteTemplate[]
  /**
   * The vault's workflows, summarized for surfaces outside the workflows view.
   * The command palette builds its Run entries from this synchronously, which
   * is why it is store state rather than a fetch when the palette opens.
   */
  workflowIndex: WorkflowIndexEntry[]
  query: string
  initialized: boolean
  workspaceRestored: boolean
  sidebarOpen: boolean
  noteListOpen: boolean
  zenMode: boolean
  zenRestoreState: ZenRestoreState | null
  vimMode: boolean
  /** Key sequence that exits insert mode (maps to <Esc>), e.g. "jk". Persisted. */
  vimInsertEscape: string
  /** When true, Vim yank/delete/change also copy to the system clipboard. Persisted. */
  vimYankToClipboard: boolean
  vimBlockImeInNormalMode: boolean
  /** Display-row or logical-line semantics for $, I, A and dependent operators. */
  vimWrappedLineMotions: VimWrappedLineMotionMode
  keymapOverrides: KeymapOverrides
  /** Enabled CSS overrides, keyed by filename. Persisted to config [overrides]. */
  enabledOverrides: Record<string, string>
  /** Visual color tweaks (token slug → color). Persisted to config [tweaks]. */
  themeTweaks: Record<string, string>
  whichKeyHints: boolean
  whichKeyHintMode: WhichKeyHintMode
  whichKeyHintTimeoutMs: number
  vaultTextSearchBackend: VaultTextSearchBackendPreference
  ripgrepBinaryPath: string | null
  fzfBinaryPath: string | null
  livePreview: boolean
  showHeadingLevelLabels: boolean
  listIndentGuides: boolean
  renderTablesInLivePreview: boolean
  completedTaskStyle: CompletedTaskStyle
  mathRenderer: MathRenderer
  typstTagPreambles: boolean
  harperEnabled: boolean
  harperDialect: HarperDialect
  harperLintConfig: HarperLintConfig
  looseMathDelimiters: boolean
  keepViewModeAcrossNotes: boolean
  /** The mode a note opens in before it has a remembered one. Persisted. (#543) */
  defaultPaneMode: PaneMode
  /** Renaming a note rewrites its leading `# Heading` to match. Persisted. (#455) */
  syncTitleHeadingOnRename: boolean
  /** Auto-close markdown delimiters while typing. Persisted. */
  markdownSnippets: boolean
  textReplacementsEnabled: boolean
  textReplacements: TextReplacements
  /** Auto-insert matching `[]`, `()`, and `{}` delimiters while typing. Persisted. */
  autoPairs: boolean
  /** Also auto-insert matching quotes outside Markdown code spans and blocks. Persisted. */
  autoPairQuotesInProse: boolean
  hideBuiltinTemplates: boolean
  tabsEnabled: boolean
  wrapTabs: boolean
  settingsOpen: boolean
  /** Chapter index of the guided Workflows tutorial, or null when it is not
   *  running. Session-only on purpose: the tutorial re-seeds (and first
   *  cleans) its practice material on every start, so resuming a half-done
   *  one after a restart would point at files that were never re-created.
   *  Cleared on every vault switch with the rest of the per-vault slices: the
   *  practice notes it is talking about live in the vault it started in. */
  workflowTutorialStep: number | null
  /** The most recent workflow run applied in this vault, receipt and undo
   *  state included. Lives HERE rather than in the view for two reasons:
   *  leaving the view and coming back must not cost the Undo (the receipt
   *  toast expires in seconds, and a run someone can no longer take back
   *  because they glanced at a note is a broken promise), and a run started
   *  from the palette has to replace the one the view is showing rather than
   *  leave two receipts for one workflow. Session-only, and per-vault: a run
   *  id means nothing to another vault's journal, so every vault switch
   *  clears it rather than offering an Undo that fails. The run-history UI is
   *  the durable version of this, later. */
  workflowRunRecord: WorkflowRunRecord | null
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  editorFontSize: number
  mathFontScale: number
  editorLineHeight: number
  editorTabSize: number
  editorScrollOff: number
  timeFormat: TimeFormat
  previewMaxWidth: number
  lineNumberMode: LineNumberMode
  lineNumberPosition: LineNumberPosition
  viewSettingsScope: 'global' | 'vault'
  pdfExportUseTheme: boolean
  interfaceFont: string | null
  textFont: string | null
  monoFont: string | null
  systemFolderLabels: SystemFolderLabels
  sidebarWidth: number
  noteListWidth: number
  noteSortOrder: NoteSortOrder
  assetSortOrder: AssetSortOrder
  groupByKind: boolean
  autoReveal: boolean
  unifiedSidebar: boolean
  darkSidebar: boolean
  showSidebarChevrons: boolean
  /** Manual (drag-to-reorder) note order for `noteSortOrder: 'manual'`, keyed
   *  by parent directory → ordered note paths. Persisted per vault (#224). */
  manualNoteOrder: ManualNoteOrder
  /** Sidebar tree collapsed-folder keys. Kept in the store so the
   *  state survives Sidebar unmount/mount (e.g. toggling the sidebar). */
  collapsedFolders: string[]

  /** Pinned reference pane — an always-visible side panel that shows a
   *  single companion note while the user works in the main editor. */
  pinnedRefPath: string | null
  /** URL hash fragment for the pinned asset (e.g. "#page=12") — passed
   *  through to the iframe so the PDF viewer opens at the right page. */
  pinnedRefFragment: string | null
  pinnedRefVisible: boolean
  pinnedRefWidth: number
  panelWidths: PanelWidths
  pinnedRefMode: 'edit' | 'preview'

  /** Auto-title new Quick Notes to today's date instead of the
   *  default "Quick Note <ts>" pattern. */
  quickNoteDateTitle: boolean
  /** Prefix used when generating new Quick Note titles. */
  quickNoteTitlePrefix: string | null

  /** Whether long lines wrap or scroll horizontally in the editor. */
  wordWrap: boolean

  /** When false the editor caret and the Vim block cursor stay solid
   *  instead of blinking. */
  cursorBlink: boolean

  /** Animate Ctrl+D / Ctrl+U half-page jumps in preview mode. Off
   *  gives an instant snap, which Vim muscle memory prefers. */
  previewSmoothScroll: boolean

  /** Max content width inside the editor, in px. Caps and centers the
   *  text so wide windows don't make every line stretch edge-to-edge. */
  editorMaxWidth: number

  /** How embedded PDFs render in the editor's live preview (edit mode):
   *  'compact' shows the same card the reference pane uses, 'full'
   *  inlines the actual PDF iframe. Preview mode always shows the full
   *  iframe unless the PDF is the pinned reference. */
  pdfEmbedInEditMode: 'compact' | 'full'

  /** Whether the pinned reference is a markdown note (default) or
   *  some other asset (PDF, audio, etc.) shown via iframe. */
  pinnedRefKind: 'note' | 'asset'

  /** Per-note reference pins. Active note's entry overrides the
   *  global pinnedRefPath while that note is open. */
  noteRefs: Record<string, { path: string; kind: 'note' | 'asset'; fragment?: string | null }>

  /** Center the editor + preview content (with the width cap) or
   *  left-align it to the pane edge. */
  contentAlign: 'center' | 'left'

  /** Sidebar Tags section collapsed — hides the pill rail but keeps
   *  the section header visible as a toggle. Persisted. */
  tagsCollapsed: boolean
  /** Render `/`-separated tags as a collapsible tree (sidebar + Tags view).
   *  Persisted. (#439) */
  nestedTags: boolean
  /** Master switch for the Workflows feature. Persisted. Off hides the sidebar
   *  row, the `view.workflows` command, and the leader binding, so the canvas
   *  has no way in at all. */
  workflowsEnabled: boolean
  atlasEnabled: boolean
  /** Built-in recipes hidden from the New-workflow gallery, by preset id.
   *  Persisted (portable). Hiding is per taste, not per vault. */
  hiddenWorkflowPresets: string[]
  /** Full paths of collapsed nodes in the nested-tag tree. Persisted. */
  collapsedTagNodes: string[]
  /** Auto-show the calendar panel when the active note is a daily or
   *  weekly note. Persisted. */
  autoCalendarPanel: boolean
  /** Which weekday the calendar grid starts on. Persisted. */
  calendarWeekStart: CalendarWeekStart
  /** Show the ISO week-number column in the calendar. Persisted. */
  calendarShowWeekNumbers: boolean

  /** Vault-wide Tasks view state. Populated lazily when the view is opened
   *  and kept incrementally fresh via the chokidar watcher while the view
   *  is visible. */
  vaultTasks: VaultTask[]

  /** User themes parsed from ~/.config/zennotes/themes. Loaded + watched by
   *  `initCustomThemes`; the CSS is injected as it changes. */
  customThemes: CustomTheme[]
  /** User-installed TextMate grammars and a revision used to refresh previews. */
  customCodeLanguages: CustomCodeLanguage[]
  customCodeLanguagesRevision: number
  /** User CSS overrides parsed from ~/.config/zennotes/overrides. Loaded + watched
   *  by `initOverrides`; enabled ones are injected on top of the active theme. */
  overrides: Override[]
  /** Toggle a override on/off (persists to the config [overrides] table). */
  setOverrideEnabled(name: string, on: boolean): void
  /** Set or clear a visual color tweak (slug → color; null clears it). Persisted. */
  setThemeTweak(slug: string, value: string | null): void
  /** Clear all visual color tweaks. */
  resetThemeTweaks(): void
  tasksLoading: boolean
  tasksFilter: string
  taskCursorIndex: number
  /** Which sub-view is active inside the Tasks tab. */
  tasksViewMode: TasksViewMode
  /** Keep tasks from archived notes on the Tasks surfaces (off by default). */
  showArchivedTasks: boolean
  /** Column source for the Tasks Kanban view. */
  kanbanGroupBy: KanbanGroupBy
  /** Display-only column title overrides for the Tasks Kanban view. */
  kanbanColumnTitles: Record<string, string>
  /** Manual column arrangement per board (groupBy → ordered column ids). */
  kanbanColumnOrder: Record<string, string[]>
  /** Manual card arrangement inside columns (`groupBy:columnId` → ordered
   *  task identity keys). Persisted so a hand-prioritized column survives
   *  leaving the Kanban view. */
  kanbanCardOrder: Record<string, string[]>
  /** Ordered status ids for the custom-status Kanban board (config-driven). */
  kanbanStatuses: string[]
  /** True once the user has finished or skipped the first-run onboarding. */
  hasCompletedOnboarding: boolean
  /** ISO YYYY-MM-DD currently selected in the Calendar view. null = today. */
  tasksCalendarSelectedDate: string | null
  /** First-of-month anchor (ISO YYYY-MM-01) for the Calendar view's grid. */
  tasksCalendarMonthAnchor: string | null

  /** Hydrated CSV databases keyed by their vault-relative `.csv` path. */
  databases: Record<string, DatabaseDoc>
  /** In-flight load flags keyed by `.csv` path. */
  databasesLoading: Record<string, boolean>

  /** Tags currently selected in the Tags view. The view shows every non-
   *  trash note carrying *all* (or, in `any` mode, any) of these, depending on
   *  `tagMatchMode`. Cleared when the Tags tab closes. */
  selectedTags: string[]
  /** Whether multiple selected tags combine with AND (`all`, the default —
   *  narrows) or OR (`any` — widens). */
  tagMatchMode: TagMatchMode

  /** Vim navigation: which panel is keyboard-focused. */
  focusedPanel: Panel | null
  sidebarCursorIndex: number
  /** Expanded group keys in the Daily/Weekly date-nav tree (ephemeral UI, not
   *  persisted). Kept in the store — not Sidebar-local — so the keyboard nav in
   *  VimNav can expand/collapse date groups like real folders. (#301) */
  dateNavExpanded: string[]
  /** Editor view mode (edit/split/preview) per pane, per note path. Ephemeral
   *  (not persisted): kept in the store so it survives EditorPane remounts and a
   *  split can inherit the source pane's mode instead of resetting to edit. (#321) */
  paneModes: Record<string, PaneModesByPath>
  /** Last view mode explicitly set in each pane, by pane id. Used only when
   *  `keepViewModeAcrossNotes` is on, so every note in the pane follows the
   *  pane's current mode instead of its own. Ephemeral, like `paneModes`. */
  paneStickyModes: Record<string, PaneMode>
  noteListCursorIndex: number
  connectionsCursorIndex: number
  /** Row cursor for the Outline panel, mirroring the connections cursor so
   *  pane navigation can restore where you were. (#477) */
  outlineCursorIndex: number
  connectionPreview: ConnectionPreviewState | null
  editorViewRef: EditorView | null
  editorCursorPosition: EditorCursorPosition | null
  pendingTitleFocusPath: string | null

  /**
   * Recursive layout tree for the editor area. Always contains at
   * least one leaf pane. Each leaf holds its own tab list + active
   * tab; splits hold ordered children and flex-ratio sizes.
   */
  paneLayout: PaneLayout
  /** ID of the currently focused leaf pane. */
  activePaneId: string
  /** Loaded note contents, keyed by path. Shared across panes so the
   *  same note open in two panes stays in sync on edit. */
  noteContents: Record<string, NoteContent>
  /** Dirty flags keyed by path — a buffer with unsaved edits. */
  noteDirty: Record<string, boolean>
  /** Comment sidecars keyed by note path. Loaded lazily per open note. */
  noteComments: Record<string, NoteComment[]>
  activeCommentId: string | null
  closedTabStack: ClosedTabEntry[]

  setVault: (v: VaultInfo | null) => void
  setVaultSettings: (next: VaultSettings) => Promise<void>
  /**
   * Toggle a favorite (a note path or a `folder:subpath` key) and persist it.
   * Favorites pin to the top of the sidebar.
   */
  toggleFavorite: (key: string) => Promise<void>
  /** Toggle favorite for the active editor note (Vim leader command). */
  toggleFavoriteActiveNote: () => Promise<void>
  /** @internal Replace the favorites list and persist (no note refresh). */
  applyFavorites: (nextFavorites: string[]) => Promise<void>
  /**
   * Toggle a folder on the vault's `tasks.excludedFolders` list (#458) and
   * rescan, so its checkboxes leave (or rejoin) every Tasks surface at once.
   * `relDir` is the folder's vault-relative on-disk path
   * (`vaultRelativeFolderPath` output, e.g. `inbox/Books`).
   */
  toggleTasksExcludedFolder: (relDir: string) => Promise<void>
  /**
   * Point the vault at a different Typst preamble folder (#562). Empty or
   * invalid input restores the default (`typst`). Notes in the folder are
   * preambles AND are left out of the tag index, so this moves both at once;
   * the note list is refreshed because every note's tags may have changed.
   */
  setTypstPreambleFolder: (folder: string) => Promise<void>
  setNotes: (notes: NoteMeta[]) => void
  setView: (view: View) => void
  /** Open the Tasks panel as a tab in the active pane. If the tab is
   *  already open elsewhere it's focused; otherwise a fresh tab is added. */
  openTasksView: () => Promise<void>
  /** Close the Tasks tab in every pane that has it open. */
  closeTasksView: () => void
  /** Toggle a tag in the Tags view selection and ensure the Tags tab is
   *  open + focused. If `tag` is omitted, just opens the tab with the
   *  current selection. First open with a tag starts a fresh selection. */
  openTagView: (tag?: string) => Promise<void>
  /** Open the Workflows canvas as a tab in the active pane. */
  openWorkflowsView: () => Promise<void>
  /** Open the Atlas map as a tab in the active pane. */
  openAtlasView: () => Promise<void>
  /** Close the Tags tab in every pane and clear the selection. */
  closeTagView: () => void
  /** Open the built-in Help tab in the active pane. */
  openHelpView: () => Promise<void>
  /** Open the built-in Quick Notes tab in the active pane. */
  openQuickNotesView: () => Promise<void>
  /** Open the built-in Archive tab in the active pane. */
  openArchiveView: () => Promise<void>
  openAssetsView: () => Promise<void>
  /** Open the built-in Trash tab in the active pane. */
  openTrashView: () => Promise<void>
  /** Read a CSV database (CSV + sidecar) into `databases` if not already loaded. */
  loadDatabase: (csvPath: string) => Promise<void>
  /** Load a database and open it as a tab in the active pane. */
  openDatabase: (csvPath: string) => Promise<void>
  /** Create a new empty database under `folder`/`subpath` and open it. */
  createDatabase: (folder: NoteFolder, subpath?: string, title?: string) => Promise<void>
  /** Create a database in the configured default databases location and open it. (#362) */
  newDatabase: () => Promise<void>
  /** Rename a database (its `.base` folder); rehomes the open grid tab. */
  renameDatabase: (csvPath: string, newTitle: string) => Promise<void>
  /** Optimistically replace a database's rows and debounce-persist the CSV. */
  updateDatabaseRows: (csvPath: string, next: DatabaseDoc) => void
  /** Delete rows AND purge their record-page mappings from the sidecar (a plain
   *  row write only touches the CSV, so a stale UUID would otherwise linger in
   *  schema.json). When a deleted row has a linked page note, prompt whether to
   *  trash the note too or keep it as a standalone note. (#391) */
  deleteDatabaseRows: (csvPath: string, rowIds: string[]) => Promise<void>
  /** Optimistically replace a database's schema/views and debounce-persist sidecar + CSV. */
  updateDatabaseSchema: (csvPath: string, next: DatabaseDoc) => void
  /** Re-read a database from disk after an external change (skips our own write echoes). */
  syncDatabaseFromDisk: (csvPath: string) => Promise<void>
  /** Drop a deleted database's cached doc and close its tab (no disk read). */
  forgetDatabase: (csvPath: string) => Promise<void>
  /** Open a record as a markdown "page" note (creating + linking it on first open). */
  openRecordPage: (csvPath: string, rowId: string) => Promise<void>
  /** Rename a record's linked page note to match its title (no-op if unlinked). */
  renameRecordPage: (csvPath: string, rowId: string) => Promise<void>
  /** Add or remove a tag from the Tags view selection without touching
   *  pane layout. No-op if the selection is already in that state. */
  toggleTagSelection: (tag: string) => void
  /** Replace the Tags view selection wholesale (used by `:tag a b c`). */
  setSelectedTags: (tags: string[]) => void
  /** Switch how multiple selected tags combine (AND vs OR). */
  setTagMatchMode: (mode: TagMatchMode) => void
  /** Force a full vault rescan for tasks. */
  refreshTasks: () => Promise<void>
  /** Rescan a single note's tasks and splice the result into `vaultTasks`. */
  rescanTasksForPath: (relPath: string) => Promise<void>
  /** Open the note containing `task` and place the cursor on that line. */
  openTaskAt: (task: VaultTask) => Promise<void>
  /** Flip a task's checkbox. Reuses `toggleTaskAtIndex` so the file round-
   *  trips exactly — works whether or not the note is currently open. */
  toggleTaskFromList: (task: VaultTask) => Promise<void>
  /** Toggle a task's cancelled state (`[-]` inline, `status: cancelled` for a
   *  file-task). Cancelled = intentionally abandoned, distinct from done. (#450) */
  cancelTaskFromList: (task: VaultTask) => Promise<void>
  /** Toggle a task's in-progress state (`[/]` inline, `status: in-progress` for
   *  a file-task). Still open work: it keeps its place in Today rather than
   *  moving to a group of its own. (#512) */
  startTaskFromList: (task: VaultTask) => Promise<void>
  /** Apply one or more structured mutations to the task line on disk
   *  and reflect them locally. Used by the Kanban DnD pipeline to
   *  flip checked / waiting / priority without forcing the user to
   *  drop into the editor. Multiple mutations are coalesced into a
   *  single buffer update so a status change ("uncheck + clear
   *  waiting") never sees a half-applied intermediate state. */
  applyTaskMutation: (
    task: VaultTask,
    mutation: TaskMutation | TaskMutation[]
  ) => Promise<void>
  /** Delete a task's line from its note (the right-click "Delete" action). */
  deleteTaskFromList: (task: VaultTask) => Promise<void>
  /** Physically move a task's line into the daily note for `dateIso`,
   *  removing it from its current note. Falls back to setting the due date
   *  when daily notes are disabled or it already lives in that day's note. */
  moveTaskToDate: (task: VaultTask, dateIso: string) => Promise<void>
  /** Forward a task to another note (#316): leaves `[>]` + a link to the target
   *  on the original, and appends a fresh `- [ ]` copy (backlinked) to the
   *  target note. */
  forwardTask: (task: VaultTask, targetPath: string) => Promise<void>
  setTasksFilter: (q: string) => void
  setTasksViewMode: (mode: TasksViewMode) => void
  /** Toggle whether archived notes' tasks stay on the Tasks surfaces (#540). */
  setShowArchivedTasks: (show: boolean) => void
  /** Confirm archiving `paths` when they still carry open tasks. Resolves true
   *  when nothing is open or the user confirmed; every archive entry point
   *  (single or bulk) calls this first so the warning cannot be bypassed by
   *  surface, and a bulk archive asks once, not once per note. */
  confirmArchiveNotes: (paths: string[]) => Promise<boolean>
  setKanbanGroupBy: (group: KanbanGroupBy) => void
  setKanbanColumnTitle: (
    group: KanbanGroupBy,
    columnId: string,
    title: string | null
  ) => void
  /** Persist the manual column arrangement for a board. Pass the full ordered
   *  list of column ids; empties clear the override for that board. */
  setKanbanColumnOrder: (group: KanbanGroupBy, orderedIds: string[]) => void
  /** Persist the manual card arrangement after a drop. `entries` maps
   *  `${groupBy}:${columnId}` keys to the full ordered list of task identity
   *  keys for that column; an empty list clears the column's entry, so writing
   *  a whole board prunes columns that emptied out. */
  setKanbanCardOrder: (entries: Record<string, string[]>) => void
  /** Replace the ordered custom-status list (from Settings). Normalized and
   *  written back to config.toml + the per-vault view override. (#354) */
  setKanbanStatuses: (statuses: string[]) => void
  setTasksCalendarSelectedDate: (iso: string | null) => void
  setTasksCalendarMonthAnchor: (iso: string | null) => void
  setTaskCursorIndex: (idx: number) => void
  selectNote: (relPath: string | null) => Promise<void>
  /** Open a note as the active pane's VS Code-style preview tab: it reuses
   *  the existing preview slot and promotes on double-click, edit, or pin. */
  previewNote: (relPath: string) => Promise<void>
  prefetchNotes: (paths: string[]) => void
  openNoteAtOffset: (
    relPath: string,
    offset: number,
    options?: { scrollMode?: 'center' | 'start' }
  ) => Promise<void>
  /** Reload the vault's Typst preamble notes (tag-driven math definitions). */
  refreshTypstPreambles: () => Promise<void>
  jumpToPreviousNote: () => Promise<void>
  jumpToNextNote: () => Promise<void>
  toggleRecentNote: () => Promise<void>
  applyChange: (ev: VaultChangeEvent) => Promise<void>
  refreshNotes: () => Promise<void>
  refreshRootContentHidden: () => Promise<void>
  /** Dismiss the vault-root notice for the current vault, persisted (#216). */
  dismissRootContentBanner: () => void
  refreshAssets: () => Promise<void>
  deleteAsset: (relPath: string) => Promise<void>
  undoLastAssetAction: () => Promise<boolean>
  updateActiveBody: (body: string) => void
  persistActive: () => Promise<void>
  formatActiveNote: () => Promise<void>
  renameNote: (oldPath: string, nextTitle: string) => Promise<void>
  renameActive: (nextTitle: string) => Promise<void>
  createAndOpen: (
    folder: NoteFolder,
    subpath?: string,
    options?: { focusTitle?: boolean; title?: string }
  ) => Promise<void>
  createDrawingAndOpen: (folder: NoteFolder, subpath?: string) => Promise<void>
  /** Quick-add a whole-note task file (`#task`-tagged, TaskNotes-style). Prompts
   *  for a title and creates it at `opts` (an explicit folder/subpath) or, when
   *  omitted, the configured tasks location. Resolves to the created path, or
   *  null if cancelled. */
  newTaskFile: (opts?: { folder: NoteFolder; subpath?: string }) => Promise<string | null>
  /** Quick-add a task file after first asking which folder to put it in (a
   *  destination prompt with folder autocomplete), then the title — for keeping
   *  per-project tasks organized. Resolves to the created path, or null. */
  newTaskFileInChosenFolder: () => Promise<string | null>
  /**
   * Create a note after asking where to put it: a destination prompt that
   * defaults to `initialPath` (empty = vault root), so the user can press Enter
   * to accept or type / pick a folder. Used by the sidebar's "+" buttons, which
   * — unlike the right-click menus — carry no implied location.
   */
  createNoteInChosenFolder: (opts?: { initialPath?: string }) => Promise<void>
  createNoteInCurrentFolder: () => Promise<void>
  /**
   * Web counterpart of the desktop drag-to-open feature: for each
   * drag-and-dropped markdown File, read its contents, create a note from
   * it (titled after the filename), and open it. The browser only exposes
   * dropped file *contents*, not paths, so unlike desktop — which opens the
   * file in place — the web build brings it into the vault as a note.
   */
  importDroppedMarkdownFiles: (files: File[]) => Promise<void>
  closeActiveNote: () => Promise<void>
  reopenLastClosedTab: () => Promise<void>
  trashActive: () => Promise<void>
  /** Move any note to the Trash the way trashing the active note does (confirm,
   *  move, drop its tabs and buffers). Resolves true when the note moved. */
  trashNote: (path: string) => Promise<boolean>
  /** Delete the active note for good. Offered where the note is already in
   *  the Trash, where Move to Trash would be a no-op with a misleading
   *  prompt (#712). */
  deleteActivePermanently: () => Promise<void>
  /** Delete any note for good (confirm, delete, drop its tabs and buffers).
   *  Resolves true when the file is gone. */
  deleteNotePermanently: (path: string) => Promise<boolean>
  restoreActive: () => Promise<void>
  archiveActive: () => Promise<void>
  unarchiveActive: () => Promise<void>
  exportActiveNotePdf: () => Promise<void>
  exportActiveNoteDocx: () => Promise<void>
  copyActiveNoteAsMarkdown: () => Promise<void>
  copyActiveNoteAsHtml: () => Promise<void>
  setSearchOpen: (open: boolean) => void
  setVaultTextSearchOpen: (open: boolean) => void
  setCommandPaletteOpen: (open: boolean, mode?: CommandPaletteInitialMode) => void
  setBufferPaletteOpen: (open: boolean) => void
  setOutlinePaletteOpen: (open: boolean) => void
  setQuery: (q: string) => void
  toggleSidebar: () => void
  toggleNoteList: () => void
  setFocusMode: (focus: boolean) => void
  setVimMode: (on: boolean) => void
  setVimInsertEscape: (sequence: string) => void
  setVimYankToClipboard: (on: boolean) => void
  setVimBlockImeInNormalMode: (on: boolean) => void
  setVimWrappedLineMotions: (mode: VimWrappedLineMotionMode) => void
  setKeymapBinding: (id: KeymapId, binding: string | null) => void
  resetAllKeymaps: () => void
  setWhichKeyHints: (on: boolean) => void
  setWhichKeyHintMode: (mode: WhichKeyHintMode) => void
  setWhichKeyHintTimeoutMs: (ms: number) => void
  setVaultTextSearchBackend: (backend: VaultTextSearchBackendPreference) => void
  setRipgrepBinaryPath: (path: string | null) => void
  setFzfBinaryPath: (path: string | null) => void
  setLivePreview: (on: boolean) => void
  setShowHeadingLevelLabels: (on: boolean) => void
  setListIndentGuides: (on: boolean) => void
  setRenderTablesInLivePreview: (on: boolean) => void
  setCompletedTaskStyle: (style: CompletedTaskStyle) => void
  setMathRenderer: (renderer: MathRenderer) => void
  setTypstTagPreambles: (on: boolean) => void
  setHarperEnabled: (on: boolean) => void
  setHarperDialect: (dialect: HarperDialect) => void
  setHarperLintConfig: (config: HarperLintConfig) => void
  /** Write the vault's Harper dictionary and ignored suggestions to vault.json
   *  without the note rescan a full settings save does. */
  saveHarperVaultState: (next: HarperVaultState) => Promise<void>
  setLooseMathDelimiters: (on: boolean) => void
  setKeepViewModeAcrossNotes: (on: boolean) => void
  setDefaultPaneMode: (mode: PaneMode) => void
  setSyncTitleHeadingOnRename: (on: boolean) => void
  setMarkdownSnippets: (on: boolean) => void
  setTextReplacementsEnabled: (on: boolean) => void
  setTextReplacements: (replacements: TextReplacements) => void
  setAutoPairs: (on: boolean) => void
  setAutoPairQuotesInProse: (on: boolean) => void
  setHideBuiltinTemplates: (hidden: boolean) => void
  /** Turn the whole Workflows feature on or off. Switching it off also closes
   *  any pane still showing the canvas. */
  setWorkflowsEnabled: (on: boolean) => void
  setAtlasEnabled: (on: boolean) => void
  hideWorkflowPreset: (id: string) => void
  restoreWorkflowPreset: (id: string) => void
  /** Wholesale replacement, for Settings' Hide all / Restore all. The preset
   *  ids come from the caller so the store never imports the preset bodies
   *  (they belong to lazy chunks, not the boot path). */
  setHiddenWorkflowPresets: (ids: readonly string[]) => void
  setTabsEnabled: (on: boolean) => void
  setWrapTabs: (on: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setWorkflowTutorialStep: (step: number | null) => void
  setWorkflowRunRecord: (
    next: WorkflowRunRecord | null | ((prev: WorkflowRunRecord | null) => WorkflowRunRecord | null)
  ) => void
  setTheme: (next: { id: string; family: ThemeFamily; mode: ThemeMode }) => void
  setEditorFontSize: (px: number) => void
  setMathFontScale: (percent: number) => void
  setEditorLineHeight: (mult: number) => void
  setEditorTabSize: (size: number) => void
  setEditorScrollOff: (lines: number) => void
  setTimeFormat: (format: TimeFormat) => void
  setPreviewMaxWidth: (px: number) => void
  setLineNumberMode: (mode: LineNumberMode) => void
  setViewSettingsScope: (scope: 'global' | 'vault') => void
  setPdfExportUseTheme: (on: boolean) => void
  setLineNumberPosition: (position: LineNumberPosition) => void
  setInterfaceFont: (family: string | null) => void
  setTextFont: (family: string | null) => void
  setMonoFont: (family: string | null) => void
  setSystemFolderLabel: (key: LabelKey, label: string | null) => void
  setSidebarWidth: (px: number) => void
  setNoteListWidth: (px: number) => void
  setNoteSortOrder: (order: NoteSortOrder) => void
  /** Set the Assets view sort column + direction. (#473) */
  setAssetSortOrder: (order: AssetSortOrder) => void
  /** Move a note before/after a sibling in its folder's manual order (#224). */
  reorderNoteManually: (
    draggedPath: string,
    targetPath: string,
    position: 'before' | 'after'
  ) => void
  /** Reorder a task by moving its markdown line before/after another task's
   *  line in the same note (the note's line order is the source of truth).
   *  No-op across notes. */
  reorderTaskInNote: (
    task: VaultTask,
    targetTask: VaultTask,
    position: 'before' | 'after'
  ) => Promise<void>
  setGroupByKind: (on: boolean) => void
  setAutoReveal: (on: boolean) => void
  setUnifiedSidebar: (on: boolean) => void
  setDarkSidebar: (on: boolean) => void
  setShowSidebarChevrons: (on: boolean) => void
  toggleCollapseFolder: (key: string) => void
  setCollapsedFolders: (keys: string[]) => void
  /* Daily/Weekly date-nav tree expand state — reachable from VimNav (#301) */
  expandDateNav: (key: string) => void
  collapseDateNav: (key: string) => void
  toggleDateNav: (key: string) => void

  /* Pinned reference pane */
  pinReference: (path: string) => Promise<void>
  /** Pin a non-text asset (PDF, etc.) — rendered in the side pane via
   *  iframe, with no text-content cache. */
  pinAssetReference: (path: string, fragment?: string | null) => void
  unpinReference: () => void
  /** Per-note variant: the pin only shows while `notePath` is the
   *  active note. Switching notes hides it; coming back shows it. */
  pinAssetReferenceForNote: (notePath: string, assetPath: string, fragment?: string | null) => void
  unpinReferenceForNote: (notePath: string) => void
  togglePinnedRefVisible: () => void
  setPinnedRefWidth: (px: number) => void
  setPanelWidth: (panel: RightPanelId, px: number) => void
  setPinnedRefMode: (mode: 'edit' | 'preview') => void

  setQuickNoteDateTitle: (on: boolean) => void
  setQuickNoteTitlePrefix: (prefix: string | null) => void
  openTodayDailyNote: () => Promise<void>
  openThisWeekWeeklyNote: () => Promise<void>
  openThisMonthMonthlyNote: () => Promise<void>
  setTemplatePaletteOpen: (open: boolean) => void
  setEmbedDrawingPaletteOpen: (open: boolean) => void
  /** Create a new Excalidraw drawing and open it in a dedicated tab. */
  newDrawing: () => Promise<void>
  /** Create a new Excalidraw drawing, embed it at the cursor in the active
   *  note, then switch focus to the new drawing's editor tab. */
  embedNewDrawing: () => Promise<void>
  /** Insert a `![[path]]` embed at the cursor in the active note. */
  insertEmbedAtCursor: (embed: string) => void
  /** Open the template picker scoped to a folder; the chosen template is
   *  created there directly (no destination prompt). */
  openTemplatePaletteForFolder: (folder: NoteFolder, subpath: string) => void
  /** Open the template picker in 'insert' mode: the chosen template is rendered
   *  into the active note instead of creating a new note. */
  openTemplatePaletteForInsert: () => void
  /** Render a template into the active note — replacing a blank/scaffold note,
   *  otherwise inserting at the cursor — and place the caret at {{cursor}}. */
  insertTemplateIntoActiveNote: (template: NoteTemplate) => void
  /** Reload custom templates from disk (called on vault open and after CRUD). */
  loadCustomTemplates: () => Promise<void>
  /** Reload the workflow index (called with the vault indexes and after workflow CRUD). */
  loadWorkflowIndex: () => Promise<void>
  saveCustomTemplate: (input: {
    slug: string
    raw: string
    previousSourcePath?: string
  }) => Promise<void>
  deleteCustomTemplate: (sourcePath: string) => Promise<void>
  /** Create + open a note from a template, substituting variables and placing
   *  the caret at `{{cursor}}`. Falls back to a title prompt when the template
   *  has no titleTemplate and no explicit title is supplied. */
  createFromTemplate: (
    template: NoteTemplate,
    opts?: { folder?: NoteFolder; subpath?: string; title?: string; date?: Date }
  ) => Promise<void>
  saveActiveNoteAsTemplate: () => Promise<void>
  saveActiveNoteAs: (newName: string) => Promise<void>
  setWordWrap: (on: boolean) => void
  setCursorBlink: (on: boolean) => void
  setPreviewSmoothScroll: (on: boolean) => void
  setEditorMaxWidth: (px: number) => void
  setPdfEmbedInEditMode: (mode: 'compact' | 'full') => void
  setContentAlign: (align: 'center' | 'left') => void
  setTagsCollapsed: (collapsed: boolean) => void
  setNestedTags: (enabled: boolean) => void
  /** Toggle a nested-tag tree node between expanded and collapsed by its full path. */
  toggleCollapseTagNode: (path: string) => void
  setAutoCalendarPanel: (enabled: boolean) => void
  setCalendarWeekStart: (start: CalendarWeekStart) => void
  setCalendarShowWeekNumbers: (show: boolean) => void
  openDailyNoteForDate: (date: Date) => Promise<void>
  openWeeklyNoteForDate: (date: Date) => Promise<void>
  openMonthlyNoteForDate: (date: Date) => Promise<void>
  /** Find the daily note for `date`, creating it on disk (template-aware)
   *  WITHOUT navigating to it. Returns its meta, or null if daily notes are
   *  disabled or creation failed. */
  ensureDailyNoteForDate: (date: Date) => Promise<NoteMeta | null>
  /** Append a `- [ ] …` task to the daily note for `dateIso` (YYYY-MM-DD),
   *  prompting to create that daily note first if it doesn't exist. */
  addTaskForDate: (dateIso: string, text: string) => Promise<void>
  /** Move unfinished tasks from past daily notes into today's note. Returns the
   *  number of task lines moved. Without `force`, it is gated by the
   *  `rolloverUnfinishedTasks` setting and a once-per-day marker. */
  rolloverUnfinishedTasksIntoToday: (opts?: {
    force?: boolean
    open?: boolean
  }) => Promise<number>
  /** Mark the first-run onboarding as complete (or skipped). Persists. */
  completeOnboarding: () => void
  /** Re-open the first-run onboarding wizard. Persists. */
  restartOnboarding: () => void
  setFocusedPanel: (panel: Panel | null) => void
  setSidebarCursorIndex: (idx: number) => void
  setNoteListCursorIndex: (idx: number) => void
  setConnectionsCursorIndex: (idx: number) => void
  setOutlineCursorIndex: (idx: number) => void
  setConnectionPreview: (preview: ConnectionPreviewState | null) => void
  setEditorViewRef: (view: EditorView | null) => void
  setEditorCursorPosition: (position: EditorCursorPosition | null) => void

  /* ---- Pane tree actions ---- */
  /** Focus the given pane and sync active-note plumbing to its activeTab. */
  setActivePane: (paneId: string) => void
  /** Focus a tab (path) inside a pane. Loads content if not yet cached. */
  focusTabInPane: (paneId: string, path: string) => Promise<void>
  /** Add a tab to a pane at `insertIndex` (or end) and focus it. */
  openNoteInPane: (paneId: string, path: string, insertIndex?: number) => Promise<void>
  /** Close a tab from a specific pane. Removes the pane when empty. */
  closeTabInPane: (paneId: string, path: string) => Promise<void>
  /** Reorder a tab within one pane. */
  reorderTabInPane: (
    paneId: string,
    dragPath: string,
    targetPath: string,
    position: 'before' | 'after'
  ) => void
  /** Move a tab between panes (optionally dropping on another tab for ordering). */
  movePaneTab: (args: {
    sourcePaneId: string
    targetPaneId: string
    path: string
    insertIndex?: number
    beforePath?: string
  }) => Promise<void>
  /** Split a target pane along `edge`. If `sourcePaneId` is given, the
   *  path is moved out of that pane; otherwise a fresh tab is added. */
  splitPaneWithTab: (args: {
    targetPaneId: string
    edge: Exclude<PaneEdge, 'center'>
    path: string
    sourcePaneId?: string
  }) => Promise<void>
  /** Update sizes on a split node (for divider drag). */
  resizeSplit: (splitId: string, sizes: number[]) => void
  setPaneModeForPath: (paneId: string, path: string | null, mode: PaneMode) => void
  /** Pin a tab within a specific pane — sticks it to the left of the
   *  strip and protects it from "Close Others" / "Close Tabs to Right". */
  pinTabInPane: (paneId: string, path: string) => void
  unpinTabInPane: (paneId: string, path: string) => void
  /** Promote a preview tab to a permanent tab (double-click on the tab). */
  promoteTabInPane: (paneId: string, path: string) => void
  toggleTabPin: (paneId: string, path: string) => void
  /** Update an open note's body (typed into any pane). Flags dirty. */
  updateNoteBody: (path: string, body: string) => void
  /** Persist a specific note to disk. */
  persistNote: (path: string) => Promise<void>
  loadNoteComments: (path: string) => Promise<NoteComment[]>
  addNoteComment: (input: NoteCommentInput) => Promise<NoteComment | null>
  updateNoteComment: (
    path: string,
    id: string,
    patch: Partial<Pick<NoteComment, 'body' | 'resolvedAt' | 'anchorStart' | 'anchorEnd' | 'anchorText'>>
  ) => Promise<void>
  deleteNoteComment: (path: string, id: string) => Promise<void>
  setActiveCommentId: (id: string | null) => void

  /* ---- Legacy compatibility aliases used by NoteList / Sidebar ---- */
  openNoteInTab: (relPath: string) => Promise<void>
  closeTab: (relPath: string) => Promise<void>

  clearPendingTitleFocus: () => void
  clearPendingJumpLocation: () => void
  /** Rewrite `#oldTag` → `#newTag` across every non-trash note. */
  renameTag: (oldTag: string, newTag: string) => Promise<void>
  /** Remove `#tag` from every non-trash note. */
  deleteTag: (tag: string) => Promise<void>
  createFolder: (folder: NoteFolder, subpath: string) => Promise<void>
  renameFolder: (
    folder: NoteFolder,
    oldSubpath: string,
    newSubpath: string
  ) => Promise<void>
  deleteFolder: (folder: NoteFolder, subpath: string) => Promise<void>
  duplicateFolder: (folder: NoteFolder, subpath: string) => Promise<void>
  revealFolder: (folder: NoteFolder, subpath: string) => Promise<void>
  revealAssetsDir: () => Promise<void>
  /** Move a note to a different folder + subpath. */
  moveNote: (
    relPath: string,
    targetFolder: NoteFolder,
    targetSubpath: string
  ) => Promise<void>
  init: () => Promise<void>
  openVaultPicker: () => Promise<void>
  openLocalVault: (root: string) => Promise<void>
  closeVault: () => Promise<void>
  connectRemoteWorkspace: () => Promise<void>
  connectRemoteWorkspaceProfile: (id: string) => Promise<void>
  changeRemoteWorkspaceVaultPath: () => Promise<void>
  disconnectRemoteWorkspace: () => Promise<void>
  /** Re-attempt the workspace configured on disk after the server was
   *  unreachable at boot; full init on success, refreshed error on failure. */
  retryWorkspaceBoot: () => Promise<void>
  saveRemoteWorkspaceProfile: (input: RemoteWorkspaceProfileInput) => Promise<RemoteWorkspaceProfile>
  deleteRemoteWorkspaceProfile: (id: string) => Promise<void>
  refreshRemoteWorkspaceProfiles: () => Promise<RemoteWorkspaceProfile[]>
  refreshLocalVaults: () => Promise<LocalVaultEntry[]>
  persistWorkspace: () => void
  flushDirtyNotes: () => Promise<void>
  refreshWorkspaceContext: () => Promise<RemoteWorkspaceInfo | null>
}

/** Debounced per-path save timers. Module-scoped so they survive re-renders. */
const pathSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Per-path write tails. Filesystems and remote workspaces do not promise that
 *  two concurrent writes finish in call order, so a newer body must not race an
 *  older one to the final rename. */
const pathSaveQueues = new Map<string, Promise<void>>()
const PATH_SAVE_DEBOUNCE_MS = 350

/**
 * The body we most recently wrote to each path. The vault file watcher
 * inevitably echoes our own writes back through `applyChange` after a
 * short delay — when we recognise the echo (disk body === what we
 * wrote) we skip the refresh. Without this, edits made between save
 * completion and echo arrival get rolled back to the older disk body.
 */
const lastWrittenByPath = new Map<string, string>()

/**
 * Old paths of renames the host has not answered yet. A rename is a move on
 * disk, and the watcher reports a move as an unlink of the old path followed
 * by an add of the new one; on Linux (inotify) the unlink lands in the
 * renderer within milliseconds, while the reply to the rename waits for the
 * host to rewrite every inbound wikilink first. So the unlink arrived first,
 * closed the note's tab as a deletion, and the reply then renamed a tab that
 * was no longer there: the renamed note vanished from the editor (#713).
 * macOS delivers file events late enough that the reply usually won, which
 * is why the race only showed on Linux. While a path is in this set, its
 * unlink is the rename's own echo and its tab is kept through refreshes.
 */
const renamesInFlight = new Set<string>()

// --- CSV database debounced persistence + echo suppression ---
const DATABASE_SAVE_DEBOUNCE_MS = 400
const databaseSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** A pending write that touched the schema must persist the sidecar too. */
const databaseWriteKind = new Map<string, 'rows' | 'schema'>()
/** When we last wrote a database; used to ignore the watcher echo of our own write. */
const lastDatabaseWriteAt = new Map<string, number>()

function databaseToSidecar(doc: DatabaseDoc): DatabaseSidecar {
  return {
    version: 1,
    idFieldId: doc.idFieldId,
    fields: doc.fields,
    views: doc.views,
    activeViewId: doc.activeViewId,
    ...(doc.pages ? { pages: doc.pages } : {})
  }
}

function scheduleDatabaseWrite(
  csvPath: string,
  kind: 'rows' | 'schema',
  getDoc: () => DatabaseDoc | undefined
): void {
  const prev = databaseWriteKind.get(csvPath)
  databaseWriteKind.set(csvPath, kind === 'schema' || prev === 'schema' ? 'schema' : 'rows')
  const existing = databaseSaveTimers.get(csvPath)
  if (existing) clearTimeout(existing)
  databaseSaveTimers.set(
    csvPath,
    setTimeout(() => {
      databaseSaveTimers.delete(csvPath)
      const writeKind = databaseWriteKind.get(csvPath) ?? 'rows'
      databaseWriteKind.delete(csvPath)
      const doc = getDoc()
      if (!doc) return
      const done = (): void => {
        lastDatabaseWriteAt.set(csvPath, Date.now())
      }
      const write =
        writeKind === 'schema'
          ? window.zen.writeDatabaseSchema(csvPath, databaseToSidecar(doc), doc.rows)
          : window.zen.writeDatabaseRows(csvPath, doc.rows)
      void write.catch((err) => console.error('database write failed', err)).finally(done)
    }, DATABASE_SAVE_DEBOUNCE_MS)
  )
}

/**
 * The database table is the source of truth for a record's properties; the
 * record-page note's frontmatter is a derived "metadata" mirror. Whenever the
 * table changes (a cell value, an added/renamed/removed field), re-mirror the
 * frontmatter of any record page that's currently open so it updates live —
 * preserving the page's body. Pages that aren't open are re-mirrored lazily the
 * next time they're opened (see `openRecordPage`).
 */
function remirrorOpenRecordPages(
  csvPath: string,
  get: () => {
    databases: Record<string, DatabaseDoc>
    noteContents: Record<string, NoteContent>
    updateNoteBody: (path: string, body: string) => void
  }
): void {
  const doc = get().databases[csvPath]
  if (!doc?.pages) return
  const { noteContents } = get()
  for (const [rowId, pagePath] of Object.entries(doc.pages)) {
    const current = noteContents[pagePath]
    if (!current) continue // not open — re-mirrored on next open
    const row = doc.rows.find((r) => r.id === rowId)
    if (!row) continue
    const { body } = parseFrontmatter(current.body)
    const next = composePageBody(doc, row, body)
    if (next !== current.body) get().updateNoteBody(pagePath, next)
  }
}

function normalizeServerBaseUrl(value: string): string {
  const trimmed = value.trim()
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return normalized.replace(/\/+$/, '')
}

function deriveRemoteProfileName(
  baseUrl: string,
  vault: VaultInfo | null,
  existing: RemoteWorkspaceProfile[]
): string {
  let host = 'ZenNotes Server'
  try {
    host = new URL(normalizeServerBaseUrl(baseUrl)).host || host
  } catch {
    host = normalizeServerBaseUrl(baseUrl)
  }
  const base = vault?.name ? `${vault.name} (${host})` : host
  if (!existing.some((entry) => entry.name === base)) return base
  let suffix = 2
  while (existing.some((entry) => entry.name === `${base} ${suffix}`)) suffix += 1
  return `${base} ${suffix}`
}

function findMatchingRemoteProfile(
  profiles: RemoteWorkspaceProfile[],
  baseUrl: string,
  vaultPath: string | null
): RemoteWorkspaceProfile | null {
  const normalizedBaseUrl = normalizeServerBaseUrl(baseUrl)
  return (
    profiles.find(
      (entry) =>
        normalizeServerBaseUrl(entry.baseUrl) === normalizedBaseUrl &&
        (entry.vaultPath ?? null) === (vaultPath ?? null)
    ) ?? null
  )
}

function workspaceModeFrom(info: RemoteWorkspaceInfo | null): WorkspaceMode {
  return info?.mode === 'remote' ? 'remote' : 'local'
}

async function ensureWebServerSession(
  capabilities?: ServerCapabilities | null
): Promise<boolean> {
  if (window.zen.getAppInfo().runtime !== 'web') return true

  const serverCapabilities = capabilities ?? (await window.zen.getServerCapabilities())
  if (!serverCapabilities?.authRequired || !serverCapabilities.supportsSessionLogin) {
    return true
  }

  const session = await window.zen.getServerSession()
  if (session.authenticated) return true

  const token = await promptApp({
    title: 'Server Auth Token',
    description:
      'This ZenNotes server requires its auth token before notes can be accessed in the browser.',
    placeholder: 'Enter the server auth token',
    okLabel: 'Sign In',
    plainInput: true
  })
  if (!token?.trim()) return false

  await window.zen.loginServerSession(token.trim())
  return true
}

function describeWebServerSetupError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const normalized = message.toLowerCase()
  if (
    normalized.includes('/capabilities') ||
    normalized.includes('fetch failed') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('proxy error') ||
    normalized.includes('econnrefused') ||
    normalized.includes('internal server error')
  ) {
    return [
      'ZenNotes could not reach its server API.',
      'For normal self-hosted use, run `make up` and open http://localhost:7878.',
      'If you are using the web dev server, make sure `npm run dev:server` is running too.'
    ].join(' ')
  }
  return message
}

function activeFieldsFrom(
  layout: PaneLayout,
  activePaneId: string,
  noteContents: Record<string, NoteContent>,
  noteDirty: Record<string, boolean>
): { selectedPath: string | null; activeNote: NoteContent | null; activeDirty: boolean } {
  const leaf = findLeaf(layout, activePaneId)
  const path = leaf?.activeTab ?? null
  return {
    selectedPath: path,
    activeNote: path ? noteContents[path] ?? null : null,
    activeDirty: path ? noteDirty[path] ?? false : false
  }
}

function renameNoteState(
  s: Store,
  oldPath: string,
  meta: NoteMeta
): Partial<Store> {
  const rewrite = (p: string): string => (p === oldPath ? meta.path : p)
  const nextLayout = rewritePathsInTree(s.paneLayout, rewrite)
  const ensured = ensureActivePane(nextLayout, s.activePaneId)
  const contents = { ...s.noteContents }
  const dirty = { ...s.noteDirty }
  const prevContent = contents[oldPath]
  const prevDirty = dirty[oldPath] ?? false
  if (oldPath !== meta.path) {
    delete contents[oldPath]
    delete dirty[oldPath]
  }
  if (prevContent) {
    contents[meta.path] = { ...prevContent, ...meta }
  }
  dirty[meta.path] = prevDirty
  return {
    paneLayout: ensured.layout,
    activePaneId: ensured.activePaneId,
    noteContents: contents,
    noteDirty: dirty,
    notes: replaceNoteMeta(s.notes, oldPath, meta),
    noteBackstack: rewriteNoteJumpHistory(s.noteBackstack, rewrite),
    noteForwardstack: rewriteNoteJumpHistory(s.noteForwardstack, rewrite),
    pendingJumpLocation:
      s.pendingJumpLocation?.path === oldPath
        ? { ...s.pendingJumpLocation, path: meta.path }
        : s.pendingJumpLocation,
    pendingTitleFocusPath:
      s.pendingTitleFocusPath === oldPath ? meta.path : s.pendingTitleFocusPath,
    pinnedRefPath: s.pinnedRefPath === oldPath ? meta.path : s.pinnedRefPath,
    noteComments: rewriteNoteCommentsPath(s.noteComments, oldPath, meta.path),
    activeCommentId: s.activeCommentId,
    ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
  }
}

/**
 * After a rename, bring the note's leading `# Heading` along with the new
 * filename (#455). Opt-in via the `syncTitleHeadingOnRename` setting; a note
 * with no leading H1 is never given one.
 *
 * Runs for both open and closed notes: an open note goes through the normal
 * buffer + save path so every pane showing it repaints, while a closed one is
 * patched straight on disk rather than being pulled into the buffer map.
 * Callers should refresh notes afterwards so the excerpt catches up.
 */
async function syncHeadingAfterRename(
  meta: NoteMeta,
  get: () => {
    syncTitleHeadingOnRename: boolean
    noteContents: Record<string, NoteContent>
    updateNoteBody: (path: string, body: string) => void
    persistNote: (path: string) => Promise<void>
  }
): Promise<void> {
  if (!get().syncTitleHeadingOnRename) return
  // Markdown only, and never an Obsidian drawing: those are `.md` files whose
  // headings (`# Excalidraw Data`) are structure, not a title.
  if (!meta.path.toLowerCase().endsWith('.md')) return
  if (isObsidianExcalidrawPath(meta.path)) return
  try {
    const open = get().noteContents[meta.path]
    if (open) {
      if (isObsidianExcalidrawMarkdown(open.body)) return
      const next = retitleLeadingHeading(open.body, meta.title)
      if (next === open.body) return
      get().updateNoteBody(meta.path, next)
      await get().persistNote(meta.path)
      return
    }
    const content = await window.zen.readNote(meta.path)
    if (isObsidianExcalidrawMarkdown(content.body)) return
    const next = retitleLeadingHeading(content.body, meta.title)
    if (next === content.body) return
    await window.zen.writeNote(meta.path, next)
  } catch (err) {
    // The rename itself succeeded; a failed heading rewrite must not undo it.
    console.error('syncHeadingAfterRename failed', err)
  }
}

const MAX_DATE_NOTE_PATTERN_HISTORY = 20

function dateNotePatternKey(pattern: DateNotePatternSettings): string {
  return `${pattern.directory}\0${pattern.titlePattern ?? ''}\0${pattern.locale ?? ''}`
}

function currentDailyPatternFromSettings(settings: VaultSettings): DateNotePatternSettings {
  return {
    directory: settings.dailyNotes.directory,
    titlePattern: settings.dailyNotes.titlePattern,
    locale: settings.dailyNotes.locale
  }
}

function currentWeeklyPatternFromSettings(settings: VaultSettings): DateNotePatternSettings {
  return {
    directory: settings.weeklyNotes.directory,
    titlePattern: settings.weeklyNotes.titlePattern,
    locale: settings.weeklyNotes.locale
  }
}

function currentMonthlyPatternFromSettings(settings: VaultSettings): DateNotePatternSettings {
  return {
    directory: settings.monthlyNotes.directory,
    titlePattern: settings.monthlyNotes.titlePattern,
    locale: settings.monthlyNotes.locale
  }
}

function appendDateNotePatternHistory(
  history: readonly DateNotePatternSettings[] | undefined,
  previous: DateNotePatternSettings,
  current: DateNotePatternSettings
): DateNotePatternSettings[] {
  const out: DateNotePatternSettings[] = []
  const seen = new Set([dateNotePatternKey(current)])
  for (const pattern of [previous, ...(history ?? [])]) {
    const key = dateNotePatternKey(pattern)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(pattern)
    if (out.length >= MAX_DATE_NOTE_PATTERN_HISTORY) break
  }
  return out
}

function withDateNotePatternHistory(
  previousSettings: VaultSettings,
  requestedSettings: VaultSettings
): VaultSettings {
  const previous = normalizeVaultSettings(previousSettings)
  const next = normalizeVaultSettings(requestedSettings)
  const previousDaily = currentDailyPatternFromSettings(previous)
  const nextDaily = currentDailyPatternFromSettings(next)
  const previousWeekly = currentWeeklyPatternFromSettings(previous)
  const nextWeekly = currentWeeklyPatternFromSettings(next)
  const previousMonthly = currentMonthlyPatternFromSettings(previous)
  const nextMonthly = currentMonthlyPatternFromSettings(next)

  return {
    ...next,
    dailyNotes: {
      ...next.dailyNotes,
      legacyPatterns:
        previous.dailyNotes.enabled &&
        next.dailyNotes.enabled &&
        dateNotePatternKey(previousDaily) !== dateNotePatternKey(nextDaily)
          ? appendDateNotePatternHistory(
              next.dailyNotes.legacyPatterns,
              previousDaily,
              nextDaily
            )
          : next.dailyNotes.legacyPatterns
    },
    weeklyNotes: {
      ...next.weeklyNotes,
      legacyPatterns:
        previous.weeklyNotes.enabled &&
        next.weeklyNotes.enabled &&
        dateNotePatternKey(previousWeekly) !== dateNotePatternKey(nextWeekly)
          ? appendDateNotePatternHistory(
              next.weeklyNotes.legacyPatterns,
              previousWeekly,
              nextWeekly
            )
          : next.weeklyNotes.legacyPatterns
    },
    monthlyNotes: {
      ...next.monthlyNotes,
      legacyPatterns:
        previous.monthlyNotes.enabled &&
        next.monthlyNotes.enabled &&
        dateNotePatternKey(previousMonthly) !== dateNotePatternKey(nextMonthly)
          ? appendDateNotePatternHistory(
              next.monthlyNotes.legacyPatterns,
              previousMonthly,
              nextMonthly
            )
          : next.monthlyNotes.legacyPatterns
    }
  }
}

function rewriteNoteCommentsPath(
  comments: Record<string, NoteComment[]>,
  oldPath: string,
  nextPath: string
): Record<string, NoteComment[]> {
  if (oldPath === nextPath || !(oldPath in comments)) return comments
  const { [oldPath]: moving, ...rest } = comments
  return {
    ...rest,
    [nextPath]: moving.map((comment) => ({ ...comment, notePath: nextPath }))
  }
}

/** Ensure `activePaneId` points at a real leaf. Falls back to first leaf. */
function ensureActivePane(
  layout: PaneLayout,
  activePaneId: string
): { layout: PaneLayout; activePaneId: string } {
  if (findLeaf(layout, activePaneId)) return { layout, activePaneId }
  const first = allLeaves(layout)[0]
  return { layout, activePaneId: first?.id ?? activePaneId }
}

// Fresh empty leaf that owns the initial activePaneId. Held in module
// scope so the state initializer below can reference it.
const initialPane = makeLeaf()
const MAX_PREFETCHED_NOTE_CONTENTS = 48
const NOTE_PREFETCH_BATCH_SIZE = 12
const INITIAL_VISIBLE_NOTE_PREFETCH_CRITICAL_BATCH_SIZE = 8
const INITIAL_VISIBLE_NOTE_PREFETCH_BACKGROUND_DELAY_MS = 1_600
const noteReadPromises = new Map<string, Promise<NoteContent>>()
const prefetchedNotePaths: string[] = []

function noteReadCacheKey(
  state: Pick<Store, 'vault' | 'workspaceMode' | 'remoteWorkspaceInfo'>,
  relPath: string
): string {
  return [
    state.workspaceMode,
    state.vault?.root ?? '',
    state.remoteWorkspaceInfo?.baseUrl ?? '',
    state.remoteWorkspaceInfo?.profileId ?? '',
    relPath
  ].join('\0')
}

function clearNoteContentReadCaches(): void {
  noteReadPromises.clear()
  prefetchedNotePaths.length = 0
}

function readNoteContent(relPath: string, state: Store): Promise<NoteContent> {
  const cacheKey = noteReadCacheKey(state, relPath)
  const pending = noteReadPromises.get(cacheKey)
  if (pending) return pending

  const next = window.zen.readNote(relPath).finally(() => {
    noteReadPromises.delete(cacheKey)
  })
  noteReadPromises.set(cacheKey, next)
  return next
}

function rememberPrefetchedPath(path: string): void {
  const existing = prefetchedNotePaths.indexOf(path)
  if (existing >= 0) prefetchedNotePaths.splice(existing, 1)
  prefetchedNotePaths.push(path)
}

function prunePrefetchedContents(s: Store): Partial<Store> {
  if (prefetchedNotePaths.length <= MAX_PREFETCHED_NOTE_CONTENTS) return {}

  const contents = { ...s.noteContents }
  const dirty = { ...s.noteDirty }
  while (prefetchedNotePaths.length > MAX_PREFETCHED_NOTE_CONTENTS) {
    const path = prefetchedNotePaths.shift()
    if (!path) continue
    const referenced =
      s.selectedPath === path ||
      s.pinnedRefPath === path ||
      allLeaves(s.paneLayout).some((leaf) => leaf.tabs.includes(path))
    if (referenced || dirty[path]) continue
    delete contents[path]
    delete dirty[path]
  }

  return { noteContents: contents, noteDirty: dirty }
}

function initialVisibleNotePrefetchPaths(state: Pick<Store, 'notes' | 'noteSortOrder'>): string[] {
  return selectInitialVisibleNotePrefetchPaths(state.notes, state.noteSortOrder)
}

async function prefetchInitialVisibleNotes(state: Store): Promise<void> {
  const paths = initialVisibleNotePrefetchPaths(state)
  if (paths.length === 0) return

  const existing = new Set(Object.keys(state.noteContents))
  const livePaths = new Set(state.notes.map((note) => note.path))
  const candidates = paths
    .filter((path) => livePaths.has(path))
    .filter((path) => !isWorkspaceVirtualTabPath(path))
    .filter((path) => !existing.has(path))
    .slice(0, INITIAL_VISIBLE_NOTE_PREFETCH_BATCH_SIZE)

  if (candidates.length === 0) return

  const criticalCandidates = candidates.slice(0, INITIAL_VISIBLE_NOTE_PREFETCH_CRITICAL_BATCH_SIZE)
  const backgroundCandidates = candidates.slice(criticalCandidates.length)
  const scheduleBackgroundPrefetch = (): void => {
    if (backgroundCandidates.length === 0) return
    window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(
          () => useStore.getState().prefetchNotes(backgroundCandidates),
          { timeout: 2_000 }
        )
        return
      }
      useStore.getState().prefetchNotes(backgroundCandidates)
    }, INITIAL_VISIBLE_NOTE_PREFETCH_BACKGROUND_DELAY_MS)
  }

  const startedAt = performance.now()
  if (criticalCandidates.length > 0) {
    useStore.getState().prefetchNotes(criticalCandidates)
  }
  recordRendererPerf('store.initial-prefetch', performance.now() - startedAt, {
    requested: criticalCandidates.length,
    backgroundQueued: backgroundCandidates.length,
    mode: 'scheduled'
  })
  scheduleBackgroundPrefetch()
}

/**
 * The workspace with `path` gone: its tabs closed, its buffer and dirty flag
 * dropped, the reference pane unpinned if it was showing it. The one shape
 * trashing, archiving and deleting a note all leave behind.
 */
function withoutNoteInWorkspace(s: Store, path: string): Partial<Store> {
  const nextLayout = rewritePathsInTree(s.paneLayout, (p) => (p === path ? null : p))
  const ensured = ensureActivePane(nextLayout, s.activePaneId)
  const { [path]: _drop, ...contents } = s.noteContents
  const { [path]: _d, ...dirty } = s.noteDirty
  void _drop
  void _d
  return {
    paneLayout: ensured.layout,
    activePaneId: ensured.activePaneId,
    noteContents: contents,
    noteDirty: dirty,
    pendingJumpLocation: null,
    pinnedRefPath: s.pinnedRefPath === path ? null : s.pinnedRefPath,
    ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
  }
}

export const useStore = create<Store>((set, get) => {
  const selectNoteImpl = async (
    relPath: string | null,
    historyMode: 'push' | 'preserve' = 'push',
    opts?: { preview?: boolean }
  ): Promise<boolean> => {
    const startedAt = performance.now()
    const state = get()
    const activeLeaf = findLeaf(state.paneLayout, state.activePaneId)
    if (!activeLeaf) return false

    // Preview opens reuse the pane's preview slot; permanent opens promote
    // the path if it was previously sitting in that slot.
    const addTabToLeaf = (l: PaneLeaf, path: string): PaneLeaf =>
      opts?.preview
        ? leafWithPreviewTab(l, path)
        : leafWithPromotedTab(leafWithAddedTab(l, path), path)

    if (!relPath) {
      const nextLayout =
        updateLeaf(state.paneLayout, activeLeaf.id, (l) => ({
          ...l,
          tabs: [],
          activeTab: null
        })) ?? makeLeaf()
      // If the tree lost the active leaf (shouldn't here, but defensively),
      // pin active to a surviving leaf.
      const ensured = ensureActivePane(nextLayout, state.activePaneId)
      const active = activeFieldsFrom(
        ensured.layout,
        ensured.activePaneId,
        state.noteContents,
        state.noteDirty
      )
      set({
        paneLayout: ensured.layout,
        activePaneId: ensured.activePaneId,
        ...active,
        loadingNote: false,
        pendingJumpLocation: null
      })
      return true
    }

    if (isWorkspaceVirtualTabPath(relPath)) {
      if (
        state.selectedPath &&
        state.selectedPath !== relPath &&
        !isWorkspaceVirtualTabPath(state.selectedPath) &&
        state.noteDirty[state.selectedPath]
      ) {
        await get().persistNote(state.selectedPath)
      }
      const latest = get()
      const leafNow = findLeaf(latest.paneLayout, latest.activePaneId)
      if (!leafNow) return false
      const nextLayout =
        updateLeaf(latest.paneLayout, leafNow.id, (l) => leafWithAddedTab(l, relPath)) ??
        latest.paneLayout
      set({
        paneLayout: nextLayout,
        loadingNote: false,
        pendingJumpLocation: null,
        ...activeFieldsFrom(nextLayout, latest.activePaneId, latest.noteContents, latest.noteDirty)
      })
      recordRendererPerf('note.open.virtual', performance.now() - startedAt, {
        path: relPath
      })
      return true
    }

    if (
      activeLeaf.activeTab === relPath &&
      state.noteContents[relPath] &&
      !state.loadingNote
    ) {
      if (!activeLeaf.tabs.includes(relPath)) {
        const layout =
          updateLeaf(state.paneLayout, activeLeaf.id, (l) => addTabToLeaf(l, relPath)) ??
          state.paneLayout
        set({
          paneLayout: layout,
          ...activeFieldsFrom(layout, state.activePaneId, state.noteContents, state.noteDirty)
        })
      } else if (!opts?.preview && activeLeaf.previewTab === relPath) {
        // Permanent re-open of the tab that is currently previewing (e.g.
        // double-click or Enter right after a single click) promotes it.
        const layout =
          updateLeaf(state.paneLayout, activeLeaf.id, (l) =>
            leafWithPromotedTab(l, relPath)
          ) ?? state.paneLayout
        set({ paneLayout: layout })
      }
      recordRendererPerf('note.open.cached', performance.now() - startedAt, {
        path: relPath
      })
      return true
    }

    if (state.noteContents[relPath]) {
      const nextLayout =
        updateLeaf(state.paneLayout, activeLeaf.id, (l) => addTabToLeaf(l, relPath)) ??
        state.paneLayout
      set({
        paneLayout: nextLayout,
        ...(historyMode === 'push'
          ? noteHistoryAfterJump(state, relPath)
          : { noteBackstack: state.noteBackstack, noteForwardstack: state.noteForwardstack }),
        pendingJumpLocation: null,
        loadingNote: false,
        ...activeFieldsFrom(nextLayout, state.activePaneId, state.noteContents, state.noteDirty)
      })
      recordRendererPerf('note.open.cached', performance.now() - startedAt, {
        path: relPath
      })
      return true
    }

    // Flush pending save for whatever was focused before switching away.
    if (
      state.selectedPath &&
      state.selectedPath !== relPath &&
      !isWorkspaceVirtualTabPath(state.selectedPath) &&
      state.noteDirty[state.selectedPath]
    ) {
      await get().persistNote(state.selectedPath)
    }

    const latest = get()
    const { noteBackstack: nextBackstack, noteForwardstack: nextForwardstack } =
      historyMode === 'push'
        ? noteHistoryAfterJump(latest, relPath)
        : { noteBackstack: latest.noteBackstack, noteForwardstack: latest.noteForwardstack }

    set({ loadingNote: true })
    try {
      const readScopeKey = noteReadCacheKey(latest, relPath)
      const content = await readNoteContent(relPath, latest)
      const s = get()
      if (noteReadCacheKey(s, relPath) !== readScopeKey) {
        set({ loadingNote: false })
        return false
      }
      const leafNow = findLeaf(s.paneLayout, s.activePaneId)
      if (!leafNow) {
        set({ loadingNote: false })
        return false
      }
      const nextLayout =
        updateLeaf(s.paneLayout, leafNow.id, (l) => addTabToLeaf(l, relPath)) ??
        s.paneLayout
      const contents = { ...s.noteContents, [relPath]: content }
      const dirty = { ...s.noteDirty, [relPath]: false }
      set({
        paneLayout: nextLayout,
        noteContents: contents,
        noteDirty: dirty,
        loadingNote: false,
        ...activeFieldsFrom(nextLayout, s.activePaneId, contents, dirty),
        noteBackstack: nextBackstack,
        noteForwardstack: nextForwardstack,
        pendingJumpLocation: null
      })
      recordRendererPerf('note.open.uncached', performance.now() - startedAt, {
        path: relPath
      })
      return true
    } catch (err) {
      recordRendererPerf('note.open.error', performance.now() - startedAt, {
        path: relPath
      })
      console.error('readNote failed', err)
      set({ loadingNote: false, pendingJumpLocation: null })
      return false
    }
  }

  const jumpThroughNoteHistory = async (direction: 'back' | 'forward'): Promise<void> => {
    const state = get()
    const source =
      direction === 'back' ? [...state.noteBackstack] : [...state.noteForwardstack]
    if (source.length === 0) return

    if (state.selectedPath && state.noteDirty[state.selectedPath]) {
      await get().persistNote(state.selectedPath)
    }

    set({ loadingNote: true })
    while (source.length > 0) {
      const target = source.pop() ?? null
      if (!target || target.path === get().selectedPath || !isJumpHistoryTabPath(target.path)) {
        continue
      }
      // A virtual surface in the history — a database grid a record page was
      // opened from, or the Tasks/Tags view (#633). Reopen the tab instead of
      // loading note content, and record the current location on the opposite
      // stack so the jump stays reversible.
      if (isWorkspaceVirtualTabPath(target.path)) {
        const latest = get()
        const opposite =
          direction === 'back' ? latest.noteForwardstack : latest.noteBackstack
        const nextOpposite = appendNoteJumpHistory(opposite, captureNoteJumpLocation(latest))
        set({
          loadingNote: false,
          pendingJumpLocation: null,
          noteBackstack: direction === 'back' ? source : nextOpposite,
          noteForwardstack: direction === 'back' ? nextOpposite : source
        })
        // Tasks/Tags go through focusTabInPane, which carries each panel's
        // reopen semantics (focus claim, task refresh) and records no history
        // of its own; database surfaces keep their selectNote path.
        if (isDatabaseSurfaceTabPath(target.path)) {
          await selectNoteImpl(target.path, 'preserve')
        } else {
          await get().focusTabInPane(latest.activePaneId, target.path)
        }
        return
      }
      try {
        const content = await readNoteContent(target.path, get())
        const latest = get()
        const leaf = findLeaf(latest.paneLayout, latest.activePaneId)
        if (!leaf) continue
        const currentSnapshot = captureNoteJumpLocation(latest)
        const opposite =
          direction === 'back' ? latest.noteForwardstack : latest.noteBackstack
        const nextOpposite = appendNoteJumpHistory(opposite, currentSnapshot)
        const nextLayout =
          updateLeaf(latest.paneLayout, leaf.id, (l) => leafWithAddedTab(l, target.path)) ??
          latest.paneLayout
        const contents = { ...latest.noteContents, [target.path]: content }
        const dirty = { ...latest.noteDirty, [target.path]: false }
        set({
          paneLayout: nextLayout,
          noteContents: contents,
          noteDirty: dirty,
          loadingNote: false,
          pendingJumpLocation: target,
          noteBackstack: direction === 'back' ? source : nextOpposite,
          noteForwardstack: direction === 'back' ? nextOpposite : source,
          ...activeFieldsFrom(nextLayout, latest.activePaneId, contents, dirty)
        })
        return
      } catch (err) {
        console.error(`jump ${direction} readNote failed`, err)
      }
    }

    set({
      loadingNote: false,
      pendingJumpLocation: null,
      noteBackstack: direction === 'back' ? [] : state.noteBackstack,
      noteForwardstack: direction === 'forward' ? [] : state.noteForwardstack
    })
  }

  const scheduleAssetsRefreshForVault = (vault: VaultInfo): void => {
    window.setTimeout(() => {
      if (get().vault?.root !== vault.root) return
      void get().refreshAssets()
    }, 2000)
  }

  const restoreWorkspaceForVault = async (vault: VaultInfo): Promise<void> => {
    const startedAt = performance.now()
    // Overlay this vault's per-vault view overrides onto the live prefs — only
    // in per-vault scope; in 'global' scope the global prefs win. (#292)
    if (get().viewSettingsScope === 'vault') {
      const viewOverlay = viewPrefsFromVault(get().vaultSettings)
      if (Object.keys(viewOverlay).length > 0) set(viewOverlay)
    }
    // Prefer the synced .zennotes/workspace.json when it's newer than the local
    // cache, so opening a vault on another machine restores its workspace. (#292)
    const rawSnapshot = await loadBestWorkspaceSnapshot(vault.root)
    if (!rawSnapshot || typeof rawSnapshot !== 'object') {
      set({
        collapsedFolders: computeStartupCollapsedFolders(
          get().folders,
          get().vaultSettings,
          null
        ),
        workspaceRestored: true
      })
      scheduleAssetsRefreshForVault(vault)
      recordRendererPerf('workspace.restore.empty', performance.now() - startedAt)
      return
    }

    const snapshot = rawSnapshot as Partial<WorkspaceSnapshot>
    let layout = sanitizeWorkspaceLayout(snapshot.paneLayout)
    // A workspace saved while Workflows was on (or synced from a machine where
    // it still is) must not resurrect the canvas for someone who turned the
    // feature off.
    if (!get().workflowsEnabled) {
      layout = rewritePathsInTree(layout, (path) => (isWorkflowsTabPath(path) ? null : path))
    }
    if (!get().atlasEnabled) {
      layout = rewritePathsInTree(layout, (path) => (isAtlasTabPath(path) ? null : path))
    }
    const unreadable = new Set<string>()
    const contents: Record<string, NoteContent> = {}
    const dirty: Record<string, boolean> = {}
    const pathsToLoad = initialWorkspaceRestoreContentPaths(layout)

    await Promise.all(
      pathsToLoad.map(async (path) => {
        try {
          contents[path] = await readNoteContent(path, get())
          dirty[path] = false
        } catch (err) {
          unreadable.add(path)
          console.error('restoreWorkspace readNote failed', err)
        }
      })
    )

    if (unreadable.size > 0) {
      layout = rewritePathsInTree(layout, (path) => (unreadable.has(path) ? null : path))
    }

    const ensured = ensureActivePane(
      layout,
      typeof snapshot.activePaneId === 'string' ? snapshot.activePaneId : ''
    )
    const active = activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
    const restoredView = normalizeWorkspaceView(snapshot.view)
    const nextView: View = active.selectedPath
      ? restoredView
      : { kind: 'folder', folder: 'inbox', subpath: '' }
    const collapsedFolders = computeStartupCollapsedFolders(
      get().folders,
      get().vaultSettings,
      active.selectedPath
    )

    set({
      paneLayout: ensured.layout,
      activePaneId: ensured.activePaneId,
      noteContents: contents,
      noteDirty: dirty,
      view: nextView,
      sidebarOpen:
        typeof snapshot.sidebarOpen === 'boolean'
          ? snapshot.sidebarOpen
          : get().sidebarOpen,
      noteListOpen:
        typeof snapshot.noteListOpen === 'boolean'
          ? snapshot.noteListOpen
          : get().noteListOpen,
      selectedTags: normalizeWorkspaceTags(snapshot.selectedTags),
      collapsedFolders,
      workspaceRestored: true,
      ...active
    })
    scheduleAssetsRefreshForVault(vault)
    recordRendererPerf('workspace.restore', performance.now() - startedAt, {
      panes: allLeaves(ensured.layout).length,
      eagerNotes: pathsToLoad.length
    })
  }

  /** #564: the saved workspace snapshot is tiny next to the note index, so the
   *  tabs paint first and the vault scan lands afterwards. The snapshot is
   *  trusted up front; once the listing arrives, `refreshNotes` prunes tabs
   *  whose notes are gone (with the #384 guard against transient wipes), the
   *  freshly discovered folders join the startup-collapsed set, and background
   *  tabs get the deferred content warm-up the restore itself skipped. */
  const openVaultWorkspace = async (vault: VaultInfo): Promise<void> => {
    await restoreWorkspaceForVault(vault)
    await refreshVaultIndexes()
    if (get().vault?.root !== vault.root) return
    // The snapshot was trusted before the index existed; now that the real
    // listing is here, run the strict check the pre-2.27 restore order gave
    // for free: every restored tab whose note never materialized is closed,
    // active or not. refreshNotes cannot do this on its own (its mid-save
    // exemption and the #384 transient-wipe guard both assume the tabs they
    // keep were verified once), so a snapshot synced from another machine
    // would otherwise leave ghost tabs alive for the whole session. Dirty
    // tabs stay (unsaved edits beat a stale listing), and an empty listing
    // skips the pass: it is indistinguishable from a failed one (#384).
    set((s) => {
      if (s.notes.length === 0) return {}
      const existing = new Set(s.notes.map((note) => note.path))
      const keepTab = (path: string): boolean =>
        existing.has(path) || isWorkspaceVirtualTabPath(path) || s.noteDirty[path] === true
      const stale = allLeaves(s.paneLayout)
        .flatMap((leaf) => leaf.tabs)
        .filter((tab) => !keepTab(tab))
      if (stale.length === 0) return {}
      const validated = rewritePathsInTree(s.paneLayout, (path) =>
        keepTab(path) ? path : null
      )
      const ensured = ensureActivePane(validated, s.activePaneId)
      return {
        paneLayout: ensured.layout,
        activePaneId: ensured.activePaneId,
        ...activeFieldsFrom(ensured.layout, ensured.activePaneId, s.noteContents, s.noteDirty)
      }
    })
    const s = get()
    // Folder rows did not exist while the workspace painted, so collapse the
    // ones the index just discovered. Quick Notes and Inbox were decided at
    // restore time (and may have been toggled since), so they stay untouched.
    const startupCollapsed = computeStartupCollapsedFolders(
      s.folders,
      s.vaultSettings,
      s.selectedPath
    )
    const discovered = startupCollapsed.filter(
      (key) => key !== 'quick:' && key !== 'inbox:' && !s.collapsedFolders.includes(key)
    )
    if (discovered.length > 0) {
      set({ collapsedFolders: [...s.collapsedFolders, ...discovered] })
    }
    const prefetchPaths = workspaceRestorePrefetchContentPaths(
      get().paneLayout,
      new Set(get().notes.map((note) => note.path)),
      new Set(Object.keys(get().noteContents))
    )
    if (prefetchPaths.length > 0) {
      window.setTimeout(() => get().prefetchNotes(prefetchPaths), 120)
    }
  }

  return {
  vault: null,
  workspaceMode: 'local',
  remoteWorkspaceInfo: null,
  remoteWorkspaceProfiles: [],
  localVaults: [],
  workspaceSetupError: null,
  vaultSettings: DEFAULT_VAULT_SETTINGS,
  rootContentHiddenByInboxMode: false,
  rootContentBannerDismissed: false,
  manualNoteOrder: {},
  notes: [],
  typstPreambleNotes: [],
  folders: [],
  assetFiles: [],
  assetUndoStack: [],
  hasAssetsDir: false,
  view: { kind: 'folder', folder: 'inbox', subpath: '' },
  selectedPath: null,
  activeNote: null,
  activeDirty: false,
  noteBackstack: [],
  noteForwardstack: [],
  pendingJumpLocation: null,
  loadingNote: false,
  searchOpen: false,
  vaultTextSearchOpen: false,
  commandPaletteOpen: false,
  commandPaletteInitialMode: 'main',
  bufferPaletteOpen: false,
  outlinePaletteOpen: false,
  templatePaletteOpen: false,
  embedDrawingPaletteOpen: false,
  excalidrawPreviewVersion: 0,
  templatePaletteMode: 'create',
  templatePaletteTarget: null,
  customTemplates: [],
  workflowIndex: [],
  query: '',
  initialized: false,
  workspaceRestored: false,
  sidebarOpen: true,
  noteListOpen: true,
  zenMode: false,
  zenRestoreState: null,
  vimMode: loadPrefs().vimMode,
  vimInsertEscape: loadPrefs().vimInsertEscape,
  vimYankToClipboard: loadPrefs().vimYankToClipboard,
  vimBlockImeInNormalMode: loadPrefs().vimBlockImeInNormalMode,
  vimWrappedLineMotions: loadPrefs().vimWrappedLineMotions,
  keymapOverrides: loadPrefs().keymapOverrides,
  enabledOverrides: loadPrefs().enabledOverrides,
  themeTweaks: loadPrefs().themeTweaks,
  whichKeyHints: loadPrefs().whichKeyHints,
  whichKeyHintMode: loadPrefs().whichKeyHintMode,
  whichKeyHintTimeoutMs: loadPrefs().whichKeyHintTimeoutMs,
  vaultTextSearchBackend: loadPrefs().vaultTextSearchBackend,
  ripgrepBinaryPath: loadPrefs().ripgrepBinaryPath,
  fzfBinaryPath: loadPrefs().fzfBinaryPath,
  livePreview: loadPrefs().livePreview,
  showHeadingLevelLabels: loadPrefs().showHeadingLevelLabels,
  listIndentGuides: loadPrefs().listIndentGuides,
  renderTablesInLivePreview: loadPrefs().renderTablesInLivePreview,
  completedTaskStyle: loadPrefs().completedTaskStyle,
  mathRenderer: loadPrefs().mathRenderer,
  typstTagPreambles: loadPrefs().typstTagPreambles,
  harperEnabled: loadPrefs().harperEnabled,
  harperDialect: loadPrefs().harperDialect,
  harperLintConfig: loadPrefs().harperLintConfig,
  looseMathDelimiters: loadPrefs().looseMathDelimiters,
  keepViewModeAcrossNotes: loadPrefs().keepViewModeAcrossNotes,
  defaultPaneMode: loadPrefs().defaultPaneMode,
  syncTitleHeadingOnRename: loadPrefs().syncTitleHeadingOnRename,
  markdownSnippets: loadPrefs().markdownSnippets,
  textReplacementsEnabled: loadPrefs().textReplacementsEnabled,
  textReplacements: loadPrefs().textReplacements,
  autoPairs: loadPrefs().autoPairs,
  autoPairQuotesInProse: loadPrefs().autoPairQuotesInProse,
  hideBuiltinTemplates: loadPrefs().hideBuiltinTemplates,
  tabsEnabled: loadPrefs().tabsEnabled,
  wrapTabs: loadPrefs().wrapTabs,
  settingsOpen: false,
  workflowTutorialStep: null,
  workflowRunRecord: null,
  themeId: loadPrefs().themeId,
  themeFamily: loadPrefs().themeFamily,
  themeMode: loadPrefs().themeMode,
  editorFontSize: loadPrefs().editorFontSize,
  mathFontScale: loadPrefs().mathFontScale,
  editorLineHeight: loadPrefs().editorLineHeight,
  editorTabSize: loadPrefs().editorTabSize,
  editorScrollOff: loadPrefs().editorScrollOff,
  timeFormat: loadPrefs().timeFormat,
  previewMaxWidth: loadPrefs().previewMaxWidth,
  lineNumberMode: loadPrefs().lineNumberMode,
  viewSettingsScope: loadPrefs().viewSettingsScope,
  pdfExportUseTheme: loadPrefs().pdfExportUseTheme,
  lineNumberPosition: loadPrefs().lineNumberPosition,
  interfaceFont: loadPrefs().interfaceFont,
  textFont: loadPrefs().textFont,
  monoFont: loadPrefs().monoFont,
  systemFolderLabels: loadPrefs().systemFolderLabels,
  sidebarWidth: loadPrefs().sidebarWidth,
  noteListWidth: loadPrefs().noteListWidth,
  noteSortOrder: loadPrefs().noteSortOrder,
  assetSortOrder: loadPrefs().assetSortOrder,
  groupByKind: loadPrefs().groupByKind,
  autoReveal: loadPrefs().autoReveal,
  unifiedSidebar: loadPrefs().unifiedSidebar,
  darkSidebar: loadPrefs().darkSidebar,
  showSidebarChevrons: loadPrefs().showSidebarChevrons,
  collapsedFolders: DEFAULT_PREFS.collapsedFolders,
  pinnedRefPath: loadPrefs().pinnedRefPath,
  pinnedRefFragment: null,
  pinnedRefVisible: loadPrefs().pinnedRefVisible,
  pinnedRefWidth: loadPrefs().pinnedRefWidth,
  panelWidths: loadPrefs().panelWidths,
  pinnedRefMode: loadPrefs().pinnedRefMode,
  quickNoteDateTitle: loadPrefs().quickNoteDateTitle,
  quickNoteTitlePrefix: loadPrefs().quickNoteTitlePrefix,
  wordWrap: loadPrefs().wordWrap,
  cursorBlink: loadPrefs().cursorBlink,
  previewSmoothScroll: loadPrefs().previewSmoothScroll,
  editorMaxWidth: loadPrefs().editorMaxWidth,
  pdfEmbedInEditMode: loadPrefs().pdfEmbedInEditMode,
  pinnedRefKind: loadPrefs().pinnedRefKind,
  noteRefs: loadPrefs().noteRefs,
  contentAlign: loadPrefs().contentAlign,
  tagsCollapsed: loadPrefs().tagsCollapsed,
  nestedTags: loadPrefs().nestedTags,
  workflowsEnabled: loadPrefs().workflowsEnabled,
  atlasEnabled: loadPrefs().atlasEnabled,
  hiddenWorkflowPresets: loadPrefs().hiddenWorkflowPresets,
  collapsedTagNodes: loadPrefs().collapsedTagNodes,
  autoCalendarPanel: loadPrefs().autoCalendarPanel,
  calendarWeekStart: loadPrefs().calendarWeekStart,
  calendarShowWeekNumbers: loadPrefs().calendarShowWeekNumbers,
  tasksViewMode: loadPrefs().tasksViewMode,
  showArchivedTasks: loadPrefs().showArchivedTasks,
  kanbanGroupBy: loadPrefs().kanbanGroupBy,
  kanbanColumnTitles: loadPrefs().kanbanColumnTitles,
  kanbanColumnOrder: loadPrefs().kanbanColumnOrder,
  kanbanCardOrder: loadPrefs().kanbanCardOrder,
  kanbanStatuses: loadPrefs().kanbanStatuses,
  hasCompletedOnboarding: loadPrefs().hasCompletedOnboarding,
  vaultTasks: [],
  customThemes: [],
  customCodeLanguages: [],
  customCodeLanguagesRevision: 0,
  overrides: [],
  tasksLoading: false,
  tasksFilter: '',
  taskCursorIndex: 0,
  tasksCalendarSelectedDate: null,
  tasksCalendarMonthAnchor: null,
  databases: {},
  databasesLoading: {},
  selectedTags: [],
  tagMatchMode: 'all',
  focusedPanel: null,
  sidebarCursorIndex: 0,
  dateNavExpanded: [],
  paneModes: {},
  paneStickyModes: {},
  noteListCursorIndex: 0,
  connectionsCursorIndex: 0,
  outlineCursorIndex: 0,
  connectionPreview: null,
  editorViewRef: null,
  editorCursorPosition: null,
  pendingTitleFocusPath: null,
  paneLayout: initialPane,
  activePaneId: initialPane.id,
  noteContents: {},
  noteDirty: {},
  noteComments: {},
  activeCommentId: null,
  closedTabStack: [],

  setVault: (v) =>
    set((s) => {
      const vaultChanged = s.vault?.root !== v?.root || s.vault?.name !== v?.name
      if (vaultChanged) {
        clearNoteContentReadCaches()
      }
      return vaultChanged ? { vault: v, assetUndoStack: [], closedTabStack: [] } : { vault: v }
    }),
  setVaultSettings: async (next) => {
    try {
      const settingsToSave = withDateNotePatternHistory(get().vaultSettings, next)
      const settings = normalizeVaultSettings(await window.zen.setVaultSettings(settingsToSave))
      set({
        vaultSettings: settings
      })
      await get().refreshNotes()
      await get().refreshRootContentHidden()
    } catch (err) {
      console.error('setVaultSettings failed', err)
    }
  },
  applyFavorites: async (nextFavorites) => {
    const current = get().vaultSettings
    if (
      current.favorites.length === nextFavorites.length &&
      current.favorites.every((f, i) => f === nextFavorites[i])
    ) {
      return // unchanged — skip the disk write
    }
    // Favorites don't affect note listing, so update optimistically and persist
    // without a full refreshNotes.
    set({ vaultSettings: { ...current, favorites: nextFavorites } })
    try {
      const saved = normalizeVaultSettings(
        await window.zen.setVaultSettings({ ...get().vaultSettings, favorites: nextFavorites })
      )
      set({ vaultSettings: saved })
    } catch (err) {
      console.error('applyFavorites failed', err)
      set({ vaultSettings: current }) // revert on failure
    }
  },
  toggleFavorite: async (key) => {
    if (!key) return
    await get().applyFavorites(toggleFavoriteKey(get().vaultSettings.favorites, key))
  },
  toggleTasksExcludedFolder: async (relDir) => {
    const cleaned = normalizeTasksExcludedFolder(relDir)
    if (!cleaned) return
    const settings = get().vaultSettings
    const current = settings.tasks?.excludedFolders ?? []
    const next = current.includes(cleaned)
      ? current.filter((f) => f !== cleaned)
      : [...current, cleaned]
    await get().setVaultSettings({
      ...settings,
      tasks: next.length > 0 ? { excludedFolders: next } : undefined
    })
    // Rescan immediately: the Tasks view, boards, and calendars should reflect
    // the exclusion without waiting for the next natural refresh.
    await get().refreshTasks()
  },
  setTypstPreambleFolder: async (folder) => {
    const settings = get().vaultSettings
    const cleaned = normalizeTypstPreambleFolder(folder)
    const next =
      cleaned && cleaned !== TYPST_PREAMBLE_FOLDER ? { folder: cleaned } : undefined
    if ((next?.folder ?? null) === (settings.typstPreambles?.folder ?? null)) return
    await get().setVaultSettings({ ...settings, typstPreambles: next })
    // Every note's tags may have changed: the old folder's notes get theirs
    // back, the new folder's lose them. The index was invalidated by the write,
    // so a plain refresh is enough to repaint the tag list.
    await get().refreshNotes()
    if (get().typstTagPreambles) await get().refreshTypstPreambles()
  },
  toggleFavoriteActiveNote: async () => {
    const path = get().activeNote?.path ?? get().selectedPath
    if (!path) return
    await get().toggleFavorite(path)
  },
  refreshRootContentHidden: async () => {
    try {
      const hidden = await window.zen.rootContentHiddenByInboxMode()
      const dismissed = readRootBannerDismissed(get().vault?.root ?? '')
      const cur = get()
      if (
        cur.rootContentHiddenByInboxMode !== hidden ||
        cur.rootContentBannerDismissed !== dismissed
      ) {
        set({ rootContentHiddenByInboxMode: hidden, rootContentBannerDismissed: dismissed })
      }
    } catch {
      // Non-fatal: the banner is advisory; keep the previous value on error.
    }
  },
  dismissRootContentBanner: () => {
    writeRootBannerDismissed(get().vault?.root ?? '')
    set({ rootContentBannerDismissed: true })
  },
  setNotes: (notes) => set({ notes }),
  setView: (view) => {
    set({
      view,
      selectedPath: null,
      activeNote: null,
      activeDirty: false,
      pendingJumpLocation: null
    })
    if (view.kind === 'assets') void get().refreshAssets()
  },

  openTasksView: async () => {
    const state = get()
    // Reset the panel's session state every time we open it — stale cursor/
    // filter from a prior visit would feel weird. Opening the panel is also a
    // jump worth undoing: record where the user came from so Ctrl+O returns
    // there, and the panel itself joins the trail (#633). `openNoteInPane`
    // below is the raw tab primitive and keeps no history of its own.
    set({ tasksFilter: '', taskCursorIndex: 0, ...noteHistoryAfterJump(state, TASKS_TAB_PATH) })
    // Add (or focus) the virtual Tasks tab in the currently active pane.
    await get().openNoteInPane(state.activePaneId, TASKS_TAB_PATH)
    // Hand keyboard focus to the Tasks panel so vim-style navigation works
    // immediately. Blur whatever held DOM focus (sidebar button etc.) so
    // native tab/focus rings don't fight with our panel's keydown handler.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    set({ focusedPanel: 'tasks' })
    // Kick off the scan lazily. First open does a cold fetch; subsequent
    // opens reuse whatever the watcher has kept fresh.
    if (state.vaultTasks.length === 0 || !state.tasksLoading) {
      void get().refreshTasks()
    }
  },

  closeTasksView: () => {
    // Remove the Tasks tab from every pane that has it. Multiple panes
    // showing tasks is allowed; closing should clean them all up.
    const state = get()
    for (const leaf of allLeaves(state.paneLayout)) {
      if (leaf.tabs.includes(TASKS_TAB_PATH)) {
        void get().closeTabInPane(leaf.id, TASKS_TAB_PATH)
      }
    }
    set({ tasksFilter: '', taskCursorIndex: 0 })
    // The Tasks panel held keyboard focus; hand it back to the editor so the
    // reopened note takes typing immediately, without a pane jump or click. (#353)
    requestEditorFocus()
  },

  openWorkflowsView: async () => {
    const state = get()
    // Single funnel for every entry point (sidebar row, command, leader key),
    // so the feature switch holds even if a caller forgets to check it.
    if (!state.workflowsEnabled) return
    await get().openNoteInPane(state.activePaneId, WORKFLOWS_TAB_PATH)
    // Deliberately NO blur here. This used to mirror the Tasks view and drop
    // focus from whatever opened it, but the ordering defeats the view: the tab
    // opens, React mounts WorkflowsView, its mount effect focuses the workflow
    // list, and only THEN does this line run and strip it again. Focus landed on
    // <body>, so j/k reached the document instead of the list and the whole view
    // read as broken in a keyboard-first app. The view claims the keyboard
    // itself, which also moves focus off the sidebar row this was blurring.
  },

  openTagView: async (tag) => {
    const state = get()
    const trimmed = tag?.trim() ?? ''
    const isOpen = allLeaves(state.paneLayout).some((l) =>
      l.tabs.includes(TAGS_TAB_PATH)
    )

    // Clicking a tag when the tab is already open toggles its membership
    // in the selection — narrows or widens the existing results without
    // spawning more tabs. First open starts with just this tag selected.
    if (trimmed) {
      if (isOpen) {
        get().toggleTagSelection(trimmed)
      } else {
        set({ selectedTags: [trimmed] })
      }
    }

    // Same as openTasksView: opening the panel is a jump, record the origin
    // so Ctrl+O returns to it and the panel joins the trail (#633).
    set(noteHistoryAfterJump(get(), TAGS_TAB_PATH))
    await get().openNoteInPane(state.activePaneId, TAGS_TAB_PATH)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    set({ focusedPanel: 'tags' })
  },

  closeTagView: () => {
    const state = get()
    for (const leaf of allLeaves(state.paneLayout)) {
      if (leaf.tabs.includes(TAGS_TAB_PATH)) {
        void get().closeTabInPane(leaf.id, TAGS_TAB_PATH)
      }
    }
    set({ selectedTags: [] })
    // Same as closeTasksView: return keyboard focus to the editor pane. (#353)
    requestEditorFocus()
  },

  openHelpView: async () => {
    const state = get()
    await get().openNoteInPane(state.activePaneId, HELP_TAB_PATH)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    set({ focusedPanel: 'editor' })
  },

  openQuickNotesView: async () => {
    const state = get()
    await get().openNoteInPane(state.activePaneId, QUICK_NOTES_TAB_PATH)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    set({ focusedPanel: 'editor' })
  },

  openArchiveView: async () => {
    const state = get()
    await get().openNoteInPane(state.activePaneId, ARCHIVE_TAB_PATH)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    set({ focusedPanel: 'editor' })
  },

  openTrashView: async () => {
    const state = get()
    await get().openNoteInPane(state.activePaneId, TRASH_TAB_PATH)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    set({ focusedPanel: 'editor' })
  },

  openAssetsView: async () => {
    // Refresh both: assets for the list, notes for fresh assetEmbeds (usage).
    await Promise.all([get().refreshAssets(), get().refreshNotes()])
    // The pane id must be read AFTER the refreshes. With no tabs open,
    // refreshNotes prunes the empty leaf and mints a replacement with a new
    // id (rewritePathsInTree returns makeLeaf() for a tree that pruned to
    // nothing), so an id snapshotted before the await names a pane that no
    // longer exists and openNoteInPane silently no-ops: clicking Assets on
    // the home screen did nothing. The sibling view openers have no await
    // between reading the id and using it.
    await get().openNoteInPane(get().activePaneId, ASSETS_VIEW_TAB_PATH)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    set({ focusedPanel: 'editor' })
  },
  loadDatabase: async (csvPath) => {
    if (get().databasesLoading[csvPath]) return
    set((s) => ({ databasesLoading: { ...s.databasesLoading, [csvPath]: true } }))
    try {
      const doc = await window.zen.openDatabase(csvPath)
      if (!doc) {
        // The .csv is gone — drop it and close any stale tab rather than leave
        // a grid pointed at a deleted file (and re-requesting it on every render).
        await get().forgetDatabase(csvPath)
        return
      }
      set((s) => ({ databases: { ...s.databases, [csvPath]: doc } }))
    } catch (err) {
      // Failing silently here is how "clicking a database does nothing" bug
      // reports happen (#499): the sidebar row looks live, the click dies in
      // the console. Whatever the cause (server unreachable, bad schema),
      // say so where the user is looking.
      console.error('loadDatabase failed', err)
      const { useToastStore } = await import('./lib/toast')
      useToastStore
        .getState()
        .addToast(humanIpcError(err, 'Could not open database'), 'error')
    } finally {
      set((s) =>
        csvPath in s.databasesLoading
          ? { databasesLoading: { ...s.databasesLoading, [csvPath]: false } }
          : {}
      )
    }
  },
  openDatabase: async (csvPath) => {
    await get().loadDatabase(csvPath)
    // The load may have failed/forgotten a now-missing database — don't open an
    // empty tab for it.
    if (!get().databases[csvPath]) return
    await get().openNoteInPane(get().activePaneId, databaseTabPath(csvPath))
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    set({ focusedPanel: 'editor' })
  },
  createDatabase: async (folder, subpath = '', title) => {
    try {
      const doc = await window.zen.createDatabase(folder, subpath, title)
      set((s) => ({ databases: { ...s.databases, [doc.path]: doc } }))
      await get().openNoteInPane(get().activePaneId, databaseTabPath(doc.path))
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      set({ focusedPanel: 'editor' })
    } catch (err) {
      console.error('createDatabase failed', err)
      const { useToastStore } = await import('./lib/toast')
      useToastStore
        .getState()
        .addToast(humanIpcError(err, 'Could not create database'), 'error')
    }
  },
  newDatabase: async () => {
    const s = get()
    const settings = normalizeVaultSettings(s.vaultSettings)
    const { folder, subpath } = resolveCreateLocation(
      settings.databasesLocation,
      s.activeNote,
      settings
    )
    await get().createDatabase(folder, subpath)
  },
  newTaskFile: async (opts) => {
    const title = (
      await promptApp({
        title: 'New task',
        placeholder: 'Task title, e.g. Buy groceries',
        okLabel: 'Create task'
      })
    )?.trim()
    if (!title) return null
    const s = get()
    const settings = normalizeVaultSettings(s.vaultSettings)
    // An explicit destination wins; otherwise fall back to the configured tasks
    // location (the inbox by default).
    const { folder, subpath } = opts
      ? { folder: opts.folder, subpath: opts.subpath ?? '' }
      : resolveCreateLocation(settings.tasksLocation, s.activeNote, settings)
    try {
      const meta = await window.zen.createNote(folder, title, subpath)
      rememberEditModeForCreatedNote(meta.path)
      // Overwrite the default `# title` body with the TaskNotes-style frontmatter
      // so the note is recognized as a task and shows up in the Tasks view.
      await window.zen.writeNote(
        meta.path,
        composeTaskFile({ title, dateCreated: new Date().toISOString() })
      )
      await get().refreshTasks()
      return meta.path
    } catch (err) {
      console.error('newTaskFile failed', err)
      return null
    }
  },
  newTaskFileInChosenFolder: async () => {
    const state = get()
    const entered = await promptApp(buildNoteDestinationPrompt('', state.folders))
    if (entered == null) return null // cancelled
    const dest = parseTemplateDestination(entered)
    return get().newTaskFile({ folder: dest.folder, subpath: dest.subpath })
  },
  renameDatabase: async (csvPath, newTitle) => {
    if (typeof window.zen.renameDatabase !== 'function') return
    try {
      const newCsvPath = await window.zen.renameDatabase(csvPath, newTitle)
      if (!newCsvPath || newCsvPath === csvPath) {
        await get().refreshNotes()
        return
      }
      // The `.base` folder moved, so the open grid tab's path changed. Rehome it
      // in place (and the cached doc) instead of leaving a stale tab.
      const oldTab = databaseTabPath(csvPath)
      const newTab = databaseTabPath(newCsvPath)
      set((s) => {
        const rewrite = (p: string): string => (p === oldTab ? newTab : p)
        const ensured = ensureActivePane(rewritePathsInTree(s.paneLayout, rewrite), s.activePaneId)
        const databases = { ...s.databases }
        const loading = { ...s.databasesLoading }
        const prev = databases[csvPath]
        if (prev) {
          databases[newCsvPath] = {
            ...prev,
            path: newCsvPath,
            title: formTitleFromCsvPath(newCsvPath)
          }
          delete databases[csvPath]
        }
        delete loading[csvPath]
        return {
          paneLayout: ensured.layout,
          activePaneId: ensured.activePaneId,
          databases,
          databasesLoading: loading,
          ...activeFieldsFrom(ensured.layout, ensured.activePaneId, s.noteContents, s.noteDirty)
        }
      })
      await get().refreshNotes()
    } catch (err) {
      console.error('renameDatabase failed', err)
      window.alert(err instanceof Error ? err.message : String(err))
    }
  },
  updateDatabaseRows: (csvPath, next) => {
    set((s) => ({ databases: { ...s.databases, [csvPath]: next } }))
    scheduleDatabaseWrite(csvPath, 'rows', () => get().databases[csvPath])
    remirrorOpenRecordPages(csvPath, get)
  },
  deleteDatabaseRows: async (csvPath, rowIds) => {
    const doc = get().databases[csvPath]
    if (!doc) return
    const ids = [...new Set(rowIds)].filter((id) => doc.rows.some((r) => r.id === id))
    if (ids.length === 0) return

    // Deleted rows that carry a linked record page — the ones worth asking about.
    const attached = ids
      .map((id) => doc.pages?.[id])
      .filter((p): p is string => typeof p === 'string' && p.length > 0)

    let trashNotes = false
    if (attached.length > 0) {
      const many = attached.length > 1
      trashNotes = await confirmApp({
        title: many ? `Delete ${ids.length} rows and their notes?` : 'Delete row and its linked note?',
        description: many
          ? `${attached.length} of these rows have a linked page note. Move those notes to Trash too, or keep them as standalone notes? The rows are deleted either way.`
          : 'This row has a linked page note. Move it to Trash too, or keep it as a standalone note? The row is deleted either way.',
        confirmLabel: many ? 'Delete rows + notes' : 'Delete row + note',
        cancelLabel: many ? 'Keep notes' : 'Keep note',
        danger: true
      })
    }

    // Re-read after the (async) prompt so a concurrent edit isn't clobbered.
    const latest = get().databases[csvPath]
    if (!latest) return
    const removeSet = new Set(ids)
    const nextPages = { ...(latest.pages ?? {}) }
    const nextFlags = { ...(latest.pageHasContent ?? {}) }
    const prunedPaths: string[] = []
    for (const id of ids) {
      const pagePath = nextPages[id]
      if (pagePath) {
        prunedPaths.push(pagePath)
        delete nextPages[id]
        delete nextFlags[id]
      }
    }
    const pagesChanged = prunedPaths.length > 0
    const next: DatabaseDoc = {
      ...latest,
      rows: latest.rows.filter((r) => !removeSet.has(r.id)),
      ...(pagesChanged ? { pages: nextPages, pageHasContent: nextFlags } : {})
    }
    set((s) => ({ databases: { ...s.databases, [csvPath]: next } }))
    // A pruned page mapping lives in the sidecar, so force a schema write; a
    // plain 'rows' write only rewrites the CSV and would leave the stale entry.
    scheduleDatabaseWrite(csvPath, pagesChanged ? 'schema' : 'rows', () => get().databases[csvPath])
    remirrorOpenRecordPages(csvPath, get)

    if (trashNotes) {
      for (const pagePath of prunedPaths) {
        await moveNoteToTrash(pagePath, { temporarySession: get().vault?.temporary === true })
      }
    }
  },
  updateDatabaseSchema: (csvPath, next) => {
    set((s) => ({ databases: { ...s.databases, [csvPath]: next } }))
    scheduleDatabaseWrite(csvPath, 'schema', () => get().databases[csvPath])
    remirrorOpenRecordPages(csvPath, get)
  },
  syncDatabaseFromDisk: async (csvPath) => {
    if (!get().databases[csvPath]) return
    // Ignore the watcher echo of a write we just made.
    if (Date.now() - (lastDatabaseWriteAt.get(csvPath) ?? 0) < 1500) return
    // Don't clobber edits that are still mid-debounce.
    if (databaseSaveTimers.has(csvPath)) return
    try {
      const doc = await window.zen.openDatabase(csvPath)
      if (!doc) {
        await get().forgetDatabase(csvPath)
        return
      }
      set((s) => (s.databases[csvPath] ? { databases: { ...s.databases, [csvPath]: doc } } : {}))
    } catch (err) {
      console.error('syncDatabaseFromDisk failed', err)
    }
  },
  forgetDatabase: async (csvPath) => {
    // Close the database's tab in every pane that holds it. A .csv can be open
    // either as a `zen://database/…` tab or as a `.csv` asset tab that renders
    // the same grid, so close both forms.
    const tabPaths = [databaseTabPath(csvPath), assetTabPath(csvPath)]
    for (const leaf of allLeaves(get().paneLayout)) {
      for (const tabPath of tabPaths) {
        if (leaf.tabs.includes(tabPath)) {
          await get().closeTabInPane(leaf.id, tabPath)
        }
      }
    }
    // Drop the cached doc + loading flag so nothing re-reads a file that's gone.
    set((s) => {
      if (!(csvPath in s.databases) && !(csvPath in s.databasesLoading)) return {}
      const databases = { ...s.databases }
      const databasesLoading = { ...s.databasesLoading }
      delete databases[csvPath]
      delete databasesLoading[csvPath]
      return { databases, databasesLoading }
    })
  },
  openRecordPage: async (csvPath, rowId) => {
    const doc = get().databases[csvPath]
    if (!doc) return
    const row = doc.rows.find((r) => r.id === rowId)
    if (!row) return
    let pagePath = doc.pages?.[rowId]
    if (pagePath) {
      // Confirm the linked note still exists; otherwise recreate-and-relink.
      try {
        await window.zen.readNote(pagePath)
      } catch {
        pagePath = undefined
      }
    }
    if (!pagePath) {
      try {
        const body = composePageBody(doc, row, `# ${recordTitle(doc, row)}\n\n`)
        pagePath = await window.zen.createRecordPage(csvPath, recordTitle(doc, row), body)
        get().updateDatabaseSchema(csvPath, {
          ...doc,
          pages: { ...(doc.pages ?? {}), [rowId]: pagePath },
          pageHasContent: { ...(doc.pageHasContent ?? {}), [rowId]: false }
        })
      } catch (err) {
        console.error('createRecordPage failed', err)
        return
      }
    } else {
      // Re-mirror current properties into the note's frontmatter, keep the body.
      try {
        const note = await window.zen.readNote(pagePath)
        const { body } = parseFrontmatter(note.body)
        await window.zen.writeNote(pagePath, composePageBody(doc, row, body))
      } catch (err) {
        console.error('refresh record page failed', err)
      }
    }
    await get().selectNote(pagePath)
  },
  renameRecordPage: async (csvPath, rowId) => {
    const doc = get().databases[csvPath]
    const pagePath = doc?.pages?.[rowId]
    if (!doc || !pagePath) return
    const row = doc.rows.find((r) => r.id === rowId)
    if (!row) return
    try {
      const meta = await window.zen.renameNote(pagePath, recordTitle(doc, row))
      if (meta.path !== pagePath) {
        get().updateDatabaseSchema(csvPath, {
          ...get().databases[csvPath]!,
          pages: { ...(get().databases[csvPath]!.pages ?? {}), [rowId]: meta.path }
        })
      }
    } catch (err) {
      console.error('renameRecordPage failed', err)
    }
  },

  toggleTagSelection: (tag) => {
    const trimmed = tag.trim()
    if (!trimmed) return
    set((s) => {
      const has = s.selectedTags.includes(trimmed)
      const next = has
        ? s.selectedTags.filter((t) => t !== trimmed)
        : [...s.selectedTags, trimmed]
      return { selectedTags: next }
    })
  },

  setSelectedTags: (tags) => {
    // De-dupe + drop empties so `:tag foo foo bar ""` ends up as ["foo","bar"].
    const seen = new Set<string>()
    const clean: string[] = []
    for (const t of tags) {
      const v = t.trim()
      if (!v || seen.has(v)) continue
      seen.add(v)
      clean.push(v)
    }
    set({ selectedTags: clean })
  },

  setTagMatchMode: (mode) => set({ tagMatchMode: mode }),

  refreshTasks: async () => {
    set({ tasksLoading: true })
    try {
      const tasks = await window.zen.scanTasks()
      set({ vaultTasks: withoutPendingCloudConflictTasks(tasks), tasksLoading: false })
    } catch (err) {
      console.error('scanTasks failed', err)
      set({ tasksLoading: false })
    }
  },

  rescanTasksForPath: async (relPath) => {
    try {
      const fresh = isolatedCloudTaskPaths.has(cloudSyncPathKey(relPath))
        ? []
        : await window.zen.scanTasksForPath(relPath)
      set((s) => ({
        vaultTasks: s.vaultTasks.filter((t) => t.sourcePath !== relPath).concat(fresh)
      }))
    } catch (err) {
      console.error('scanTasksForPath failed', err)
    }
  },

  openTaskAt: async (task) => {
    const state = get()

    // Pull body — in-memory first, disk fallback. Used to resolve lineNumber
    // to a char offset because the editor view may not be mounted yet.
    let body = state.noteContents[task.sourcePath]?.body
    if (!body) {
      try {
        const content = await window.zen.readNote(task.sourcePath)
        body = content.body
      } catch (err) {
        console.error('openTaskAt readNote failed', err)
        return
      }
    }
    const lines = body.split('\n')
    const taskLineNumber = resolveTaskLineNumber(body, task)
    let offset = 0
    for (let i = 0; i < taskLineNumber && i < lines.length; i++) {
      offset += lines[i].length + 1
    }
    // Nudge cursor past indentation + list marker so it lands on the content.
    // All five states, or opening a `[/]` task from the list would drop the
    // cursor at column 0 instead of on the text. (#512)
    const lineText = lines[taskLineNumber] ?? ''
    const taskBracketMatch = lineText.match(/^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[[ xX>/-]\]\s*/)
    const insideOffset = taskBracketMatch ? taskBracketMatch[0].length : 0
    const anchor = offset + insideOffset

    // Focus / open the note in the active pane. This replaces the Tasks
    // tab's content area with the note (the Tasks tab itself stays in the
    // strip, so the user can hop back with a click).
    await get().openNoteInPane(state.activePaneId, task.sourcePath)
    // Make sure the folder view is sensible in case the sidebar is visible.
    if (state.view.kind !== 'folder' || state.view.folder !== task.noteFolder) {
      set({ view: { kind: 'folder', folder: task.noteFolder, subpath: '' } })
    }
    set({
      pendingJumpLocation: {
        path: task.sourcePath,
        editorSelectionAnchor: anchor,
        editorSelectionHead: anchor,
        editorScrollTop: 0,
        previewScrollTop: 0,
        editorScrollMode: 'center',
        highlightLine: true
      },
      focusedPanel: 'editor'
    })
    // Setting focusedPanel above only updates store state; the Tasks view still
    // holds real DOM focus (opening the source note swaps the pane's content
    // async), so move keyboard focus to the editor for vim motions / typing.
    // The event handler retries across the note remount. (#415)
    requestEditorFocus()
  },

  toggleTaskFromList: async (task) => {
    const state = get()
    const path = task.sourcePath
    const openBuffer = state.noteContents[path]
    // Prefer the live buffer for open notes so we don't stomp unsaved edits.
    const body = openBuffer?.body ?? (await window.zen.readNote(path)).body
    // A file-task's completion lives in frontmatter (`status`/`completedDate`),
    // not a checkbox char.
    const nextChecked = !task.checked
    const nextBody =
      task.kind === 'file'
        ? setTaskFileStatus(body, nextChecked, toIsoDateLocal(new Date()))
        : toggleTaskAtIndex(body, task.taskIndex, nextChecked)
    if (nextBody === body) return

    if (openBuffer) {
      // Push through the normal open-note pipeline — marks dirty and lets
      // autosave flush on its schedule.
      get().updateNoteBody(path, nextBody)
    } else {
      try {
        await window.zen.writeNote(path, nextBody)
      } catch (err) {
        console.error('writeNote (toggle) failed', err)
        return
      }
    }

    // Optimistically reflect the change locally; the watcher echo will
    // confirm via rescanTasksForPath.
    const nextStatus = nextChecked ? 'done' : 'open'
    set((s) => ({
      vaultTasks: s.vaultTasks.map((t) =>
        t.sourcePath === path && t.taskIndex === task.taskIndex
          ? task.kind === 'file'
            ? withFileTaskStatus(t, nextStatus)
            : withInlineTaskMarker(t, nextChecked ? 'done' : 'open')
          : t
      )
    }))
  },

  cancelTaskFromList: async (task) => {
    const path = task.sourcePath
    const openBuffer = get().noteContents[path]
    const body = openBuffer?.body ?? (await window.zen.readNote(path)).body
    const nextCancelled = !task.cancelled
    const nextBody =
      task.kind === 'file'
        ? setTaskFileCancelled(body, nextCancelled)
        : setTaskCancelledAtIndex(body, task.taskIndex, nextCancelled)
    if (nextBody === body) return

    if (openBuffer) {
      get().updateNoteBody(path, nextBody)
    } else {
      try {
        await window.zen.writeNote(path, nextBody)
      } catch (err) {
        console.error('writeNote (cancel) failed', err)
        return
      }
    }

    const nextStatus = nextCancelled ? 'cancelled' : 'open'
    set((s) => ({
      vaultTasks: s.vaultTasks.map((t) =>
        t.sourcePath === path && t.taskIndex === task.taskIndex
          ? task.kind === 'file'
            ? withFileTaskStatus(t, nextStatus)
            : withInlineTaskMarker(t, nextCancelled ? 'cancelled' : 'open')
          : t
      )
    }))
  },

  startTaskFromList: async (task) => {
    const path = task.sourcePath
    const openBuffer = get().noteContents[path]
    const body = openBuffer?.body ?? (await window.zen.readNote(path)).body
    const nextInProgress = !task.inProgress
    const nextBody =
      task.kind === 'file'
        ? setTaskFileInProgress(body, nextInProgress)
        : setTaskInProgressAtIndex(body, task.taskIndex, nextInProgress)
    if (nextBody === body) return

    if (openBuffer) {
      get().updateNoteBody(path, nextBody)
    } else {
      try {
        await window.zen.writeNote(path, nextBody)
      } catch (err) {
        console.error('writeNote (start) failed', err)
        return
      }
    }

    const nextStatus = nextInProgress ? 'in-progress' : 'open'
    set((s) => ({
      vaultTasks: s.vaultTasks.map((t) =>
        t.sourcePath === path && t.taskIndex === task.taskIndex
          ? task.kind === 'file'
            ? withFileTaskStatus(t, nextStatus)
            : withInlineTaskMarker(t, nextInProgress ? 'in-progress' : 'open')
          : t
      )
    }))
  },

  applyTaskMutation: async (task, mutation) => {
    const mutations: TaskMutation[] = Array.isArray(mutation) ? mutation : [mutation]
    if (mutations.length === 0) return

    const path = task.sourcePath
    const optimisticTask = applyTaskMutationsToTask(task, mutations)
    const hasOptimisticChange = optimisticTask !== task

    // Tracked from HERE rather than from the write queue below: the optimistic
    // paint yields a frame before anything is queued, and a quit inside that
    // frame would find an empty queue and drop the move. See
    // `drainTaskMutationQueues`.
    const running = (async () => {
      if (hasOptimisticChange) {
        set((s) => ({
          vaultTasks: s.vaultTasks.map((t) =>
            t.sourcePath === path && t.taskIndex === task.taskIndex ? optimisticTask : t
          )
        }))
        await yieldForOptimisticPaint()
      }

      // The optimistic paint above is immediate; everything from the body read
      // down is queued per path, so a second mutation cannot read a base an
      // in-flight write is about to invalidate.
      await queueTaskMutation(path, async () => {
        const latestState = get()
        const latestOpenBuffer = latestState.noteContents[path]
        let body: string
        try {
          body = latestOpenBuffer?.body ?? (await window.zen.readNote(path)).body
        } catch (err) {
          console.error('readNote (mutate) failed', err)
          if (hasOptimisticChange) void get().rescanTasksForPath(path)
          return
        }

        let nextBody = body
        if (task.kind === 'file') {
          // Whole-note task: every field lives in frontmatter, so apply the whole
          // batch as one frontmatter rewrite rather than per-line edits.
          nextBody = updateFrontmatterFields(
            body,
            fileTaskMutationUpdates(mutations, toIsoDateLocal(new Date()))
          )
        } else {
          for (const m of mutations) {
            switch (m.kind) {
              case 'set-checked':
                nextBody = setTaskCheckedAtIndex(nextBody, task.taskIndex, m.checked)
                break
              case 'set-waiting':
                nextBody = setTaskWaitingAtIndex(nextBody, task.taskIndex, m.waiting)
                break
              case 'set-in-progress':
                nextBody = setTaskInProgressAtIndex(nextBody, task.taskIndex, m.inProgress)
                break
              case 'set-priority':
                nextBody = setTaskPriorityAtIndex(nextBody, task.taskIndex, m.priority)
                break
              case 'set-due':
                nextBody = setTaskDueAtIndex(nextBody, task.taskIndex, m.due)
                break
              case 'set-field':
                nextBody = setTaskFieldAtIndex(nextBody, task.taskIndex, m.key, m.value)
                break
              case 'set-text':
                nextBody = setTaskTextAtIndex(nextBody, task.taskIndex, m.text)
                break
            }
          }
        }
        if (nextBody === body) {
          if (hasOptimisticChange) void get().rescanTasksForPath(path)
          return
        }

        // The buffer route exists to MERGE with unsaved edits, so it is taken only
        // when the note is genuinely dirty. `noteContents` also caches notes nobody
        // has open (previews, workspace prefetch), and routing those through
        // `updateNoteBody` hands the change to an editor autosave that has no
        // editor: mark-dirty, wait, and hope. In a rapid Kanban chain the watcher
        // reload from the PREVIOUS write then reloads the cache over the pending
        // edit, and the move silently reverts on disk (#503). A clean note takes
        // the disk write like any external edit; the cache is updated in the same
        // breath so a third move in the chain never reads a stale base.
        if (latestOpenBuffer && latestState.noteDirty[path]) {
          get().updateNoteBody(path, nextBody)
        } else {
          try {
            await window.zen.writeNote(path, nextBody)
          } catch (err) {
            console.error('writeNote (mutate) failed', err)
            if (hasOptimisticChange) void get().rescanTasksForPath(path)
            return
          }
          if (latestOpenBuffer) {
            set((s) => {
              const cached = s.noteContents[path]
              // Only a still-clean cache entry is ours to move forward; a buffer
              // the user dirtied since the read above keeps their text.
              if (!cached || s.noteDirty[path]) return s
              return { noteContents: { ...s.noteContents, [path]: { ...cached, body: nextBody } } }
            })
          }
        }
      })
    })()
    inFlightTaskMutations.add(running)
    try {
      await running
    } finally {
      inFlightTaskMutations.delete(running)
    }
  },

  deleteTaskFromList: async (task) => {
    const path = task.sourcePath
    // A file-task *is* the note, so "delete" means trash the whole note (with a
    // confirm, since it may hold body notes). Inline tasks just drop their line.
    if (task.kind === 'file') {
      if (!(await confirmMoveToTrash(task.noteTitle))) return
      set((s) => ({ vaultTasks: s.vaultTasks.filter((t) => t.sourcePath !== path) }))
      if (await moveNoteToTrash(path, { temporarySession: get().vault?.temporary === true })) {
        await get().refreshNotes()
      }
      else void get().refreshTasks()
      return
    }
    const openBuffer = get().noteContents[path]
    let body: string
    try {
      body = openBuffer?.body ?? (await window.zen.readNote(path)).body
    } catch (err) {
      console.error('deleteTaskFromList readNote failed', err)
      return
    }
    const nextBody = removeTaskAtIndex(body, task.taskIndex)
    if (nextBody === body) return
    // Optimistically drop it from the index so the row vanishes immediately.
    set((s) => ({
      vaultTasks: s.vaultTasks.filter(
        (t) => !(t.sourcePath === path && t.taskIndex === task.taskIndex)
      )
    }))
    if (openBuffer) {
      get().updateNoteBody(path, nextBody)
    } else {
      try {
        await window.zen.writeNote(path, nextBody)
        await get().rescanTasksForPath(path)
      } catch (err) {
        console.error('deleteTaskFromList writeNote failed', err)
        void get().rescanTasksForPath(path)
      }
    }
  },

  moveTaskToDate: async (task, dateIso) => {
    const parsed = parseIsoDateLocal(dateIso)
    if (!parsed) return
    // A file-task isn't a line that can move into a daily note; rescheduling it
    // just rewrites its frontmatter `due`.
    if (task.kind === 'file') {
      await get().applyTaskMutation(task, { kind: 'set-due', due: dateIso })
      return
    }
    const settings = normalizeVaultSettings(get().vaultSettings)
    // No daily notes to move into — just set the due date instead.
    if (!settings.dailyNotes.enabled) {
      await get().applyTaskMutation(task, { kind: 'set-due', due: dateIso })
      return
    }
    const target = await get().ensureDailyNoteForDate(parsed)
    if (!target) return
    const inferDue = settings.dailyNotes.tasksDueOnNoteDate
    // Already in that day's note — nothing to relocate; just align its due.
    if (target.path === task.sourcePath) {
      await get().applyTaskMutation(task, { kind: 'set-due', due: inferDue ? null : dateIso })
      return
    }

    const srcBuffer = get().noteContents[task.sourcePath]
    const tgtBuffer = get().noteContents[target.path]
    let srcBody: string
    let tgtBody: string
    try {
      srcBody = srcBuffer?.body ?? (await window.zen.readNote(task.sourcePath)).body
      tgtBody = tgtBuffer?.body ?? (await window.zen.readNote(target.path)).body
    } catch (err) {
      console.error('moveTaskToDate read failed', err)
      return
    }
    const { line, body: strippedSrc } = takeTaskLineAtIndex(srcBody, task.taskIndex)
    if (!line) return
    // Moving INTO the target day's note: with implicit due on, a bare line
    // already reads as that day, so strip any `due:` token; otherwise write the
    // explicit date.
    const movedLine = setTaskDueAtIndex(line, 0, inferDue ? null : dateIso)
    const trimmed = tgtBody.replace(/\s+$/u, '')
    const nextTgt = trimmed.length ? `${trimmed}\n${movedLine}\n` : `${movedLine}\n`

    // Persist both notes (open buffers go through the edit pipeline).
    if (srcBuffer) get().updateNoteBody(task.sourcePath, strippedSrc)
    else {
      try {
        await window.zen.writeNote(task.sourcePath, strippedSrc)
      } catch (err) {
        console.error('moveTaskToDate write source failed', err)
        return
      }
    }
    if (tgtBuffer) get().updateNoteBody(target.path, nextTgt)
    else {
      try {
        await window.zen.writeNote(target.path, nextTgt)
      } catch (err) {
        console.error('moveTaskToDate write target failed', err)
        return
      }
    }

    // Rebuild the index for the two affected notes with a client-side parse —
    // authoritative (same parser the scanner uses) and independent of the
    // single-file IPC rescanner, so the move shows immediately.
    const srcTasks = parseTasksFromBody(strippedSrc, {
      path: task.sourcePath,
      title: task.noteTitle,
      folder: task.noteFolder
    })
    const tgtTasks = parseTasksFromBody(nextTgt, {
      path: target.path,
      title: target.title,
      folder: target.folder
    })
    set((s) => ({
      // Both rebuilt notes go back through the Cloud filter: a note waiting on
      // a conflict decision must stay out of the task surfaces even when an
      // edit to another note reindexes it.
      vaultTasks: [
        ...s.vaultTasks.filter(
          (t) => t.sourcePath !== task.sourcePath && t.sourcePath !== target.path
        ),
        ...withoutPendingCloudConflictTasks([...srcTasks, ...tgtTasks])
      ]
    }))
  },

  forwardTask: async (task, targetPath) => {
    if (!targetPath || targetPath === task.sourcePath) return
    const targetMeta = get().notes.find((n) => n.path === targetPath)
    if (!targetMeta) return

    const srcBuffer = get().noteContents[task.sourcePath]
    const tgtBuffer = get().noteContents[targetPath]
    let srcBody: string
    let tgtBody: string
    try {
      srcBody = srcBuffer?.body ?? (await window.zen.readNote(task.sourcePath)).body
      tgtBody = tgtBuffer?.body ?? (await window.zen.readNote(targetPath)).body
    } catch (err) {
      console.error('forwardTask read failed', err)
      return
    }

    // Cross-links are title-based wikilinks (navigable + resolver-friendly).
    const backLink = `[[${task.noteTitle}]]`
    const forwardLink = `[[${targetMeta.title}]]`

    // Original: flip to `[>]` and record where it went. The task's indented
    // subtree is part of the record: open subtasks flip to `[>]` with the
    // parent, done and cancelled subtasks keep their state (#611).
    const { body: nextSrc, childLines } = forwardTaskSubtreeAtIndex(
      srcBody,
      task.taskIndex,
      forwardLink
    )
    if (nextSrc === srcBody) return

    // Copy: a fresh open task in the target, backlinked to the origin, with the
    // subtree beneath it verbatim so the destination holds a faithful copy of
    // the task's current state (#611). Slot it under the target's `## Tasks`
    // heading when it has one, else append (#452).
    const copyLine = `- [ ] ${task.content} ${backLink}`.replace(/\s+$/u, '')
    const nextTgt = insertTasksUnderTasksHeading(tgtBody, [copyLine, ...childLines])

    if (srcBuffer) get().updateNoteBody(task.sourcePath, nextSrc)
    else {
      try {
        await window.zen.writeNote(task.sourcePath, nextSrc)
      } catch (err) {
        console.error('forwardTask write source failed', err)
        return
      }
    }
    if (tgtBuffer) get().updateNoteBody(targetPath, nextTgt)
    else {
      try {
        await window.zen.writeNote(targetPath, nextTgt)
      } catch (err) {
        console.error('forwardTask write target failed', err)
        return
      }
    }

    const srcTasks = parseTasksFromBody(nextSrc, {
      path: task.sourcePath,
      title: task.noteTitle,
      folder: task.noteFolder
    })
    const tgtTasks = parseTasksFromBody(nextTgt, {
      path: targetPath,
      title: targetMeta.title,
      folder: targetMeta.folder
    })
    set((s) => ({
      // Same filter as the move above: forwarding must not slip a withheld
      // note's tasks back into the shared cache.
      vaultTasks: [
        ...s.vaultTasks.filter(
          (t) => t.sourcePath !== task.sourcePath && t.sourcePath !== targetPath
        ),
        ...withoutPendingCloudConflictTasks([...srcTasks, ...tgtTasks])
      ]
    }))
  },

  setTasksFilter: (q) => set({ tasksFilter: q, taskCursorIndex: 0 }),
  setTasksViewMode: (mode) => {
    set({ tasksViewMode: mode, taskCursorIndex: 0 })
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ tasksViewMode: mode })
  },
  setShowArchivedTasks: (show) => {
    set({ showArchivedTasks: show })
    savePrefs(collectPrefs(get()))
  },
  confirmArchiveNotes: async (paths) => {
    const state = get()
    const targets = new Set(paths)
    // Open = not done, not cancelled, not forwarded; waiting and in-progress
    // still count as live work someone could lose sight of.
    const open = state.vaultTasks.filter(
      (t) => targets.has(t.sourcePath) && !t.checked && !t.cancelled && !t.forwarded
    ).length
    if (open === 0) return true
    const subject =
      paths.length === 1 ? 'This note still has' : `These ${paths.length} notes still have`
    const hidden = !state.showArchivedTasks
    return await confirmApp({
      title: paths.length === 1 ? 'Archive note?' : 'Archive notes?',
      description: `${subject} ${open} open task${open === 1 ? '' : 's'}.${
        hidden ? ' Tasks from archived notes leave the Tasks views.' : ''
      } Archive anyway?`,
      confirmLabel: 'Archive'
    })
  },
  setKanbanGroupBy: (group) => {
    set({ kanbanGroupBy: group })
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ kanbanGroupBy: group })
  },
  setKanbanColumnTitle: (group, columnId, title) => {
    const key = `${group}:${columnId}`
    const normalized = typeof title === 'string' ? normalizeKanbanColumnTitle(title) : null
    const nextTitles = { ...get().kanbanColumnTitles }
    if (normalized) nextTitles[key] = normalized
    else delete nextTitles[key]
    set({ kanbanColumnTitles: nextTitles })
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ kanbanColumnTitles: nextTitles })
  },
  setKanbanColumnOrder: (group, orderedIds) => {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const raw of orderedIds) {
      const id = typeof raw === 'string' ? raw.trim() : ''
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    const nextOrder = { ...get().kanbanColumnOrder }
    if (ids.length) nextOrder[group] = ids
    else delete nextOrder[group]
    set({ kanbanColumnOrder: nextOrder })
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ kanbanColumnOrder: nextOrder })
  },
  setKanbanCardOrder: (entries) => {
    const merged = { ...get().kanbanCardOrder }
    for (const [key, order] of Object.entries(entries)) {
      if (order.length) merged[key] = order
      else delete merged[key]
    }
    // Re-normalizing enforces the key grammar and the column/card caps on
    // every write, so the map can't grow without bound.
    const next = normalizeKanbanCardOrder(merged)
    set({ kanbanCardOrder: next })
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ kanbanCardOrder: next })
  },
  setKanbanStatuses: (statuses) => {
    const next = normalizeKanbanStatuses(statuses)
    set({ kanbanStatuses: next })
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ kanbanStatuses: next })
  },
  setTasksCalendarSelectedDate: (iso) => set({ tasksCalendarSelectedDate: iso }),
  setTasksCalendarMonthAnchor: (iso) => set({ tasksCalendarMonthAnchor: iso }),
  setTaskCursorIndex: (idx) => set({ taskCursorIndex: Math.max(0, idx) }),

  selectNote: async (relPath) => {
    await selectNoteImpl(relPath, 'push')
  },

  previewNote: async (relPath) => {
    await selectNoteImpl(relPath, 'push', { preview: true })
  },

  prefetchNotes: (paths) => {
    const state = get()
    const existing = new Set(Object.keys(state.noteContents))
    const livePaths = new Set(state.notes.map((note) => note.path))
    const candidates = paths
      .filter((path) => livePaths.has(path))
      .filter((path) => !isWorkspaceVirtualTabPath(path))
      .filter((path) => !existing.has(path))
      .slice(0, NOTE_PREFETCH_BATCH_SIZE)

    if (candidates.length === 0) return

    const reads = candidates.map((path) => {
      const readScopeKey = noteReadCacheKey(state, path)
      return readNoteContent(path, state).then(
        (content) => ({ path, readScopeKey, content }),
        () => null
      )
    })

    void Promise.all(reads).then((results) => {
      const loaded = results.filter(
        (result): result is { path: string; readScopeKey: string; content: NoteContent } =>
          result !== null
      )
      if (loaded.length === 0) return

      set((s) => {
        let contents = s.noteContents
        let dirty = s.noteDirty
        let changed = false
        const live = new Set(s.notes.map((note) => note.path))

        for (const { path, readScopeKey, content } of loaded) {
          if (noteReadCacheKey(s, path) !== readScopeKey) continue
          if (contents[path]) continue
          if (!live.has(path)) continue
          if (!changed) {
            contents = { ...contents }
            dirty = { ...dirty }
            changed = true
          }
          contents[path] = content
          dirty[path] = false
          rememberPrefetchedPath(path)
        }

        if (!changed) return s
        const next = {
          noteContents: contents,
          noteDirty: dirty,
          ...activeFieldsFrom(s.paneLayout, s.activePaneId, contents, dirty)
        }
        const pruned = prunePrefetchedContents({ ...s, ...next })
        return { ...next, ...pruned }
      })
    })
  },

  openNoteAtOffset: async (relPath, offset, options) => {
    const state = get()
    const anchor = Math.max(0, offset)
    const pendingJumpLocation = {
      path: relPath,
      editorSelectionAnchor: anchor,
      editorSelectionHead: anchor,
      editorScrollTop: 0,
      previewScrollTop: 0,
      editorScrollMode: options?.scrollMode ?? 'center'
    }
    set({
      pendingJumpLocation,
      focusedPanel: 'editor',
      // Opening at an offset is still a jump the user should be able to undo
      // with Ctrl+O, so it records where they came from. `openNoteInPane`
      // below is the raw tab primitive and keeps no history of its own. (#484)
      ...noteHistoryAfterJump(state, relPath)
    })
    await get().openNoteInPane(state.activePaneId, relPath)
    set((s) => {
      if (s.selectedPath === relPath) return { focusedPanel: 'editor' }
      if (s.pendingJumpLocation?.path === relPath) {
        return { pendingJumpLocation: null, focusedPanel: 'editor' }
      }
      return { focusedPanel: 'editor' }
    })
  },

  refreshTypstPreambles: async () => {
    const state = get()
    if (!state.typstTagPreambles) {
      if (state.typstPreambleNotes.length) set({ typstPreambleNotes: [] })
      return
    }
    const preambleFolder = resolveTypstPreambleFolder(
      state.vaultSettings?.typstPreambles?.folder
    )
    const candidates = state.notes.filter(
      (note) => note.folder !== 'trash' && isTypstPreamblePath(note.path, preambleFolder)
    )
    const loaded: TypstPreambleNote[] = []
    for (const note of candidates) {
      try {
        const body = get().noteContents[note.path]?.body ?? (await window.zen.readNote(note.path)).body
        loaded.push({ key: preambleKeyFromTitle(note.title), body })
      } catch (err) {
        console.error('typst preamble read failed', note.path, err)
      }
    }
    set({ typstPreambleNotes: loaded })
  },

  jumpToPreviousNote: async () => {
    await jumpThroughNoteHistory('back')
  },

  jumpToNextNote: async () => {
    await jumpThroughNoteHistory('forward')
  },

  toggleRecentNote: async () => {
    const state = get()
    const available = new Set(
      state.notes.filter((note) => note.folder !== 'trash').map((note) => note.path)
    )
    const target = recentNoteToggleTarget(
      state.selectedPath,
      state.noteBackstack,
      available
    )
    if (target) await get().selectNote(target)
  },

  refreshNotes: async () => {
    try {
      // Load this vault's manual note order once per vault (drives #224).
      const orderRoot = get().vault?.root ?? ''
      if (manualOrderLoadedForRoot !== orderRoot) {
        manualOrderLoadedForRoot = orderRoot
        set({ manualNoteOrder: readManualOrder(orderRoot) })
      }
      const startedAt = performance.now()
      const [notes, folders, hasAssetsDirOnDisk] = await Promise.all([
        listNotesFromBridge(),
        window.zen.listFolders(),
        window.zen.hasAssetsDir()
      ])
      recordRendererPerf('store.refreshNotes.fetch', performance.now() - startedAt, {
        notes: notes.length,
        folders: folders.length,
        hasAssetsDir: hasAssetsDirOnDisk
      })
      set((s) => {
        const applyStartedAt = performance.now()
        const noteMetaByPath = new Map(notes.map((note) => [note.path, note] as const))
        const existingPaths = new Set(notes.map((n) => n.path))
        // Drop tabs whose notes no longer exist. The currently focused
        // selectedPath is exempt so the editor doesn't blank out mid-save,
        // but only when its note actually loaded (or holds unsaved edits):
        // a tab restored from a stale snapshot and promoted to active after
        // its read failed has nothing to blank, and the exemption would keep
        // that ghost alive through every refresh (#564).
        const keep = (path: string): boolean =>
          existingPaths.has(path) ||
          isWorkspaceVirtualTabPath(path) ||
          renamesInFlight.has(path) ||
          (path === s.selectedPath &&
            (s.noteContents[path] !== undefined || s.noteDirty[path] === true))
        const prunedLayout = rewritePathsInTree(s.paneLayout, (path) =>
          keep(path) ? path : null
        )
        // #384: never let a background note-list refresh close *every* open
        // note tab at once (a transient/incomplete list — reported on Linux
        // when moving a note to Trash — would otherwise wipe all tabs and drop
        // the user on the home screen). Real deletions are handled precisely by
        // the trash/delete actions and applyChange('unlink').
        const nextLayout = preserveLayoutIfPruneEmptiesNoteTabs(
          s.paneLayout,
          prunedLayout,
          isWorkspaceVirtualTabPath
        )
        const ensured = ensureActivePane(nextLayout, s.activePaneId)
        // Auto-unpin the reference pane if its note has been deleted on
        // disk. Asset pins (PDFs etc.) aren't in the notes index, so
        // we leave them alone — the iframe will just render empty if
        // the file is gone, and the user can unpin manually.
        const pinnedStillExists =
          s.pinnedRefPath !== null &&
          (s.pinnedRefKind === 'asset' ||
            existingPaths.has(s.pinnedRefPath) ||
            s.pinnedRefPath === s.selectedPath)
        const pinnedRefPath = pinnedStillExists ? s.pinnedRefPath : null
        // Prune content caches for paths no longer referenced anywhere.
        const referenced = new Set<string>()
        for (const leaf of allLeaves(nextLayout)) {
          for (const tab of leaf.tabs) referenced.add(tab)
        }
        if (pinnedRefPath) referenced.add(pinnedRefPath)
        const contents: Record<string, NoteContent> = {}
        const dirty: Record<string, boolean> = {}
        for (const [path, content] of Object.entries(s.noteContents)) {
          if (!referenced.has(path)) continue
          const latestMeta = noteMetaByPath.get(path)
          contents[path] = latestMeta ? { ...content, ...latestMeta } : content
        }
        for (const [path, isDirty] of Object.entries(s.noteDirty)) {
          if (referenced.has(path)) dirty[path] = isDirty
        }
        const next = {
          notes:
            s.noteSortOrder === 'none'
              ? mergeNotesPreservingOrder(s.notes, notes)
              : notes,
          folders: mergeFoldersPreservingOrder(s.folders, folders),
          hasAssetsDir: hasAssetsDirOnDisk || s.assetFiles.length > 0,
          paneLayout: ensured.layout,
          activePaneId: ensured.activePaneId,
          noteContents: contents,
          noteDirty: dirty,
          pinnedRefPath,
          ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
        }
        recordRendererPerf('store.refreshNotes.apply', performance.now() - applyStartedAt, {
          notes: notes.length,
          folders: folders.length
        })
        return next
      })
      // The note list is where preamble notes are discovered, so keep them in
      // step with it (no-op unless the setting is on). (#486)
      if (get().typstTagPreambles) void get().refreshTypstPreambles()
    } catch (err) {
      console.error('refresh failed', err)
    }
  },

  refreshAssets: async () => {
    try {
      const startedAt = performance.now()
      const [rawAssets, hasAssetsDirOnDisk] = await Promise.all([
        window.zen.listAssets(),
        window.zen.hasAssetsDir()
      ])
      // Hide database internals (sidecar + .bak backups) — they're not
      // standalone files the user manages.
      const assetFiles = rawAssets.filter((a) => !isDatabaseInternalPath(a.path))
      set({
        assetFiles,
        hasAssetsDir: hasAssetsDirOnDisk || assetFiles.length > 0
      })
      recordRendererPerf('store.refreshAssets.fetch', performance.now() - startedAt, {
        assets: assetFiles.length,
        hasAssetsDir: hasAssetsDirOnDisk || assetFiles.length > 0
      })
    } catch (err) {
      console.error('refresh assets failed', err)
    }
  },

  deleteAsset: async (relPath) => {
    if (typeof window.zen.deleteAsset !== 'function') {
      window.alert('Asset deletion is not available until the app is restarted.')
      return
    }
    try {
      const deleted = await window.zen.deleteAsset(relPath)
      if (isDeletedAssetRecord(deleted) && typeof window.zen.restoreDeletedAsset === 'function') {
        const entry: AssetUndoEntry = { kind: 'delete-asset', deleted, createdAt: Date.now() }
        set((s) => ({
          assetUndoStack: [...s.assetUndoStack, entry].slice(-MAX_ASSET_UNDO_STACK)
        }))
      }
      await get().refreshAssets()
    } catch (err) {
      console.error('delete asset failed', err)
      window.alert(err instanceof Error ? err.message : String(err))
    }
  },

  undoLastAssetAction: async () => {
    const entry = get().assetUndoStack.at(-1)
    if (!entry) return false
    if (typeof window.zen.restoreDeletedAsset !== 'function') {
      window.alert('Asset undo is not available until the app is restarted.')
      return false
    }

    set((s) => ({ assetUndoStack: s.assetUndoStack.slice(0, -1) }))
    try {
      await window.zen.restoreDeletedAsset(entry.deleted)
      await get().refreshAssets()
      return true
    } catch (err) {
      set((s) => ({
        assetUndoStack: [...s.assetUndoStack, entry].slice(-MAX_ASSET_UNDO_STACK)
      }))
      console.error('undo asset action failed', err)
      window.alert(err instanceof Error ? err.message : String(err))
      return false
    }
  },

  applyChange: async (ev) => {
    // The live feed's unlink handling, shared with the resync path below:
    // a deleted note's tab closes wherever it is open.
    const closeUnlinkedNote = (notePath: string): void => {
      // The unlink half of a rename we asked for: the reply will move the
      // tab to the new path (see renamesInFlight).
      if (renamesInFlight.has(notePath)) return
      set((s) => {
        const nextLayout = rewritePathsInTree(s.paneLayout, (p) =>
          p === notePath ? null : p
        )
        const ensured = ensureActivePane(nextLayout, s.activePaneId)
        const { [notePath]: _drop, ...contents } = s.noteContents
        const { [notePath]: _d, ...dirty } = s.noteDirty
        void _drop
        void _d
        return {
          paneLayout: ensured.layout,
          activePaneId: ensured.activePaneId,
          noteContents: contents,
          noteDirty: dirty,
          pinnedRefPath: s.pinnedRefPath === notePath ? null : s.pinnedRefPath,
          ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
        }
      })
    }
    if (ev.scope === 'resync') {
      // The change feed was interrupted and events were lost; re-pull every
      // surface the feed keeps fresh instead of trusting the resumed stream.
      await Promise.all([
        refreshNotesCoalesced(),
        get().refreshAssets(),
        get().loadCustomTemplates(),
        window.zen
          .getVaultSettings()
          .then((settings) => {
            const normalized = normalizeVaultSettings(settings)
            set({
              vaultSettings: normalized,
              ...(get().viewSettingsScope === 'vault' ? viewPrefsFromVault(normalized) : {})
            })
          })
          .catch((err) => {
            console.error('resync vault settings failed', err)
          }),
        tasksSurfaceVisible(get()) ? get().refreshTasks() : Promise.resolve()
      ])
      const stateAfter = get()
      const openTabs = [...new Set(allLeaves(stateAfter.paneLayout).flatMap((leaf) => leaf.tabs))]
      // Databases and comment threads have their own feed scopes ('database',
      // 'comments') whose per-path events the gap swallowed too: re-pull
      // every loaded database (syncDatabaseFromDisk forgets ones deleted on
      // the server and refuses to clobber mid-debounce edits) and the
      // comments of every open note. Any drawing may also have changed;
      // drop all cached previews so embeds re-render instead of showing the
      // pre-gap image.
      invalidateAllExcalidrawPreviews()
      set({ excalidrawPreviewVersion: get().excalidrawPreviewVersion + 1 })
      await Promise.all([
        ...Object.keys(stateAfter.databases).map((csvPath) =>
          get().syncDatabaseFromDisk(csvPath)
        ),
        ...openTabs
          .filter((p) => stateAfter.noteContents[p])
          .map(async (p) => {
            await get().loadNoteComments(p)
          })
      ])
      // Open notes may have changed on the server while the feed was down.
      // Re-read the clean ones; a dirty buffer holds local edits the user
      // has not saved, and clobbering those trades a stale view for lost work.
      const openPaths = openTabs.filter(
        (p) => stateAfter.noteContents[p] && !stateAfter.noteDirty[p]
      )
      await Promise.all(
        openPaths.map(async (openPath) => {
          try {
            const content = await window.zen.readNote(openPath)
            set((s) => {
              const existing = s.noteContents[openPath]
              if (!existing || existing.body === content.body || s.noteDirty[openPath]) return s
              const contents = { ...s.noteContents, [openPath]: content }
              const dirty = { ...s.noteDirty, [openPath]: false }
              return {
                noteContents: contents,
                noteDirty: dirty,
                ...activeFieldsFrom(s.paneLayout, s.activePaneId, contents, dirty)
              }
            })
          } catch {
            // refreshNotes above deliberately never prunes selectedPath and
            // refuses a prune that would close every note tab (#384),
            // deferring real deletions to unlink events that a resync can
            // never deliver. The fresh note list is the second witness: a
            // path missing from it that also fails to read was deleted on
            // the server while the feed was down, so close its tab like the
            // lost unlink event would have. Dirty buffers never reach this
            // loop, so unsaved local edits survive.
            if (!get().notes.some((n) => n.path === openPath)) {
              closeUnlinkedNote(openPath)
            }
          }
        })
      )
      return
    }
    if (ev.scope === 'comments') {
      await get().loadNoteComments(ev.path)
      return
    }
    if (ev.scope === 'templates') {
      await get().loadCustomTemplates()
      return
    }
    if (ev.scope === 'database') {
      // On delete, forget the database instead of re-reading a file that's gone
      // (which throws "Database not found"); otherwise sync from disk.
      if (ev.kind === 'unlink') {
        await get().forgetDatabase(ev.path)
      } else {
        await get().syncDatabaseFromDisk(ev.path)
      }
      // Surface a newly-created (or removed) .csv in the note list.
      if (ev.kind !== 'change') await get().refreshAssets()
      return
    }
    if (ev.scope === 'folder') {
      // A folder was created/removed/renamed externally (e.g. in another
      // client sharing this vault). An empty folder produces no note event,
      // so refresh the tree explicitly — refreshNotes() re-lists folders.
      await refreshNotesCoalesced()
      return
    }
    // Excalidraw drawings are notes (they live in the notes tree), so treat
    // their change events as note events, not asset events.
    const pathIsNote =
      ev.path.toLowerCase().endsWith('.md') || isExcalidrawPath(ev.path)
    if (ev.scope !== 'vault-settings' && !pathIsNote) {
      await get().refreshAssets()
      return
    }
    // An Excalidraw drawing changed on disk — drop its cached PNG preview
    // and bump the version so editor widgets and preview embeds re-render.
    if (isExcalidrawPath(ev.path) || isObsidianExcalidrawPath(ev.path)) {
      invalidateExcalidrawPreview(ev.path)
      set({ excalidrawPreviewVersion: get().excalidrawPreviewVersion + 1 })
    }
    await Promise.all([
      refreshNotesCoalesced(),
      ev.scope === 'vault-settings'
        ? window.zen
            .getVaultSettings()
            .then((settings) => {
              const normalized = normalizeVaultSettings(settings)
              // Re-overlay view overrides if vault.json changed externally — only
              // in per-vault scope. (#292)
              set({
                vaultSettings: normalized,
                ...(get().viewSettingsScope === 'vault' ? viewPrefsFromVault(normalized) : {})
              })
            })
            .catch((err) => {
              console.error('refresh vault settings failed', err)
            })
        : Promise.resolve()
    ])
    const state = get()

    if (ev.scope === 'vault-settings') return

    // A record "page" note changed on disk — re-sync any open database that
    // links to it so the Table's page icon (empty vs has-content) updates. The
    // page note needn't be open in a pane; the database tab is what shows it.
    for (const [csvPath, dbDoc] of Object.entries(state.databases)) {
      if (dbDoc.pages && Object.values(dbDoc.pages).includes(ev.path)) {
        void get().syncDatabaseFromDisk(csvPath)
      }
    }

    // Keep the shared task cache in sync as files change externally or via our
    // own writes — cheap per-path rescans instead of walking the whole vault.
    // This covers the Tasks view (incl. inactive tabs, so returning to Kanban
    // doesn't show stale cards) and the calendar panel, whose weekly task list
    // otherwise kept showing a daily note's tasks as they were at the last full
    // scan (stale checked-state, missing newly added tasks).
    if (tasksSurfaceVisible(state)) {
      if (ev.kind === 'unlink') {
        set((s) => ({
          vaultTasks: s.vaultTasks.filter((t) => t.sourcePath !== ev.path)
        }))
      } else {
        await get().rescanTasksForPath(ev.path)
      }
    }

    // Only react when the path is actually open somewhere.
    const open = findLeavesContaining(state.paneLayout, ev.path).length > 0
    if (!open) return

    if (ev.kind === 'unlink') {
      closeUnlinkedNote(ev.path)
      return
    }

    // 'add' counts as new content for a note we already hold open. A writer
    // that renames a file into place (ZenNotes saving atomically, but equally
    // git, rsync, Syncthing or vim) shows up on Linux as IN_MOVED_TO, which the
    // server's watcher reports as 'add' rather than 'change'; treating it as
    // noise left the buffer showing content that no longer existed on disk.
    if (ev.kind === 'change' || ev.kind === 'add') {
      try {
        const content = await window.zen.readNote(ev.path)
        // Drop the watcher echo of our own writes. Without this, an
        // edit made between save-completion and echo-arrival gets
        // overwritten with the older disk body and the user sees
        // their last keystroke (often Enter) reverted.
        if (lastWrittenByPath.get(ev.path) === content.body) return
        set((s) => {
          const existing = s.noteContents[ev.path]
          // Ignore noise — only push when disk differs from our buffer.
          if (existing && existing.body === content.body) return s
          // Never replace a dirty buffer: it holds edits the user has not
          // saved, and the editor applies this push as a non-undoable doc
          // swap (#247), so a stale or truncated read here destroyed work
          // with no way back (#585). Same policy as the resync path above;
          // the pending save will reconcile disk with the buffer instead.
          if (s.noteDirty[ev.path]) return s
          const contents = { ...s.noteContents, [ev.path]: content }
          const dirty = { ...s.noteDirty, [ev.path]: false }
          return {
            noteContents: contents,
            noteDirty: dirty,
            ...activeFieldsFrom(s.paneLayout, s.activePaneId, contents, dirty)
          }
        })
      } catch {
        /* ignore — note may have been moved in the same tick */
      }
    }
  },

  updateActiveBody: (body) => {
    const path = get().selectedPath
    if (!path) return
    get().updateNoteBody(path, body)
  },

  updateNoteBody: (path, body) => {
    set((s) => {
      const existing = s.noteContents[path]
      if (!existing || existing.body === body) return s
      const contents = { ...s.noteContents, [path]: { ...existing, body } }
      const dirty = { ...s.noteDirty, [path]: true }
      // Editing a preview tab promotes it to a permanent tab (VS Code
      // behavior) so the edit can't be displaced by the next preview.
      // Cheap guard first: this runs on every keystroke.
      const needsPromote = allLeaves(s.paneLayout).some((l) => l.previewTab === path)
      const layout = needsPromote
        ? (mapLeaves(s.paneLayout, (l) => leafWithPromotedTab(l, path)) ?? s.paneLayout)
        : s.paneLayout
      return {
        noteContents: contents,
        noteDirty: dirty,
        ...(layout !== s.paneLayout ? { paneLayout: layout } : {}),
        ...activeFieldsFrom(layout, s.activePaneId, contents, dirty)
      }
    })
    // Debounced disk write.
    const existing = pathSaveTimers.get(path)
    if (existing) clearTimeout(existing)
    pathSaveTimers.set(
      path,
      setTimeout(() => {
        pathSaveTimers.delete(path)
        void get().persistNote(path)
      }, PATH_SAVE_DEBOUNCE_MS)
    )
  },

  persistActive: async () => {
    const path = get().selectedPath
    if (!path) return
    await get().persistNote(path)
  },

  persistNote: async (path) => {
    const pending = pathSaveTimers.get(path)
    if (pending) {
      clearTimeout(pending)
      pathSaveTimers.delete(path)
    }
    const performWrite = async (): Promise<void> => {
      const s = get()
      const content = s.noteContents[path]
      if (!content || !s.noteDirty[path]) return
      try {
        // Snapshot only after earlier writes finish. A second caller sees the
        // newest buffer here, then becomes the last writer by construction.
        const writtenBody = content.body
        lastWrittenByPath.set(path, writtenBody)
        const meta = await window.zen.writeNote(path, writtenBody)
        // Saving a Typst preamble note changes the definitions every note tagged
        // for it compiles against, so reload and repaint open panes. (#486)
        if (
          get().typstTagPreambles &&
          isTypstPreamblePath(
            path,
            resolveTypstPreambleFolder(get().vaultSettings?.typstPreambles?.folder)
          )
        ) {
          void get().refreshTypstPreambles()
        }
        set((cur) => {
          // Keystrokes that landed while the write was in flight leave the
          // buffer ahead of disk. The queued caller will persist them next.
          const stillCurrent = cur.noteContents[path]?.body === writtenBody
          const dirty = stillCurrent ? { ...cur.noteDirty, [path]: false } : cur.noteDirty
          return {
            noteDirty: dirty,
            notes: cur.notes.map((n) => (n.path === meta.path ? { ...n, ...meta } : n)),
            ...activeFieldsFrom(cur.paneLayout, cur.activePaneId, cur.noteContents, dirty)
          }
        })
      } catch (err) {
        console.error('writeNote failed', err)
      }
    }
    const previous = pathSaveQueues.get(path)
    // Start the first write synchronously through its first await, preserving
    // the body visible to this call. Later callers wait for that promise and
    // snapshot the newest buffer only when their turn begins.
    const run = previous ? previous.catch(() => {}).then(performWrite) : performWrite()
    pathSaveQueues.set(path, run)
    try {
      await run
    } finally {
      if (pathSaveQueues.get(path) === run) pathSaveQueues.delete(path)
    }
  },

  loadNoteComments: async (path) => {
    if (!path || isWorkspaceVirtualTabPath(path)) return []
    try {
      const comments = await window.zen.readNoteComments(path)
      set((s) => ({
        noteComments: { ...s.noteComments, [path]: comments }
      }))
      return comments
    } catch (err) {
      console.error('readNoteComments failed', err)
      return get().noteComments[path] ?? []
    }
  },

  addNoteComment: async (input) => {
    const path = input.notePath
    if (!path || isWorkspaceVirtualTabPath(path)) return null
    const body = input.body.trim()
    if (!body) return null
    const now = Date.now()
    const current = get().noteComments[path] ?? (await get().loadNoteComments(path))
    const draft: NoteCommentInput = {
      ...input,
      notePath: path,
      body,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      resolvedAt: input.resolvedAt ?? null
    }
    try {
      const comments = await window.zen.writeNoteComments(path, [...current, draft])
      const created = comments[comments.length - 1] ?? null
      set((s) => ({
        noteComments: { ...s.noteComments, [path]: comments },
        activeCommentId: created?.id ?? s.activeCommentId
      }))
      return created
    } catch (err) {
      console.error('writeNoteComments failed', err)
      return null
    }
  },

  updateNoteComment: async (path, id, patch) => {
    if (!path || !id) return
    const current = get().noteComments[path] ?? (await get().loadNoteComments(path))
    const now = Date.now()
    const next = current.map((comment) =>
      comment.id === id
        ? {
            ...comment,
            ...patch,
            body: patch.body !== undefined ? patch.body.trim() : comment.body,
            updatedAt: now
          }
        : comment
    )
    try {
      const comments = await window.zen.writeNoteComments(path, next)
      set((s) => ({
        noteComments: { ...s.noteComments, [path]: comments },
        activeCommentId:
          s.activeCommentId && comments.some((comment) => comment.id === s.activeCommentId)
            ? s.activeCommentId
            : null
      }))
    } catch (err) {
      console.error('updateNoteComment failed', err)
    }
  },

  deleteNoteComment: async (path, id) => {
    if (!path || !id) return
    const current = get().noteComments[path] ?? (await get().loadNoteComments(path))
    const next = current.filter((comment) => comment.id !== id)
    try {
      const comments = await window.zen.writeNoteComments(path, next)
      set((s) => ({
        noteComments: { ...s.noteComments, [path]: comments },
        activeCommentId: s.activeCommentId === id ? null : s.activeCommentId
      }))
    } catch (err) {
      console.error('deleteNoteComment failed', err)
    }
  },

  setActiveCommentId: (id) => set({ activeCommentId: id }),

  formatActiveNote: async () => {
    const s = get()
    const path = s.selectedPath
    if (!path) return
    const content = s.noteContents[path]
    if (!content) return
    try {
      const formatted = await formatMarkdown(content.body)
      if (formatted === content.body) return
      get().updateNoteBody(path, formatted)
      await get().persistNote(path)
    } catch (err) {
      console.error('formatActiveNote failed', err)
    }
  },

  renameNote: async (oldPath, nextTitle) => {
    if (!oldPath) return
    try {
      // Renaming rewrites every inbound wikilink on disk. Flush open buffers
      // first so that rewrite cannot race a pending save and get overwritten
      // by stale editor contents immediately afterwards.
      await get().flushDirtyNotes()
      if (Object.values(get().noteDirty).some(Boolean)) {
        throw new Error('Could not rename while notes still have unsaved changes')
      }
      renamesInFlight.add(oldPath)
      let meta: NoteMeta
      try {
        meta = await window.zen.renameNote(oldPath, nextTitle)
        set((s) => renameNoteState(s, oldPath, meta))
      } finally {
        renamesInFlight.delete(oldPath)
      }
      await get().applyFavorites(
        rewriteFavoriteNotePath(get().vaultSettings.favorites, oldPath, meta.path)
      )
      // Before the refresh so one listing picks up both the rename and the
      // rewritten heading (excerpt, size).
      await syncHeadingAfterRename(meta, get)
      await get().refreshNotes()
    } catch (err) {
      console.error('renameNote failed', err)
    }
  },

  renameActive: async (nextTitle) => {
    const oldPath = get().selectedPath
    if (!oldPath) return
    await get().renameNote(oldPath, nextTitle)
  },

  createAndOpen: async (folder, subpath = '', options) => {
    try {
      const meta = await window.zen.createNote(folder, options?.title, subpath)
      rememberEditModeForCreatedNote(meta.path)
      await get().refreshNotes()
      set({
        view: { kind: 'folder', folder, subpath },
        pendingTitleFocusPath: options?.focusTitle ? meta.path : null
      })
      await get().selectNote(meta.path)
    } catch (err) {
      console.error('createNote failed', err)
    }
  },

  createDrawingAndOpen: async (folder, subpath = '') => {
    try {
      const meta = await window.zen.createExcalidraw(folder, subpath)
      await get().refreshNotes()
      set({ view: { kind: 'folder', folder, subpath } })
      await get().selectNote(meta.path)
    } catch (err) {
      console.error('createExcalidraw failed', err)
    }
  },

  insertEmbedAtCursor: (embed) => {
    const state = get()
    const view = state.editorViewRef
    if (!view) return
    const { from, to } = view.state.selection.main
    view.dispatch({
      changes: { from, to, insert: embed },
      selection: { anchor: from + embed.length },
      scrollIntoView: true
    })
    view.focus()
  },

  newDrawing: async () => {
    try {
      const s = get()
      const settings = normalizeVaultSettings(s.vaultSettings)
      const { folder, subpath } = resolveCreateLocation(
        settings.drawingsLocation,
        s.activeNote,
        settings
      )
      const meta = await window.zen.createExcalidraw(folder, subpath)
      await get().refreshNotes()
      await get().openNoteInTab(meta.path)
    } catch (err) {
      console.error('newDrawing failed', err)
    }
  },

  embedNewDrawing: async () => {
    try {
      const s = get()
      const settings = normalizeVaultSettings(s.vaultSettings)
      const { folder, subpath } = resolveCreateLocation(
        settings.drawingsLocation,
        s.activeNote,
        settings
      )
      const meta = await window.zen.createExcalidraw(folder, subpath)
      if (get().activeNote) {
        get().insertEmbedAtCursor(`![[${meta.path}]]\n`)
      }
      await get().refreshNotes()
      await get().openNoteInTab(meta.path)
    } catch (err) {
      console.error('embedNewDrawing failed', err)
    }
  },

  createNoteInCurrentFolder: async () => {
    const s = get()
    if (isTrashViewActive(s)) return
    // "Current folder" is the folder of the active note (the one you're
    // editing), not the sidebar's browse view; those drift apart when notes
    // from different folders are open. (#403) Fall back to the browsed folder
    // only when no note is open. (#614)
    const active = s.activeNote
    if (active && active.folder !== 'trash') {
      await get().createAndOpen(active.folder, noteFolderSubpath(active, s.vaultSettings), {
        focusTitle: true
      })
      return
    }
    const v = s.view
    if (v.kind !== 'folder' || v.folder === 'trash') return
    await get().createAndOpen(v.folder, v.subpath, { focusTitle: true })
  },
  createNoteInChosenFolder: async (opts) => {
    const state = get()
    const entered = await promptApp(
      buildNoteDestinationPrompt(opts?.initialPath ?? '', state.folders)
    )
    if (entered == null) return // cancelled
    const dest = parseTemplateDestination(entered)
    await get().createAndOpen(dest.folder, dest.subpath, { focusTitle: true })
  },

  importDroppedMarkdownFiles: async (files) => {
    const createdPaths: string[] = []
    for (const file of files) {
      try {
        const content = await file.text()
        const title = file.name.replace(/\.(md|markdown)$/i, '').trim()
        const meta = await window.zen.createNote('inbox', title || undefined)
        if (content) await window.zen.writeNote(meta.path, content)
        createdPaths.push(meta.path)
      } catch (err) {
        console.error('importDroppedMarkdownFiles failed', file.name, err)
      }
    }
    if (createdPaths.length === 0) return
    await get().refreshNotes()
    for (const path of createdPaths) await get().openNoteInTab(path)
  },

  closeActiveNote: async () => {
    const state = get()
    const path = state.selectedPath
    if (!path) return
    await get().closeTabInPane(state.activePaneId, path)
  },

  reopenLastClosedTab: async () => {
    while (get().closedTabStack.length > 0) {
      const entry = get().closedTabStack.at(-1)
      if (!entry) return
      set((s) => ({ closedTabStack: s.closedTabStack.slice(0, -1) }))

      const state = get()
      const targetPaneId = findLeaf(state.paneLayout, entry.paneId)
        ? entry.paneId
        : state.activePaneId

      if (!isWorkspaceVirtualTabPath(entry.path)) {
        const noteExists = state.notes.some((note) => note.path === entry.path)
        if (!noteExists) continue
      }

      await get().openNoteInPane(targetPaneId, entry.path, entry.index)
      if (entry.pinned) get().pinTabInPane(targetPaneId, entry.path)
      return
    }
  },

  trashActive: async () => {
    const path = get().selectedPath
    if (!path) return
    await get().trashNote(path)
  },

  trashNote: async (path) => {
    const state = get()
    const title = state.notes.find((note) => note.path === path)?.title
    if (!(await confirmMoveToTrash(title))) return false
    if (!(await moveNoteToTrash(path, { temporarySession: state.vault?.temporary === true }))) {
      return false
    }
    set((s) => withoutNoteInWorkspace(s, path))
    await get().refreshNotes()
    return true
  },

  deleteActivePermanently: async () => {
    const path = get().selectedPath
    if (!path) return
    await get().deleteNotePermanently(path)
  },

  deleteNotePermanently: async (path) => {
    const title = get().notes.find((note) => note.path === path)?.title
    if (!(await confirmDeletePermanently(title))) return false
    if (!(await deleteNotePermanently(path))) return false
    set((s) => withoutNoteInWorkspace(s, path))
    await get().refreshNotes()
    return true
  },

  restoreActive: async () => {
    const path = get().selectedPath
    if (!path) return
    const meta = await window.zen.restoreFromTrash(path)
    await get().refreshNotes()
    set((s) => {
      const rewrite = (p: string): string => (p === path ? meta.path : p)
      const nextLayout = rewritePathsInTree(s.paneLayout, rewrite)
      const ensured = ensureActivePane(nextLayout, s.activePaneId)
      const contents = { ...s.noteContents }
      const dirty = { ...s.noteDirty }
      const prevContent = contents[path]
      if (path !== meta.path) {
        delete contents[path]
        delete dirty[path]
      }
      if (prevContent) {
        contents[meta.path] = { ...prevContent, ...meta }
      }
      dirty[meta.path] = false
      return {
        paneLayout: ensured.layout,
        activePaneId: ensured.activePaneId,
        noteContents: contents,
        noteDirty: dirty,
        noteBackstack: rewriteNoteJumpHistory(s.noteBackstack, rewrite),
        noteForwardstack: rewriteNoteJumpHistory(s.noteForwardstack, rewrite),
        pendingJumpLocation:
          s.pendingJumpLocation?.path === path
            ? { ...s.pendingJumpLocation, path: meta.path }
            : s.pendingJumpLocation,
        pinnedRefPath: s.pinnedRefPath === path ? meta.path : s.pinnedRefPath,
        ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
      }
    })
  },

  archiveActive: async () => {
    const path = get().selectedPath
    if (!path) return
    if (!(await get().confirmArchiveNotes([path]))) return
    await window.zen.archiveNote(path)
    set((s) => withoutNoteInWorkspace(s, path))
    await get().refreshNotes()
  },

  unarchiveActive: async () => {
    const path = get().selectedPath
    if (!path) return
    const meta = await window.zen.unarchiveNote(path)
    await get().refreshNotes()
    set((s) => {
      const rewrite = (p: string): string => (p === path ? meta.path : p)
      const nextLayout = rewritePathsInTree(s.paneLayout, rewrite)
      const ensured = ensureActivePane(nextLayout, s.activePaneId)
      const contents = { ...s.noteContents }
      const dirty = { ...s.noteDirty }
      const prevContent = contents[path]
      if (path !== meta.path) {
        delete contents[path]
        delete dirty[path]
      }
      if (prevContent) {
        contents[meta.path] = { ...prevContent, ...meta }
      }
      dirty[meta.path] = false
      return {
        paneLayout: ensured.layout,
        activePaneId: ensured.activePaneId,
        noteContents: contents,
        noteDirty: dirty,
        noteBackstack: rewriteNoteJumpHistory(s.noteBackstack, rewrite),
        noteForwardstack: rewriteNoteJumpHistory(s.noteForwardstack, rewrite),
        pendingJumpLocation:
          s.pendingJumpLocation?.path === path
            ? { ...s.pendingJumpLocation, path: meta.path }
            : s.pendingJumpLocation,
        pinnedRefPath: s.pinnedRefPath === path ? meta.path : s.pinnedRefPath,
        ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
      }
    })
  },

  exportActiveNoteDocx: async () => {
    const path = get().selectedPath
    if (!path) return
    try {
      // The export reads the file, so unsaved edits must land first: same
      // rule as the PDF path.
      await get().persistNote(path)
      if (get().noteDirty[path]) {
        throw new Error('Could not save the note before exporting it.')
      }
      const docxPath = await window.zen.exportNoteDocx(path)
      // Null means the save dialog was cancelled, which is not a result.
      if (docxPath) {
        const { useToastStore } = await import('./lib/toast')
        useToastStore.getState().addToast('Word document exported', 'success', {
          label: 'Show in folder',
          onClick: () => void window.zen.revealFilePath(docxPath)
        })
      }
    } catch (err) {
      console.error('exportNoteDocx failed', err)
      const { useToastStore } = await import('./lib/toast')
      useToastStore
        .getState()
        .addToast(
          err instanceof Error ? err.message : 'Could not export the note as a Word document.',
          'error'
        )
    }
  },

  exportActiveNotePdf: async () => {
    const path = get().selectedPath
    if (!path) return
    const appInfo = window.zen.getAppInfo()
    let preparedExportWindow: Window | null = null
    try {
      if (appInfo.runtime === 'web') {
        preparedExportWindow = window.open('', 'zennotes-pdf-export')
        if (preparedExportWindow && preparedExportWindow.document) {
          preparedExportWindow.document.title = 'Preparing PDF export…'
          preparedExportWindow.document.body.innerHTML =
            '<div style="margin:40px;font:16px/1.6 -apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif;color:#1f2937">Preparing PDF export…</div>'
        }
      }
      await get().persistNote(path)
      if (get().noteDirty[path]) {
        throw new Error('Could not save the note before exporting the PDF.')
      }
      const pdfPath = await window.zen.exportNotePdf(path)
      // A returned path means a real file was written on disk — desktop only.
      // Web returns null (it navigates the prepared window to a print view, which
      // is the feedback there, so we must NOT close that window), and desktop
      // returns null when the save dialog is cancelled. Only then confirm + offer
      // to reveal the file. (#257)
      if (pdfPath) {
        const { useToastStore } = await import('./lib/toast')
        useToastStore.getState().addToast('PDF exported', 'success', {
          label: 'Show in folder',
          onClick: () => void window.zen.revealFilePath(pdfPath)
        })
      }
    } catch (err) {
      preparedExportWindow?.close()
      console.error('exportNotePdf failed', err)
      const { useToastStore } = await import('./lib/toast')
      useToastStore.getState().addToast(
        err instanceof Error ? err.message : 'Could not export the note as a PDF.',
        'error'
      )
    }
  },

  copyActiveNoteAsMarkdown: async () => {
    const s = get()
    const active = s.activeNote
    if (!active) return
    let body = s.noteContents[active.path]?.body
    if (body == null) {
      try {
        body = (await window.zen.readNote(active.path)).body
      } catch {
        return
      }
    }
    window.zen.clipboardWriteText(body)
  },

  copyActiveNoteAsHtml: async () => {
    const s = get()
    const active = s.activeNote
    if (!active) return
    let body = s.noteContents[active.path]?.body
    if (body == null) {
      try {
        body = (await window.zen.readNote(active.path)).body
      } catch {
        return
      }
    }
    const { useToastStore } = await import('./lib/toast')
    try {
      // Lazy: the renderer chain rides the markdown vendor chunk, which has
      // no business on the boot path for a clipboard command.
      const { renderNoteEmailHtml, collectEmailImageRefs } = await import('./lib/note-email-html')
      const { resolveAssetVaultRelativePath } = await import('./lib/local-assets')
      // Every local image rides along as a data: URI (#628). Anything the
      // vault cannot serve, or that is too big for a mail body, keeps the
      // alt-text fallback.
      const images = new Map<string, string>()
      for (const ref of collectEmailImageRefs(body)) {
        const rel = resolveAssetVaultRelativePath(s.vault?.root, active.path, ref)
        if (!rel) continue
        try {
          const base64 = await window.zen.readVaultAssetBase64(rel)
          if (base64.length > EMAIL_IMAGE_MAX_BASE64) continue
          images.set(ref, `data:${emailImageMime(rel)};base64,${base64}`)
        } catch {
          /* unreadable: the alt text stands in */
        }
      }
      const { html } = renderNoteEmailHtml(body, active.title, { images })
      // Both flavors: rich for mail clients, the markdown itself for editors.
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([body], { type: 'text/plain' })
        })
      ])
      useToastStore
        .getState()
        .addToast('Copied as HTML, ready to paste into an email', 'success')
    } catch (err) {
      console.error('copyActiveNoteAsHtml failed', err)
      useToastStore
        .getState()
        .addToast(
          err instanceof Error ? err.message : 'Could not copy the note as HTML.',
          'error'
        )
    }
  },

  setSearchOpen: (open) =>
    set({
      searchOpen: open,
      vaultTextSearchOpen: open ? false : get().vaultTextSearchOpen,
      query: open ? get().query : ''
    }),
  setVaultTextSearchOpen: (open) =>
    set({
      vaultTextSearchOpen: open,
      searchOpen: open ? false : get().searchOpen
    }),
  setCommandPaletteOpen: (open, mode = 'main') =>
    set({
      commandPaletteOpen: open,
      commandPaletteInitialMode: open ? mode : 'main'
    }),
  setBufferPaletteOpen: (open) => set({ bufferPaletteOpen: open }),
  setEmbedDrawingPaletteOpen: (open) => set({ embedDrawingPaletteOpen: open }),
  setOutlinePaletteOpen: (open) => set({ outlinePaletteOpen: open }),
  setQuery: (q) => set({ query: q }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleNoteList: () => set((s) => ({ noteListOpen: !s.noteListOpen })),
  setFocusMode: (focus) =>
    set((s) => {
      if (focus) {
        if (s.zenMode) return {}
        return {
          zenMode: true,
          zenRestoreState: {
            sidebarOpen: s.sidebarOpen,
            noteListOpen: s.noteListOpen,
            pinnedRefVisible: s.pinnedRefVisible
          },
          sidebarOpen: false,
          noteListOpen: false,
          pinnedRefVisible: false,
          focusedPanel: 'editor'
        }
      }

      if (!s.zenMode) return {}
      return {
        zenMode: false,
        zenRestoreState: null,
        sidebarOpen: s.zenRestoreState?.sidebarOpen ?? s.sidebarOpen,
        noteListOpen: s.zenRestoreState?.noteListOpen ?? s.noteListOpen,
        pinnedRefVisible: s.zenRestoreState?.pinnedRefVisible ?? s.pinnedRefVisible,
        focusedPanel: 'editor'
      }
    }),
  setVimMode: (on) => {
    set({ vimMode: on })
    savePrefs(collectPrefs(get()))
  },
  setVimInsertEscape: (sequence) => {
    set({ vimInsertEscape: sequence.trim().slice(0, 5) })
    savePrefs(collectPrefs(get()))
  },
  setVimYankToClipboard: (on) => {
    set({ vimYankToClipboard: on })
    savePrefs(collectPrefs(get()))
  },
  setVimBlockImeInNormalMode: (on) => {
    set({ vimBlockImeInNormalMode: on })
    savePrefs(collectPrefs(get()))
  },
  setVimWrappedLineMotions: (mode) => {
    set({ vimWrappedLineMotions: mode })
    savePrefs(collectPrefs(get()))
  },
  setKeymapBinding: (id, binding) => {
    set((s) => {
      const nextOverrides = { ...s.keymapOverrides }
      if (binding) nextOverrides[id] = binding
      else delete nextOverrides[id]
      return { keymapOverrides: nextOverrides }
    })
    savePrefs(collectPrefs(get()))
  },
  resetAllKeymaps: () => {
    set({ keymapOverrides: {} })
    savePrefs(collectPrefs(get()))
  },
  setOverrideEnabled: (name, on) => {
    set((s) => {
      const next = { ...s.enabledOverrides }
      if (on) next[name] = 'on'
      else delete next[name]
      return { enabledOverrides: next }
    })
    savePrefs(collectPrefs(get()))
  },
  setThemeTweak: (slug, value) => {
    set((s) => {
      const next = { ...s.themeTweaks }
      if (value) next[slug] = value
      else delete next[slug]
      return { themeTweaks: next }
    })
    // State updates immediately (live preview); the config write is debounced.
    scheduleThemeTweaksSave()
  },
  resetThemeTweaks: () => {
    set({ themeTweaks: {} })
    savePrefs(collectPrefs(get()))
  },
  setWhichKeyHints: (on) => {
    set({ whichKeyHints: on })
    savePrefs(collectPrefs(get()))
  },
  setWhichKeyHintMode: (mode) => {
    set({ whichKeyHintMode: mode })
    savePrefs(collectPrefs(get()))
  },
  setWhichKeyHintTimeoutMs: (ms) => {
    set({ whichKeyHintTimeoutMs: Math.min(3000, Math.max(400, Math.round(ms))) })
    savePrefs(collectPrefs(get()))
  },
  setVaultTextSearchBackend: (backend) => {
    set({ vaultTextSearchBackend: backend })
    savePrefs(collectPrefs(get()))
  },
  setRipgrepBinaryPath: (path) => {
    set({ ripgrepBinaryPath: path })
    savePrefs(collectPrefs(get()))
  },
  setFzfBinaryPath: (path) => {
    set({ fzfBinaryPath: path })
    savePrefs(collectPrefs(get()))
  },
  setLivePreview: (on) => {
    set({ livePreview: on })
    savePrefs(collectPrefs(get()))
  },
  setShowHeadingLevelLabels: (on) => {
    set({ showHeadingLevelLabels: on })
    savePrefs(collectPrefs(get()))
  },
  setListIndentGuides: (on) => {
    set({ listIndentGuides: on })
    savePrefs(collectPrefs(get()))
  },
  setRenderTablesInLivePreview: (on) => {
    set({ renderTablesInLivePreview: on })
    savePrefs(collectPrefs(get()))
  },
  setCompletedTaskStyle: (style) => {
    set({ completedTaskStyle: style })
    savePrefs(collectPrefs(get()))
  },
  setMathRenderer: (renderer) => {
    set({ mathRenderer: renderer })
    savePrefs(collectPrefs(get()))
  },
  setHarperEnabled: (on) => {
    set({ harperEnabled: on })
    savePrefs(collectPrefs(get()))
  },
  setHarperDialect: (dialect) => {
    set({ harperDialect: dialect })
    savePrefs(collectPrefs(get()))
  },
  setHarperLintConfig: (config) => {
    set({ harperLintConfig: normalizeHarperLintConfig(config) })
    savePrefs(collectPrefs(get()))
  },
  saveHarperVaultState: async (next) => {
    const settings = get().vaultSettings
    const harper = next.words.length === 0 && next.ignoredLints.length === 0 ? undefined : next
    try {
      const saved = normalizeVaultSettings(
        await window.zen.setVaultSettings({ ...settings, harper })
      )
      set({ vaultSettings: saved })
    } catch (error) {
      console.error('saveHarperVaultState failed', error)
    }
  },
  setTypstTagPreambles: (on) => {
    set({ typstTagPreambles: on })
    savePrefs(collectPrefs(get()))
    if (on) void get().refreshTypstPreambles()
    else set({ typstPreambleNotes: [] })
  },
  setLooseMathDelimiters: (on) => {
    set({ looseMathDelimiters: on })
    savePrefs(collectPrefs(get()))
  },
  setKeepViewModeAcrossNotes: (on) => {
    set({ keepViewModeAcrossNotes: on })
    savePrefs(collectPrefs(get()))
  },
  setDefaultPaneMode: (mode) => {
    set({ defaultPaneMode: mode })
    savePrefs(collectPrefs(get()))
  },
  setSyncTitleHeadingOnRename: (on) => {
    set({ syncTitleHeadingOnRename: on })
    savePrefs(collectPrefs(get()))
  },
  setMarkdownSnippets: (on) => {
    set({ markdownSnippets: on })
    savePrefs(collectPrefs(get()))
  },
  setTextReplacementsEnabled: (on) => {
    set({ textReplacementsEnabled: on })
    savePrefs(collectPrefs(get()))
  },
  setTextReplacements: (replacements) => {
    set({ textReplacements: normalizeTextReplacements(replacements) })
    savePrefs(collectPrefs(get()))
  },
  setAutoPairs: (on) => {
    set({ autoPairs: on })
    savePrefs(collectPrefs(get()))
  },
  setAutoPairQuotesInProse: (on) => {
    set({ autoPairQuotesInProse: on })
    savePrefs(collectPrefs(get()))
  },
  setHideBuiltinTemplates: (hidden) => {
    set({ hideBuiltinTemplates: hidden })
    savePrefs(collectPrefs(get()))
  },

  openAtlasView: async () => {
    const state = get()
    // Single funnel for every entry point (sidebar row, command, leader key),
    // so the feature switch holds even if a caller forgets to check it.
    if (!state.atlasEnabled) return
    await get().openNoteInPane(state.activePaneId, ATLAS_TAB_PATH)
    // Hand the keyboard over on EVERY open, not just the first: clicking the
    // sidebar row leaves focus (and focusedPanel) on the sidebar, and the
    // row click is also how people re-enter an already-open Atlas tab. The
    // map takes DOM focus itself once it owns the panel, so only strip focus
    // from something else; blurring the map root here put focus back on
    // <body> and the global Vim layer ate `[`/`]` as buffer prefixes (#670).
    const active = document.activeElement as HTMLElement | null
    if (active && !active.closest('[data-atlas-view]')) active.blur?.()
    set({ focusedPanel: 'atlas' })
  },
  setWorkflowsEnabled: (on) => {
    set({ workflowsEnabled: on })
    savePrefs(collectPrefs(get()))
    if (!on) closeWorkflowsTabsEverywhere()
  },
  setAtlasEnabled: (on) => {
    set({ atlasEnabled: on })
    savePrefs(collectPrefs(get()))
    if (!on) closeAtlasTabsEverywhere()
  },
  hideWorkflowPreset: (id) => {
    set((s) => ({
      hiddenWorkflowPresets: normalizeHiddenWorkflowPresets([...s.hiddenWorkflowPresets, id])
    }))
    savePrefs(collectPrefs(get()))
  },
  restoreWorkflowPreset: (id) => {
    set((s) => ({
      hiddenWorkflowPresets: s.hiddenWorkflowPresets.filter((hidden) => hidden !== id)
    }))
    savePrefs(collectPrefs(get()))
  },
  setHiddenWorkflowPresets: (ids) => {
    set({ hiddenWorkflowPresets: normalizeHiddenWorkflowPresets([...ids]) })
    savePrefs(collectPrefs(get()))
  },
  setTabsEnabled: (on) => {
    set((s) => {
      if (on) return { tabsEnabled: true }
      // Collapse to a single leaf holding just the current selectedPath
      // (if any). All other tabs + splits vanish. The pinned reference
      // pane is independent of the tab tree and keeps its own content.
      const activePath = s.selectedPath
      const onlyLeaf: PaneLeaf = {
        kind: 'leaf',
        id: s.activePaneId,
        tabs: activePath ? [activePath] : [],
        pinnedTabs: [],
        activeTab: activePath
      }
      const contents: Record<string, NoteContent> = {}
      const dirty: Record<string, boolean> = {}
      if (activePath && s.noteContents[activePath]) {
        contents[activePath] = s.noteContents[activePath]
        dirty[activePath] = s.noteDirty[activePath] ?? false
      }
      if (s.pinnedRefPath && s.noteContents[s.pinnedRefPath]) {
        contents[s.pinnedRefPath] = s.noteContents[s.pinnedRefPath]
        dirty[s.pinnedRefPath] = s.noteDirty[s.pinnedRefPath] ?? false
      }
      return {
        tabsEnabled: false,
        paneLayout: onlyLeaf,
        activePaneId: onlyLeaf.id,
        noteContents: contents,
        noteDirty: dirty,
        ...activeFieldsFrom(onlyLeaf, onlyLeaf.id, contents, dirty)
      }
    })
    savePrefs(collectPrefs(get()))
  },
  setWrapTabs: (on) => {
    set({ wrapTabs: on })
    savePrefs(collectPrefs(get()))
  },
  setPdfExportUseTheme: (on) => {
    set({ pdfExportUseTheme: on })
    savePrefs(collectPrefs(get()))
  },
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setWorkflowTutorialStep: (step) => set({ workflowTutorialStep: step }),
  setWorkflowRunRecord: (next) =>
    set((s) => ({
      workflowRunRecord: typeof next === 'function' ? next(s.workflowRunRecord) : next
    })),
  setTheme: ({ id, family, mode }) => {
    set({ themeId: id, themeFamily: family, themeMode: mode })
    savePrefs(collectPrefs(get()))
  },
  setEditorFontSize: (px) => {
    set({ editorFontSize: px })
    savePrefs(collectPrefs(get()))
  },
  setMathFontScale: (percent) => {
    set({ mathFontScale: Math.min(200, Math.max(50, Math.round(percent))) })
    savePrefs(collectPrefs(get()))
  },
  setEditorLineHeight: (mult) => {
    set({ editorLineHeight: mult })
    savePrefs(collectPrefs(get()))
  },
  setEditorTabSize: (size) => {
    set({ editorTabSize: normalizeEditorTabSize(size) })
    savePrefs(collectPrefs(get()))
  },
  setEditorScrollOff: (lines) => {
    set({ editorScrollOff: Math.max(0, Math.floor(lines)) })
    savePrefs(collectPrefs(get()))
  },
  setTimeFormat: (format) => {
    set({ timeFormat: format })
    savePrefs(collectPrefs(get()))
  },
  setPreviewMaxWidth: (px) => {
    const clamped = Math.min(1600, Math.max(640, Math.round(px)))
    set({ previewMaxWidth: clamped })
    savePrefs(collectPrefs(get()))
  },
  setLineNumberMode: (mode) => {
    set({ lineNumberMode: mode })
    savePrefs(collectPrefs(get()))
  },
  setViewSettingsScope: (scope) => {
    set({ viewSettingsScope: scope })
    savePrefs(collectPrefs(get()))
    // Switching to per-vault: overlay this vault's saved view immediately so the
    // change takes effect without a reopen. Switching to global keeps the live
    // (global) values as-is. (#292)
    if (scope === 'vault') set(viewPrefsFromVault(get().vaultSettings))
  },
  setLineNumberPosition: (position) => {
    set({ lineNumberPosition: position })
    savePrefs(collectPrefs(get()))
  },
  setInterfaceFont: (family) => {
    set({ interfaceFont: family })
    savePrefs(collectPrefs(get()))
  },
  setTextFont: (family) => {
    set({ textFont: family })
    savePrefs(collectPrefs(get()))
  },
  setMonoFont: (family) => {
    set({ monoFont: family })
    savePrefs(collectPrefs(get()))
  },
  setSystemFolderLabel: (folder, label) => {
    const normalized = normalizeSystemFolderLabels({ [folder]: label })
    set((s) => ({
      systemFolderLabels: normalized[folder]
        ? { ...s.systemFolderLabels, [folder]: normalized[folder] }
        : Object.fromEntries(
            Object.entries(s.systemFolderLabels).filter(([key]) => key !== folder)
          ) as SystemFolderLabels
    }))
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ systemFolderLabels: get().systemFolderLabels })
  },
  setSidebarWidth: (px) => {
    const clamped = Math.min(520, Math.max(160, Math.round(px)))
    set({ sidebarWidth: clamped })
    savePrefs(collectPrefs(get()))
  },
  setNoteListWidth: (px) => {
    const clamped = Math.min(560, Math.max(200, Math.round(px)))
    set({ noteListWidth: clamped })
    savePrefs(collectPrefs(get()))
  },
  setNoteSortOrder: (order) => {
    set({ noteSortOrder: order })
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ noteSortOrder: order })
  },
  setAssetSortOrder: (order) => {
    set({ assetSortOrder: order })
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ assetSortOrder: order })
  },
  reorderNoteManually: (draggedPath, targetPath, position) => {
    const dir = parentDirOf(draggedPath)
    if (draggedPath === targetPath || parentDirOf(targetPath) !== dir) return
    const s = get()
    const existing = s.manualNoteOrder[dir]
    // Current sibling order (manual if set, else file order), then move.
    const ordered = s.notes
      .filter((n) => parentDirOf(n.path) === dir)
      .slice()
      .sort((a, b) =>
        manualOrderCompare(existing, a.path, a.siblingOrder, b.path, b.siblingOrder)
      )
      .map((n) => n.path)
    const next = applyManualMove(ordered, draggedPath, targetPath, position)
    const nextMap = { ...s.manualNoteOrder, [dir]: next }
    set({ manualNoteOrder: nextMap })
    writeManualOrder(s.vault?.root ?? '', nextMap)
  },
  reorderTaskInNote: async (task, targetTask, position) => {
    // Reorder is a within-note line move — tasks in different notes live in
    // different files, so cross-note moves aren't possible here.
    if (task.sourcePath !== targetTask.sourcePath || task.taskIndex === targetTask.taskIndex) {
      return
    }
    const path = task.sourcePath
    const openBuffer = get().noteContents[path]
    let body: string
    try {
      body = openBuffer?.body ?? (await window.zen.readNote(path)).body
    } catch (err) {
      console.error('readNote (reorder) failed', err)
      return
    }
    const nextBody = moveTaskLine(body, task.taskIndex, targetTask.taskIndex, position)
    if (nextBody === body) return

    // Optimistically refresh this note's tasks so the list reorders immediately,
    // whether the note is open (unsaved buffer) or only on disk.
    const fresh = parseTasksFromBody(nextBody, {
      path,
      title: task.noteTitle,
      folder: task.noteFolder
    })
    set((s) => ({
      vaultTasks: s.vaultTasks.filter((t) => t.sourcePath !== path).concat(fresh)
    }))

    if (get().noteContents[path]) {
      get().updateNoteBody(path, nextBody)
    } else {
      try {
        await window.zen.writeNote(path, nextBody)
      } catch (err) {
        console.error('writeNote (reorder) failed', err)
        void get().rescanTasksForPath(path)
      }
    }
  },
  setGroupByKind: (on) => {
    set({ groupByKind: on })
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ groupByKind: on })
  },
  setAutoReveal: (on) => {
    set({ autoReveal: on })
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ autoReveal: on })
  },
  setUnifiedSidebar: () => {
    set({ unifiedSidebar: true })
    savePrefs(collectPrefs(get()))
    persistVaultViewOverride({ unifiedSidebar: true })
  },
  setDarkSidebar: (on) => {
    set({ darkSidebar: on })
    savePrefs(collectPrefs(get()))
  },
  setShowSidebarChevrons: (on) => {
    set({ showSidebarChevrons: on })
    savePrefs(collectPrefs(get()))
  },
  toggleCollapseFolder: (key) => {
    set((s) =>
      s.collapsedFolders.includes(key)
        ? { collapsedFolders: s.collapsedFolders.filter((k) => k !== key) }
        : { collapsedFolders: [...s.collapsedFolders, key] }
    )
    savePrefs(collectPrefs(get()))
  },
  setCollapsedFolders: (keys) => {
    set({ collapsedFolders: keys })
    savePrefs(collectPrefs(get()))
  },

  pinReference: async (path) => {
    if (!path) return
    const s = get()
    // Already pinned to this path — just make sure it's visible.
    if (s.pinnedRefPath === path && s.pinnedRefKind === 'note') {
      if (!s.pinnedRefVisible) {
        set({ pinnedRefVisible: true })
        savePrefs(collectPrefs(get()))
      }
      return
    }
    // Preload content if we don't already have it cached.
    let contents = s.noteContents
    let dirty = s.noteDirty
    if (!contents[path]) {
      try {
        const content = await readNoteContent(path, s)
        contents = { ...contents, [path]: content }
        dirty = { ...dirty, [path]: false }
      } catch (err) {
        console.error('pinReference readNote failed', err)
        return
      }
    }
    set({
      pinnedRefPath: path,
      pinnedRefKind: 'note',
      pinnedRefVisible: true,
      noteContents: contents,
      noteDirty: dirty
    })
    savePrefs(collectPrefs(get()))
  },

  pinAssetReference: (path, fragment) => {
    if (!path) return
    const s = get()
    // If we were previously pinning a note, evict its content unless
    // some other pane has it open.
    let contents = s.noteContents
    let dirty = s.noteDirty
    if (s.pinnedRefKind === 'note' && s.pinnedRefPath && s.pinnedRefPath !== path) {
      const stillOpen = allLeaves(s.paneLayout).some((l) =>
        l.tabs.includes(s.pinnedRefPath as string)
      )
      if (!stillOpen) {
        contents = { ...contents }
        dirty = { ...dirty }
        delete contents[s.pinnedRefPath]
        delete dirty[s.pinnedRefPath]
      }
    }
    set({
      pinnedRefPath: path,
      pinnedRefFragment: fragment ?? null,
      pinnedRefKind: 'asset',
      pinnedRefVisible: true,
      noteContents: contents,
      noteDirty: dirty
    })
    savePrefs(collectPrefs(get()))
  },

  pinAssetReferenceForNote: (notePath, assetPath, fragment) => {
    if (!notePath || !assetPath) return
    set((s) => ({
      noteRefs: { ...s.noteRefs, [notePath]: { path: assetPath, kind: 'asset', fragment: fragment ?? null } },
      pinnedRefVisible: true
    }))
    savePrefs(collectPrefs(get()))
  },

  unpinReferenceForNote: (notePath) => {
    set((s) => {
      if (!(notePath in s.noteRefs)) return s
      const { [notePath]: _drop, ...rest } = s.noteRefs
      void _drop
      return { noteRefs: rest }
    })
    savePrefs(collectPrefs(get()))
  },

  unpinReference: () => {
    const s = get()
    const path = s.pinnedRefPath
    if (!path) return
    // Evict the cached note content only when this was a note-kind
    // pin (assets aren't cached in noteContents anyway) and no pane
    // still has the note open.
    let contents = s.noteContents
    let dirty = s.noteDirty
    if (s.pinnedRefKind === 'note') {
      const stillOpen = allLeaves(s.paneLayout).some((l) => l.tabs.includes(path))
      if (!stillOpen) {
        contents = { ...contents }
        dirty = { ...dirty }
        delete contents[path]
        delete dirty[path]
      }
    }
    set({
      pinnedRefPath: null,
      pinnedRefFragment: null,
      pinnedRefKind: 'note',
      noteContents: contents,
      noteDirty: dirty
    })
    savePrefs(collectPrefs(get()))
  },

  togglePinnedRefVisible: () => {
    set((st) => ({ pinnedRefVisible: !st.pinnedRefVisible }))
    savePrefs(collectPrefs(get()))
  },

  setPinnedRefWidth: (px) => {
    // Cap at `viewport - 320px` so the main editor always has room to
    // breathe, with an absolute ceiling of 2400px for giant monitors.
    // 800px was too stingy for PDF work at a readable zoom.
    const viewport =
      typeof window !== 'undefined' ? window.innerWidth : 1600
    const upper = Math.max(400, Math.min(2400, viewport - 320))
    const clamped = Math.min(upper, Math.max(280, Math.round(px)))
    set({ pinnedRefWidth: clamped })
    savePrefs(collectPrefs(get()))
  },

  setPanelWidth: (panel, px) => {
    set({ panelWidths: { ...get().panelWidths, [panel]: clampPanelWidth(px) } })
    savePrefs(collectPrefs(get()))
  },

  setPinnedRefMode: (mode) => {
    set({ pinnedRefMode: mode })
    savePrefs(collectPrefs(get()))
  },

  setQuickNoteDateTitle: (on) => {
    set({ quickNoteDateTitle: on })
    savePrefs(collectPrefs(get()))
  },

  setQuickNoteTitlePrefix: (prefix) => {
    set({ quickNoteTitlePrefix: prefix?.trim() ? prefix.trim() : null })
    savePrefs(collectPrefs(get()))
  },

  openDailyNoteForDate: async (date) => {
    const state = get()
    const settings = normalizeVaultSettings(state.vaultSettings)
    if (!settings.dailyNotes.enabled) return
    const { title, subpath } = dailyNoteLocationForDate(date, settings)
    const existing = findDailyNoteForDate(state.notes, settings, date)
    if (existing) {
      set({ view: { kind: 'folder', folder: 'inbox', subpath } })
      await get().selectNote(existing.path)
    } else {
      const template = resolveTemplate(state.customTemplates, settings.dailyNotes.templateId)
      if (template) {
        await get().createFromTemplate(template, { folder: 'inbox', subpath, title, date })
      } else {
        await get().createAndOpen('inbox', subpath, { title })
      }
    }
    // Land keyboard focus in the editor so `i` starts insert straight away,
    // instead of leaving focus on the sidebar item that just got selected. The
    // command is a jump-and-type flow and is often fired from outside the
    // editor (leader key, palette), where focus would otherwise stay put. (#353)
    requestEditorFocus()
    // Opening *today's* note rolls unfinished tasks forward from past daily
    // notes (Obsidian-style) when enabled. Fire-and-forget so the note shows
    // right away; the rollover appends into the now-open buffer.
    if (noteTitleForDate(date) === noteTitleForDate(new Date())) {
      void get().rolloverUnfinishedTasksIntoToday()
    }
  },

  openTodayDailyNote: async () => {
    await get().openDailyNoteForDate(new Date())
  },

  ensureDailyNoteForDate: async (date) => {
    const state = get()
    const settings = normalizeVaultSettings(state.vaultSettings)
    if (!settings.dailyNotes.enabled) return null
    const existing = findDailyNoteForDate(state.notes, settings, date)
    if (existing) return existing
    const { title, subpath } = dailyNoteLocationForDate(date, settings)
    const template = resolveTemplate(state.customTemplates, settings.dailyNotes.templateId)
    const body = template ? renderTemplate(template.body, { title, now: date }).body : ''
    try {
      const meta = await window.zen.createNote('inbox', title, subpath)
      rememberEditModeForCreatedNote(meta.path)
      if (body) await window.zen.writeNote(meta.path, body)
      await get().refreshNotes()
      return get().notes.find((n) => n.path === meta.path) ?? meta
    } catch (err) {
      console.error('ensureDailyNoteForDate failed', err)
      return null
    }
  },

  addTaskForDate: async (dateIso, text) => {
    const content = text.trim()
    if (!content) return
    const parsed = parseIsoDateLocal(dateIso)
    if (!parsed) return
    const settings = normalizeVaultSettings(get().vaultSettings)
    if (!settings.dailyNotes.enabled) return
    let note = findDailyNoteForDate(get().notes, settings, parsed)
    if (!note) {
      const ok = await confirmApp({
        title: 'Create daily note?',
        description: `No daily note exists for ${dateIso} yet. Create it and add this task?`,
        confirmLabel: 'Create & add'
      })
      if (!ok) return
      note = await get().ensureDailyNoteForDate(parsed)
      if (!note) return
    }
    const path = note.path
    // Implicit due already covers daily-note tasks; only write an explicit
    // `due:` token when inference is off, so the task still lands on this day.
    const line = settings.dailyNotes.tasksDueOnNoteDate
      ? `- [ ] ${content}`
      : `- [ ] ${content} due:${dateIso}`
    const openBuffer = get().noteContents[path]
    const body = openBuffer?.body ?? (await window.zen.readNote(path)).body
    const trimmed = body.replace(/\s+$/u, '')
    const nextBody = trimmed.length ? `${trimmed}\n${line}\n` : `${line}\n`
    if (openBuffer) {
      // Open note: edit through the buffer so unsaved changes aren't stomped;
      // its autosave + the watcher rescan the tasks (a disk rescan now would be
      // stale). The common add-from-calendar case hits the writeNote branch.
      get().updateNoteBody(path, nextBody)
    } else {
      try {
        await window.zen.writeNote(path, nextBody)
        await get().rescanTasksForPath(path)
      } catch (err) {
        console.error('addTaskForDate writeNote failed', err)
      }
    }
  },

  rolloverUnfinishedTasksIntoToday: async (opts) => {
    const force = opts?.force === true
    const settings = normalizeVaultSettings(get().vaultSettings)
    if (!settings.dailyNotes.enabled) return 0
    const today = new Date()
    const todayIso = noteTitleForDate(today)
    const vaultRoot = get().vault?.root ?? ''
    if (!force) {
      if (!settings.dailyNotes.rolloverUnfinishedTasks) return 0
      if (readRolloverMarker(vaultRoot) === todayIso) return 0
    }
    const todayNote = await get().ensureDailyNoteForDate(today)
    if (!todayNote) return 0
    if (opts?.open) {
      const { subpath } = dailyNoteLocationForDate(today, settings)
      set({ view: { kind: 'folder', folder: 'inbox', subpath } })
      await get().selectNote(todayNote.path)
    }

    // Gather unfinished task blocks from every *past* daily note, oldest first.
    const pastNotes: Array<{ note: NoteMeta; iso: string }> = []
    for (const note of get().notes) {
      if (note.path === todayNote.path) continue
      const info = classifyDateNote(note, settings)
      if (info?.kind !== 'daily') continue
      const iso = noteTitleForDate(info.date)
      if (iso < todayIso) pastNotes.push({ note, iso })
    }
    pastNotes.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0))

    const movedLines: string[] = []
    for (const { note } of pastNotes) {
      const buffer = get().noteContents[note.path]
      let body: string
      try {
        body = buffer?.body ?? (await window.zen.readNote(note.path)).body
      } catch (err) {
        console.error('rollover readNote failed', note.path, err)
        continue
      }
      const { moved, rest } = extractOpenTaskBlocks(body)
      if (moved.length === 0) continue
      movedLines.push(...moved)
      if (buffer) {
        // Open buffer: route through the normal edit pipeline (marks dirty,
        // autosaves, watcher rescans tasks) — same as toggleTaskFromList. A disk
        // rescan here would read the not-yet-flushed file and go stale.
        get().updateNoteBody(note.path, rest)
      } else {
        try {
          await window.zen.writeNote(note.path, rest)
          await get().rescanTasksForPath(note.path)
        } catch (err) {
          console.error('rollover writeNote (source) failed', note.path, err)
          // Don't drop the lines we already pulled — they'll still land in today.
        }
      }
    }

    if (movedLines.length === 0) {
      writeRolloverMarker(vaultRoot, todayIso)
      return 0
    }

    const todayBuffer = get().noteContents[todayNote.path]
    let todayBody: string
    try {
      todayBody = todayBuffer?.body ?? (await window.zen.readNote(todayNote.path)).body
    } catch (err) {
      console.error('rollover readNote (today) failed', err)
      return 0
    }
    // Group the rolled-over tasks under today's `## Tasks` heading if it has
    // one, else append them to the end (#452).
    const nextBody = insertTasksUnderTasksHeading(todayBody, movedLines)
    if (todayBuffer) {
      get().updateNoteBody(todayNote.path, nextBody)
    } else {
      try {
        await window.zen.writeNote(todayNote.path, nextBody)
        await get().rescanTasksForPath(todayNote.path)
      } catch (err) {
        console.error('rollover writeNote (today) failed', err)
        return 0
      }
    }
    writeRolloverMarker(vaultRoot, todayIso)
    return movedLines.length
  },

  openWeeklyNoteForDate: async (date) => {
    const state = get()
    const settings = normalizeVaultSettings(state.vaultSettings)
    if (!settings.weeklyNotes.enabled) return
    const { title, subpath } = weeklyNoteLocationForDate(date, settings)
    const existing = findWeeklyNoteForDate(state.notes, settings, date)
    if (existing) {
      set({ view: { kind: 'folder', folder: 'inbox', subpath } })
      await get().selectNote(existing.path)
    } else {
      const template = resolveTemplate(state.customTemplates, settings.weeklyNotes.templateId)
      if (template) {
        await get().createFromTemplate(template, { folder: 'inbox', subpath, title, date })
      } else {
        await get().createAndOpen('inbox', subpath, { title })
      }
    }
    // Focus the editor so `i` starts insert immediately (see openDailyNoteForDate).
    requestEditorFocus()
  },

  openThisWeekWeeklyNote: async () => {
    await get().openWeeklyNoteForDate(new Date())
  },

  openMonthlyNoteForDate: async (date) => {
    const state = get()
    const settings = normalizeVaultSettings(state.vaultSettings)
    if (!settings.monthlyNotes.enabled) return
    const { title, subpath } = monthlyNoteLocationForDate(date, settings)
    const existing = findMonthlyNoteForDate(state.notes, settings, date)
    if (existing) {
      set({ view: { kind: 'folder', folder: 'inbox', subpath } })
      await get().selectNote(existing.path)
    } else {
      const template = resolveTemplate(state.customTemplates, settings.monthlyNotes.templateId)
      if (template) {
        await get().createFromTemplate(template, { folder: 'inbox', subpath, title, date })
      } else {
        await get().createAndOpen('inbox', subpath, { title })
      }
    }
    // Focus the editor so `i` starts insert immediately (see openDailyNoteForDate).
    requestEditorFocus()
  },

  openThisMonthMonthlyNote: async () => {
    await get().openMonthlyNoteForDate(new Date())
  },

  setTemplatePaletteOpen: (open) =>
    set({ templatePaletteOpen: open, templatePaletteTarget: null, templatePaletteMode: 'create' }),

  openTemplatePaletteForFolder: (folder, subpath) =>
    set({
      templatePaletteTarget: { folder, subpath },
      templatePaletteOpen: true,
      templatePaletteMode: 'create'
    }),

  openTemplatePaletteForInsert: () =>
    set({ templatePaletteOpen: true, templatePaletteMode: 'insert', templatePaletteTarget: null }),

  insertTemplateIntoActiveNote: (template) => {
    const state = get()
    const view = state.editorViewRef
    const active = state.activeNote
    if (!view || !active) return
    const { body, cursorOffset } = renderTemplate(template.body, { title: active.title })
    const doc = view.state.doc
    const fullText = doc.toString().trim()
    // A blank note or one that is still just the default `# Title` scaffold gets
    // its whole body replaced; an in-progress note inserts at the cursor.
    const isScaffold = fullText === '' || fullText === `# ${active.title}`.trim()
    const range = isScaffold
      ? { from: 0, to: doc.length }
      : { from: view.state.selection.main.from, to: view.state.selection.main.to }
    const anchor = range.from + (cursorOffset ?? body.length)
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: body },
      selection: { anchor: Math.min(anchor, range.from + body.length) },
      scrollIntoView: true
    })
    view.focus()
  },

  loadCustomTemplates: async () => {
    try {
      const files = await window.zen.listTemplates()
      set({ customTemplates: files.map((f) => parseCustomTemplate(f.raw, f.sourcePath)) })
    } catch (err) {
      console.error('loadCustomTemplates failed', err)
      set({ customTemplates: [] })
    }
  },

  loadWorkflowIndex: async () => {
    // A workspace with no workflow support (the web bridge, an old server)
    // simply has none; the palette then offers no Run entries, same as a vault
    // with an empty workflows directory.
    if (typeof window.zen.listWorkflows !== 'function') return
    try {
      const files = await window.zen.listWorkflows()
      set({ workflowIndex: buildWorkflowIndex(files) })
    } catch (err) {
      console.error('loadWorkflowIndex failed', err)
      set({ workflowIndex: [] })
    }
  },

  saveCustomTemplate: async (input) => {
    await window.zen.writeTemplate(input)
    await get().loadCustomTemplates()
  },

  deleteCustomTemplate: async (sourcePath) => {
    await window.zen.deleteTemplate(sourcePath)
    await get().loadCustomTemplates()
  },

  createFromTemplate: async (template, opts) => {
    try {
      // 1. Destination. An explicit folder (e.g. right-click on a folder) is
      // used directly; otherwise prompt, defaulting to the vault root so the
      // user can just press Enter to skip — or type / pick a folder.
      let folder: NoteFolder
      let subpath: string
      if (opts?.folder !== undefined) {
        folder = opts.folder
        subpath = opts.subpath ?? ''
      } else {
        const state = get()
        // Default the prompt to the template's preferred subpath (relative to
        // the notes root), if any; otherwise empty = vault root.
        const initialPath =
          !template.targetFolder || template.targetFolder === 'inbox'
            ? template.targetSubpath ?? ''
            : ''
        const entered = await promptApp(
          buildTemplateDestinationPrompt(template.name, initialPath, state.folders)
        )
        if (entered == null) return // cancelled
        const dest = parseTemplateDestination(entered)
        folder = dest.folder
        subpath = dest.subpath
      }
      // 2. Title.
      let title = opts?.title?.trim() ?? ''
      if (!title && template.titleTemplate) {
        title = renderTitle(template.titleTemplate, { title: '', now: opts?.date })
      }
      if (!title) {
        const entered = await promptApp({
          title: 'New note from template',
          description: template.name,
          initialValue: template.name,
          okLabel: 'Create'
        })
        if (entered == null) return // cancelled
        title = entered.trim()
      }
      if (!title) title = template.name
      const { body, cursorOffset } = renderTemplate(template.body, { title, now: opts?.date })
      const meta = await window.zen.createNote(folder, title, subpath)
      rememberEditModeForCreatedNote(meta.path)
      // Write the rendered body before opening so the editor never flashes the
      // default `# Title` scaffold (mirrors importDroppedMarkdownFiles).
      await window.zen.writeNote(meta.path, body)
      await get().refreshNotes()
      set({ view: { kind: 'folder', folder, subpath } })
      if (cursorOffset != null) {
        await get().openNoteAtOffset(meta.path, cursorOffset)
      } else {
        await get().selectNote(meta.path)
      }
      // Land keyboard focus in the editor so typing starts immediately. This
      // flow is usually fired from outside the editor — the Leader menu, the
      // command palette, a folder menu — where focus would otherwise stay on
      // the picker/prompt that just closed. (#436, mirrors the daily-note flow)
      requestEditorFocus()
    } catch (err) {
      console.error('createFromTemplate failed', err)
    }
  },

  saveActiveNoteAsTemplate: async () => {
    const active = get().activeNote
    if (!active) return
    const name = await promptApp({
      title: 'Save note as template',
      description: 'Saved to .zennotes/templates and shown in the template picker.',
      initialValue: active.title,
      okLabel: 'Save'
    })
    if (name == null) return
    const trimmed = name.trim()
    if (!trimmed) return
    const raw = composeTemplateFile({ name: trimmed, category: 'Custom', body: active.body })
    await get().saveCustomTemplate({ slug: slugifyTemplateName(trimmed), raw })
  },

  saveActiveNoteAs: async (newName: string) => {
    const active = get().activeNote
    const notePath = active?.path
    if (!active || !notePath) return
    // Strip a user-supplied extension so the name stays title-based; the backend
    // appends the note's real file extension.
    const trimmedName = newName.trim().replace(/\.md$/i, '')
    if (!trimmedName || trimmedName === active.title) return
    if (
      typeof window.zen.duplicateNote !== 'function' ||
      typeof window.zen.renameNote !== 'function'
    ) {
      return
    }
    try {
      // Vim's :saveas writes the note under a new name and keeps the original.
      // Save the current note, duplicate it (a copy in the same folder), rename
      // the copy to the requested name, and open it — the original is untouched.
      await get().persistNote(notePath)
      const copy = await window.zen.duplicateNote(notePath)
      const renamed = await window.zen.renameNote(copy.path, trimmedName)
      await syncHeadingAfterRename(renamed, get)
      await get().refreshNotes()
      await get().selectNote(renamed.path)
      get().setFocusedPanel('editor')
      requestAnimationFrame(() => get().editorViewRef?.focus())
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  },

  setWordWrap: (on) => {
    set({ wordWrap: on })
    savePrefs(collectPrefs(get()))
  },

  setCursorBlink: (on) => {
    set({ cursorBlink: on })
    savePrefs(collectPrefs(get()))
  },

  setPreviewSmoothScroll: (on) => {
    set({ previewSmoothScroll: on })
    savePrefs(collectPrefs(get()))
  },

  setEditorMaxWidth: (px) => {
    const clamped = Math.min(2000, Math.max(560, Math.round(px)))
    set({ editorMaxWidth: clamped })
    savePrefs(collectPrefs(get()))
  },

  setPdfEmbedInEditMode: (mode) => {
    set({ pdfEmbedInEditMode: mode })
    savePrefs(collectPrefs(get()))
  },

  setContentAlign: (align) => {
    set({ contentAlign: align })
    savePrefs(collectPrefs(get()))
  },
  setTagsCollapsed: (collapsed) => {
    set({ tagsCollapsed: collapsed })
    savePrefs(collectPrefs(get()))
  },
  setNestedTags: (enabled) => {
    set({ nestedTags: enabled })
    savePrefs(collectPrefs(get()))
  },
  toggleCollapseTagNode: (path) => {
    set((s) =>
      s.collapsedTagNodes.includes(path)
        ? { collapsedTagNodes: s.collapsedTagNodes.filter((p) => p !== path) }
        : { collapsedTagNodes: [...s.collapsedTagNodes, path] }
    )
    savePrefs(collectPrefs(get()))
  },
  setAutoCalendarPanel: (enabled) => {
    set({ autoCalendarPanel: enabled })
    savePrefs(collectPrefs(get()))
  },
  setCalendarWeekStart: (start) => {
    set({ calendarWeekStart: start })
    savePrefs(collectPrefs(get()))
  },
  setCalendarShowWeekNumbers: (show) => {
    set({ calendarShowWeekNumbers: show })
    savePrefs(collectPrefs(get()))
  },
  completeOnboarding: () => {
    if (get().hasCompletedOnboarding) return
    set({ hasCompletedOnboarding: true })
    savePrefs(collectPrefs(get()))
  },
  restartOnboarding: () => {
    set({ hasCompletedOnboarding: false, settingsOpen: false })
    savePrefs(collectPrefs(get()))
  },
  setFocusedPanel: (panel) => {
    // Handing the keyboard to the sidebar must also take it away from any
    // self-keyed surface (the database grid keeps every key while it holds
    // DOM focus). Without this, "Focus Sidebar" painted the vim cursor and
    // `m` hint on a sidebar row while the grid silently kept the keys, and
    // pressing `m` on a "selected" folder opened nothing.
    if (panel === 'sidebar') releaseSelfKeyedSurfaceFocus()
    set({ focusedPanel: panel })
  },
  setSidebarCursorIndex: (idx) => set({ sidebarCursorIndex: idx }),
  // #301: date-nav tree expand/collapse. Ephemeral (no savePrefs) — mirrors
  // toggleCollapseFolder but for the Daily/Weekly date groups so VimNav's
  // keyboard nav can drive them like real folders.
  expandDateNav: (key) =>
    set((s) =>
      s.dateNavExpanded.includes(key) ? {} : { dateNavExpanded: [...s.dateNavExpanded, key] }
    ),
  collapseDateNav: (key) =>
    set((s) => ({ dateNavExpanded: s.dateNavExpanded.filter((k) => k !== key) })),
  toggleDateNav: (key) =>
    set((s) =>
      s.dateNavExpanded.includes(key)
        ? { dateNavExpanded: s.dateNavExpanded.filter((k) => k !== key) }
        : { dateNavExpanded: [...s.dateNavExpanded, key] }
    ),
  setNoteListCursorIndex: (idx) => set({ noteListCursorIndex: idx }),
  setConnectionsCursorIndex: (idx) => set({ connectionsCursorIndex: idx }),
  setOutlineCursorIndex: (idx) => set({ outlineCursorIndex: idx }),
  setConnectionPreview: (preview) => set({ connectionPreview: preview }),
  setEditorViewRef: (view) =>
    set({
      editorViewRef: view,
      editorCursorPosition: view ? editorCursorPosition(view.state) : null
    }),
  setEditorCursorPosition: (position) => set({ editorCursorPosition: position }),
  setActivePane: (paneId) => {
    const s = get()
    if (s.activePaneId === paneId) return
    if (!findLeaf(s.paneLayout, paneId)) return
    set({
      activePaneId: paneId,
      ...activeFieldsFrom(s.paneLayout, paneId, s.noteContents, s.noteDirty)
    })
  },

  focusTabInPane: async (paneId, path) => {
    const s = get()
    const leaf = findLeaf(s.paneLayout, paneId)
    if (!leaf) return

    // Flush pending save on outgoing activeTab — but only if we're the
    // active pane; inactive panes continue to autosave via their own cycle.
    if (s.activePaneId === paneId && s.selectedPath && s.selectedPath !== path) {
      if (s.noteDirty[s.selectedPath]) await get().persistNote(s.selectedPath)
    }

    // Virtual Workflows tab. Same deal as Tasks below: `zen://workflows` is not
    // a file, so it must short-circuit before the disk read or readNote tries to
    // open `<vault>/zen:/workflows` and the tab never opens.
    if (isWorkflowsTabPath(path)) {
      // Same gate as `openNoteInPane`: a disabled feature has no focusable tab.
      if (!s.workflowsEnabled) return
      set((cur) => {
        const nextLayout =
          updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path)) ??
          cur.paneLayout
        return {
          paneLayout: nextLayout,
          activePaneId: paneId,
          ...activeFieldsFrom(nextLayout, paneId, cur.noteContents, cur.noteDirty)
        }
      })
      return
    }

    // Virtual Tasks tab — no disk read, no content cache entry. Just update
    // the pane layout so the tab becomes active and EditorPane can render
    // the panel instead of a CodeMirror view.
    if (isTasksTabPath(path)) {
      set((cur) => {
        const nextLayout =
          updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path)) ??
          cur.paneLayout
        return {
          paneLayout: nextLayout,
          activePaneId: paneId,
          focusedPanel: 'tasks',
          ...activeFieldsFrom(nextLayout, paneId, cur.noteContents, cur.noteDirty)
        }
      })
      if (!get().tasksLoading) void get().refreshTasks()
      return
    }

    if (isQuickNotesTabPath(path)) {
      set((cur) => {
        const nextLayout =
          updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path)) ??
          cur.paneLayout
        return {
          paneLayout: nextLayout,
          activePaneId: paneId,
          focusedPanel: 'editor',
          ...activeFieldsFrom(nextLayout, paneId, cur.noteContents, cur.noteDirty)
        }
      })
      return
    }

    // Virtual Tags tab — no disk I/O, EditorPane renders the tag list
    // instead of CodeMirror. A single tab accumulates selected tags in
    // `selectedTags`; this just focuses it.
    if (isTagsTabPath(path)) {
      set((cur) => {
        const nextLayout =
          updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path)) ??
          cur.paneLayout
        return {
          paneLayout: nextLayout,
          activePaneId: paneId,
          ...activeFieldsFrom(nextLayout, paneId, cur.noteContents, cur.noteDirty)
        }
      })
      return
    }

    // Built-in Help tab — virtual content that still follows the editor
    // focus path so preview-like scroll navigation works naturally.
    if (isHelpTabPath(path)) {
      set((cur) => {
        const nextLayout =
          updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path)) ??
          cur.paneLayout
        return {
          paneLayout: nextLayout,
          activePaneId: paneId,
          focusedPanel: 'editor',
          ...activeFieldsFrom(nextLayout, paneId, cur.noteContents, cur.noteDirty)
        }
      })
      return
    }

    if (isArchiveTabPath(path)) {
      set((cur) => {
        const nextLayout =
          updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path)) ??
          cur.paneLayout
        return {
          paneLayout: nextLayout,
          activePaneId: paneId,
          focusedPanel: 'editor',
          ...activeFieldsFrom(nextLayout, paneId, cur.noteContents, cur.noteDirty)
        }
      })
      return
    }

    if (isTrashTabPath(path)) {
      set((cur) => {
        const nextLayout =
          updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path)) ??
          cur.paneLayout
        return {
          paneLayout: nextLayout,
          activePaneId: paneId,
          focusedPanel: 'editor',
          ...activeFieldsFrom(nextLayout, paneId, cur.noteContents, cur.noteDirty)
        }
      })
      return
    }

    if (isWorkspaceVirtualTabPath(path)) {
      set((cur) => {
        const nextLayout =
          updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path)) ??
          cur.paneLayout
        return {
          paneLayout: nextLayout,
          activePaneId: paneId,
          focusedPanel: 'editor',
          ...activeFieldsFrom(nextLayout, paneId, cur.noteContents, cur.noteDirty)
        }
      })
      return
    }

    const needContent = !s.noteContents[path]
    if (needContent) {
      set({ loadingNote: paneId === s.activePaneId })
      try {
        const content = await readNoteContent(path, s)
        set((cur) => {
          const contents = { ...cur.noteContents, [path]: content }
          const dirty = { ...cur.noteDirty, [path]: false }
          const nextLayout =
            updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path)) ??
            cur.paneLayout
          return {
            paneLayout: nextLayout,
            noteContents: contents,
            noteDirty: dirty,
            activePaneId: paneId,
            loadingNote: false,
            ...activeFieldsFrom(nextLayout, paneId, contents, dirty)
          }
        })
      } catch (err) {
        console.error('focusTabInPane readNote failed', err)
        set({ loadingNote: false })
      }
      return
    }

    set((cur) => {
      const nextLayout =
        updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path)) ??
        cur.paneLayout
      return {
        paneLayout: nextLayout,
        activePaneId: paneId,
        ...activeFieldsFrom(nextLayout, paneId, cur.noteContents, cur.noteDirty)
      }
    })
  },

  openNoteInPane: async (paneId, path, insertIndex) => {
    const s = get()
    const leaf = findLeaf(s.paneLayout, paneId)
    if (!leaf) return
    // The feature switch, at the layer every caller funnels through rather than
    // only in `openWorkflowsView`. Reopen Closed Tab lands here directly, and a
    // canvas that can write to the vault may never come back past a switch that
    // turned it off.
    if (isWorkflowsTabPath(path) && !s.workflowsEnabled) return
    if (isAtlasTabPath(path) && !s.atlasEnabled) return
    // Tasks / Tags / Help / Trash tabs are virtual — add them without touching disk.
    if (isWorkspaceVirtualTabPath(path)) {
      set((cur) => {
        const nextLayout =
          updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path, insertIndex)) ??
          cur.paneLayout
        return {
          paneLayout: nextLayout,
          activePaneId: paneId,
          ...activeFieldsFrom(nextLayout, paneId, cur.noteContents, cur.noteDirty)
        }
      })
      return
    }
    if (!s.noteContents[path]) {
      try {
        const content = await readNoteContent(path, s)
        set((cur) => {
          const contents = { ...cur.noteContents, [path]: content }
          const dirty = { ...cur.noteDirty, [path]: false }
          const nextLayout =
            updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path, insertIndex)) ??
            cur.paneLayout
          return {
            paneLayout: nextLayout,
            noteContents: contents,
            noteDirty: dirty,
            activePaneId: paneId,
            ...activeFieldsFrom(nextLayout, paneId, contents, dirty)
          }
        })
      } catch (err) {
        console.error('openNoteInPane readNote failed', err)
      }
      return
    }
    set((cur) => {
      const nextLayout =
        updateLeaf(cur.paneLayout, paneId, (l) => leafWithAddedTab(l, path, insertIndex)) ??
        cur.paneLayout
      return {
        paneLayout: nextLayout,
        activePaneId: paneId,
        ...activeFieldsFrom(nextLayout, paneId, cur.noteContents, cur.noteDirty)
      }
    })
  },

  closeTabInPane: async (paneId, path) => {
    // Capture the tab's pane-local position before removal so Cmd/Ctrl+Shift+T
    // can reopen multiple closed tabs in the same order and restore pinned state.
    const closingLeaf = findLeaf(get().paneLayout, paneId)
    const closingIndex = closingLeaf?.tabs.indexOf(path) ?? -1
    const closedTabEntry: ClosedTabEntry | null =
      closingLeaf && closingIndex !== -1
        ? {
            paneId,
            path,
            index: closingIndex,
            pinned: closingLeaf.pinnedTabs.includes(path)
          }
        : null

    // Flush pending save for the tab we're about to drop. Other panes
    // (and the pinned-reference pane) may still reference the note via
    // its content cache — we only evict content when nothing else has
    // it open anymore.
    if (get().noteDirty[path]) {
      await get().persistNote(path)
    }
    set((s) => {
      const nextLayout =
        updateLeaf(s.paneLayout, paneId, (l) => leafWithoutTab(l, path)) ?? makeLeaf()
      const ensured = ensureActivePane(nextLayout, s.activePaneId)
      const stillOpen =
        s.pinnedRefPath === path ||
        allLeaves(nextLayout).some((l) => l.tabs.includes(path))
      const contents = { ...s.noteContents }
      const dirty = { ...s.noteDirty }
      if (!stillOpen) {
        delete contents[path]
        delete dirty[path]
      }
      const closedTabStack = closedTabEntry
        ? [...s.closedTabStack, closedTabEntry].slice(-MAX_CLOSED_TAB_STACK)
        : s.closedTabStack
      return {
        paneLayout: ensured.layout,
        activePaneId: ensured.activePaneId,
        noteContents: contents,
        noteDirty: dirty,
        closedTabStack,
        ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
      }
    })
  },

  reorderTabInPane: (paneId, dragPath, targetPath, position) => {
    if (!dragPath || !targetPath || dragPath === targetPath) return
    set((s) => {
      const nextLayout = updateLeaf(s.paneLayout, paneId, (l) =>
        leafWithReorderedTab(l, dragPath, targetPath, position)
      )
      if (!nextLayout || nextLayout === s.paneLayout) return s
      return {
        paneLayout: nextLayout,
        ...activeFieldsFrom(nextLayout, s.activePaneId, s.noteContents, s.noteDirty)
      }
    })
  },

  movePaneTab: async ({ sourcePaneId, targetPaneId, path, insertIndex, beforePath }) => {
    const s = get()
    if (sourcePaneId === targetPaneId && !beforePath && insertIndex == null) {
      // Same-pane drop on the pane body is a no-op; use reorder for tab strip.
      return
    }
    // Make sure content is available (it should be — source pane has it).
    let contents = s.noteContents
    let dirty = s.noteDirty
    if (!isWorkspaceVirtualTabPath(path) && !contents[path]) {
      try {
        const content = await readNoteContent(path, s)
        contents = { ...contents, [path]: content }
        dirty = { ...dirty, [path]: false }
      } catch (err) {
        console.error('movePaneTab readNote failed', err)
        return
      }
    }
    set((cur) => {
      let layout = cur.paneLayout
      if (sourcePaneId !== targetPaneId) {
        layout = updateLeaf(layout, sourcePaneId, (l) => leafWithoutTab(l, path)) ?? makeLeaf()
      }
      const targetLeaf = findLeaf(layout, targetPaneId)
      if (!targetLeaf) return cur
      const idx =
        beforePath != null
          ? Math.max(0, targetLeaf.tabs.indexOf(beforePath))
          : insertIndex
      layout =
        updateLeaf(layout, targetPaneId, (l) => leafWithAddedTab(l, path, idx)) ?? layout
      const ensured = ensureActivePane(layout, targetPaneId)
      // Evict content only when nothing references the path anymore,
      // including the pinned-reference pane.
      const stillOpen =
        cur.pinnedRefPath === path ||
        allLeaves(layout).some((l) => l.tabs.includes(path))
      const nextContents = { ...contents }
      const nextDirty = { ...dirty }
      if (!stillOpen) {
        delete nextContents[path]
        delete nextDirty[path]
      }
      return {
        paneLayout: ensured.layout,
        activePaneId: targetPaneId,
        noteContents: nextContents,
        noteDirty: nextDirty,
        ...activeFieldsFrom(ensured.layout, targetPaneId, nextContents, nextDirty)
      }
    })
  },

  splitPaneWithTab: async ({ targetPaneId, edge, path, sourcePaneId }) => {
    // Make sure content is loaded. Virtual tabs (Tasks, Tags, Help, Trash) skip disk I/O.
    const s0 = get()
    let contents = s0.noteContents
    let dirty = s0.noteDirty
    if (
      !isWorkspaceVirtualTabPath(path) &&
      !contents[path]
    ) {
      try {
        const content = await readNoteContent(path, s0)
        contents = { ...contents, [path]: content }
        dirty = { ...dirty, [path]: false }
      } catch (err) {
        console.error('splitPaneWithTab readNote failed', err)
        return
      }
    }
    set((cur) => {
      let layout = cur.paneLayout
      if (sourcePaneId && sourcePaneId !== targetPaneId) {
        layout = updateLeaf(layout, sourcePaneId, (l) => leafWithoutTab(l, path)) ?? makeLeaf()
      }
      // After removing the source tab, the target pane id must still
      // exist. If the source WAS the target, that's only valid when the
      // source had more than one tab.
      if (sourcePaneId === targetPaneId) {
        const sameLeaf = findLeaf(layout, targetPaneId)
        if (!sameLeaf || sameLeaf.tabs.length <= 1) {
          // Only one tab and we're trying to split it off itself — nothing to do.
          return cur
        }
        layout = updateLeaf(layout, targetPaneId, (l) => leafWithoutTab(l, path)) ?? layout
      }
      const targetLeaf = findLeaf(layout, targetPaneId)
      if (!targetLeaf) return cur
      const newLeaf = makeLeaf([path], path)
      layout = splitLeaf(layout, targetPaneId, edge, newLeaf)
      const stillOpen =
        cur.pinnedRefPath === path ||
        allLeaves(layout).some((l) => l.tabs.includes(path))
      const nextContents = { ...contents }
      const nextDirty = { ...dirty }
      if (!stillOpen) {
        delete nextContents[path]
        delete nextDirty[path]
      }
      return {
        paneLayout: layout,
        activePaneId: newLeaf.id,
        noteContents: nextContents,
        noteDirty: nextDirty,
        // Inherit the source pane's view mode so splitting a preview pane opens
        // the new pane in preview too, not a reset-to-edit. (#321)
        paneModes: {
          ...cur.paneModes,
          [newLeaf.id]: cur.paneModes[sourcePaneId ?? targetPaneId] ?? {}
        },
        ...activeFieldsFrom(layout, newLeaf.id, nextContents, nextDirty)
      }
    })
  },

  setPaneModeForPath: (paneId, path, mode) =>
    set((s) => ({
      paneModes: {
        ...s.paneModes,
        [paneId]: paneModesWithPathMode(s.paneModes[paneId] ?? {}, path, mode)
      },
      // Remember the pane's latest mode so `keepViewModeAcrossNotes` can make
      // every note in this pane follow it.
      paneStickyModes: { ...s.paneStickyModes, [paneId]: mode }
    })),

  resizeSplit: (splitId, sizes) => {
    set((s) => {
      const nextLayout = updateSplitSizes(s.paneLayout, splitId, sizes)
      if (nextLayout === s.paneLayout) return s
      return { paneLayout: nextLayout }
    })
  },

  pinTabInPane: (paneId, path) => {
    set((s) => {
      const nextLayout = updateLeaf(s.paneLayout, paneId, (l) =>
        leafWithPinnedTab(l, path)
      )
      if (!nextLayout || nextLayout === s.paneLayout) return s
      return {
        paneLayout: nextLayout,
        ...activeFieldsFrom(nextLayout, s.activePaneId, s.noteContents, s.noteDirty)
      }
    })
  },
  unpinTabInPane: (paneId, path) => {
    set((s) => {
      const nextLayout = updateLeaf(s.paneLayout, paneId, (l) =>
        leafWithUnpinnedTab(l, path)
      )
      if (!nextLayout || nextLayout === s.paneLayout) return s
      return {
        paneLayout: nextLayout,
        ...activeFieldsFrom(nextLayout, s.activePaneId, s.noteContents, s.noteDirty)
      }
    })
  },
  promoteTabInPane: (paneId, path) => {
    set((s) => {
      const nextLayout = updateLeaf(s.paneLayout, paneId, (l) =>
        leafWithPromotedTab(l, path)
      )
      if (!nextLayout || nextLayout === s.paneLayout) return s
      return { paneLayout: nextLayout }
    })
  },
  toggleTabPin: (paneId, path) => {
    const leaf = findLeaf(get().paneLayout, paneId)
    if (!leaf || !leaf.tabs.includes(path)) return
    if (leaf.pinnedTabs.includes(path)) get().unpinTabInPane(paneId, path)
    else get().pinTabInPane(paneId, path)
  },

  openNoteInTab: async (relPath) => {
    if (!relPath) return
    await get().selectNote(relPath)
  },
  closeTab: async (relPath) => {
    const s = get()
    // Find the first leaf holding this tab (active pane wins if multiple).
    const activeLeaf = findLeaf(s.paneLayout, s.activePaneId)
    const ownerId =
      activeLeaf?.tabs.includes(relPath)
        ? activeLeaf.id
        : allLeaves(s.paneLayout).find((l) => l.tabs.includes(relPath))?.id ?? null
    if (!ownerId) return
    await get().closeTabInPane(ownerId, relPath)
  },
  clearPendingTitleFocus: () => set({ pendingTitleFocusPath: null }),
  clearPendingJumpLocation: () => set({ pendingJumpLocation: null }),

  renameTag: async (oldTag, newTag) => {
    await rewriteTagAcrossVault(get, oldTag, newTag)
  },
  deleteTag: async (tag) => {
    await rewriteTagAcrossVault(get, tag, null)
  },

  createFolder: async (folder, subpath) => {
    await window.zen.createFolder(folder, subpath)
    await get().refreshNotes()
    set({ view: { kind: 'folder', folder, subpath } })
  },

  renameFolder: async (folder, oldSubpath, newSubpath) => {
    await window.zen.renameFolder(folder, oldSubpath, newSubpath)

    const folderPath = resolveFolderPath(folder, get().vaultSettings.systemFolderPaths)
    const oldPrefix = `${folderPath}/${oldSubpath}/`
    const newPrefix = `${folderPath}/${newSubpath}/`
    const rewritePath = (p: string): string =>
      p.toLowerCase().startsWith(oldPrefix.toLowerCase())
        ? newPrefix + p.slice(oldPrefix.length)
        : p

    const notes = get().notes.map((n) =>
      n.path.toLowerCase().startsWith(oldPrefix.toLowerCase()) ? { ...n, path: rewritePath(n.path) } : n
    )
    const folders = get().folders.map((f) => {
      if (f.folder !== folder) return f
      if (f.subpath === oldSubpath) return { ...f, subpath: newSubpath }
      if (f.subpath.startsWith(`${oldSubpath}/`)) {
        return { ...f, subpath: newSubpath + f.subpath.slice(oldSubpath.length) }
      }
      return f
    })
    const nextFolderIcons = rewriteFolderIconsForRename(
      get().vaultSettings.folderIcons,
      folder,
      oldSubpath,
      newSubpath
    )
    const nextFolderColors = rewriteFolderColorsForRename(
      get().vaultSettings.folderColors,
      folder,
      oldSubpath,
      newSubpath
    )
    set((s) => {
      const nextLayout = rewritePathsInTree(s.paneLayout, rewritePath)
      const ensured = ensureActivePane(nextLayout, s.activePaneId)
      const contents: Record<string, NoteContent> = {}
      const dirty: Record<string, boolean> = {}
      for (const [path, content] of Object.entries(s.noteContents)) {
        const next = rewritePath(path)
        contents[next] = path === next ? content : { ...content, path: next }
        dirty[next] = s.noteDirty[path] ?? false
      }
      return {
        notes,
        folders,
        paneLayout: ensured.layout,
        activePaneId: ensured.activePaneId,
        noteContents: contents,
        noteDirty: dirty,
        noteBackstack: rewriteNoteJumpHistory(s.noteBackstack, rewritePath),
        noteForwardstack: rewriteNoteJumpHistory(s.noteForwardstack, rewritePath),
        pendingJumpLocation: s.pendingJumpLocation
          ? { ...s.pendingJumpLocation, path: rewritePath(s.pendingJumpLocation.path) }
          : null,
        pinnedRefPath: s.pinnedRefPath ? rewritePath(s.pinnedRefPath) : null,
        vaultSettings: {
          ...s.vaultSettings,
          folderIcons: nextFolderIcons,
          folderColors: nextFolderColors
        },
        ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
      }
    })

    // Repoint favorites at the renamed folder (its own key, descendant folder
    // keys, and note favorites that lived under it) and persist.
    await get().applyFavorites(
      rewriteFavoritesForFolderRename(
        get().vaultSettings.favorites,
        folder,
        oldSubpath,
        newSubpath,
        oldPrefix,
        newPrefix
      )
    )

    await get().refreshNotes()

    const v = get().view
    if (v.kind === 'folder' && v.folder === folder) {
      if (v.subpath === oldSubpath) {
        set({ view: { ...v, subpath: newSubpath } })
      } else if (v.subpath.startsWith(`${oldSubpath}/`)) {
        const tail = v.subpath.slice(oldSubpath.length + 1)
        set({ view: { ...v, subpath: `${newSubpath}/${tail}` } })
      }
    }
  },

  deleteFolder: async (folder, subpath) => {
    await window.zen.deleteFolder(folder, subpath)
    await get().refreshNotes()
    const v = get().view
    if (
      v.kind === 'folder' &&
      v.folder === folder &&
      (v.subpath === subpath || v.subpath.startsWith(`${subpath}/`))
    ) {
      set({ view: { kind: 'folder', folder, subpath: '' } })
    }
    const folderPath = resolveFolderPath(folder, get().vaultSettings.systemFolderPaths)
    const prefix = `${folderPath}/${subpath}/`
    const nextFolderIcons = removeFolderIcons(get().vaultSettings.folderIcons, folder, subpath)
    const nextFolderColors = removeFolderColors(get().vaultSettings.folderColors, folder, subpath)
    set((s) => {
      const nextLayout = rewritePathsInTree(s.paneLayout, (p) =>
        p.startsWith(prefix) ? null : p
      )
      const ensured = ensureActivePane(nextLayout, s.activePaneId)
      const contents: Record<string, NoteContent> = {}
      const dirty: Record<string, boolean> = {}
      for (const [path, content] of Object.entries(s.noteContents)) {
        if (!path.startsWith(prefix)) {
          contents[path] = content
          dirty[path] = s.noteDirty[path] ?? false
        }
      }
      return {
        paneLayout: ensured.layout,
        activePaneId: ensured.activePaneId,
        noteContents: contents,
        noteDirty: dirty,
        pendingJumpLocation: null,
        pinnedRefPath:
          s.pinnedRefPath && s.pinnedRefPath.startsWith(prefix) ? null : s.pinnedRefPath,
        vaultSettings: {
          ...s.vaultSettings,
          folderIcons: nextFolderIcons,
          folderColors: nextFolderColors
        },
        ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
      }
    })
    // Drop favorites for the deleted folder and the notes that lived under it.
    await get().applyFavorites(
      removeFavoritesForFolder(get().vaultSettings.favorites, folder, subpath, prefix)
    )
  },

  duplicateFolder: async (folder, subpath) => {
    const newSubpath = await window.zen.duplicateFolder(folder, subpath)
    await get().refreshNotes()
    set((s) => ({
      view: { kind: 'folder', folder, subpath: newSubpath },
      vaultSettings: {
        ...s.vaultSettings,
        folderIcons: duplicateFolderIcons(
          s.vaultSettings.folderIcons,
          folder,
          subpath,
          newSubpath
        ),
        folderColors: duplicateFolderColors(
          s.vaultSettings.folderColors,
          folder,
          subpath,
          newSubpath
        )
      }
    }))
  },

  revealFolder: async (folder, subpath) => {
    await window.zen.revealFolder(folder, subpath)
  },

  revealAssetsDir: async () => {
    await window.zen.revealAssetsDir()
  },

  moveNote: async (relPath, targetFolder, targetSubpath) => {
    try {
      const meta = await window.zen.moveNote(relPath, targetFolder, targetSubpath)
      await get().refreshNotes()
      set((s) => {
        const rewrite = (p: string): string => (p === relPath ? meta.path : p)
        const nextLayout = rewritePathsInTree(s.paneLayout, rewrite)
        const ensured = ensureActivePane(nextLayout, s.activePaneId)
        const contents = { ...s.noteContents }
        const dirty = { ...s.noteDirty }
        const prev = contents[relPath]
        if (relPath !== meta.path) {
          delete contents[relPath]
          delete dirty[relPath]
        }
        if (prev) {
          contents[meta.path] = { ...prev, ...meta }
          dirty[meta.path] = s.noteDirty[relPath] ?? false
        }
        return {
          paneLayout: ensured.layout,
          activePaneId: ensured.activePaneId,
          noteContents: contents,
          noteDirty: dirty,
          noteBackstack: rewriteNoteJumpHistory(s.noteBackstack, rewrite),
          noteForwardstack: rewriteNoteJumpHistory(s.noteForwardstack, rewrite),
          pendingJumpLocation:
            s.pendingJumpLocation?.path === relPath
              ? { ...s.pendingJumpLocation, path: meta.path }
              : s.pendingJumpLocation,
          pinnedRefPath: s.pinnedRefPath === relPath ? meta.path : s.pinnedRefPath,
          ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
        }
      })
      await get().applyFavorites(
        rewriteFavoriteNotePath(get().vaultSettings.favorites, relPath, meta.path)
      )
    } catch (err) {
      console.error('moveNote failed', err)
    }
  },

  refreshWorkspaceContext: async () => {
    try {
      const info = await window.zen.getRemoteWorkspaceInfo()
      set({
        workspaceMode: workspaceModeFrom(info),
        remoteWorkspaceInfo: info
      })
      return info
    } catch (err) {
      console.error('refreshWorkspaceContext failed', err)
      set({
        workspaceMode: 'local',
        remoteWorkspaceInfo: null
      })
      return null
    }
  },

  refreshRemoteWorkspaceProfiles: async () => {
    if (!window.zen.getCapabilities().supportsRemoteWorkspace) {
      set({ remoteWorkspaceProfiles: [] })
      return []
    }
    try {
      const profiles = await window.zen.listRemoteWorkspaceProfiles()
      set({ remoteWorkspaceProfiles: profiles })
      return profiles
    } catch (err) {
      console.error('refreshRemoteWorkspaceProfiles failed', err)
      set({ remoteWorkspaceProfiles: [] })
      return []
    }
  },

  refreshLocalVaults: async () => {
    if (!window.zen.getCapabilities().supportsLocalFilesystemPickers) {
      set({ localVaults: [] })
      return []
    }
    try {
      const localVaults = await window.zen.listLocalVaults()
      set({ localVaults })
      return localVaults
    } catch (err) {
      console.error('refreshLocalVaults failed', err)
      set({ localVaults: [] })
      return []
    }
  },

  init: async () => {
    if (get().initialized) return
    const startedAt = performance.now()
    set({ initialized: true })
    let initializedVault = false
    try {
      const remoteWorkspaceProfilesPromise = get().refreshRemoteWorkspaceProfiles()
      const localVaultsPromise = get().refreshLocalVaults()
      const [remoteWorkspaceInfo, serverCapabilities] = await Promise.all([
        get().refreshWorkspaceContext(),
        window.zen.getServerCapabilities().catch(() => null)
      ])
      if (!(await ensureWebServerSession(serverCapabilities))) {
        void remoteWorkspaceProfilesPromise
        void localVaultsPromise
        set({
          workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
          remoteWorkspaceInfo,
          workspaceSetupError: null,
          workspaceRestored: true,
          vaultSettings: DEFAULT_VAULT_SETTINGS
        })
        recordRendererPerf('store.init', performance.now() - startedAt, {
          hasVault: false
        })
        return
      }
      const vault = await window.zen.getCurrentVault()
      void remoteWorkspaceProfilesPromise
      void localVaultsPromise
      if (vault) {
        const vaultSettings = normalizeVaultSettings(await window.zen.getVaultSettings())
        set({
          vault,
          workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
          remoteWorkspaceInfo,
          workspaceSetupError: null,
          vaultSettings,
          workspaceRestored: false
        })
        await openVaultWorkspace(vault)
        await prefetchInitialVisibleNotes(get())
        initializedVault = true
      } else {
        set({
          workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
          remoteWorkspaceInfo,
          workspaceSetupError: null,
          workspaceRestored: true,
          vaultSettings: DEFAULT_VAULT_SETTINGS
        })
      }
    } catch (err) {
      console.error('init failed', err)
      set({
        workspaceMode: 'local',
        remoteWorkspaceInfo: null,
        workspaceSetupError:
          window.zen.getAppInfo().runtime === 'web' ? describeWebServerSetupError(err) : null,
        workspaceRestored: true,
        vaultSettings: DEFAULT_VAULT_SETTINGS
      })
    }
    recordRendererPerf('store.init', performance.now() - startedAt, {
      hasVault: initializedVault
    })
    // Default focus to the sidebar so j/k navigation works immediately
    if (get().sidebarOpen && !get().focusedPanel) {
      set({ focusedPanel: 'sidebar' })
    }
    // Restore the pinned reference note by loading its content — the
    // path survived in prefs; `refreshNotes` has already confirmed it
    // still exists and otherwise cleared `pinnedRefPath`.
    const pinnedPath = get().pinnedRefPath
    if (pinnedPath && !get().noteContents[pinnedPath]) {
      try {
        const content = await readNoteContent(pinnedPath, get())
        set((s) => ({
          noteContents: { ...s.noteContents, [pinnedPath]: content },
          noteDirty: { ...s.noteDirty, [pinnedPath]: false }
        }))
      } catch (err) {
        console.error('pinned reference readNote failed', err)
        set({ pinnedRefPath: null })
        savePrefs(collectPrefs(get()))
      }
    }
    // `retryWorkspaceBoot` re-enters `init` on every successful reconnect, so
    // the previous subscription has to go before a new one is made. Without
    // this each reconnect left a live listener behind and one file change
    // arrived as N changes, each running the full `applyChange`.
    vaultChangeUnsubscribe?.()
    vaultChangeUnsubscribe = window.zen.onVaultChange((ev) => {
      void get().applyChange(ev)
    })
  },

  retryWorkspaceBoot: async () => {
    set({ workspaceSetupError: null })
    try {
      const vault = await window.zen.retryWorkspaceBoot()
      if (vault) {
        // The workspace is reachable again: run the exact boot path so the
        // vault, settings, indexes and session restore land the normal way.
        // init() is once-guarded for real boots; this re-entry is the point.
        set({ initialized: false })
        await get().init()
        return
      }
      // Still down. Refresh the info so the screen shows the latest reason.
      await get().refreshWorkspaceContext()
    } catch (err) {
      console.error('retryWorkspaceBoot failed', err)
      set({ workspaceSetupError: humanIpcError(err, 'Could not reach the server.') })
    }
  },

  openVaultPicker: async () => {
    await get().flushDirtyNotes()
    set({ workspaceSetupError: null })
    const capabilities = window.zen.getCapabilities()
    const appInfo = window.zen.getAppInfo()
    let vault: VaultInfo | null = null

    try {
      if (appInfo.runtime === 'web' && !capabilities.supportsLocalFilesystemPickers) {
        const serverCapabilities = await window.zen.getServerCapabilities()
        if (!(await ensureWebServerSession(serverCapabilities))) return
        const current = await window.zen.getCurrentVault()
        const enteredPath = await pickServerDirectoryApp(
          {
            title: 'Choose Vault Folder',
            description:
              'Choose the folder on the server that ZenNotes should use as your vault.',
            initialPath: current?.root ?? '',
            confirmLabel: 'Choose Folder'
          },
          async (path) => {
            vault = await window.zen.selectVaultPath(path.trim())
          }
        )
        if (!enteredPath) return
      } else {
        vault = await window.zen.pickVault()
      }
    } catch (err) {
      console.error('openVaultPicker failed', err)
      if (appInfo.runtime === 'web') {
        set({ workspaceSetupError: describeWebServerSetupError(err) })
        return
      }
      throw err
    }

    if (!vault) return

    await get().refreshLocalVaults()
    const remoteWorkspaceInfo = await get().refreshWorkspaceContext()

    const vaultSettings = normalizeVaultSettings(await window.zen.getVaultSettings())
    const fresh = makeLeaf()
    set({
      vault,
      workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
      remoteWorkspaceInfo,
      workspaceSetupError: null,
      vaultSettings,
      notes: [],
      folders: [],
      hasAssetsDir: false,
      assetFiles: [],
      assetUndoStack: [],
      closedTabStack: [],
      workflowRunRecord: null,
      workflowTutorialStep: null,
      vaultTasks: [],
      selectedTags: [],
      view: { kind: 'folder', folder: 'inbox', subpath: '' },
      selectedPath: null,
      activeNote: null,
      activeDirty: false,
      paneLayout: fresh,
      activePaneId: fresh.id,
      noteContents: {},
      noteDirty: {},
      loadingNote: false,
      noteBackstack: [],
      noteForwardstack: [],
      pendingJumpLocation: null,
      pinnedRefPath: null,
      workspaceRestored: false
    })
    savePrefs(collectPrefs(get()))
    await openVaultWorkspace(vault)
  },

  openLocalVault: async (root: string) => {
    const trimmed = root.trim()
    if (!trimmed) return
    // Only a no-op when we are already in this exact local vault. In remote
    // mode vault.root holds the server-reported path, which for a localhost
    // server equals the local vault's own path -- comparing against it here
    // would wrongly block switching back from remote to local.
    if (get().workspaceMode === 'local' && trimmed === get().vault?.root) return
    try {
      await get().flushDirtyNotes()
      set({ workspaceSetupError: null })
      const vault = await window.zen.openLocalVault(trimmed)
      await get().refreshLocalVaults()
      if (!vault) return

      const remoteWorkspaceInfo = await get().refreshWorkspaceContext()
      const vaultSettings = normalizeVaultSettings(await window.zen.getVaultSettings())
      const fresh = makeLeaf()
      set({
        vault,
        workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
        remoteWorkspaceInfo,
        workspaceSetupError: null,
        vaultSettings,
        notes: [],
        folders: [],
        hasAssetsDir: false,
        assetFiles: [],
        assetUndoStack: [],
        closedTabStack: [],
        workflowRunRecord: null,
        workflowTutorialStep: null,
        vaultTasks: [],
        selectedTags: [],
        view: { kind: 'folder', folder: 'inbox', subpath: '' },
        selectedPath: null,
        activeNote: null,
        activeDirty: false,
        paneLayout: fresh,
        activePaneId: fresh.id,
        noteContents: {},
        noteDirty: {},
        loadingNote: false,
        noteBackstack: [],
        noteForwardstack: [],
        pendingJumpLocation: null,
        pinnedRefPath: null,
        workspaceRestored: false
      })
      savePrefs(collectPrefs(get()))
      await openVaultWorkspace(vault)
    } catch (err) {
      console.error('openLocalVault failed', err)
      window.alert(err instanceof Error ? err.message : String(err))
    }
  },

  closeVault: async () => {
    const closingVault = get().vault
    if (!closingVault || get().workspaceMode === 'remote') return
    try {
      await get().flushDirtyNotes()
      set({ workspaceSetupError: null })
      const fallbackLocalVault =
        get().localVaults.find((entry) => entry.root !== closingVault.root) ?? null
      const nextVault = await window.zen.closeVault()
      const refreshedLocalVaults = await get().refreshLocalVaults()
      const remoteWorkspaceInfo = await get().refreshWorkspaceContext()
      const fallbackAfterClose =
        fallbackLocalVault ??
        refreshedLocalVaults.find((entry) => entry.root !== closingVault.root) ??
        null
      const vaultToOpen =
        nextVault ??
        (fallbackAfterClose ? await window.zen.openLocalVault(fallbackAfterClose.root) : null)
      if (vaultToOpen && !nextVault) await get().refreshLocalVaults()

      if (vaultToOpen) {
        const vaultSettings = normalizeVaultSettings(await window.zen.getVaultSettings())
        const fresh = makeLeaf()
        set({
          vault: vaultToOpen,
          workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
          remoteWorkspaceInfo,
          workspaceSetupError: null,
          vaultSettings,
          notes: [],
          folders: [],
          hasAssetsDir: false,
          assetFiles: [],
          assetUndoStack: [],
          closedTabStack: [],
          workflowRunRecord: null,
          workflowTutorialStep: null,
          vaultTasks: [],
          selectedTags: [],
          view: { kind: 'folder', folder: 'inbox', subpath: '' },
          selectedPath: null,
          activeNote: null,
          activeDirty: false,
          paneLayout: fresh,
          activePaneId: fresh.id,
          noteContents: {},
          noteDirty: {},
          loadingNote: false,
          noteBackstack: [],
          noteForwardstack: [],
          pendingJumpLocation: null,
          pinnedRefPath: null,
          workspaceRestored: false
        })
        savePrefs(collectPrefs(get()))
        await openVaultWorkspace(vaultToOpen)
        return
      }

      const fresh = makeLeaf()
      set({
        vault: null,
        workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
        remoteWorkspaceInfo,
        workspaceSetupError: null,
        vaultSettings: DEFAULT_VAULT_SETTINGS,
        notes: [],
        folders: [],
        hasAssetsDir: false,
        assetFiles: [],
        assetUndoStack: [],
        closedTabStack: [],
        workflowRunRecord: null,
        workflowTutorialStep: null,
        vaultTasks: [],
        selectedTags: [],
        view: { kind: 'folder', folder: 'inbox', subpath: '' },
        selectedPath: null,
        activeNote: null,
        activeDirty: false,
        paneLayout: fresh,
        activePaneId: fresh.id,
        noteContents: {},
        noteDirty: {},
        loadingNote: false,
        noteBackstack: [],
        noteForwardstack: [],
        pendingJumpLocation: null,
        pinnedRefPath: null,
        workspaceRestored: true
      })
      savePrefs(collectPrefs(get()))
    } catch (err) {
      console.error('closeVault failed', err)
      window.alert(err instanceof Error ? err.message : String(err))
    }
  },

  connectRemoteWorkspace: async () => {
    try {
      await get().flushDirtyNotes()
      const capabilities = window.zen.getCapabilities()
      if (!capabilities.supportsRemoteWorkspace) {
        throw new Error('Remote workspace connection is not available in this build.')
      }

      const currentRemote = await window.zen.getRemoteWorkspaceInfo()
      const profileSuggestions = get().remoteWorkspaceProfiles.map((profile) => ({
        value: profile.baseUrl,
        label: profile.name,
        detail: profile.vaultPath ?? undefined
      }))
      const baseUrl = await promptApp({
        title: 'Connect to Remote Vault',
        description:
          "Your ZenNotes server's address, like http://localhost:7878 or https://notes.example.com.",
        initialValue: currentRemote?.baseUrl ?? 'http://localhost:7878',
        placeholder: 'http://localhost:7878',
        okLabel: 'Next',
        plainInput: true,
        suggestions: profileSuggestions,
        validate: (value) => {
          try {
            // eslint-disable-next-line no-new
            new URL(normalizeServerBaseUrl(value))
            return null
          } catch {
            return 'Enter a valid server URL.'
          }
        }
      })
      if (!baseUrl) return

      const normalizedBaseUrl = normalizeServerBaseUrl(baseUrl)

      const authToken = await promptApp({
        title: 'Auth Token',
        description: "The server's auth token — leave blank if it doesn't need one.",
        placeholder: 'Optional',
        okLabel: 'Connect',
        allowEmptySubmit: true,
        plainInput: true
      })
      if (authToken == null) return

      let vault: VaultInfo | null = null
      const result = await window.zen.connectRemoteWorkspace(normalizedBaseUrl, authToken.trim() || null)
      vault = result.vault

      if (!vault && result.capabilities.supportsVaultSelection) {
        const enteredPath = await pickServerDirectoryApp(
          {
            title: 'Choose Vault Folder',
            description:
              'Choose the folder on the connected ZenNotes server that should be used as your vault.',
            confirmLabel: 'Choose Folder'
          },
          async (selectedPath) => {
            vault = await window.zen.selectVaultPath(selectedPath.trim())
          }
        )
        if (!enteredPath || !vault) {
          await window.zen.disconnectRemoteWorkspace()
          await get().refreshWorkspaceContext()
          return
        }
      }

      if (!vault) {
        throw new Error('Connected to the server, but no vault folder is selected there yet.')
      }

      const existingProfile = findMatchingRemoteProfile(
        get().remoteWorkspaceProfiles,
        normalizedBaseUrl,
        vault.root
      )
      const savedProfile = await window.zen.saveRemoteWorkspaceProfile({
        id: existingProfile?.id,
        name:
          existingProfile?.name ??
          deriveRemoteProfileName(normalizedBaseUrl, vault, get().remoteWorkspaceProfiles),
        baseUrl: normalizedBaseUrl,
        authToken: authToken.trim() || null,
        vaultPath: vault.root
      })
      const [remoteWorkspaceInfo] = await Promise.all([
        get().refreshWorkspaceContext(),
        get().refreshRemoteWorkspaceProfiles()
      ])

      const vaultSettings = normalizeVaultSettings(await window.zen.getVaultSettings())
      const fresh = makeLeaf()
      set({
        vault,
        workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
        vaultSettings,
        notes: [],
        folders: [],
        hasAssetsDir: false,
        assetFiles: [],
        assetUndoStack: [],
        closedTabStack: [],
        workflowRunRecord: null,
        workflowTutorialStep: null,
        vaultTasks: [],
        selectedTags: [],
        view: { kind: 'folder', folder: 'inbox', subpath: '' },
        selectedPath: null,
        activeNote: null,
        activeDirty: false,
        paneLayout: fresh,
        activePaneId: fresh.id,
        noteContents: {},
        noteDirty: {},
        loadingNote: false,
        noteBackstack: [],
        noteForwardstack: [],
        pendingJumpLocation: null,
        pinnedRefPath: null,
        workspaceRestored: false,
        remoteWorkspaceInfo:
          remoteWorkspaceInfo && remoteWorkspaceInfo.baseUrl === normalizedBaseUrl
            ? { ...remoteWorkspaceInfo, profileId: savedProfile.id }
            : remoteWorkspaceInfo
      })
      savePrefs(collectPrefs(get()))
      await openVaultWorkspace(vault)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  },

  connectRemoteWorkspaceProfile: async (id: string) => {
    try {
      await get().flushDirtyNotes()
      const profile = get().remoteWorkspaceProfiles.find((entry) => entry.id === id)
      if (!profile) {
        throw new Error('That saved remote workspace could not be found.')
      }
      let vault: VaultInfo | null = null
      const result = await window.zen.connectRemoteWorkspaceProfile(id)
      vault = result.vault
      if (!vault && result.capabilities.supportsVaultSelection) {
        const enteredPath = await pickServerDirectoryApp(
          {
            title: 'Choose Vault Folder',
            description:
              'Choose the folder on the connected ZenNotes server that should be used as your vault.',
            initialPath: profile.vaultPath ?? '',
            confirmLabel: 'Choose Folder'
          },
          async (selectedPath) => {
            vault = await window.zen.selectVaultPath(selectedPath.trim())
          }
        )
        if (!enteredPath || !vault) {
          await window.zen.disconnectRemoteWorkspace()
          await get().refreshWorkspaceContext()
          return
        }
        const selectedVault: VaultInfo = vault
        await window.zen.saveRemoteWorkspaceProfile({
          ...profile,
          vaultPath: selectedVault.root
        })
      }
      if (!vault) {
        throw new Error('Connected to the server, but no vault folder is selected there yet.')
      }
      const [remoteWorkspaceInfo] = await Promise.all([
        get().refreshWorkspaceContext(),
        get().refreshRemoteWorkspaceProfiles()
      ])
      const vaultSettings = normalizeVaultSettings(await window.zen.getVaultSettings())
      const fresh = makeLeaf()
      set({
        vault,
        workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
        remoteWorkspaceInfo,
        vaultSettings,
        notes: [],
        folders: [],
        hasAssetsDir: false,
        assetFiles: [],
        assetUndoStack: [],
        closedTabStack: [],
        workflowRunRecord: null,
        workflowTutorialStep: null,
        vaultTasks: [],
        selectedTags: [],
        view: { kind: 'folder', folder: 'inbox', subpath: '' },
        selectedPath: null,
        activeNote: null,
        activeDirty: false,
        paneLayout: fresh,
        activePaneId: fresh.id,
        noteContents: {},
        noteDirty: {},
        loadingNote: false,
        noteBackstack: [],
        noteForwardstack: [],
        pendingJumpLocation: null,
        pinnedRefPath: null,
        workspaceRestored: false
      })
      savePrefs(collectPrefs(get()))
      await openVaultWorkspace(vault)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  },

  changeRemoteWorkspaceVaultPath: async () => {
    try {
      if (get().workspaceMode !== 'remote') return
      const remoteInfo = get().remoteWorkspaceInfo
      if (!remoteInfo?.capabilities?.supportsVaultSelection) {
        throw new Error('This ZenNotes server does not allow switching vault folders from the app.')
      }

      await get().flushDirtyNotes()

      const currentVault = get().vault
      const currentProfile = get().remoteWorkspaceProfiles.find(
        (entry) => entry.id === (remoteInfo.profileId ?? null)
      )

      let nextVault: VaultInfo | null = null
      const enteredPath = await pickServerDirectoryApp(
        {
          title: 'Choose Vault Folder',
          description:
            'Choose the folder on the connected ZenNotes server that ZenNotes should use as your vault.',
          initialPath: currentVault?.root ?? currentProfile?.vaultPath ?? '',
          confirmLabel: 'Choose Folder'
        },
        async (selectedPath) => {
          nextVault = await window.zen.selectVaultPath(selectedPath.trim())
        }
      )

      if (!enteredPath || !nextVault) return
      const selectedVault: VaultInfo = nextVault

      if (currentProfile) {
        await window.zen.saveRemoteWorkspaceProfile({
          ...currentProfile,
          vaultPath: selectedVault.root
        })
      }

      const [remoteWorkspaceInfo] = await Promise.all([
        get().refreshWorkspaceContext(),
        get().refreshRemoteWorkspaceProfiles()
      ])
      const vaultSettings = normalizeVaultSettings(await window.zen.getVaultSettings())
      const fresh = makeLeaf()
      set({
        vault: selectedVault,
        workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
        remoteWorkspaceInfo,
        vaultSettings,
        notes: [],
        folders: [],
        hasAssetsDir: false,
        assetFiles: [],
        assetUndoStack: [],
        closedTabStack: [],
        workflowRunRecord: null,
        workflowTutorialStep: null,
        vaultTasks: [],
        selectedTags: [],
        view: { kind: 'folder', folder: 'inbox', subpath: '' },
        selectedPath: null,
        activeNote: null,
        activeDirty: false,
        paneLayout: fresh,
        activePaneId: fresh.id,
        noteContents: {},
        noteDirty: {},
        loadingNote: false,
        noteBackstack: [],
        noteForwardstack: [],
        pendingJumpLocation: null,
        pinnedRefPath: null,
        workspaceRestored: false
      })
      savePrefs(collectPrefs(get()))
      await openVaultWorkspace(selectedVault)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  },

  disconnectRemoteWorkspace: async () => {
    try {
      await get().flushDirtyNotes()
      const vault = await window.zen.disconnectRemoteWorkspace()
      const remoteWorkspaceInfo = await get().refreshWorkspaceContext()
      await get().refreshLocalVaults()

      if (!vault) {
        const fresh = makeLeaf()
        set({
          vault: null,
          workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
          remoteWorkspaceInfo,
          vaultSettings: DEFAULT_VAULT_SETTINGS,
          notes: [],
          folders: [],
          hasAssetsDir: false,
          assetFiles: [],
          assetUndoStack: [],
          closedTabStack: [],
          workflowRunRecord: null,
          workflowTutorialStep: null,
          vaultTasks: [],
          selectedTags: [],
          view: { kind: 'folder', folder: 'inbox', subpath: '' },
          selectedPath: null,
          activeNote: null,
          activeDirty: false,
          paneLayout: fresh,
          activePaneId: fresh.id,
          noteContents: {},
          noteDirty: {},
          loadingNote: false,
          noteBackstack: [],
          noteForwardstack: [],
          pendingJumpLocation: null,
          pinnedRefPath: null,
          workspaceRestored: true
        })
        savePrefs(collectPrefs(get()))
        return
      }

      const vaultSettings = normalizeVaultSettings(await window.zen.getVaultSettings())
      const fresh = makeLeaf()
      set({
        vault,
        workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
        remoteWorkspaceInfo,
        vaultSettings,
        notes: [],
        folders: [],
        hasAssetsDir: false,
        assetFiles: [],
        assetUndoStack: [],
        closedTabStack: [],
        workflowRunRecord: null,
        workflowTutorialStep: null,
        vaultTasks: [],
        selectedTags: [],
        view: { kind: 'folder', folder: 'inbox', subpath: '' },
        selectedPath: null,
        activeNote: null,
        activeDirty: false,
        paneLayout: fresh,
        activePaneId: fresh.id,
        noteContents: {},
        noteDirty: {},
        loadingNote: false,
        noteBackstack: [],
        noteForwardstack: [],
        pendingJumpLocation: null,
        pinnedRefPath: null,
        workspaceRestored: false
      })
      savePrefs(collectPrefs(get()))
      await openVaultWorkspace(vault)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  },

  saveRemoteWorkspaceProfile: async (input) => {
    const profile = await window.zen.saveRemoteWorkspaceProfile(input)
    await Promise.all([get().refreshRemoteWorkspaceProfiles(), get().refreshWorkspaceContext()])
    return profile
  },

  deleteRemoteWorkspaceProfile: async (id) => {
    const wasRemote = get().workspaceMode === 'remote'
    await window.zen.deleteRemoteWorkspaceProfile(id)
    const [profiles] = await Promise.all([
      get().refreshRemoteWorkspaceProfiles(),
      get().refreshWorkspaceContext()
    ])
    if (wasRemote && profiles.length === 0) {
      await get().disconnectRemoteWorkspace()
    }
  },

  persistWorkspace: () => {
    const state = get()
    if (!state.vault || !state.workspaceRestored) return
    const sidebarOpen = state.zenMode
      ? state.zenRestoreState?.sidebarOpen ?? state.sidebarOpen
      : state.sidebarOpen
    const noteListOpen = state.zenMode
      ? state.zenRestoreState?.noteListOpen ?? state.noteListOpen
      : state.noteListOpen
    saveWorkspaceSnapshot(state.vault.root, {
      paneLayout: state.paneLayout,
      activePaneId: state.activePaneId,
      view: state.view,
      sidebarOpen,
      noteListOpen,
      selectedTags: state.selectedTags
    })
  },

  flushDirtyNotes: async () => {
    get().persistWorkspace()
    // Before the dirty sweep, not after: a queued task write on a note someone
    // has open lands in the buffer rather than on disk, so draining first is
    // what puts it in the set the sweep below persists.
    await drainTaskMutationQueues()
    const dirtyPaths = Object.entries(get().noteDirty)
      .filter(([, isDirty]) => isDirty)
      .map(([path]) => path)
    await Promise.all(dirtyPaths.map(async (path) => get().persistNote(path)))
  }
  }
})

/** Drop the virtual Workflows tab from every pane that has it, mirroring
 *  `closeTasksView`. Called whenever the feature is switched off, from either
 *  Settings or an external config edit, so a disabled feature can never leave a
 *  live canvas (which can write to the vault) on screen. */
function closeWorkflowsTabsEverywhere(): void {
  const state = useStore.getState()
  for (const leaf of allLeaves(state.paneLayout)) {
    if (leaf.tabs.includes(WORKFLOWS_TAB_PATH)) {
      void state.closeTabInPane(leaf.id, WORKFLOWS_TAB_PATH)
    }
  }
  // Closing a tab records it for Reopen Closed Tab, so without this the canvas
  // is one Cmd+Shift+T away from being back. Safe to run straight after the
  // loop: a virtual tab holds no unsaved body, so every close above reached its
  // `set` synchronously.
  useStore.setState((s) => ({
    closedTabStack: s.closedTabStack.filter((entry) => !isWorkflowsTabPath(entry.path))
  }))
}

/** Drop the virtual Atlas tab from every pane, mirroring
 *  `closeWorkflowsTabsEverywhere`, whenever the feature is switched off. */
function closeAtlasTabsEverywhere(): void {
  const state = useStore.getState()
  for (const leaf of allLeaves(state.paneLayout)) {
    if (leaf.tabs.includes(ATLAS_TAB_PATH)) {
      void state.closeTabInPane(leaf.id, ATLAS_TAB_PATH)
    }
  }
  useStore.setState((s) => ({
    closedTabStack: s.closedTabStack.filter((entry) => !isAtlasTabPath(entry.path))
  }))
}

// --- Portable config file sync (desktop) ------------------------------------

/** Apply an externally-changed portable config (synced dotfile / hand-edit)
 *  to the live store and the localStorage cache. Uses setState directly so it
 *  doesn't re-trigger a write back out to the file. */
function applyPortableConfig(next: AppConfigPortable): void {
  if (!next || typeof next !== 'object') return
  const current = collectPrefs(useStore.getState())
  const merged = normalizePrefs({ ...current, ...(next as Partial<Prefs>) })
  cachedInitialPrefs = merged
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(merged))
  } catch {
    /* ignore */
  }
  const patch: Record<string, unknown> = {}
  const mergedRecord = merged as unknown as Record<string, unknown>
  for (const key of PORTABLE_PREF_KEYS) {
    patch[key] = mergedRecord[key]
  }
  useStore.setState(patch as Partial<Store>)
  // setState bypasses the setters on purpose (no write-back to the file), so
  // the tab cleanup that setWorkflowsEnabled does has to be repeated here.
  if (!merged.workflowsEnabled) closeWorkflowsTabsEverywhere()
  if (!merged.atlasEnabled) closeAtlasTabsEverywhere()
}

let configSyncInitialized = false

/**
 * Wire up portable-config syncing. Call once on app startup (desktop only —
 * a no-op on web). Seeds the config file from current prefs on first run so
 * existing users keep their setup without reconfiguring, then subscribes to
 * external edits for live reload.
 */
export function initConfigSync(): void {
  if (configSyncInitialized) return
  const bridge = typeof window !== 'undefined' ? window.zen : undefined
  if (!bridge || typeof bridge.getConfigSync !== 'function') return
  if (!configFileEnabled) return
  configSyncInitialized = true

  // Migration for existing users: no config file yet → create one from their
  // current preferences so the dotfile starts as an exact mirror of today's
  // setup, no reconfiguration needed.
  if (!configFileHadContent && typeof bridge.setConfig === 'function') {
    try {
      const prefs = collectPrefs(useStore.getState())
      void bridge.setConfig(pickPortablePrefs(prefs as unknown as Record<string, unknown>))
    } catch {
      /* ignore */
    }
  }

  if (typeof bridge.onConfigChange === 'function') {
    try {
      bridge.onConfigChange((nextCfg) => applyPortableConfig(nextCfg))
    } catch {
      /* ignore */
    }
  }
}

function applyCustomThemes(themes: CustomTheme[]): void {
  useStore.setState({ customThemes: themes })
  // App.tsx injects the active theme's CSS in response to the state change.
  // One-time canonicalization of any legacy two-id custom selection
  // (`custom-<slug>-<mode>`) persisted by the pre-release WIP: only rewrites
  // when the stored id doesn't match a loaded theme but its stripped form does,
  // so a real theme whose slug ends in `-light`/`-dark` is left untouched.
  const { themeId, themeMode } = useStore.getState()
  if (isCustomThemeId(themeId)) {
    const slug = customThemeSlugFromId(themeId)
    if (slug && !themes.some((t) => t.slug === slug)) {
      const legacy = /^custom-(.+)-(?:light|dark)$/.exec(themeId)
      if (legacy && themes.some((t) => t.slug === legacy[1])) {
        useStore
          .getState()
          .setTheme({ id: `custom-${legacy[1]}`, family: 'custom', mode: themeMode })
      }
    }
  }
}

/** Re-scan the themes dir and apply the result. Used after an in-app change
 *  (e.g. deleting a theme) so the UI updates without waiting on the watcher. */
export function refreshCustomThemes(): void {
  const bridge = typeof window !== 'undefined' ? window.zen : undefined
  if (!bridge || typeof bridge.listCustomThemes !== 'function') return
  void bridge.listCustomThemes().then(applyCustomThemes).catch(() => {})
}

/**
 * Load user themes from the config dir, inject their CSS, and keep both in sync
 * as files change. Safe to call on web (no bridge → no-op).
 */
export function initCustomThemes(): void {
  const bridge = typeof window !== 'undefined' ? window.zen : undefined
  if (!bridge || typeof bridge.listCustomThemes !== 'function') return
  refreshCustomThemes()
  if (typeof bridge.onCustomThemesChange === 'function') {
    try {
      bridge.onCustomThemesChange(applyCustomThemes)
    } catch {
      /* ignore */
    }
  }
}

async function applyCustomCodeLanguages(languages: CustomCodeLanguage[]): Promise<void> {
  useStore.setState({ customCodeLanguages: languages })
  try {
    await customCodeLanguageRegistry.replace(languages)
  } finally {
    useStore.setState((state) => ({
      customCodeLanguagesRevision: state.customCodeLanguagesRevision + 1
    }))
  }
}

export function refreshCustomCodeLanguages(): void {
  const bridge = typeof window !== 'undefined' ? window.zen : undefined
  if (!bridge || typeof bridge.listCustomCodeLanguages !== 'function') return
  void bridge.listCustomCodeLanguages().then(applyCustomCodeLanguages).catch(() => {})
}

export function initCustomCodeLanguages(): void {
  const bridge = typeof window !== 'undefined' ? window.zen : undefined
  if (!bridge || typeof bridge.listCustomCodeLanguages !== 'function') return
  refreshCustomCodeLanguages()
  if (typeof bridge.onCustomCodeLanguagesChange === 'function') {
    try {
      bridge.onCustomCodeLanguagesChange((next) => {
        void applyCustomCodeLanguages(next)
      })
    } catch {
      /* ignore */
    }
  }
}

let themeTweaksSaveTimer: ReturnType<typeof setTimeout> | null = null
/** Debounce persistence of theme tweaks so dragging a color picker (which fires
 *  continuously) doesn't spam the config file; in-memory state still updates
 *  immediately for live preview. */
function scheduleThemeTweaksSave(): void {
  if (themeTweaksSaveTimer) clearTimeout(themeTweaksSaveTimer)
  themeTweaksSaveTimer = setTimeout(() => {
    themeTweaksSaveTimer = null
    savePrefs(collectPrefs(useStore.getState()))
  }, 250)
}

/** Keep only string→string entries (token slug → color). */
function normalizeThemeTweaks(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && value) out[key] = value
    }
  }
  return out
}

/** Keep only string→string entries with a `.css` key (tolerant of hand edits). */
function normalizeEnabledOverrides(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (key.toLowerCase().endsWith('.css') && typeof value === 'string' && value) {
        out[key] = value
      }
    }
  }
  return out
}

function applyOverrides(overrides: Override[]): void {
  useStore.setState({ overrides })
  // App.tsx injects the enabled overrides in response to the state change.
}

/** Re-scan the overrides dir and apply the result. */
export function refreshOverrides(): void {
  const bridge = typeof window !== 'undefined' ? window.zen : undefined
  if (!bridge || typeof bridge.listOverrides !== 'function') return
  void bridge
    .listOverrides()
    .then(applyOverrides)
    .catch(() => {})
}

/**
 * Load user overrides from the config dir and keep them in sync as files change.
 * Safe to call on web (no bridge → no-op).
 */
export function initOverrides(): void {
  const bridge = typeof window !== 'undefined' ? window.zen : undefined
  if (!bridge || typeof bridge.listOverrides !== 'function') return
  refreshOverrides()
  if (typeof bridge.onOverridesChange === 'function') {
    try {
      bridge.onOverridesChange(applyOverrides)
    } catch {
      /* ignore */
    }
  }
}

useCloudSyncStatusStore.subscribe((state) => {
  const nextPaths = new Set(
    (state.lastSummary?.pending_conflicts ?? []).flatMap((conflict) =>
      [conflict.path, conflict.cloud_path]
        .filter((path): path is string => Boolean(path))
        .map(cloudSyncPathKey)
    )
  )
  if (
    nextPaths.size === isolatedCloudTaskPaths.size &&
    [...nextPaths].every((path) => isolatedCloudTaskPaths.has(path))
  ) {
    return
  }

  const restoredPath = [...isolatedCloudTaskPaths].some((path) => !nextPaths.has(path))
  isolatedCloudTaskPaths = nextPaths
  useStore.setState((current) => ({
    vaultTasks: withoutPendingCloudConflictTasks(current.vaultTasks)
  }))
  if (restoredPath && tasksSurfaceVisible(useStore.getState())) {
    void useStore.getState().refreshTasks()
  }
})
