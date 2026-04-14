import { create } from 'zustand'
import type { EditorView } from '@codemirror/view'
import type {
  AssetMeta,
  FolderEntry,
  NoteContent,
  NoteFolder,
  NoteMeta,
  VaultChangeEvent,
  VaultInfo
} from '@shared/ipc'
import { DEFAULT_THEME_ID, THEMES, type ThemeFamily, type ThemeMode } from './lib/themes'
import { formatMarkdown } from './lib/format-markdown'
import type { Panel } from './lib/vim-nav'
import {
  allLeaves,
  findLeaf,
  findLeavesContaining,
  leafWithAddedTab,
  leafWithReorderedTab,
  leafWithoutTab,
  makeLeaf,
  replaceLeaf,
  rewritePathsInTree,
  splitLeaf,
  updateLeaf,
  updateSplitSizes,
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

const PREFS_KEY = 'zen:prefs:v2'
const VALID_FAMILIES: ThemeFamily[] = ['apple', 'gruvbox', 'catppuccin', 'github']
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
const MAX_NOTE_JUMP_HISTORY = 100

interface Prefs {
  vimMode: boolean
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
}
const DEFAULT_PREFS: Prefs = {
  vimMode: true,
  livePreview: true,
  tabsEnabled: false,
  themeId: DEFAULT_THEME_ID,
  themeFamily: 'apple',
  themeMode: 'auto',
  editorFontSize: 16,
  editorLineHeight: 1.7,
  previewMaxWidth: 920,
  lineNumberMode: 'off',
  interfaceFont: null,
  textFont: null,
  monoFont: null,
  sidebarWidth: 232,
  noteListWidth: 300,
  noteSortOrder: 'none',
  groupByKind: false,
  autoReveal: true,
  unifiedSidebar: true,
  darkSidebar: true,
  collapsedFolders: []
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
        : DEFAULT_PREFS.collapsedFolders
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
    previewScrollTop: getVisiblePreviewScrollElement()?.scrollTop ?? 0
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
  sidebarWidth: number
  noteListWidth: number
  noteSortOrder: NoteSortOrder
  groupByKind: boolean
  autoReveal: boolean
  unifiedSidebar: boolean
  darkSidebar: boolean
  collapsedFolders: string[]
}): Prefs {
  return {
    vimMode: s.vimMode,
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
    sidebarWidth: s.sidebarWidth,
    noteListWidth: s.noteListWidth,
    noteSortOrder: s.noteSortOrder,
    groupByKind: s.groupByKind,
    autoReveal: s.autoReveal,
    unifiedSidebar: s.unifiedSidebar,
    darkSidebar: s.darkSidebar,
    collapsedFolders: s.collapsedFolders
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
  | { kind: 'tag'; tag: string }

interface Store {
  vault: VaultInfo | null
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
  query: string
  initialized: boolean
  sidebarOpen: boolean
  noteListOpen: boolean
  vimMode: boolean
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
  setNotes: (notes: NoteMeta[]) => void
  setView: (view: View) => void
  selectNote: (relPath: string | null) => Promise<void>
  jumpToPreviousNote: () => Promise<void>
  jumpToNextNote: () => Promise<void>
  applyChange: (ev: VaultChangeEvent) => Promise<void>
  refreshNotes: () => Promise<void>
  updateActiveBody: (body: string) => void
  persistActive: () => Promise<void>
  formatActiveNote: () => Promise<void>
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
  setQuery: (q: string) => void
  toggleSidebar: () => void
  toggleNoteList: () => void
  setFocusMode: (focus: boolean) => void
  setVimMode: (on: boolean) => void
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
  setSidebarWidth: (px: number) => void
  setNoteListWidth: (px: number) => void
  setNoteSortOrder: (order: NoteSortOrder) => void
  setGroupByKind: (on: boolean) => void
  setAutoReveal: (on: boolean) => void
  setUnifiedSidebar: (on: boolean) => void
  setDarkSidebar: (on: boolean) => void
  toggleCollapseFolder: (key: string) => void
  setCollapsedFolders: (keys: string[]) => void
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
}

/** Debounced per-path save timers. Module-scoped so they survive re-renders. */
const pathSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const PATH_SAVE_DEBOUNCE_MS = 350

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
      return true
    } catch (err) {
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

  return {
  vault: null,
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
  query: '',
  initialized: false,
  sidebarOpen: true,
  noteListOpen: true,
  vimMode: loadPrefs().vimMode,
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
  sidebarWidth: loadPrefs().sidebarWidth,
  noteListWidth: loadPrefs().noteListWidth,
  noteSortOrder: loadPrefs().noteSortOrder,
  groupByKind: loadPrefs().groupByKind,
  autoReveal: loadPrefs().autoReveal,
  unifiedSidebar: loadPrefs().unifiedSidebar,
  darkSidebar: loadPrefs().darkSidebar,
  collapsedFolders: loadPrefs().collapsedFolders,
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
  setNotes: (notes) => set({ notes }),
  setView: (view) =>
    set({
      view,
      selectedPath: null,
      activeNote: null,
      activeDirty: false,
      pendingJumpLocation: null
    }),

  selectNote: async (relPath) => {
    await selectNoteImpl(relPath, 'push')
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
        const existingPaths = new Set(notes.map((n) => n.path))
        // Drop tabs whose notes no longer exist — except keep the currently
        // focused selectedPath so the editor doesn't blank out mid-save.
        const keep = (path: string): boolean =>
          existingPaths.has(path) || path === s.selectedPath
        const nextLayout = rewritePathsInTree(s.paneLayout, (path) =>
          keep(path) ? path : null
        )
        const ensured = ensureActivePane(nextLayout, s.activePaneId)
        // Prune content caches for paths no longer referenced anywhere.
        const referenced = new Set<string>()
        for (const leaf of allLeaves(nextLayout)) {
          for (const tab of leaf.tabs) referenced.add(tab)
        }
        const contents: Record<string, NoteContent> = {}
        const dirty: Record<string, boolean> = {}
        for (const [path, content] of Object.entries(s.noteContents)) {
          if (referenced.has(path)) contents[path] = content
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
          ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
        }
      })
    } catch (err) {
      console.error('refresh failed', err)
    }
  },

  applyChange: async (ev) => {
    await get().refreshNotes()
    const state = get()
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
          ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
        }
      })
      return
    }

    if (ev.kind === 'change') {
      try {
        const content = await window.zen.readNote(ev.path)
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
      const meta = await window.zen.writeNote(path, content.body)
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

  renameActive: async (nextTitle) => {
    const s0 = get()
    const oldPath = s0.selectedPath
    const active = oldPath ? s0.noteContents[oldPath] : null
    if (!oldPath || !active) return
    try {
      const meta = await window.zen.renameNote(oldPath, nextTitle)
      set((s) => {
        const rewrite = (p: string): string => (p === oldPath ? meta.path : p)
        const nextLayout = rewritePathsInTree(s.paneLayout, rewrite)
        const ensured = ensureActivePane(nextLayout, s.activePaneId)
        const contents = { ...s.noteContents }
        const dirty = { ...s.noteDirty }
        if (oldPath !== meta.path) {
          delete contents[oldPath]
          delete dirty[oldPath]
        }
        contents[meta.path] = { ...active, ...meta }
        dirty[meta.path] = s.noteDirty[oldPath] ?? false
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
          ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
        }
      })
      await get().refreshNotes()
    } catch (err) {
      console.error('renameNote failed', err)
    }
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
    const path = get().selectedPath
    if (!path) return
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
        ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
      }
    })
  },

  setSearchOpen: (open) => set({ searchOpen: open, query: open ? get().query : '' }),
  setQuery: (q) => set({ query: q }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleNoteList: () => set((s) => ({ noteListOpen: !s.noteListOpen })),
  setFocusMode: (focus) =>
    set({ sidebarOpen: !focus, noteListOpen: !focus }),
  setVimMode: (on) => {
    set({ vimMode: on })
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
      // (if any). All other tabs + splits vanish.
      const activePath = s.selectedPath
      const onlyLeaf: PaneLeaf = {
        kind: 'leaf',
        id: s.activePaneId,
        tabs: activePath ? [activePath] : [],
        activeTab: activePath
      }
      const contents: Record<string, NoteContent> = {}
      const dirty: Record<string, boolean> = {}
      if (activePath && s.noteContents[activePath]) {
        contents[activePath] = s.noteContents[activePath]
        dirty[activePath] = s.noteDirty[activePath] ?? false
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
    // may still reference the note via its content cache — we only
    // evict content when NO pane has it open anymore.
    if (get().noteDirty[path]) {
      await get().persistNote(path)
    }
    set((s) => {
      const nextLayout =
        updateLeaf(s.paneLayout, paneId, (l) => leafWithoutTab(l, path)) ?? makeLeaf()
      const ensured = ensureActivePane(nextLayout, s.activePaneId)
      // Is this path still held by some other pane?
      const stillOpen = allLeaves(nextLayout).some((l) => l.tabs.includes(path))
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
    if (!contents[path]) {
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
      // Evict content if source pane dropped it and no one else has it.
      const stillOpen = allLeaves(layout).some((l) => l.tabs.includes(path))
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
    // Make sure content is loaded.
    const s0 = get()
    let contents = s0.noteContents
    let dirty = s0.noteDirty
    if (!contents[path]) {
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
      // Evict content if no pane has it anymore.
      const stillOpen = allLeaves(layout).some((l) => l.tabs.includes(path))
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
          ...activeFieldsFrom(ensured.layout, ensured.activePaneId, contents, dirty)
        }
      })
    } catch (err) {
      console.error('moveNote failed', err)
    }
  },

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })
    try {
      const vault = await window.zen.getCurrentVault()
      if (vault) {
        set({ vault })
        await get().refreshNotes()
      }
    } catch (err) {
      console.error('init failed', err)
    }
    // Default focus to the sidebar so j/k navigation works immediately
    if (get().sidebarOpen && !get().focusedPanel) {
      set({ focusedPanel: 'sidebar' })
    }
    window.zen.onVaultChange((ev) => {
      void get().applyChange(ev)
    })
  },

  openVaultPicker: async () => {
    const vault = await window.zen.pickVault()
    if (vault) {
      const fresh = makeLeaf()
      set({
        vault,
        hasAssetsDir: false,
        assetFiles: [],
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
        pendingJumpLocation: null
      })
      await get().refreshNotes()
    }
  }
  }
})
