import { create } from 'zustand'
import type { EditorView } from '@codemirror/view'
import { DEFAULT_VAULT_SETTINGS } from '@shared/ipc'
import type {
  AssetMeta,
  FolderEntry,
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
import { TASKS_TAB_PATH, isTasksTabPath } from '@shared/tasks'
import { TAGS_TAB_PATH, isTagsTabPath } from '@shared/tags'
import { HELP_TAB_PATH, isHelpTabPath } from '@shared/help'
import { ARCHIVE_TAB_PATH, isArchiveTabPath } from '@shared/archive'
import { TRASH_TAB_PATH, isTrashTabPath } from '@shared/trash'
import { QUICK_NOTES_TAB_PATH, isQuickNotesTabPath } from '@shared/quick-notes'
import { toggleTaskAtIndex } from '@shared/tasklists'
import { DEFAULT_THEME_ID, THEMES, type ThemeFamily, type ThemeMode } from './lib/themes'
import { formatMarkdown } from './lib/format-markdown'
import { confirmMoveToTrash } from './lib/confirm-trash'
import { pickServerDirectoryApp } from './components/ServerDirectoryPickerHost'
import { promptApp } from './components/PromptHost'
import type { KeymapId, KeymapOverrides } from './lib/keymaps'
import { normalizeKeymapOverrides } from './lib/keymaps'
import {
  type SystemFolderLabels,
  normalizeSystemFolderLabels
} from './lib/system-folder-labels'
import { recordRendererPerf } from './lib/perf'
import {
  normalizeDailyNotesDirectory,
  normalizeVaultSettings,
  noteFolderSubpath,
  noteTitleForDate
} from './lib/vault-layout'
import type { Panel } from './lib/vim-nav'
import {
  allLeaves,
  findLeaf,
  findLeavesContaining,
  leafWithAddedTab,
  leafWithPinnedTab,
  leafWithReorderedTab,
  leafWithUnpinnedTab,
  leafWithoutTab,
  makeLeaf,
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
  | 'updated-desc'
  | 'updated-asc'
  | 'created-desc'
  | 'created-asc'
  | 'name-asc'
  | 'name-desc'

export type LineNumberMode = 'off' | 'absolute' | 'relative'
export type WhichKeyHintMode = 'timed' | 'sticky'

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
  'tokyo-night'
]
const VALID_MODES: ThemeMode[] = ['light', 'dark', 'auto']
const VALID_SORTS: NoteSortOrder[] = [
  'none',
  'updated-desc',
  'updated-asc',
  'created-desc',
  'created-asc',
  'name-asc',
  'name-desc'
]
const VALID_LINE_NUMBER_MODES: LineNumberMode[] = ['off', 'absolute', 'relative']
const VALID_WHICH_KEY_HINT_MODES: WhichKeyHintMode[] = ['timed', 'sticky']
const VALID_VAULT_TEXT_SEARCH_BACKENDS: VaultTextSearchBackendPreference[] = [
  'auto',
  'builtin',
  'ripgrep',
  'fzf'
]
const MAX_NOTE_JUMP_HISTORY = 100

interface Prefs {
  vimMode: boolean
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
  tabsEnabled: boolean
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  editorFontSize: number    // px — affects editor + preview
  editorLineHeight: number  // unitless multiplier
  previewMaxWidth: number   // px — max reading width for preview surfaces
  lineNumberMode: LineNumberMode
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
  /** Keys of collapsed folders in the sidebar tree. */
  collapsedFolders: string[]
  /** Pinned reference pane — an always-visible companion note panel
   *  for research / drafting. Stored at the prefs layer so pins
   *  survive app restarts. */
  pinnedRefPath: string | null
  pinnedRefVisible: boolean
  pinnedRefWidth: number
  pinnedRefMode: 'edit' | 'preview'
  /** When true, "New Quick Note" auto-titles to today's date
   *  (YYYY-MM-DD), appending " (2)", " (3)" etc. for collisions. */
  quickNoteDateTitle: boolean
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
}
const DEFAULT_PREFS: Prefs = {
  vimMode: true,
  keymapOverrides: {},
  whichKeyHints: true,
  whichKeyHintMode: 'timed',
  whichKeyHintTimeoutMs: 900,
  vaultTextSearchBackend: 'auto',
  ripgrepBinaryPath: null,
  fzfBinaryPath: null,
  livePreview: true,
  tabsEnabled: true,
  themeId: DEFAULT_THEME_ID,
  themeFamily: 'gruvbox',
  themeMode: 'dark',
  editorFontSize: 16,
  editorLineHeight: 1.7,
  previewMaxWidth: 920,
  lineNumberMode: 'off',
  // Leave all font slots on the built-in "Default" path. That lets the
  // shipped CSS fallbacks choose sensible system fonts on each machine
  // instead of forcing a specific family that may not exist.
  interfaceFont: null,
  textFont: null,
  monoFont: null,
  systemFolderLabels: {},
  sidebarWidth: 260,
  noteListWidth: 300,
  noteSortOrder: 'none',
  groupByKind: true,
  autoReveal: false,
  unifiedSidebar: true,
  darkSidebar: true,
  collapsedFolders: [],
  pinnedRefPath: null,
  pinnedRefVisible: true,
  pinnedRefWidth: 420,
  pinnedRefMode: 'edit',
  quickNoteDateTitle: false,
  wordWrap: true,
  previewSmoothScroll: true,
  editorMaxWidth: 920,
  pdfEmbedInEditMode: 'compact',
  pinnedRefKind: 'note',
  noteRefs: {},
  contentAlign: 'center',
  tagsCollapsed: false
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
    tabsEnabled:
      typeof p.tabsEnabled === 'boolean' ? p.tabsEnabled : DEFAULT_PREFS.tabsEnabled,
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
        ? Math.min(520, Math.max(160, p.sidebarWidth))
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
    pinnedRefMode:
      p.pinnedRefMode === 'edit' || p.pinnedRefMode === 'preview'
        ? p.pinnedRefMode
        : DEFAULT_PREFS.pinnedRefMode,
    quickNoteDateTitle:
      typeof p.quickNoteDateTitle === 'boolean'
        ? p.quickNoteDateTitle
        : DEFAULT_PREFS.quickNoteDateTitle,
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
      typeof p.tagsCollapsed === 'boolean' ? p.tagsCollapsed : DEFAULT_PREFS.tagsCollapsed
  }
}
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) return normalizePrefs(JSON.parse(raw) as Partial<Prefs>)
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

export interface NoteJumpLocation {
  path: string
  editorSelectionAnchor: number
  editorSelectionHead: number
  editorScrollTop: number
  previewScrollTop: number
  editorScrollMode?: 'preserve' | 'center' | 'start'
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

function captureNoteJumpLocation(state: {
  selectedPath: string | null
  editorViewRef: EditorView | null
}): NoteJumpLocation | null {
  if (!state.selectedPath) return null
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
  // tag-character or end-of-string, keeping the leading separator.
  const pattern = new RegExp(`(^|\\s)#${escaped}(?=[^\\w\\-/]|$)`, 'gm')

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
  keymapOverrides: KeymapOverrides
  whichKeyHints: boolean
  whichKeyHintMode: WhichKeyHintMode
  whichKeyHintTimeoutMs: number
  vaultTextSearchBackend: VaultTextSearchBackendPreference
  ripgrepBinaryPath: string | null
  fzfBinaryPath: string | null
  livePreview: boolean
  tabsEnabled: boolean
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  editorFontSize: number
  editorLineHeight: number
  previewMaxWidth: number
  lineNumberMode: LineNumberMode
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
  collapsedFolders: string[]
  pinnedRefPath: string | null
  pinnedRefVisible: boolean
  pinnedRefWidth: number
  pinnedRefMode: 'edit' | 'preview'
  quickNoteDateTitle: boolean
  wordWrap: boolean
  previewSmoothScroll: boolean
  editorMaxWidth: number
  pdfEmbedInEditMode: 'compact' | 'full'
  pinnedRefKind: 'note' | 'asset'
  noteRefs: Record<string, { path: string; kind: 'note' | 'asset' }>
  contentAlign: 'center' | 'left'
  tagsCollapsed: boolean
}): Prefs {
  return {
    vimMode: s.vimMode,
    keymapOverrides: s.keymapOverrides,
    whichKeyHints: s.whichKeyHints,
    whichKeyHintMode: s.whichKeyHintMode,
    whichKeyHintTimeoutMs: s.whichKeyHintTimeoutMs,
    vaultTextSearchBackend: s.vaultTextSearchBackend,
    ripgrepBinaryPath: s.ripgrepBinaryPath,
    fzfBinaryPath: s.fzfBinaryPath,
    livePreview: s.livePreview,
    tabsEnabled: s.tabsEnabled,
    themeId: s.themeId,
    themeFamily: s.themeFamily,
    themeMode: s.themeMode,
    editorFontSize: s.editorFontSize,
    editorLineHeight: s.editorLineHeight,
    previewMaxWidth: s.previewMaxWidth,
    lineNumberMode: s.lineNumberMode,
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
    collapsedFolders: s.collapsedFolders,
    pinnedRefPath: s.pinnedRefPath,
    pinnedRefVisible: s.pinnedRefVisible,
    pinnedRefWidth: s.pinnedRefWidth,
    pinnedRefMode: s.pinnedRefMode,
    quickNoteDateTitle: s.quickNoteDateTitle,
    wordWrap: s.wordWrap,
    previewSmoothScroll: s.previewSmoothScroll,
    editorMaxWidth: s.editorMaxWidth,
    pdfEmbedInEditMode: s.pdfEmbedInEditMode,
    pinnedRefKind: s.pinnedRefKind,
    noteRefs: s.noteRefs,
    contentAlign: s.contentAlign,
    tagsCollapsed: s.tagsCollapsed
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

function isWorkspaceVirtualTabPath(path: string): boolean {
  return (
    isQuickNotesTabPath(path) ||
    isTasksTabPath(path) ||
    isTagsTabPath(path) ||
    isHelpTabPath(path) ||
    isArchiveTabPath(path) ||
    isTrashTabPath(path)
  )
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
  workspaceSetupError: string | null
  vaultSettings: VaultSettings
  notes: NoteMeta[]
  folders: FolderEntry[]
  assetFiles: AssetMeta[]
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
  bufferPaletteOpen: boolean
  outlinePaletteOpen: boolean
  query: string
  initialized: boolean
  workspaceRestored: boolean
  sidebarOpen: boolean
  noteListOpen: boolean
  zenMode: boolean
  zenRestoreState: ZenRestoreState | null
  vimMode: boolean
  keymapOverrides: KeymapOverrides
  whichKeyHints: boolean
  whichKeyHintMode: WhichKeyHintMode
  whichKeyHintTimeoutMs: number
  vaultTextSearchBackend: VaultTextSearchBackendPreference
  ripgrepBinaryPath: string | null
  fzfBinaryPath: string | null
  livePreview: boolean
  tabsEnabled: boolean
  settingsOpen: boolean
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  editorFontSize: number
  editorLineHeight: number
  previewMaxWidth: number
  lineNumberMode: LineNumberMode
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
  /** Sidebar tree collapsed-folder keys. Kept in the store so the
   *  state survives Sidebar unmount/mount (e.g. toggling the sidebar). */
  collapsedFolders: string[]

  /** Pinned reference pane — an always-visible side panel that shows a
   *  single companion note while the user works in the main editor. */
  pinnedRefPath: string | null
  pinnedRefVisible: boolean
  pinnedRefWidth: number
  pinnedRefMode: 'edit' | 'preview'

  /** Auto-title new Quick Notes to today's date instead of the
   *  default "Quick Note <ts>" pattern. */
  quickNoteDateTitle: boolean

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

  /** Vault-wide Tasks view state. Populated lazily when the view is opened
   *  and kept incrementally fresh via the chokidar watcher while the view
   *  is visible. */
  vaultTasks: VaultTask[]
  tasksLoading: boolean
  tasksFilter: string
  taskCursorIndex: number

  /** Tags currently selected in the Tags view. The view shows every non-
   *  trash note carrying *any* of these (union), so toggling more tags
   *  widens the result set. Cleared when the Tags tab closes. */
  selectedTags: string[]

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

  setVault: (v: VaultInfo | null) => void
  setVaultSettings: (next: VaultSettings) => Promise<void>
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
  /** Open the built-in Trash tab in the active pane. */
  openTrashView: () => Promise<void>
  /** Add or remove a tag from the Tags view selection without touching
   *  pane layout. No-op if the selection is already in that state. */
  toggleTagSelection: (tag: string) => void
  /** Replace the Tags view selection wholesale (used by `:tag a b c`). */
  setSelectedTags: (tags: string[]) => void
  /** Force a full vault rescan for tasks. */
  refreshTasks: () => Promise<void>
  /** Rescan a single note's tasks and splice the result into `vaultTasks`. */
  rescanTasksForPath: (relPath: string) => Promise<void>
  /** Open the note containing `task` and place the cursor on that line. */
  openTaskAt: (task: VaultTask) => Promise<void>
  /** Flip a task's checkbox. Reuses `toggleTaskAtIndex` so the file round-
   *  trips exactly — works whether or not the note is currently open. */
  toggleTaskFromList: (task: VaultTask) => Promise<void>
  setTasksFilter: (q: string) => void
  setTaskCursorIndex: (idx: number) => void
  selectNote: (relPath: string | null) => Promise<void>
  openNoteAtOffset: (
    relPath: string,
    offset: number,
    options?: { scrollMode?: 'center' | 'start' }
  ) => Promise<void>
  jumpToPreviousNote: () => Promise<void>
  jumpToNextNote: () => Promise<void>
  applyChange: (ev: VaultChangeEvent) => Promise<void>
  refreshNotes: () => Promise<void>
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
  closeActiveNote: () => Promise<void>
  trashActive: () => Promise<void>
  restoreActive: () => Promise<void>
  archiveActive: () => Promise<void>
  unarchiveActive: () => Promise<void>
  setSearchOpen: (open: boolean) => void
  setVaultTextSearchOpen: (open: boolean) => void
  setCommandPaletteOpen: (open: boolean) => void
  setBufferPaletteOpen: (open: boolean) => void
  setOutlinePaletteOpen: (open: boolean) => void
  setQuery: (q: string) => void
  toggleSidebar: () => void
  toggleNoteList: () => void
  setFocusMode: (focus: boolean) => void
  setVimMode: (on: boolean) => void
  setKeymapBinding: (id: KeymapId, binding: string | null) => void
  resetAllKeymaps: () => void
  setWhichKeyHints: (on: boolean) => void
  setWhichKeyHintMode: (mode: WhichKeyHintMode) => void
  setWhichKeyHintTimeoutMs: (ms: number) => void
  setVaultTextSearchBackend: (backend: VaultTextSearchBackendPreference) => void
  setRipgrepBinaryPath: (path: string | null) => void
  setFzfBinaryPath: (path: string | null) => void
  setLivePreview: (on: boolean) => void
  setTabsEnabled: (on: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setTheme: (next: { id: string; family: ThemeFamily; mode: ThemeMode }) => void
  setEditorFontSize: (px: number) => void
  setEditorLineHeight: (mult: number) => void
  setPreviewMaxWidth: (px: number) => void
  setLineNumberMode: (mode: LineNumberMode) => void
  setInterfaceFont: (family: string | null) => void
  setTextFont: (family: string | null) => void
  setMonoFont: (family: string | null) => void
  setSystemFolderLabel: (folder: NoteFolder, label: string | null) => void
  setSidebarWidth: (px: number) => void
  setNoteListWidth: (px: number) => void
  setNoteSortOrder: (order: NoteSortOrder) => void
  setGroupByKind: (on: boolean) => void
  setAutoReveal: (on: boolean) => void
  setUnifiedSidebar: (on: boolean) => void
  setDarkSidebar: (on: boolean) => void
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
  setPinnedRefMode: (mode: 'edit' | 'preview') => void

  setQuickNoteDateTitle: (on: boolean) => void
  openTodayDailyNote: () => Promise<void>
  setWordWrap: (on: boolean) => void
  setPreviewSmoothScroll: (on: boolean) => void
  setEditorMaxWidth: (px: number) => void
  setPdfEmbedInEditMode: (mode: 'compact' | 'full') => void
  setContentAlign: (align: 'center' | 'left') => void
  setTagsCollapsed: (collapsed: boolean) => void
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
  toggleTabPin: (paneId: string, path: string) => void
  /** Update an open note's body (typed into any pane). Flags dirty. */
  updateNoteBody: (path: string, body: string) => void
  /** Persist a specific note to disk. */
  persistNote: (path: string) => Promise<void>

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
  connectRemoteWorkspace: () => Promise<void>
  connectRemoteWorkspaceProfile: (id: string) => Promise<void>
  changeRemoteWorkspaceVaultPath: () => Promise<void>
  disconnectRemoteWorkspace: () => Promise<void>
  saveRemoteWorkspaceProfile: (input: RemoteWorkspaceProfileInput) => Promise<RemoteWorkspaceProfile>
  deleteRemoteWorkspaceProfile: (id: string) => Promise<void>
  refreshRemoteWorkspaceProfiles: () => Promise<RemoteWorkspaceProfile[]>
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
    ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
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

export const useStore = create<Store>((set, get) => {
  const selectNoteImpl = async (
    relPath: string | null,
    historyMode: 'push' | 'preserve' = 'push'
  ): Promise<boolean> => {
    const startedAt = performance.now()
    const state = get()
    const activeLeaf = findLeaf(state.paneLayout, state.activePaneId)
    if (!activeLeaf) return false

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

    if (
      activeLeaf.activeTab === relPath &&
      state.noteContents[relPath] &&
      !state.loadingNote
    ) {
      if (!activeLeaf.tabs.includes(relPath)) {
        const layout =
          updateLeaf(state.paneLayout, activeLeaf.id, (l) => leafWithAddedTab(l, relPath)) ??
          state.paneLayout
        set({
          paneLayout: layout,
          ...activeFieldsFrom(layout, state.activePaneId, state.noteContents, state.noteDirty)
        })
      }
      recordRendererPerf('note.open.cached', performance.now() - startedAt, {
        path: relPath
      })
      return true
    }

    if (state.noteContents[relPath]) {
      const nextLayout =
        updateLeaf(state.paneLayout, activeLeaf.id, (l) => leafWithAddedTab(l, relPath)) ??
        state.paneLayout
      set({
        paneLayout: nextLayout,
        noteBackstack: historyMode === 'push' &&
          state.selectedPath !== null &&
          state.selectedPath !== relPath
          ? appendNoteJumpHistory(state.noteBackstack, captureNoteJumpLocation(state))
          : state.noteBackstack,
        noteForwardstack:
          historyMode === 'push' &&
          state.selectedPath !== null &&
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
    if (state.selectedPath && state.selectedPath !== relPath && state.noteDirty[state.selectedPath]) {
      await get().persistNote(state.selectedPath)
    }

    const latest = get()
    const shouldPushHistory =
      historyMode === 'push' &&
      latest.selectedPath !== null &&
      latest.selectedPath !== relPath
    const nextBackstack = shouldPushHistory
      ? appendNoteJumpHistory(latest.noteBackstack, captureNoteJumpLocation(latest))
      : latest.noteBackstack
    const nextForwardstack = shouldPushHistory ? [] : latest.noteForwardstack

    set({ loadingNote: true })
    try {
      const content = await window.zen.readNote(relPath)
      const s = get()
      const leafNow = findLeaf(s.paneLayout, s.activePaneId)
      if (!leafNow) {
        set({ loadingNote: false })
        return false
      }
      const nextLayout =
        updateLeaf(s.paneLayout, leafNow.id, (l) => leafWithAddedTab(l, relPath)) ??
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
      if (!target || target.path === get().selectedPath) continue
      try {
        const content = await window.zen.readNote(target.path)
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

  const restoreWorkspaceForVault = async (vault: VaultInfo): Promise<void> => {
    const rawSnapshot = loadWorkspaceSnapshot(vault.root)
    if (!rawSnapshot || typeof rawSnapshot !== 'object') {
      set({ workspaceRestored: true })
      return
    }

    const snapshot = rawSnapshot as Partial<WorkspaceSnapshot>
    const existingPaths = new Set(get().notes.map((note) => note.path))
    let layout = sanitizeWorkspaceLayout(snapshot.paneLayout, existingPaths)
    const unreadable = new Set<string>()
    const contents: Record<string, NoteContent> = {}
    const dirty: Record<string, boolean> = {}
    const pathsToLoad = Array.from(
      new Set(
        allLeaves(layout)
          .flatMap((leaf) => leaf.tabs)
          .filter((path) => existingPaths.has(path))
      )
    )

    await Promise.all(
      pathsToLoad.map(async (path) => {
        try {
          contents[path] = await window.zen.readNote(path)
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
      workspaceRestored: true,
      ...active
    })
  }

  return {
  vault: null,
  workspaceMode: 'local',
  remoteWorkspaceInfo: null,
  remoteWorkspaceProfiles: [],
  workspaceSetupError: null,
  vaultSettings: DEFAULT_VAULT_SETTINGS,
  notes: [],
  folders: [],
  assetFiles: [],
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
  bufferPaletteOpen: false,
  outlinePaletteOpen: false,
  query: '',
  initialized: false,
  workspaceRestored: false,
  sidebarOpen: true,
  noteListOpen: true,
  zenMode: false,
  zenRestoreState: null,
  vimMode: loadPrefs().vimMode,
  keymapOverrides: loadPrefs().keymapOverrides,
  whichKeyHints: loadPrefs().whichKeyHints,
  whichKeyHintMode: loadPrefs().whichKeyHintMode,
  whichKeyHintTimeoutMs: loadPrefs().whichKeyHintTimeoutMs,
  vaultTextSearchBackend: loadPrefs().vaultTextSearchBackend,
  ripgrepBinaryPath: loadPrefs().ripgrepBinaryPath,
  fzfBinaryPath: loadPrefs().fzfBinaryPath,
  livePreview: loadPrefs().livePreview,
  tabsEnabled: loadPrefs().tabsEnabled,
  settingsOpen: false,
  themeId: loadPrefs().themeId,
  themeFamily: loadPrefs().themeFamily,
  themeMode: loadPrefs().themeMode,
  editorFontSize: loadPrefs().editorFontSize,
  editorLineHeight: loadPrefs().editorLineHeight,
  previewMaxWidth: loadPrefs().previewMaxWidth,
  lineNumberMode: loadPrefs().lineNumberMode,
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
  collapsedFolders: loadPrefs().collapsedFolders,
  pinnedRefPath: loadPrefs().pinnedRefPath,
  pinnedRefVisible: loadPrefs().pinnedRefVisible,
  pinnedRefWidth: loadPrefs().pinnedRefWidth,
  pinnedRefMode: loadPrefs().pinnedRefMode,
  quickNoteDateTitle: loadPrefs().quickNoteDateTitle,
  wordWrap: loadPrefs().wordWrap,
  previewSmoothScroll: loadPrefs().previewSmoothScroll,
  editorMaxWidth: loadPrefs().editorMaxWidth,
  pdfEmbedInEditMode: loadPrefs().pdfEmbedInEditMode,
  pinnedRefKind: loadPrefs().pinnedRefKind,
  noteRefs: loadPrefs().noteRefs,
  contentAlign: loadPrefs().contentAlign,
  tagsCollapsed: loadPrefs().tagsCollapsed,
  vaultTasks: [],
  tasksLoading: false,
  tasksFilter: '',
  taskCursorIndex: 0,
  selectedTags: [],
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

  setVault: (v) => set({ vault: v }),
  setVaultSettings: async (next) => {
    try {
      const settings = normalizeVaultSettings(await window.zen.setVaultSettings(next))
      set({
        vaultSettings: settings,
        view: { kind: 'folder', folder: 'inbox', subpath: '' }
      })
      await get().refreshNotes()
    } catch (err) {
      console.error('setVaultSettings failed', err)
    }
  },
  setNotes: (notes) => set({ notes }),
  setView: (view) =>
    set({
      view,
      selectedPath: null,
      activeNote: null,
      activeDirty: false,
      pendingJumpLocation: null
    }),

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
    let offset = 0
    for (let i = 0; i < task.lineNumber && i < lines.length; i++) {
      offset += lines[i].length + 1
    }
    // Nudge cursor past indentation + list marker so it lands on the content.
    const lineText = lines[task.lineNumber] ?? ''
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
        previewScrollTop: 0
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

  setTasksFilter: (q) => set({ tasksFilter: q, taskCursorIndex: 0 }),
  setTaskCursorIndex: (idx) => set({ taskCursorIndex: Math.max(0, idx) }),

  selectNote: async (relPath) => {
    await selectNoteImpl(relPath, 'push')
  },

  openNoteAtOffset: async (relPath, offset, options) => {
    const state = get()
    const anchor = Math.max(0, offset)
    await get().openNoteInPane(state.activePaneId, relPath)
    set({
      pendingJumpLocation: {
        path: relPath,
        editorSelectionAnchor: anchor,
        editorSelectionHead: anchor,
        editorScrollTop: 0,
        previewScrollTop: 0,
        editorScrollMode: options?.scrollMode ?? 'center'
      },
      focusedPanel: 'editor'
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
      const [notes, folders, assetFiles, hasAssetsDir] = await Promise.all([
        window.zen.listNotes(),
        window.zen.listFolders(),
        window.zen.listAssets(),
        window.zen.hasAssetsDir()
      ])
      set((s) => {
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
        return {
          notes:
            s.noteSortOrder === 'none'
              ? mergeNotesPreservingOrder(s.notes, notes)
              : notes,
          folders: mergeFoldersPreservingOrder(s.folders, folders),
          assetFiles,
          hasAssetsDir,
          paneLayout: ensured.layout,
          activePaneId: ensured.activePaneId,
          noteContents: contents,
          noteDirty: dirty,
          pinnedRefPath,
          ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
        }
      })
    } catch (err) {
      console.error('refresh failed', err)
    }
  },

  applyChange: async (ev) => {
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

    // Keep the Tasks view in sync as files change externally or via our own
    // writes — cheap per-path rescans instead of walking the whole vault.
    if (isTasksViewActive(state)) {
      if (ev.kind === 'unlink') {
        set((s) => ({
          vaultTasks: s.vaultTasks.filter((t) => t.sourcePath !== ev.path)
        }))
      } else {
        void get().rescanTasksForPath(ev.path)
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
      return {
        noteContents: contents,
        noteDirty: dirty,
        ...activeFieldsFrom(s.paneLayout, s.activePaneId, contents, dirty)
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
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
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
        const content = await window.zen.readNote(path)
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

  setPinnedRefMode: (mode) => {
    set({ pinnedRefMode: mode })
    savePrefs(collectPrefs(get()))
  },

  setQuickNoteDateTitle: (on) => {
    set({ quickNoteDateTitle: on })
    savePrefs(collectPrefs(get()))
  },

  openTodayDailyNote: async () => {
    const state = get()
    const settings = normalizeVaultSettings(state.vaultSettings)
    if (!settings.dailyNotes.enabled) return
    const title = noteTitleForDate()
    const subpath = normalizeDailyNotesDirectory(settings.dailyNotes.directory)
    const existing = state.notes.find(
      (note) =>
        note.folder === 'inbox' &&
        note.title === title &&
        noteFolderSubpath(note, settings) === subpath
    )
    if (existing) {
      set({ view: { kind: 'folder', folder: 'inbox', subpath } })
      await get().selectNote(existing.path)
      return
    }
    await get().createAndOpen('inbox', subpath, { title })
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

    const needContent = !s.noteContents[path]
    if (needContent) {
      set({ loadingNote: paneId === s.activePaneId })
      try {
        const content = await window.zen.readNote(path)
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
        const content = await window.zen.readNote(path)
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
        const content = await window.zen.readNote(path)
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
        const content = await window.zen.readNote(path)
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
        ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
      }
    })

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
        ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
      }
    })
  },

  duplicateFolder: async (folder, subpath) => {
    const newSubpath = await window.zen.duplicateFolder(folder, subpath)
    await get().refreshNotes()
    set({ view: { kind: 'folder', folder, subpath: newSubpath } })
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

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })
    try {
      const remoteWorkspaceProfilesPromise = get().refreshRemoteWorkspaceProfiles()
      const remoteWorkspaceInfo = await get().refreshWorkspaceContext()
      const serverCapabilities = await window.zen.getServerCapabilities().catch(() => null)
      if (!(await ensureWebServerSession(serverCapabilities))) {
        await remoteWorkspaceProfilesPromise
        set({
          workspaceMode: workspaceModeFrom(remoteWorkspaceInfo),
          remoteWorkspaceInfo,
          workspaceSetupError: null,
          workspaceRestored: true,
          vaultSettings: DEFAULT_VAULT_SETTINGS
        })
        return
      }
      const vault = await window.zen.getCurrentVault()
      await remoteWorkspaceProfilesPromise
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
        await get().refreshNotes()
        await restoreWorkspaceForVault(vault)
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
        const content = await window.zen.readNote(pinnedPath)
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
    await get().refreshNotes()
    await restoreWorkspaceForVault(vault)
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
      await get().refreshNotes()
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
      await get().refreshNotes()
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
      await get().refreshNotes()
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
      await get().refreshNotes()
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
