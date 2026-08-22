import type { EditorView } from '@codemirror/view'
import { getCM } from '@replit/codemirror-vim'
import type { NoteFolder, NoteMeta } from '@shared/ipc'
import { isWorkspaceVirtualTabPath } from './workspace-tabs'

/**
 * True when a Vim-hint (`<leader>h`) target opens a note the editor should land
 * on — a sidebar note/asset row (`data-sidebar-path`) or a note tab
 * (`data-tab-path` that isn't a virtual tab). Folders, the Tasks/Tags tabs, and
 * plain buttons return false, so they keep their own focus. (#100)
 */
export function hintTargetOpensNote(element: HTMLElement | null | undefined): boolean {
  if (!element) return false
  const sidebarPath = element.closest('[data-sidebar-path]')?.getAttribute('data-sidebar-path')
  if (sidebarPath && !isWorkspaceVirtualTabPath(sidebarPath)) return true
  const tabPath = element.closest('[data-tab-path]')?.getAttribute('data-tab-path')
  return !!tabPath && !isWorkspaceVirtualTabPath(tabPath)
}

/**
 * True when a keydown inside the home view (`data-home-nav`) should yield to the
 * home view's own roving-focus handler instead of VimNav's global bindings.
 *
 * The home view owns ↑/↓/j/k/Enter, but it does NOT handle the leader key — so
 * the leader (and any in-progress leader sequence) must fall through to VimNav,
 * otherwise Space-as-leader is silently swallowed while the home view is focused
 * (no note open). (#273)
 */
export function shouldYieldToHomeNav(
  target: HTMLElement | null | undefined,
  isLeaderKey: boolean,
  leaderPending: boolean
): boolean {
  if (!target?.closest('[data-home-nav]')) return false
  // Keep leader input flowing through to VimNav's leader handling.
  if (isLeaderKey || leaderPending) return false
  return true
}

// ---------------------------------------------------------------------------
// Panel types & navigation
// ---------------------------------------------------------------------------

export type Panel =
  | 'sidebar'
  | 'notelist'
  | 'tabs'
  | 'editor'
  | 'connections'
  | 'comments'
  | 'outline'
  | 'calendar'
  | 'hoverpreview'
  | 'tasks'
  | 'tags'
  | 'atlas'

export interface PanelVisibility {
  sidebarOpen: boolean
  noteListOpen: boolean
  unifiedSidebar: boolean
  connectionsOpen: boolean
  commentsOpen: boolean
  outlineOpen: boolean
  calendarOpen: boolean
  tasksViewOpen: boolean
  atlasViewOpen?: boolean
}

/** Every panel on screen, ordered left to right — the focus order both pane
 *  navigations walk. The editor-pane side panels follow the order EditorPane
 *  renders them in: connections, comments, outline, calendar. (#285, #477) */
export function getVisiblePanels(visibility: PanelVisibility): Panel[] {
  const panels: Panel[] = []
  if (visibility.sidebarOpen) panels.push('sidebar')
  if (visibility.noteListOpen && !visibility.unifiedSidebar) panels.push('notelist')
  panels.push(visibility.tasksViewOpen ? 'tasks' : visibility.atlasViewOpen ? 'atlas' : 'editor')
  if (visibility.connectionsOpen) panels.push('connections')
  if (visibility.commentsOpen) panels.push('comments')
  if (visibility.outlineOpen) panels.push('outline')
  if (visibility.calendarOpen) panels.push('calendar')
  return panels
}

/** DOM marker each editor-pane side panel renders, used to tell whether it is
 *  currently on screen. They live inside the active EditorPane rather than in
 *  app-level state, so the live DOM is the only honest source. */
const PANEL_MARKERS = {
  connections: '[data-connections-panel]',
  comments: '[data-comments-panel]',
  outline: '[data-outline-panel]',
  calendar: '[data-calendar-panel]'
} as const

/**
 * The visible panel list as it stands right now: app-level columns from the
 * store, editor-pane side panels from the DOM. Both entry points into pane
 * navigation — vim's `<C-w>hjkl` and the always-on `Alt+hjkl` — resolve their
 * target through this, so the two can never drift apart the way they had by
 * 2.18 (Alt+hjkl stopped at Connections and neither reached the Outline). (#477)
 */
export function getVisiblePanelsNow(state: {
  sidebarOpen: boolean
  noteListOpen: boolean
  unifiedSidebar: boolean
  tasksViewOpen: boolean
  atlasViewOpen?: boolean
}): Panel[] {
  const onScreen = (selector: string): boolean =>
    typeof document !== 'undefined' && document.querySelector(selector) !== null
  return getVisiblePanels({
    sidebarOpen: state.sidebarOpen,
    noteListOpen: state.noteListOpen,
    unifiedSidebar: state.unifiedSidebar,
    tasksViewOpen: state.tasksViewOpen,
    atlasViewOpen: state.atlasViewOpen,
    connectionsOpen: onScreen(PANEL_MARKERS.connections),
    commentsOpen: onScreen(PANEL_MARKERS.comments),
    outlineOpen: onScreen(PANEL_MARKERS.outline),
    calendarOpen: onScreen(PANEL_MARKERS.calendar)
  })
}

/** Move left (h/k) or right (l/j) through the visible panel list. */
export function resolveNextPanel(
  current: Panel | null,
  direction: 'left' | 'right',
  visiblePanels: Panel[]
): Panel | null {
  if (visiblePanels.length === 0) return null
  if (!current || !visiblePanels.includes(current)) return visiblePanels[0]
  const idx = visiblePanels.indexOf(current)
  if (direction === 'left') {
    return idx > 0 ? visiblePanels[idx - 1] : visiblePanels[idx]
  }
  return idx < visiblePanels.length - 1 ? visiblePanels[idx + 1] : visiblePanels[idx]
}

// ---------------------------------------------------------------------------
// Vim mode detection
// ---------------------------------------------------------------------------

export function isEditorInsertMode(view: EditorView | null, vimMode: boolean): boolean {
  if (!view || !vimMode) return false
  const cm = getCM(view)
  return cm?.state.vim?.insertMode === true
}

/**
 * True when codemirror-vim is in visual (or visual-line/block) mode — there is
 * a Vim selection standing, waiting for something to be done to it.
 *
 * Used to decide who owns Ctrl+I: with a selection live, italic is what the
 * chord is for, while the jumplist would throw the selection away. (#488)
 */
export function isEditorVisualMode(view: EditorView | null, vimMode: boolean): boolean {
  if (!view || !vimMode) return false
  const cm = getCM(view)
  return cm?.state.vim?.visualMode === true
}

/**
 * Whether Vim's jumplist keeps a chord, or hands it to the inline-format
 * shortcuts.
 *
 * The two collide only where `Mod` is Ctrl (Linux and Windows): there, Vim's
 * forward-jump `Ctrl+I` is also the italic shortcut. Normal mode gives the
 * jumplist the chord (#373). Visual mode gives it to italic: a selection is
 * standing, every other format chord already applies to it, and jumping to
 * another note would throw it away (#488). Insert mode, and Vim off, always
 * mean format.
 *
 * `chordIsFormatShortcut` is what keeps this from costing macOS anything —
 * there `Ctrl+I` is not the italic shortcut (`Cmd+I` is), so nothing collides
 * and the jumplist keeps working in every mode.
 */
export function jumplistKeepsChord(opts: {
  vimMode: boolean
  insertMode: boolean
  visualMode: boolean
  chordIsFormatShortcut: boolean
}): boolean {
  if (!opts.vimMode || opts.insertMode) return false
  if (opts.visualMode && opts.chordIsFormatShortcut) return false
  return true
}

/**
 * True when codemirror-vim is mid-command, waiting for a character or motion
 * argument — e.g. after `f`/`t`/`F`/`T`/`r`, an operator like `d`/`c`, or a
 * pending count. In that state the next key (including Space) belongs to the Vim
 * sequence, not the global leader, so the leader must stand down. (#147)
 */
export function isVimAwaitingArgument(view: EditorView | null): boolean {
  if (!view) return false
  const vim = getCM(view)?.state?.vim as
    | { expectLiteralNext?: boolean; inputState?: { keyBuffer?: unknown[] } }
    | undefined
  if (!vim) return false
  if (vim.expectLiteralNext) return true
  return (vim.inputState?.keyBuffer?.length ?? 0) > 0
}

export function clearEditorPendingVimStatus(view: EditorView | null): void {
  if (!view) return
  const cm = getCM(view)
  const vim = cm?.state?.vim
  if (!vim) return
  vim.status = ''
  cm.state.vimPlugin?.blockCursor?.scheduleRedraw?.()
  cm.state.vimPlugin?.updateStatus?.()
}

export function isEditorFocused(view: EditorView | null): boolean {
  if (!view) return false
  const active = document.activeElement
  return view.hasFocus || (active instanceof Node && view.dom.contains(active))
}

// ---------------------------------------------------------------------------
// Sidebar flat item list
// ---------------------------------------------------------------------------

export type SidebarItem =
  | { type: 'folder'; folder: NoteFolder; subpath: string; key: string; hasChildren: boolean }
  | { type: 'note'; path: string }
  | { type: 'tag'; tag: string }
  | { type: 'help' }
  | { type: 'settings' }
  | { type: 'trash' }

interface TreeNode {
  name: string
  subpath: string
  notes: NoteMeta[]
  children: TreeNode[]
}

function walkTree(
  node: TreeNode,
  folder: NoteFolder,
  collapsed: Set<string>,
  showNotes: boolean,
  depth: number,
  sortComparator: (a: NoteMeta, b: NoteMeta) => number,
  out: SidebarItem[]
): void {
  for (const child of node.children) {
    const key = `${folder}:${child.subpath}`
    const hasChildren = child.children.length > 0 || (showNotes && child.notes.length > 0)
    out.push({ type: 'folder', folder, subpath: child.subpath, key, hasChildren })
    if (!collapsed.has(key)) {
      walkTree(child, folder, collapsed, showNotes, depth + 1, sortComparator, out)
      if (showNotes) {
        const sorted = child.notes.slice().sort(sortComparator)
        for (const n of sorted) out.push({ type: 'note', path: n.path })
      }
    }
  }
}

export function flattenSidebarItems(
  inboxTree: TreeNode | null,
  archiveTree: TreeNode | null,
  collapsed: Set<string>,
  tags: [string, number][],
  showNotes: boolean,
  sortComparator: (a: NoteMeta, b: NoteMeta) => number
): SidebarItem[] {
  const items: SidebarItem[] = []

  // Inbox root
  if (inboxTree) {
    const inboxKey = 'inbox:'
    const hasChildren = inboxTree.children.length > 0 || (showNotes && inboxTree.notes.length > 0)
    items.push({ type: 'folder', folder: 'inbox', subpath: '', key: inboxKey, hasChildren })
    if (!collapsed.has(inboxKey)) {
      walkTree(inboxTree, 'inbox', collapsed, showNotes, 1, sortComparator, items)
      if (showNotes) {
        const sorted = inboxTree.notes.slice().sort(sortComparator)
        for (const n of sorted) items.push({ type: 'note', path: n.path })
      }
    }
  }

  // Archive root
  if (archiveTree) {
    const archiveKey = 'archive:'
    const hasChildren = archiveTree.children.length > 0 || (showNotes && archiveTree.notes.length > 0)
    items.push({ type: 'folder', folder: 'archive', subpath: '', key: archiveKey, hasChildren })
    if (!collapsed.has(archiveKey)) {
      walkTree(archiveTree, 'archive', collapsed, showNotes, 1, sortComparator, items)
      if (showNotes) {
        const sorted = archiveTree.notes.slice().sort(sortComparator)
        for (const n of sorted) items.push({ type: 'note', path: n.path })
      }
    }
  }

  items.push({ type: 'trash' })

  // Tags
  for (const [tag] of tags) {
    items.push({ type: 'tag', tag })
  }

  // Footer
  items.push({ type: 'help' })
  items.push({ type: 'settings' })

  return items
}

// ---------------------------------------------------------------------------
// Hint label generation
// ---------------------------------------------------------------------------

const HOME_ROW = 'asdfghjkl'
const ALL_KEYS = HOME_ROW + 'qwertyuiopzxcvbnm'

export function generateHintLabels(count: number): string[] {
  const labels: string[] = []
  if (count <= ALL_KEYS.length) {
    // Single-char labels
    for (let i = 0; i < count && i < ALL_KEYS.length; i++) {
      labels.push(ALL_KEYS[i])
    }
  } else {
    // Two-char labels
    for (let i = 0; i < ALL_KEYS.length && labels.length < count; i++) {
      for (let j = 0; j < ALL_KEYS.length && labels.length < count; j++) {
        labels.push(ALL_KEYS[i] + ALL_KEYS[j])
      }
    }
  }
  return labels
}
