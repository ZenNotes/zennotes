import type { EditorView } from '@codemirror/view'
import { getCM } from '@replit/codemirror-vim'
import type { NoteFolder, NoteMeta } from '@shared/ipc'

// ---------------------------------------------------------------------------
// Panel types & navigation
// ---------------------------------------------------------------------------

export type Panel =
  | 'sidebar'
  | 'notelist'
  | 'tabs'
  | 'editor'
  | 'connections'
  | 'hoverpreview'
  | 'tasks'
  | 'tags'

export function getVisiblePanels(
  sidebarOpen: boolean,
  noteListOpen: boolean,
  unifiedSidebar: boolean,
  connectionsOpen: boolean,
  tasksViewOpen = false
): Panel[] {
  const panels: Panel[] = []
  if (sidebarOpen) panels.push('sidebar')
  if (noteListOpen && !unifiedSidebar) panels.push('notelist')
  panels.push(tasksViewOpen ? 'tasks' : 'editor')
  if (connectionsOpen) panels.push('connections')
  return panels
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
  return view.hasFocus
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
