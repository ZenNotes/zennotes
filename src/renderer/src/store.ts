import { create } from 'zustand'
import type { EditorView } from '@codemirror/view'
import type {
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

function rewriteOpenPaths(paths: string[], rewrite: (path: string) => string): string[] {
  const next: string[] = []
  for (const path of paths) {
    const mapped = rewrite(path)
    if (next[next.length - 1] === mapped) continue
    if (next.includes(mapped)) continue
    next.push(mapped)
  }
  return next
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
  | { kind: 'tag'; tag: string }

interface Store {
  vault: VaultInfo | null
  notes: NoteMeta[]
  folders: FolderEntry[]
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
  openTabs: string[]
  splitNotePath: string | null
  splitNote: NoteContent | null

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
  closeTab: (relPath: string) => Promise<void>
  openNoteInSplit: (relPath: string) => Promise<void>
  closeSplitNote: () => void
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
  /** Move a note to a different folder + subpath. */
  moveNote: (
    relPath: string,
    targetFolder: NoteFolder,
    targetSubpath: string
  ) => Promise<void>
  init: () => Promise<void>
  openVaultPicker: () => Promise<void>
}

export const useStore = create<Store>((set, get) => {
  const selectNoteImpl = async (
    relPath: string | null,
    historyMode: 'push' | 'preserve' = 'push'
  ): Promise<boolean> => {
    const state = get()
    if (!relPath) {
      set({
        selectedPath: null,
        activeNote: null,
        activeDirty: false,
        loadingNote: false,
        pendingJumpLocation: null
      })
      return true
    }
    if (state.selectedPath === relPath && state.activeNote && !state.loadingNote) {
      if (state.tabsEnabled && !state.openTabs.includes(relPath)) {
        set({ openTabs: [...state.openTabs, relPath] })
      }
      return true
    }

    const current = state.activeNote
    if (current && state.activeDirty && current.path !== relPath) {
      await get().persistActive()
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
      set({
        selectedPath: relPath,
        activeNote: content,
        activeDirty: false,
        loadingNote: false,
        openTabs: get().tabsEnabled
          ? get().openTabs.includes(relPath)
            ? get().openTabs
            : [...get().openTabs, relPath]
          : [relPath],
        ...(get().splitNotePath === relPath
          ? { splitNotePath: null, splitNote: null }
          : {}),
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

    const current = state.activeNote
    if (current && state.activeDirty) {
      await get().persistActive()
    }

    set({ loadingNote: true })
    while (source.length > 0) {
      const target = source.pop() ?? null
      if (!target || target.path === get().selectedPath) continue
      try {
        const content = await window.zen.readNote(target.path)
        const currentSnapshot = captureNoteJumpLocation(get())
        const opposite =
          direction === 'back' ? state.noteForwardstack : state.noteBackstack
        const nextOpposite = appendNoteJumpHistory(opposite, currentSnapshot)
        set({
          selectedPath: target.path,
          activeNote: content,
          activeDirty: false,
          loadingNote: false,
          pendingJumpLocation: target,
          noteBackstack: direction === 'back' ? source : nextOpposite,
          noteForwardstack: direction === 'back' ? nextOpposite : source
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
  openTabs: [],
  splitNotePath: null,
  splitNote: null,

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
      const [notes, folders] = await Promise.all([
        window.zen.listNotes(),
        window.zen.listFolders()
      ])
      set((s) => ({
        notes:
          s.noteSortOrder === 'none'
            ? mergeNotesPreservingOrder(s.notes, notes)
            : notes,
        folders: mergeFoldersPreservingOrder(s.folders, folders),
        openTabs: s.openTabs.filter((path) =>
          path === s.selectedPath || notes.some((note) => note.path === path)
        ),
        ...(s.splitNotePath &&
        !notes.some((note) => note.path === s.splitNotePath) &&
        s.splitNotePath !== s.selectedPath
          ? { splitNotePath: null, splitNote: null }
          : {})
      }))
    } catch (err) {
      console.error('refresh failed', err)
    }
  },

  applyChange: async (ev) => {
    await get().refreshNotes()
    const state = get()
    if (state.selectedPath && ev.path === state.selectedPath) {
      if (ev.kind === 'unlink') {
        set((s) => ({
          selectedPath: null,
          activeNote: null,
          activeDirty: false,
          openTabs: s.openTabs.filter((path) => path !== ev.path)
        }))
      } else if (ev.kind === 'change') {
        try {
          const content = await window.zen.readNote(state.selectedPath)
          // Only refresh the editor if the on-disk body diverged from ours.
          if (!state.activeNote || state.activeNote.body !== content.body) {
            set({ activeNote: content, activeDirty: false })
          }
        } catch {
          /* ignore */
        }
      }
    }
    const latest = get()
    if (latest.splitNotePath && ev.path === latest.splitNotePath) {
      if (ev.kind === 'unlink') {
        set({ splitNotePath: null, splitNote: null })
      } else if (ev.kind === 'change') {
        try {
          const content = await window.zen.readNote(latest.splitNotePath)
          set({ splitNote: content })
        } catch {
          /* ignore */
        }
      }
    }
  },

  updateActiveBody: (body) => {
    const active = get().activeNote
    if (!active) return
    if (active.body === body) return
    set({ activeNote: { ...active, body }, activeDirty: true })
  },

  persistActive: async () => {
    const active = get().activeNote
    if (!active || !get().activeDirty) return
    try {
      const meta = await window.zen.writeNote(active.path, active.body)
      set((s) => ({
        activeDirty: false,
        notes: s.notes.map((n) => (n.path === meta.path ? { ...n, ...meta } : n))
      }))

    } catch (err) {
      console.error('writeNote failed', err)
    }
  },

  formatActiveNote: async () => {
    const active = get().activeNote
    if (!active) return
    try {
      const formatted = await formatMarkdown(active.body)
      if (formatted === active.body) return
      set({ activeNote: { ...active, body: formatted }, activeDirty: true })
      await get().persistActive()
    } catch (err) {
      console.error('formatActiveNote failed', err)
    }
  },

  renameActive: async (nextTitle) => {
    const active = get().activeNote
    if (!active) return
    try {
      const oldPath = active.path
      const meta = await window.zen.renameNote(oldPath, nextTitle)
      set((s) => ({
        activeNote: { ...active, ...meta },
        selectedPath: meta.path,
        notes: replaceNoteMeta(s.notes, oldPath, meta),
        openTabs: rewriteOpenPaths(s.openTabs, (path) => (path === oldPath ? meta.path : path)),
        splitNotePath: s.splitNotePath === oldPath ? meta.path : s.splitNotePath,
        splitNote:
          s.splitNotePath === oldPath && s.splitNote ? { ...s.splitNote, ...meta } : s.splitNote,
        noteBackstack: rewriteNoteJumpHistory(s.noteBackstack, (path) =>
          path === oldPath ? meta.path : path
        ),
        noteForwardstack: rewriteNoteJumpHistory(s.noteForwardstack, (path) =>
          path === oldPath ? meta.path : path
        ),
        pendingJumpLocation:
          s.pendingJumpLocation?.path === oldPath
            ? { ...s.pendingJumpLocation, path: meta.path }
            : s.pendingJumpLocation
      }))
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
    if (state.activeNote && state.activeDirty) {
      await get().persistActive()
    }
    if (state.tabsEnabled && state.selectedPath) {
      const closingPath = state.selectedPath
      const remaining = state.openTabs.filter((path) => path !== closingPath)
      if (remaining.length > 0) {
        const closingIdx = state.openTabs.indexOf(closingPath)
        const fallbackIdx = Math.min(closingIdx, remaining.length - 1)
        const nextPath = remaining[Math.max(0, fallbackIdx)] ?? null
        set({ openTabs: remaining })
        if (nextPath) {
          await selectNoteImpl(nextPath, 'preserve')
          return
        }
      }
    }
    set({
      activeNote: null,
      activeDirty: false,
      selectedPath: null,
      openTabs: [],
      loadingNote: false,
      pendingJumpLocation: null
    })
  },

  trashActive: async () => {
    const active = get().activeNote
    if (!active) return
    try {
      await window.zen.moveToTrash(active.path)
      set((s) => ({
        activeNote: null,
        activeDirty: false,
        selectedPath: null,
        openTabs: s.openTabs.filter((path) => path !== active.path),
        splitNotePath: s.splitNotePath === active.path ? null : s.splitNotePath,
        splitNote: s.splitNotePath === active.path ? null : s.splitNote,
        pendingJumpLocation: null
      }))
      await get().refreshNotes()
    } catch (err) {
      console.error('moveToTrash failed', err)
    }
  },

  restoreActive: async () => {
    const active = get().activeNote
    if (!active) return
    const oldPath = active.path
    const meta = await window.zen.restoreFromTrash(active.path)
    await get().refreshNotes()
    set((s) => ({
      activeNote: { ...active, ...meta },
      selectedPath: meta.path,
      activeDirty: false,
      openTabs: rewriteOpenPaths(s.openTabs, (path) => (path === oldPath ? meta.path : path)),
      splitNotePath: s.splitNotePath === oldPath ? meta.path : s.splitNotePath,
      splitNote:
        s.splitNotePath === oldPath && s.splitNote ? { ...s.splitNote, ...meta } : s.splitNote,
      noteBackstack: rewriteNoteJumpHistory(s.noteBackstack, (path) =>
        path === oldPath ? meta.path : path
      ),
      noteForwardstack: rewriteNoteJumpHistory(s.noteForwardstack, (path) =>
        path === oldPath ? meta.path : path
      ),
      pendingJumpLocation:
        s.pendingJumpLocation?.path === oldPath
          ? { ...s.pendingJumpLocation, path: meta.path }
          : s.pendingJumpLocation
    }))
  },

  archiveActive: async () => {
    const active = get().activeNote
    if (!active) return
    await window.zen.archiveNote(active.path)
    set((s) => ({
      activeNote: null,
      activeDirty: false,
      selectedPath: null,
      openTabs: s.openTabs.filter((path) => path !== active.path),
      splitNotePath: s.splitNotePath === active.path ? null : s.splitNotePath,
      splitNote: s.splitNotePath === active.path ? null : s.splitNote,
      pendingJumpLocation: null
    }))
    await get().refreshNotes()
  },

  unarchiveActive: async () => {
    const active = get().activeNote
    if (!active) return
    const oldPath = active.path
    const meta = await window.zen.unarchiveNote(active.path)
    await get().refreshNotes()
    set((s) => ({
      activeNote: { ...active, ...meta },
      selectedPath: meta.path,
      activeDirty: false,
      openTabs: rewriteOpenPaths(s.openTabs, (path) => (path === oldPath ? meta.path : path)),
      splitNotePath: s.splitNotePath === oldPath ? meta.path : s.splitNotePath,
      splitNote:
        s.splitNotePath === oldPath && s.splitNote ? { ...s.splitNote, ...meta } : s.splitNote,
      noteBackstack: rewriteNoteJumpHistory(s.noteBackstack, (path) =>
        path === oldPath ? meta.path : path
      ),
      noteForwardstack: rewriteNoteJumpHistory(s.noteForwardstack, (path) =>
        path === oldPath ? meta.path : path
      ),
      pendingJumpLocation:
        s.pendingJumpLocation?.path === oldPath
          ? { ...s.pendingJumpLocation, path: meta.path }
          : s.pendingJumpLocation
    }))
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
    set((s) => ({
      tabsEnabled: on,
      openTabs: on
        ? s.selectedPath
          ? s.openTabs.includes(s.selectedPath)
            ? s.openTabs
            : [...s.openTabs, s.selectedPath]
          : s.openTabs
        : s.selectedPath
          ? [s.selectedPath]
          : [],
      splitNotePath: on ? s.splitNotePath : null,
      splitNote: on ? s.splitNote : null
    }))
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
  closeTab: async (relPath) => {
    if (get().selectedPath === relPath) {
      await get().closeActiveNote()
      return
    }
    set((s) => ({
      openTabs: s.openTabs.filter((path) => path !== relPath),
      splitNotePath: s.splitNotePath === relPath ? null : s.splitNotePath,
      splitNote: s.splitNotePath === relPath ? null : s.splitNote
    }))
  },
  openNoteInSplit: async (relPath) => {
    const state = get()
    if (!state.tabsEnabled || !relPath || relPath === state.selectedPath) return
    try {
      const content = await window.zen.readNote(relPath)
      set({ splitNotePath: relPath, splitNote: content })
    } catch (err) {
      console.error('openNoteInSplit failed', err)
    }
  },
  closeSplitNote: () => set({ splitNotePath: null, splitNote: null }),
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

    // Immediately rewrite paths in the store so the UI reflects the
    // new name without depending on filesystem race conditions.
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
    set((s) => ({
      notes,
      folders,
      openTabs: rewriteOpenPaths(s.openTabs, rewritePath),
      splitNotePath: s.splitNotePath ? rewritePath(s.splitNotePath) : null,
      splitNote:
        s.splitNotePath && s.splitNote
          ? { ...s.splitNote, path: rewritePath(s.splitNote.path) }
          : s.splitNote,
      noteBackstack: rewriteNoteJumpHistory(s.noteBackstack, rewritePath),
      noteForwardstack: rewriteNoteJumpHistory(s.noteForwardstack, rewritePath),
      pendingJumpLocation: s.pendingJumpLocation
        ? { ...s.pendingJumpLocation, path: rewritePath(s.pendingJumpLocation.path) }
        : null
    }))

    // Also refresh from disk to pick up any other changes
    await get().refreshNotes()

    // If the current view was inside the folder we just renamed,
    // rewrite its subpath so we stay on the same folder visually.
    const v = get().view
    if (v.kind === 'folder' && v.folder === folder) {
      if (v.subpath === oldSubpath) {
        set({ view: { ...v, subpath: newSubpath } })
      } else if (v.subpath.startsWith(`${oldSubpath}/`)) {
        const tail = v.subpath.slice(oldSubpath.length + 1)
        set({ view: { ...v, subpath: `${newSubpath}/${tail}` } })
      }
    }
    // Active note's path will have changed too — update it.
    const active = get().activeNote
    if (active && active.path.startsWith(oldPrefix)) {
      const newPath = rewritePath(active.path)
      set({ activeNote: { ...active, path: newPath }, selectedPath: newPath })
    }
  },

  deleteFolder: async (folder, subpath) => {
    await window.zen.deleteFolder(folder, subpath)
    await get().refreshNotes()
    // If the current view lived inside the deleted folder, bounce
    // back to the top-level.
    const v = get().view
    if (
      v.kind === 'folder' &&
      v.folder === folder &&
      (v.subpath === subpath || v.subpath.startsWith(`${subpath}/`))
    ) {
      set({ view: { kind: 'folder', folder, subpath: '' } })
    }
    // Drop the active note if it was inside that folder.
    const active = get().activeNote
    if (active && active.path.startsWith(`${folder}/${subpath}/`)) {
      set({
        activeNote: null,
        activeDirty: false,
        selectedPath: null,
        openTabs: get().openTabs.filter((path) => !path.startsWith(`${folder}/${subpath}/`)),
        splitNotePath:
          get().splitNotePath?.startsWith(`${folder}/${subpath}/`) ? null : get().splitNotePath,
        splitNote:
          get().splitNotePath?.startsWith(`${folder}/${subpath}/`) ? null : get().splitNote,
        pendingJumpLocation: null
      })
    }
  },

  duplicateFolder: async (folder, subpath) => {
    const newSubpath = await window.zen.duplicateFolder(folder, subpath)
    await get().refreshNotes()
    set({ view: { kind: 'folder', folder, subpath: newSubpath } })
  },

  revealFolder: async (folder, subpath) => {
    await window.zen.revealFolder(folder, subpath)
  },

  moveNote: async (relPath, targetFolder, targetSubpath) => {
    try {
      const meta = await window.zen.moveNote(relPath, targetFolder, targetSubpath)
      await get().refreshNotes()
      const active = get().activeNote
      set((s) => ({
        ...(s.selectedPath === relPath
          ? {
              activeNote: active ? { ...active, ...meta } : active,
              selectedPath: meta.path,
              activeDirty: false
            }
          : {}),
        openTabs: rewriteOpenPaths(s.openTabs, (path) => (path === relPath ? meta.path : path)),
        splitNotePath: s.splitNotePath === relPath ? meta.path : s.splitNotePath,
        splitNote:
          s.splitNotePath === relPath && s.splitNote ? { ...s.splitNote, ...meta } : s.splitNote,
        noteBackstack: rewriteNoteJumpHistory(s.noteBackstack, (path) =>
          path === relPath ? meta.path : path
        ),
        noteForwardstack: rewriteNoteJumpHistory(s.noteForwardstack, (path) =>
          path === relPath ? meta.path : path
        ),
        pendingJumpLocation:
          s.pendingJumpLocation?.path === relPath
            ? { ...s.pendingJumpLocation, path: meta.path }
            : s.pendingJumpLocation
      }))
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
      set({
        vault,
        view: { kind: 'folder', folder: 'inbox', subpath: '' },
        selectedPath: null,
        activeNote: null,
        activeDirty: false,
        openTabs: [],
        splitNotePath: null,
        splitNote: null,
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
