import { create } from 'zustand'
import type { EditorView } from '@codemirror/view'
import { DEFAULT_VAULT_SETTINGS } from '@shared/ipc'
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
  VaultTextSearchBackendPreference,
  VaultChangeEvent,
  VaultInfo,
  WorkspaceMode
} from '@shared/ipc'
import type { VaultTask } from '@shared/tasks'
import { isExcalidrawPath } from '@shared/excalidraw'
import { TASKS_TAB_PATH, isTasksTabPath, parseTasksFromBody } from '@shared/tasks'
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
import { HELP_TAB_PATH, isHelpTabPath } from '@shared/help'
import { ARCHIVE_TAB_PATH, isArchiveTabPath } from '@shared/archive'
import { TRASH_TAB_PATH, isTrashTabPath } from '@shared/trash'
import { ASSETS_VIEW_TAB_PATH, isAssetsViewTabPath } from '@shared/assets-view'
import { QUICK_NOTES_TAB_PATH, isQuickNotesTabPath } from '@shared/quick-notes'
import { isAssetTabPath, assetPathFromTab, assetTabPath } from './lib/asset-tabs'
import {
  FENCE_RE,
  TASK_LINE_RE,
  extractUncheckedTaskBlocks,
  removeTaskAtIndex,
  takeTaskLineAtIndex,
  setTaskCheckedAtIndex,
  setTaskDueAtIndex,
  setTaskPriorityAtIndex,
  setTaskTextAtIndex,
  setTaskWaitingAtIndex,
  toggleTaskAtIndex,
  type TaskPriority as TaskLinePriority
} from '@shared/tasklists'
import { DEFAULT_THEME_ID, THEMES, type ThemeFamily, type ThemeMode } from './lib/themes'
import { formatMarkdown } from './lib/format-markdown'
import { confirmMoveToTrash } from './lib/confirm-trash'
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
  noteTitleForDate,
  isPrimaryNotesAtRoot,
  removeFavoritesForFolder,
  removeFolderColors,
  removeFolderIcons,
  normalizeVaultSettings,
  noteFolderSubpath,
  rewriteFavoriteNotePath,
  rewriteFavoritesForFolderRename,
  toggleFavorite as toggleFavoriteKey,
  weeklyNoteLocationForDate,
  rewriteFolderColorsForRename,
  rewriteFolderIconsForRename
} from './lib/vault-layout'
import { renderTemplate, renderTitle } from './lib/template-render'
import type { NoteTemplate } from '@bridge-contract/templates'
import { BUILTIN_TEMPLATES } from '@shared/builtin-templates'
import {
  composeTemplateFile,
  mergeTemplates,
  parseCustomTemplate,
  slugifyTemplateName
} from '@shared/template-files'
import {
  INITIAL_VISIBLE_NOTE_PREFETCH_BATCH_SIZE,
  selectInitialVisibleNotePrefetchPaths
} from './lib/note-prefetch'
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
  splitLeaf,
  updateLeaf,
  updateSplitSizes,
  nextPaneId,
  type PaneEdge,
  type PaneLayout,
  type PaneLeaf
} from './lib/pane-layout'

export type NoteSortOrder =
  | 'none'
  | 'manual'
  | 'updated-desc'
  | 'updated-asc'
  | 'created-desc'
  | 'created-asc'
  | 'name-asc'
  | 'name-desc'

export type LineNumberMode = 'off' | 'absolute' | 'relative'

/** Where the line-number gutter sits when content is centered: glued to the
 *  left of the text column ('text', default) or pinned to the editor's far-left
 *  edge ('edge'). No visible effect when content is left-aligned. (#228) */
export type LineNumberPosition = 'edge' | 'text'
export type WhichKeyHintMode = 'timed' | 'sticky'
export type CommandPaletteInitialMode = 'main' | 'vault'

const PREFS_KEY = 'zen:prefs:v2'
const WORKSPACE_KEY = 'zen:workspace:v1'
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
  'black-metal'
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
const LIST_NOTES_BRIDGE_PAGE_SIZE = 250

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

async function refreshVaultIndexes(): Promise<void> {
  const state = useStore.getState()
  await Promise.all([
    state.refreshNotes(),
    state.refreshAssets(),
    state.loadCustomTemplates(),
    state.refreshRootContentHidden()
  ])
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
  /** When true, Vim yank/delete/change also copy to the system clipboard
   *  (like `set clipboard=unnamed`). */
  vimYankToClipboard: boolean
  keymapOverrides: KeymapOverrides
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
  /** Auto-close markdown delimiters while typing: `**`+Space → `**|**`,
   *  ```` ``` ````+Enter expands a fenced block. Off restores plain typing. */
  markdownSnippets: boolean
  hideBuiltinTemplates: boolean // hide shipped built-in templates from the pickers
  tabsEnabled: boolean
  wrapTabs: boolean
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  editorFontSize: number    // px — affects editor + preview
  editorLineHeight: number  // unitless multiplier
  previewMaxWidth: number   // px — max reading width for preview surfaces
  lineNumberMode: LineNumberMode
  lineNumberPosition: LineNumberPosition
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
  /** Auto-show the calendar panel when the active note is a daily or
   *  weekly note. Persisted. */
  autoCalendarPanel: boolean
  /** Which weekday the calendar grid starts on. Persisted. */
  calendarWeekStart: CalendarWeekStart
  /** Show the ISO week-number column in the calendar. Persisted. */
  calendarShowWeekNumbers: boolean
  /** Last selected view inside the Tasks tab. List is the v1 default. */
  tasksViewMode: TasksViewMode
  /** Column source used when the Tasks Kanban view is active. */
  kanbanGroupBy: KanbanGroupBy
  /** Display-only Kanban column title overrides. Keyed by `${groupBy}:${columnId}`. */
  kanbanColumnTitles: Record<string, string>
  /** True once the user has dismissed the first-run onboarding wizard. */
  hasCompletedOnboarding: boolean
}

export type TasksViewMode = 'list' | 'calendar' | 'kanban'
export type KanbanGroupBy = 'status' | 'priority' | 'folder'
/** How the Tags view combines multiple selected tags: `all` = intersection
 *  (AND, narrows), `any` = union (OR, widens). */
export type TagMatchMode = 'all' | 'any'

export type TaskMutation =
  | { kind: 'set-checked'; checked: boolean }
  | { kind: 'set-waiting'; waiting: boolean }
  | { kind: 'set-priority'; priority: TaskLinePriority | null }
  | { kind: 'set-due'; due: string | null }
  | { kind: 'set-text'; text: string }

type AssetUndoEntry = { kind: 'delete-asset'; deleted: DeletedAsset; createdAt: number }

const VALID_TASKS_VIEW_MODES: TasksViewMode[] = ['list', 'calendar', 'kanban']
const VALID_KANBAN_GROUP_BYS: KanbanGroupBy[] = ['status', 'priority', 'folder']
const MAX_KANBAN_COLUMN_TITLE_LENGTH = 48
const MAX_ASSET_UNDO_STACK = 20

function normalizeKanbanColumnTitle(title: string): string | null {
  const normalized = title.trim().replace(/\s+/g, ' ').slice(0, MAX_KANBAN_COLUMN_TITLE_LENGTH)
  return normalized.length > 0 ? normalized : null
}

function normalizeKanbanColumnTitles(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}

  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue
    if (!/^[a-z-]+:[A-Za-z0-9_-]+$/.test(key)) continue
    if (!VALID_KANBAN_GROUP_BYS.some((group) => key.startsWith(`${group}:`))) continue
    const normalized = normalizeKanbanColumnTitle(value)
    if (normalized) out[key] = normalized
  }
  return out
}

const DEFAULT_PREFS: Prefs = {
  vimMode: true,
  vimInsertEscape: '',
  vimYankToClipboard: false,
  keymapOverrides: {},
  whichKeyHints: true,
  whichKeyHintMode: 'timed',
  whichKeyHintTimeoutMs: 900,
  vaultTextSearchBackend: 'auto',
  ripgrepBinaryPath: null,
  fzfBinaryPath: null,
  livePreview: true,
  markdownSnippets: true,
  hideBuiltinTemplates: false,
  tabsEnabled: true,
  wrapTabs: false,
  themeId: DEFAULT_THEME_ID,
  themeFamily: 'gruvbox',
  themeMode: 'dark',
  editorFontSize: 16,
  editorLineHeight: 1.7,
  previewMaxWidth: 920,
  lineNumberMode: 'off',
  lineNumberPosition: 'text',
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
  previewSmoothScroll: true,
  editorMaxWidth: 920,
  pdfEmbedInEditMode: 'compact',
  pinnedRefKind: 'note',
  noteRefs: {},
  contentAlign: 'center',
  tagsCollapsed: false,
  autoCalendarPanel: true,
  calendarWeekStart: 'monday',
  calendarShowWeekNumbers: true,
  tasksViewMode: 'list',
  kanbanGroupBy: 'status',
  kanbanColumnTitles: {},
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
    p.themeId && THEMES.some((t) => t.id === p.themeId)
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
    keymapOverrides: normalizeKeymapOverrides(p.keymapOverrides),
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
    markdownSnippets:
      typeof p.markdownSnippets === 'boolean'
        ? p.markdownSnippets
        : DEFAULT_PREFS.markdownSnippets,
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
    editorLineHeight:
      typeof p.editorLineHeight === 'number'
        ? p.editorLineHeight
        : DEFAULT_PREFS.editorLineHeight,
    previewMaxWidth:
      typeof p.previewMaxWidth === 'number'
        ? Math.min(1600, Math.max(640, p.previewMaxWidth))
        : DEFAULT_PREFS.previewMaxWidth,
    lineNumberMode:
      p.lineNumberMode && VALID_LINE_NUMBER_MODES.includes(p.lineNumberMode)
        ? p.lineNumberMode
        : DEFAULT_PREFS.lineNumberMode,
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
    kanbanGroupBy:
      p.kanbanGroupBy && VALID_KANBAN_GROUP_BYS.includes(p.kanbanGroupBy)
        ? p.kanbanGroupBy
        : DEFAULT_PREFS.kanbanGroupBy,
    kanbanColumnTitles: normalizeKanbanColumnTitles(p.kanbanColumnTitles),
    hasCompletedOnboarding:
      typeof p.hasCompletedOnboarding === 'boolean'
        ? p.hasCompletedOnboarding
        : DEFAULT_PREFS.hasCompletedOnboarding
  }
}
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs>
      const normalized = normalizePrefs(parsed)
      // Users upgrading from a version that didn't have the onboarding flag
      // shouldn't be greeted with the wizard on next launch — treat the
      // presence of an existing prefs blob as evidence they've been here.
      if (typeof parsed.hasCompletedOnboarding !== 'boolean') {
        normalized.hasCompletedOnboarding = true
      }
      return normalized
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_PREFS
}
function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
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
 * plus database surfaces — so opening a row's record page and pressing Ctrl+O
 * jumps back to the grid. Other virtual tabs (tasks, tags, plain assets…) stay
 * excluded.
 */
function isJumpHistoryTabPath(path: string | null | undefined): path is string {
  return !!path && (!isWorkspaceVirtualTabPath(path) || isDatabaseSurfaceTabPath(path))
}

function captureNoteJumpLocation(state: {
  selectedPath: string | null
  editorViewRef: EditorView | null
}): NoteJumpLocation | null {
  if (!isJumpHistoryTabPath(state.selectedPath)) return null
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

function applyTaskMutationsToTask(task: VaultTask, mutations: TaskMutation[]): VaultTask {
  let next = task
  for (const m of mutations) {
    switch (m.kind) {
      case 'set-checked':
        if (next.checked !== m.checked) next = { ...next, checked: m.checked }
        break
      case 'set-waiting':
        if (next.waiting !== m.waiting) next = { ...next, waiting: m.waiting }
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
      case 'set-text': {
        const content = m.text.trim()
        if (next.content !== content) next = { ...next, content }
        break
      }
    }
  }
  return next
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
  keymapOverrides: KeymapOverrides
  whichKeyHints: boolean
  whichKeyHintMode: WhichKeyHintMode
  whichKeyHintTimeoutMs: number
  vaultTextSearchBackend: VaultTextSearchBackendPreference
  ripgrepBinaryPath: string | null
  fzfBinaryPath: string | null
  livePreview: boolean
  markdownSnippets: boolean
  hideBuiltinTemplates: boolean
  tabsEnabled: boolean
  wrapTabs: boolean
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  editorFontSize: number
  editorLineHeight: number
  previewMaxWidth: number
  lineNumberMode: LineNumberMode
  lineNumberPosition: LineNumberPosition
  interfaceFont: string | null
  textFont: string | null
  monoFont: string | null
  systemFolderLabels: SystemFolderLabels
  sidebarWidth: number
  noteListWidth: number
  noteSortOrder: NoteSortOrder
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
  previewSmoothScroll: boolean
  editorMaxWidth: number
  pdfEmbedInEditMode: 'compact' | 'full'
  pinnedRefKind: 'note' | 'asset'
  noteRefs: Record<string, { path: string; kind: 'note' | 'asset' }>
  contentAlign: 'center' | 'left'
  tagsCollapsed: boolean
  autoCalendarPanel: boolean
  calendarWeekStart: CalendarWeekStart
  calendarShowWeekNumbers: boolean
  tasksViewMode: TasksViewMode
  kanbanGroupBy: KanbanGroupBy
  kanbanColumnTitles: Record<string, string>
  hasCompletedOnboarding: boolean
}): Prefs {
  return {
    vimMode: s.vimMode,
    vimInsertEscape: s.vimInsertEscape,
    vimYankToClipboard: s.vimYankToClipboard,
    keymapOverrides: s.keymapOverrides,
    whichKeyHints: s.whichKeyHints,
    whichKeyHintMode: s.whichKeyHintMode,
    whichKeyHintTimeoutMs: s.whichKeyHintTimeoutMs,
    vaultTextSearchBackend: s.vaultTextSearchBackend,
    ripgrepBinaryPath: s.ripgrepBinaryPath,
    fzfBinaryPath: s.fzfBinaryPath,
    livePreview: s.livePreview,
    markdownSnippets: s.markdownSnippets,
    hideBuiltinTemplates: s.hideBuiltinTemplates,
    tabsEnabled: s.tabsEnabled,
    wrapTabs: s.wrapTabs,
    themeId: s.themeId,
    themeFamily: s.themeFamily,
    themeMode: s.themeMode,
    editorFontSize: s.editorFontSize,
    editorLineHeight: s.editorLineHeight,
    previewMaxWidth: s.previewMaxWidth,
    lineNumberMode: s.lineNumberMode,
    lineNumberPosition: s.lineNumberPosition,
    interfaceFont: s.interfaceFont,
    textFont: s.textFont,
    monoFont: s.monoFont,
    systemFolderLabels: s.systemFolderLabels,
    sidebarWidth: s.sidebarWidth,
    noteListWidth: s.noteListWidth,
    noteSortOrder: s.noteSortOrder,
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
    previewSmoothScroll: s.previewSmoothScroll,
    editorMaxWidth: s.editorMaxWidth,
    pdfEmbedInEditMode: s.pdfEmbedInEditMode,
    pinnedRefKind: s.pinnedRefKind,
    noteRefs: s.noteRefs,
    contentAlign: s.contentAlign,
    tagsCollapsed: s.tagsCollapsed,
    autoCalendarPanel: s.autoCalendarPanel,
    calendarWeekStart: s.calendarWeekStart,
    calendarShowWeekNumbers: s.calendarShowWeekNumbers,
    tasksViewMode: s.tasksViewMode,
    kanbanGroupBy: s.kanbanGroupBy,
    kanbanColumnTitles: s.kanbanColumnTitles,
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

function saveWorkspaceSnapshot(root: string, snapshot: WorkspaceSnapshot): void {
  try {
    const allSnapshots = loadWorkspaceSnapshots()
    allSnapshots[root] = snapshot
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(allSnapshots))
  } catch {
    /* ignore */
  }
}

function loadWorkspaceSnapshot(root: string): unknown {
  return loadWorkspaceSnapshots()[root] ?? null
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

function sanitizeWorkspaceLayout(raw: unknown, existingPaths: Set<string>): PaneLayout {
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
    if (typeof value !== 'string') return null
    return existingPaths.has(value) || isWorkspaceVirtualTabPath(value) ? value : null
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

function hasTasksViewOpen(state: { paneLayout: PaneLayout }): boolean {
  return allLeaves(state.paneLayout).some((leaf) => leaf.tabs.includes(TASKS_TAB_PATH))
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
  /** 'create' makes a new note from the picked template; 'insert' renders it
   *  into the active note instead. */
  templatePaletteMode: 'create' | 'insert'
  /** When set, the template picker creates in this folder (set by right-click);
   *  null means prompt the user for a destination. */
  templatePaletteTarget: { folder: NoteFolder; subpath: string } | null
  /** Custom templates loaded from `.zennotes/templates/` (built-ins are constants). */
  customTemplates: NoteTemplate[]
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
  keymapOverrides: KeymapOverrides
  whichKeyHints: boolean
  whichKeyHintMode: WhichKeyHintMode
  whichKeyHintTimeoutMs: number
  vaultTextSearchBackend: VaultTextSearchBackendPreference
  ripgrepBinaryPath: string | null
  fzfBinaryPath: string | null
  livePreview: boolean
  /** Auto-close markdown delimiters while typing. Persisted. */
  markdownSnippets: boolean
  hideBuiltinTemplates: boolean
  tabsEnabled: boolean
  wrapTabs: boolean
  settingsOpen: boolean
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  editorFontSize: number
  editorLineHeight: number
  previewMaxWidth: number
  lineNumberMode: LineNumberMode
  lineNumberPosition: LineNumberPosition
  interfaceFont: string | null
  textFont: string | null
  monoFont: string | null
  systemFolderLabels: SystemFolderLabels
  sidebarWidth: number
  noteListWidth: number
  noteSortOrder: NoteSortOrder
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
  noteRefs: Record<string, { path: string; kind: 'note' | 'asset' }>

  /** Center the editor + preview content (with the width cap) or
   *  left-align it to the pane edge. */
  contentAlign: 'center' | 'left'

  /** Sidebar Tags section collapsed — hides the pill rail but keeps
   *  the section header visible as a toggle. Persisted. */
  tagsCollapsed: boolean
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
  tasksLoading: boolean
  tasksFilter: string
  taskCursorIndex: number
  /** Which sub-view is active inside the Tasks tab. */
  tasksViewMode: TasksViewMode
  /** Column source for the Tasks Kanban view. */
  kanbanGroupBy: KanbanGroupBy
  /** Display-only column title overrides for the Tasks Kanban view. */
  kanbanColumnTitles: Record<string, string>
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
  noteListCursorIndex: number
  connectionsCursorIndex: number
  connectionPreview: ConnectionPreviewState | null
  editorViewRef: EditorView | null
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
  /** Rename a database (its `.base` folder); rehomes the open grid tab. */
  renameDatabase: (csvPath: string, newTitle: string) => Promise<void>
  /** Optimistically replace a database's rows and debounce-persist the CSV. */
  updateDatabaseRows: (csvPath: string, next: DatabaseDoc) => void
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
  setTasksFilter: (q: string) => void
  setTasksViewMode: (mode: TasksViewMode) => void
  setKanbanGroupBy: (group: KanbanGroupBy) => void
  setKanbanColumnTitle: (
    group: KanbanGroupBy,
    columnId: string,
    title: string | null
  ) => void
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
  jumpToPreviousNote: () => Promise<void>
  jumpToNextNote: () => Promise<void>
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
  /**
   * Create a note after asking where to put it: a destination prompt that
   * defaults to `initialPath` (empty = vault root), so the user can press Enter
   * to accept or type / pick a folder. Used by the sidebar's "+" buttons, which
   * — unlike the right-click menus — carry no implied location.
   */
  createNoteInChosenFolder: (opts?: { initialPath?: string }) => Promise<void>
  /**
   * Web counterpart of the desktop drag-to-open feature: for each
   * drag-and-dropped markdown File, read its contents, create a note from
   * it (titled after the filename), and open it. The browser only exposes
   * dropped file *contents*, not paths, so unlike desktop — which opens the
   * file in place — the web build brings it into the vault as a note.
   */
  importDroppedMarkdownFiles: (files: File[]) => Promise<void>
  closeActiveNote: () => Promise<void>
  trashActive: () => Promise<void>
  restoreActive: () => Promise<void>
  archiveActive: () => Promise<void>
  unarchiveActive: () => Promise<void>
  exportActiveNotePdf: () => Promise<void>
  copyActiveNoteAsMarkdown: () => Promise<void>
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
  setKeymapBinding: (id: KeymapId, binding: string | null) => void
  resetAllKeymaps: () => void
  setWhichKeyHints: (on: boolean) => void
  setWhichKeyHintMode: (mode: WhichKeyHintMode) => void
  setWhichKeyHintTimeoutMs: (ms: number) => void
  setVaultTextSearchBackend: (backend: VaultTextSearchBackendPreference) => void
  setRipgrepBinaryPath: (path: string | null) => void
  setFzfBinaryPath: (path: string | null) => void
  setLivePreview: (on: boolean) => void
  setMarkdownSnippets: (on: boolean) => void
  setHideBuiltinTemplates: (hidden: boolean) => void
  setTabsEnabled: (on: boolean) => void
  setWrapTabs: (on: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setTheme: (next: { id: string; family: ThemeFamily; mode: ThemeMode }) => void
  setEditorFontSize: (px: number) => void
  setEditorLineHeight: (mult: number) => void
  setPreviewMaxWidth: (px: number) => void
  setLineNumberMode: (mode: LineNumberMode) => void
  setLineNumberPosition: (position: LineNumberPosition) => void
  setInterfaceFont: (family: string | null) => void
  setTextFont: (family: string | null) => void
  setMonoFont: (family: string | null) => void
  setSystemFolderLabel: (key: LabelKey, label: string | null) => void
  setSidebarWidth: (px: number) => void
  setNoteListWidth: (px: number) => void
  setNoteSortOrder: (order: NoteSortOrder) => void
  /** Move a note before/after a sibling in its folder's manual order (#224). */
  reorderNoteManually: (
    draggedPath: string,
    targetPath: string,
    position: 'before' | 'after'
  ) => void
  setGroupByKind: (on: boolean) => void
  setAutoReveal: (on: boolean) => void
  setUnifiedSidebar: (on: boolean) => void
  setDarkSidebar: (on: boolean) => void
  setShowSidebarChevrons: (on: boolean) => void
  toggleCollapseFolder: (key: string) => void
  setCollapsedFolders: (keys: string[]) => void

  /* Pinned reference pane */
  pinReference: (path: string) => Promise<void>
  /** Pin a non-text asset (PDF, etc.) — rendered in the side pane via
   *  iframe, with no text-content cache. */
  pinAssetReference: (path: string) => void
  unpinReference: () => void
  /** Per-note variant: the pin only shows while `notePath` is the
   *  active note. Switching notes hides it; coming back shows it. */
  pinAssetReferenceForNote: (notePath: string, assetPath: string) => void
  unpinReferenceForNote: (notePath: string) => void
  togglePinnedRefVisible: () => void
  setPinnedRefWidth: (px: number) => void
  setPanelWidth: (panel: RightPanelId, px: number) => void
  setPinnedRefMode: (mode: 'edit' | 'preview') => void

  setQuickNoteDateTitle: (on: boolean) => void
  setQuickNoteTitlePrefix: (prefix: string | null) => void
  openTodayDailyNote: () => Promise<void>
  openThisWeekWeeklyNote: () => Promise<void>
  setTemplatePaletteOpen: (open: boolean) => void
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
  setWordWrap: (on: boolean) => void
  setPreviewSmoothScroll: (on: boolean) => void
  setEditorMaxWidth: (px: number) => void
  setPdfEmbedInEditMode: (mode: 'compact' | 'full') => void
  setContentAlign: (align: 'center' | 'left') => void
  setTagsCollapsed: (collapsed: boolean) => void
  setAutoCalendarPanel: (enabled: boolean) => void
  setCalendarWeekStart: (start: CalendarWeekStart) => void
  setCalendarShowWeekNumbers: (show: boolean) => void
  openDailyNoteForDate: (date: Date) => Promise<void>
  openWeeklyNoteForDate: (date: Date) => Promise<void>
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
  setConnectionPreview: (preview: ConnectionPreviewState | null) => void
  setEditorViewRef: (view: EditorView | null) => void

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
const PATH_SAVE_DEBOUNCE_MS = 350

/**
 * The body we most recently wrote to each path. The vault file watcher
 * inevitably echoes our own writes back through `applyChange` after a
 * short delay — when we recognise the echo (disk body === what we
 * wrote) we skip the refresh. Without this, edits made between save
 * completion and echo arrival get rolled back to the older disk body.
 */
const lastWrittenByPath = new Map<string, string>()

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
    okLabel: 'Sign In'
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
        noteBackstack:
          historyMode === 'push' &&
          isJumpHistoryTabPath(state.selectedPath) &&
          state.selectedPath !== relPath
            ? appendNoteJumpHistory(state.noteBackstack, captureNoteJumpLocation(state))
            : state.noteBackstack,
        noteForwardstack:
          historyMode === 'push' &&
          isJumpHistoryTabPath(state.selectedPath) &&
          state.selectedPath !== relPath
            ? []
            : state.noteForwardstack,
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
    const shouldPushHistory =
      historyMode === 'push' &&
      isJumpHistoryTabPath(latest.selectedPath) &&
      latest.selectedPath !== relPath
    const nextBackstack = shouldPushHistory
      ? appendNoteJumpHistory(latest.noteBackstack, captureNoteJumpLocation(latest))
      : latest.noteBackstack
    const nextForwardstack = shouldPushHistory ? [] : latest.noteForwardstack

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
      if (
        !target ||
        target.path === get().selectedPath ||
        (isWorkspaceVirtualTabPath(target.path) && !isDatabaseSurfaceTabPath(target.path))
      ) {
        continue
      }
      // A database surface in the history — e.g. the grid a record page was
      // opened from. Reopen the tab instead of loading note content, and record
      // the current location on the opposite stack so the jump stays reversible.
      if (isDatabaseSurfaceTabPath(target.path)) {
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
        await selectNoteImpl(target.path, 'preserve')
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
    const rawSnapshot = loadWorkspaceSnapshot(vault.root)
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
    const existingPaths = new Set(get().notes.map((note) => note.path))
    let layout = sanitizeWorkspaceLayout(snapshot.paneLayout, existingPaths)
    const unreadable = new Set<string>()
    const contents: Record<string, NoteContent> = {}
    const dirty: Record<string, boolean> = {}
    const pathsToLoad = initialWorkspaceRestoreContentPaths(layout, existingPaths)
    const initiallyLoadedPaths = new Set(pathsToLoad)

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
    const restorePrefetchPaths = workspaceRestorePrefetchContentPaths(
      layout,
      existingPaths,
      initiallyLoadedPaths
    )

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
      eagerNotes: pathsToLoad.length,
      deferredNotes: restorePrefetchPaths.length
    })

    if (restorePrefetchPaths.length > 0) {
      window.setTimeout(() => get().prefetchNotes(restorePrefetchPaths), 120)
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
  templatePaletteMode: 'create',
  templatePaletteTarget: null,
  customTemplates: [],
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
  keymapOverrides: loadPrefs().keymapOverrides,
  whichKeyHints: loadPrefs().whichKeyHints,
  whichKeyHintMode: loadPrefs().whichKeyHintMode,
  whichKeyHintTimeoutMs: loadPrefs().whichKeyHintTimeoutMs,
  vaultTextSearchBackend: loadPrefs().vaultTextSearchBackend,
  ripgrepBinaryPath: loadPrefs().ripgrepBinaryPath,
  fzfBinaryPath: loadPrefs().fzfBinaryPath,
  livePreview: loadPrefs().livePreview,
  markdownSnippets: loadPrefs().markdownSnippets,
  hideBuiltinTemplates: loadPrefs().hideBuiltinTemplates,
  tabsEnabled: loadPrefs().tabsEnabled,
  wrapTabs: loadPrefs().wrapTabs,
  settingsOpen: false,
  themeId: loadPrefs().themeId,
  themeFamily: loadPrefs().themeFamily,
  themeMode: loadPrefs().themeMode,
  editorFontSize: loadPrefs().editorFontSize,
  editorLineHeight: loadPrefs().editorLineHeight,
  previewMaxWidth: loadPrefs().previewMaxWidth,
  lineNumberMode: loadPrefs().lineNumberMode,
  lineNumberPosition: loadPrefs().lineNumberPosition,
  interfaceFont: loadPrefs().interfaceFont,
  textFont: loadPrefs().textFont,
  monoFont: loadPrefs().monoFont,
  systemFolderLabels: loadPrefs().systemFolderLabels,
  sidebarWidth: loadPrefs().sidebarWidth,
  noteListWidth: loadPrefs().noteListWidth,
  noteSortOrder: loadPrefs().noteSortOrder,
  groupByKind: loadPrefs().groupByKind,
  autoReveal: loadPrefs().autoReveal,
  unifiedSidebar: loadPrefs().unifiedSidebar,
  darkSidebar: loadPrefs().darkSidebar,
  showSidebarChevrons: loadPrefs().showSidebarChevrons,
  collapsedFolders: DEFAULT_PREFS.collapsedFolders,
  pinnedRefPath: loadPrefs().pinnedRefPath,
  pinnedRefVisible: loadPrefs().pinnedRefVisible,
  pinnedRefWidth: loadPrefs().pinnedRefWidth,
  panelWidths: loadPrefs().panelWidths,
  pinnedRefMode: loadPrefs().pinnedRefMode,
  quickNoteDateTitle: loadPrefs().quickNoteDateTitle,
  quickNoteTitlePrefix: loadPrefs().quickNoteTitlePrefix,
  wordWrap: loadPrefs().wordWrap,
  previewSmoothScroll: loadPrefs().previewSmoothScroll,
  editorMaxWidth: loadPrefs().editorMaxWidth,
  pdfEmbedInEditMode: loadPrefs().pdfEmbedInEditMode,
  pinnedRefKind: loadPrefs().pinnedRefKind,
  noteRefs: loadPrefs().noteRefs,
  contentAlign: loadPrefs().contentAlign,
  tagsCollapsed: loadPrefs().tagsCollapsed,
  autoCalendarPanel: loadPrefs().autoCalendarPanel,
  calendarWeekStart: loadPrefs().calendarWeekStart,
  calendarShowWeekNumbers: loadPrefs().calendarShowWeekNumbers,
  tasksViewMode: loadPrefs().tasksViewMode,
  kanbanGroupBy: loadPrefs().kanbanGroupBy,
  kanbanColumnTitles: loadPrefs().kanbanColumnTitles,
  hasCompletedOnboarding: loadPrefs().hasCompletedOnboarding,
  vaultTasks: [],
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
  noteListCursorIndex: 0,
  connectionsCursorIndex: 0,
  connectionPreview: null,
  editorViewRef: null,
  pendingTitleFocusPath: null,
  paneLayout: initialPane,
  activePaneId: initialPane.id,
  noteContents: {},
  noteDirty: {},
  noteComments: {},
  activeCommentId: null,

  setVault: (v) =>
    set((s) => {
      const vaultChanged = s.vault?.root !== v?.root || s.vault?.name !== v?.name
      if (vaultChanged) {
        clearNoteContentReadCaches()
      }
      return vaultChanged ? { vault: v, assetUndoStack: [] } : { vault: v }
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
    // filter from a prior visit would feel weird.
    set({ tasksFilter: '', taskCursorIndex: 0 })
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
    const state = get()
    // Refresh both: assets for the list, notes for fresh assetEmbeds (usage).
    await Promise.all([get().refreshAssets(), get().refreshNotes()])
    await get().openNoteInPane(state.activePaneId, ASSETS_VIEW_TAB_PATH)
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
      console.error('loadDatabase failed', err)
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
    }
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
      set({ vaultTasks: tasks, tasksLoading: false })
    } catch (err) {
      console.error('scanTasks failed', err)
      set({ tasksLoading: false })
    }
  },

  rescanTasksForPath: async (relPath) => {
    try {
      const fresh = await window.zen.scanTasksForPath(relPath)
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
    const lineText = lines[taskLineNumber] ?? ''
    const taskBracketMatch = lineText.match(/^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s*/)
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
  },

  toggleTaskFromList: async (task) => {
    const state = get()
    const path = task.sourcePath
    const openBuffer = state.noteContents[path]
    // Prefer the live buffer for open notes so we don't stomp unsaved edits.
    const body = openBuffer?.body ?? (await window.zen.readNote(path)).body
    const nextBody = toggleTaskAtIndex(body, task.taskIndex, !task.checked)
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
    set((s) => ({
      vaultTasks: s.vaultTasks.map((t) =>
        t.sourcePath === path && t.taskIndex === task.taskIndex
          ? { ...t, checked: !task.checked }
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

    if (hasOptimisticChange) {
      set((s) => ({
        vaultTasks: s.vaultTasks.map((t) =>
          t.sourcePath === path && t.taskIndex === task.taskIndex ? optimisticTask : t
        )
      }))
      await yieldForOptimisticPaint()
    }

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
    for (const m of mutations) {
      switch (m.kind) {
        case 'set-checked':
          nextBody = setTaskCheckedAtIndex(nextBody, task.taskIndex, m.checked)
          break
        case 'set-waiting':
          nextBody = setTaskWaitingAtIndex(nextBody, task.taskIndex, m.waiting)
          break
        case 'set-priority':
          nextBody = setTaskPriorityAtIndex(nextBody, task.taskIndex, m.priority)
          break
        case 'set-due':
          nextBody = setTaskDueAtIndex(nextBody, task.taskIndex, m.due)
          break
        case 'set-text':
          nextBody = setTaskTextAtIndex(nextBody, task.taskIndex, m.text)
          break
      }
    }
    if (nextBody === body) {
      if (hasOptimisticChange) void get().rescanTasksForPath(path)
      return
    }

    if (latestOpenBuffer) {
      get().updateNoteBody(path, nextBody)
    } else {
      try {
        await window.zen.writeNote(path, nextBody)
      } catch (err) {
        console.error('writeNote (mutate) failed', err)
        if (hasOptimisticChange) void get().rescanTasksForPath(path)
        return
      }
    }
  },

  deleteTaskFromList: async (task) => {
    const path = task.sourcePath
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
      vaultTasks: [
        ...s.vaultTasks.filter(
          (t) => t.sourcePath !== task.sourcePath && t.sourcePath !== target.path
        ),
        ...srcTasks,
        ...tgtTasks
      ]
    }))
  },

  setTasksFilter: (q) => set({ tasksFilter: q, taskCursorIndex: 0 }),
  setTasksViewMode: (mode) => {
    set({ tasksViewMode: mode, taskCursorIndex: 0 })
    savePrefs(collectPrefs(get()))
  },
  setKanbanGroupBy: (group) => {
    set({ kanbanGroupBy: group })
    savePrefs(collectPrefs(get()))
  },
  setKanbanColumnTitle: (group, columnId, title) => {
    const key = `${group}:${columnId}`
    const normalized = typeof title === 'string' ? normalizeKanbanColumnTitle(title) : null
    const nextTitles = { ...get().kanbanColumnTitles }
    if (normalized) nextTitles[key] = normalized
    else delete nextTitles[key]
    set({ kanbanColumnTitles: nextTitles })
    savePrefs(collectPrefs(get()))
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
      focusedPanel: 'editor'
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

  jumpToPreviousNote: async () => {
    await jumpThroughNoteHistory('back')
  },

  jumpToNextNote: async () => {
    await jumpThroughNoteHistory('forward')
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
        // Drop tabs whose notes no longer exist — except keep the currently
        // focused selectedPath so the editor doesn't blank out mid-save.
        const keep = (path: string): boolean =>
          existingPaths.has(path) ||
          isWorkspaceVirtualTabPath(path) ||
          path === s.selectedPath
        const nextLayout = rewritePathsInTree(s.paneLayout, (path) =>
          keep(path) ? path : null
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
    if (ev.scope === 'comments') {
      await get().loadNoteComments(ev.path)
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
      await get().refreshNotes()
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
    await Promise.all([
      get().refreshNotes(),
      ev.scope === 'vault-settings'
        ? window.zen
            .getVaultSettings()
            .then((settings) => {
              set({ vaultSettings: normalizeVaultSettings(settings) })
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

    // Keep an open Tasks tab in sync as files change externally or via our own
    // writes — cheap per-path rescans instead of walking the whole vault. This
    // also covers inactive Tasks tabs so returning to Kanban doesn't show stale
    // cards from the last time the tab was focused.
    if (hasTasksViewOpen(state)) {
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
      set((s) => {
        const nextLayout = rewritePathsInTree(s.paneLayout, (p) =>
          p === ev.path ? null : p
        )
        const ensured = ensureActivePane(nextLayout, s.activePaneId)
        const { [ev.path]: _drop, ...contents } = s.noteContents
        const { [ev.path]: _d, ...dirty } = s.noteDirty
        void _drop
        void _d
        return {
          paneLayout: ensured.layout,
          activePaneId: ensured.activePaneId,
          noteContents: contents,
          noteDirty: dirty,
          pinnedRefPath: s.pinnedRefPath === ev.path ? null : s.pinnedRefPath,
          ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
        }
      })
      return
    }

    if (ev.kind === 'change') {
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
    const s = get()
    const content = s.noteContents[path]
    if (!content || !s.noteDirty[path]) return
    const pending = pathSaveTimers.get(path)
    if (pending) {
      clearTimeout(pending)
      pathSaveTimers.delete(path)
    }
    try {
      // Snapshot the body BEFORE the await so we know what hit disk
      // even if the user keeps typing while the write resolves.
      const writtenBody = content.body
      lastWrittenByPath.set(path, writtenBody)
      const meta = await window.zen.writeNote(path, writtenBody)
      set((cur) => {
        const dirty = { ...cur.noteDirty, [path]: false }
        return {
          noteDirty: dirty,
          notes: cur.notes.map((n) => (n.path === meta.path ? { ...n, ...meta } : n)),
          ...activeFieldsFrom(cur.paneLayout, cur.activePaneId, cur.noteContents, dirty)
        }
      })
    } catch (err) {
      console.error('writeNote failed', err)
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
      const meta = await window.zen.renameNote(oldPath, nextTitle)
      set((s) => renameNoteState(s, oldPath, meta))
      await get().applyFavorites(
        rewriteFavoriteNotePath(get().vaultSettings.favorites, oldPath, meta.path)
      )
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

  trashActive: async () => {
    const state = get()
    const path = state.selectedPath
    if (!path) return
    const title = state.notes.find((note) => note.path === path)?.title
    if (!(await confirmMoveToTrash(title))) return
    try {
      await window.zen.moveToTrash(path)
      set((s) => {
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
      })
      await get().refreshNotes()
    } catch (err) {
      console.error('moveToTrash failed', err)
    }
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
    await window.zen.archiveNote(path)
    set((s) => {
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
    })
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
      await window.zen.exportNotePdf(path)
    } catch (err) {
      preparedExportWindow?.close()
      console.error('exportNotePdf failed', err)
      window.alert(
        err instanceof Error ? err.message : 'Could not export the note as a PDF.'
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
  setMarkdownSnippets: (on) => {
    set({ markdownSnippets: on })
    savePrefs(collectPrefs(get()))
  },
  setHideBuiltinTemplates: (hidden) => {
    set({ hideBuiltinTemplates: hidden })
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
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setTheme: ({ id, family, mode }) => {
    set({ themeId: id, themeFamily: family, themeMode: mode })
    savePrefs(collectPrefs(get()))
  },
  setEditorFontSize: (px) => {
    set({ editorFontSize: px })
    savePrefs(collectPrefs(get()))
  },
  setEditorLineHeight: (mult) => {
    set({ editorLineHeight: mult })
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
  setGroupByKind: (on) => {
    set({ groupByKind: on })
    savePrefs(collectPrefs(get()))
  },
  setAutoReveal: (on) => {
    set({ autoReveal: on })
    savePrefs(collectPrefs(get()))
  },
  setUnifiedSidebar: () => {
    set({ unifiedSidebar: true })
    savePrefs(collectPrefs(get()))
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

  pinAssetReference: (path) => {
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
      pinnedRefKind: 'asset',
      pinnedRefVisible: true,
      noteContents: contents,
      noteDirty: dirty
    })
    savePrefs(collectPrefs(get()))
  },

  pinAssetReferenceForNote: (notePath, assetPath) => {
    if (!notePath || !assetPath) return
    set((s) => ({
      noteRefs: { ...s.noteRefs, [notePath]: { path: assetPath, kind: 'asset' } },
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
      const { moved, rest } = extractUncheckedTaskBlocks(body)
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
    const trimmed = todayBody.replace(/\s+$/u, '')
    const block = movedLines.join('\n')
    const nextBody = trimmed.length ? `${trimmed}\n${block}\n` : `${block}\n`
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
      return
    }
    const template = resolveTemplate(state.customTemplates, settings.weeklyNotes.templateId)
    if (template) {
      await get().createFromTemplate(template, { folder: 'inbox', subpath, title, date })
      return
    }
    await get().createAndOpen('inbox', subpath, { title })
  },

  openThisWeekWeeklyNote: async () => {
    await get().openWeeklyNoteForDate(new Date())
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

  setWordWrap: (on) => {
    set({ wordWrap: on })
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
  setFocusedPanel: (panel) => set({ focusedPanel: panel }),
  setSidebarCursorIndex: (idx) => set({ sidebarCursorIndex: idx }),
  setNoteListCursorIndex: (idx) => set({ noteListCursorIndex: idx }),
  setConnectionsCursorIndex: (idx) => set({ connectionsCursorIndex: idx }),
  setConnectionPreview: (preview) => set({ connectionPreview: preview }),
  setEditorViewRef: (view) => set({ editorViewRef: view }),
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
      return {
        paneLayout: ensured.layout,
        activePaneId: ensured.activePaneId,
        noteContents: contents,
        noteDirty: dirty,
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
        ...activeFieldsFrom(layout, newLeaf.id, nextContents, nextDirty)
      }
    })
  },

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

    const oldPrefix = `${folder}/${oldSubpath}/`
    const newPrefix = `${folder}/${newSubpath}/`
    const rewritePath = (p: string): string =>
      p.startsWith(oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : p

    const notes = get().notes.map((n) =>
      n.path.startsWith(oldPrefix) ? { ...n, path: rewritePath(n.path) } : n
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
    const prefix = `${folder}/${subpath}/`
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
        await refreshVaultIndexes()
        await prefetchInitialVisibleNotes(get())
        await restoreWorkspaceForVault(vault)
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
    window.zen.onVaultChange((ev) => {
      void get().applyChange(ev)
    })
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
    await refreshVaultIndexes()
    await restoreWorkspaceForVault(vault)
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
      await refreshVaultIndexes()
      await restoreWorkspaceForVault(vault)
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
        await refreshVaultIndexes()
        await restoreWorkspaceForVault(vaultToOpen)
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
        title: 'Connect to ZenNotes Server',
        description:
          'Enter the base URL for the ZenNotes server, for example `http://localhost:7878` or `https://notes.example.com`.',
        initialValue: currentRemote?.baseUrl ?? 'http://localhost:7878',
        placeholder: 'http://localhost:7878',
        okLabel: 'Next',
        suggestions: profileSuggestions,
        suggestionsHint:
          profileSuggestions.length > 0
            ? 'Saved remote workspaces are suggested here.'
            : undefined,
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
      const matchingBaseProfile =
        get().remoteWorkspaceProfiles.find(
          (profile) => normalizeServerBaseUrl(profile.baseUrl) === normalizedBaseUrl
        ) ?? null

      const authToken = await promptApp({
        title: 'Server Auth Token',
        description:
          matchingBaseProfile?.hasCredential
            ? 'If this server needs a different token than the one already stored for the saved remote, enter it here. Otherwise leave this blank.'
            : 'If your ZenNotes server requires a bearer token, enter it here. Otherwise leave this blank.',
        placeholder: 'Optional',
        okLabel: 'Connect',
        allowEmptySubmit: true
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
      await refreshVaultIndexes()
      await restoreWorkspaceForVault(vault)
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
      await refreshVaultIndexes()
      await restoreWorkspaceForVault(vault)
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
      await refreshVaultIndexes()
      await restoreWorkspaceForVault(selectedVault)
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
      await refreshVaultIndexes()
      await restoreWorkspaceForVault(vault)
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
    const dirtyPaths = Object.entries(get().noteDirty)
      .filter(([, isDirty]) => isDirty)
      .map(([path]) => path)
    await Promise.all(dirtyPaths.map(async (path) => get().persistNote(path)))
  }
  }
})
