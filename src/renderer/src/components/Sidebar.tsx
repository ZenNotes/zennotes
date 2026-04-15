import { useEffect, useMemo, useRef, useState } from 'react'
import { isHelpViewActive, isTagsViewActive, isTasksViewActive, useStore } from '../store'
import { extractTags } from '../lib/tags'
import type { FolderEntry, NoteFolder, NoteMeta } from '@shared/ipc'
import type { NoteSortOrder } from '../store'
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  CheckSquareIcon,
  DocumentIcon,
  ExpandAllIcon,
  FolderPlusIcon,
  InboxIcon,
  NotePlusIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SortIcon,
  TargetIcon,
  TrashIcon,
  ZapIcon
} from './icons'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ResizeHandle } from './ResizeHandle'
import { VaultBadge } from './VaultBadge'
import { usePrompt } from './PromptModal'
import { resolveQuickNoteTitle } from '../lib/quick-note-title'
import {
  hasZenItem,
  readDragPayload,
  setDragPayload,
  type DragPayload
} from '../lib/dnd'

function escapeForAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

export function Sidebar(): JSX.Element {
  const vault = useStore((s) => s.vault)
  const notes = useStore((s) => s.notes)
  const allFolders = useStore((s) => s.folders)
  const hasAssetsDir = useStore((s) => s.hasAssetsDir)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const sidebarCursorIndex = useStore((s) => s.sidebarCursorIndex)
  const activeNote = useStore((s) => s.activeNote)
  const view = useStore((s) => s.view)
  const assetFiles = useStore((s) => s.assetFiles)
  const setView = useStore((s) => s.setView)
  const openTasksView = useStore((s) => s.openTasksView)
  const tasksViewActive = useStore(isTasksViewActive)
  const openHelpView = useStore((s) => s.openHelpView)
  const helpViewActive = useStore(isHelpViewActive)
  const openTagView = useStore((s) => s.openTagView)
  const selectedTags = useStore((s) => s.selectedTags)
  const tagsViewActive = useStore(isTagsViewActive)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const createAndOpen = useStore((s) => s.createAndOpen)
  const quickNoteDateTitle = useStore((s) => s.quickNoteDateTitle)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const renameTag = useStore((s) => s.renameTag)
  const deleteTag = useStore((s) => s.deleteTag)
  const tagsCollapsed = useStore((s) => s.tagsCollapsed)
  const setTagsCollapsed = useStore((s) => s.setTagsCollapsed)
  const createFolderAction = useStore((s) => s.createFolder)
  const renameFolderAction = useStore((s) => s.renameFolder)
  const deleteFolderAction = useStore((s) => s.deleteFolder)
  const duplicateFolderAction = useStore((s) => s.duplicateFolder)
  const revealFolderAction = useStore((s) => s.revealFolder)
  const revealAssetsDir = useStore((s) => s.revealAssetsDir)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const noteSortOrder = useStore((s) => s.noteSortOrder)
  const setNoteSortOrder = useStore((s) => s.setNoteSortOrder)
  const groupByKind = useStore((s) => s.groupByKind)
  const setGroupByKind = useStore((s) => s.setGroupByKind)
  const autoReveal = useStore((s) => s.autoReveal)
  const setAutoReveal = useStore((s) => s.setAutoReveal)
  const unifiedSidebar = useStore((s) => s.unifiedSidebar)
  const selectNote = useStore((s) => s.selectNote)
  const selectedPath = useStore((s) => s.selectedPath)
  const tabsEnabled = useStore((s) => s.tabsEnabled)
  const openNoteInTab = useStore((s) => s.openNoteInTab)
  const moveNoteAction = useStore((s) => s.moveNote)
  const renameActive = useStore((s) => s.renameActive)
  const { prompt, modal: promptModal } = usePrompt()

  /**
   * Handle a drag-drop onto a folder (top-level or subfolder). Both
   * notes and folders can be dropped — notes become members of the
   * target folder, folders get reparented.
   */
  const handleDropOnFolder = async (
    payload: DragPayload,
    targetFolder: NoteFolder,
    targetSubpath: string
  ): Promise<void> => {
    if (payload.kind === 'note') {
      // Skip if dropping back into the same container.
      const curParts = payload.path.split('/')
      const curSub = curParts.slice(1, -1).join('/')
      const curFolder = curParts[0] as NoteFolder
      if (curFolder === targetFolder && curSub === targetSubpath) return
      await moveNoteAction(payload.path, targetFolder, targetSubpath)
      return
    }
    // Folder drop — cross-top-folder moves aren't supported (folders
    // can't move between inbox/archive/trash). Same-top-folder moves
    // reparent the subfolder.
    if (payload.folder !== targetFolder) {
      window.alert('Folders can only be moved within the same top-level folder.')
      return
    }
    if (!payload.subpath) return // top-level folder can't be moved
    const leaf = payload.subpath.split('/').slice(-1)[0]
    const nextSubpath = targetSubpath ? `${targetSubpath}/${leaf}` : leaf
    if (nextSubpath === payload.subpath) return
    if ((nextSubpath + '/').startsWith(payload.subpath + '/')) {
      // Moving into self / descendant.
      return
    }
    try {
      await renameFolderAction(payload.folder, payload.subpath, nextSubpath)
    } catch (err) {
      window.alert((err as Error).message)
    }
  }

  const [tagMenu, setTagMenu] = useState<{
    x: number
    y: number
    tag: string
  } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{
    x: number
    y: number
    folder: NoteFolder
    subpath: string // "" for top-level
  } | null>(null)
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null)
  const [noteMenu, setNoteMenu] = useState<{
    x: number
    y: number
    path: string
  } | null>(null)
  const refreshNotes = useStore((s) => s.refreshNotes)
  const collapsedList = useStore((s) => s.collapsedFolders)
  const toggleCollapseAction = useStore((s) => s.toggleCollapseFolder)
  const setCollapsedFoldersAction = useStore((s) => s.setCollapsedFolders)
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList])
  const toggleCollapse = toggleCollapseAction
  const setCollapsed = (next: Set<string>): void =>
    setCollapsedFoldersAction([...next])

  // Build a folder tree per top-level (quick + inbox + archive). Uses
  // the folders index from main so empty subfolders still appear in
  // the tree alongside ones that have notes. Trash is rendered
  // separately.
  const trees = useMemo(
    () => ({
      quick: buildTree(
        notes.filter((n) => n.folder === 'quick'),
        'quick',
        allFolders.filter((f) => f.folder === 'quick')
      ),
      inbox: buildTree(
        notes.filter((n) => n.folder === 'inbox'),
        'inbox',
        allFolders.filter((f) => f.folder === 'inbox')
      ),
      archive: buildTree(
        notes.filter((n) => n.folder === 'archive'),
        'archive',
        allFolders.filter((f) => f.folder === 'archive')
      ),
      trash: buildTree(
        notes.filter((n) => n.folder === 'trash'),
        'trash',
        allFolders.filter((f) => f.folder === 'trash')
      )
    }),
    [notes, allFolders]
  )

  const treeSortComparator = useMemo<((a: NoteMeta, b: NoteMeta) => number) | null>(() => {
    switch (noteSortOrder) {
      case 'none':
        return null
      case 'updated-asc':
        return (a: NoteMeta, b: NoteMeta) => a.updatedAt - b.updatedAt
      case 'created-desc':
        return (a: NoteMeta, b: NoteMeta) => b.createdAt - a.createdAt
      case 'created-asc':
        return (a: NoteMeta, b: NoteMeta) => a.createdAt - b.createdAt
      case 'name-asc':
        return (a: NoteMeta, b: NoteMeta) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      case 'name-desc':
        return (a: NoteMeta, b: NoteMeta) =>
          b.title.localeCompare(a.title, undefined, { sensitivity: 'base' })
      case 'updated-desc':
      default:
        return (a: NoteMeta, b: NoteMeta) => b.updatedAt - a.updatedAt
    }
  }, [noteSortOrder])

  /** All folder keys currently present in the tree, for expand/collapse-all. */
  const allFolderKeys = useMemo(() => {
    const keys: string[] = []
    const walk = (folder: NoteFolder, node: TreeNode): void => {
      // Include the top-level root key too.
      for (const child of node.children) {
        keys.push(`${folder}:${child.subpath}`)
        walk(folder, child)
      }
    }
    keys.push('inbox:')
    walk('inbox', trees.inbox)
    keys.push('archive:')
    walk('archive', trees.archive)
    return keys
  }, [trees])

  const collapseAll = (): void => setCollapsed(new Set(allFolderKeys))
  const expandAll = (): void => setCollapsed(new Set())

  /**
   * Auto-reveal: whenever the active note changes, expand every
   * ancestor folder so the note is visible in the sidebar tree.
   * Only runs when the `autoReveal` preference is on.
   */
  const activePath = activeNote?.path
  useEffect(() => {
    if (!autoReveal || !activePath) return
    const parts = activePath.split('/')
    const folder = parts[0] as NoteFolder
    // Collect every ancestor key we need to make sure is expanded.
    const ancestors: string[] = [`${folder}:`]
    let acc = ''
    for (let i = 1; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i]
      ancestors.push(`${folder}:${acc}`)
    }
    const prev = new Set(useStore.getState().collapsedFolders)
    let changed = false
    for (const key of ancestors) {
      if (prev.has(key)) {
        prev.delete(key)
        changed = true
      }
    }
    if (changed) setCollapsedFoldersAction([...prev])
  }, [autoReveal, activePath, setCollapsedFoldersAction])

  // Aggregate hashtags across non-trash notes, with the active note
  // re-computed from its live body.
  const tags = useMemo(() => {
    const counter = new Map<string, number>()
    for (const n of notes) {
      if (n.folder === 'trash') continue
      const isActive = activeNote && activeNote.path === n.path
      const list = isActive ? extractTags(activeNote!.body) : n.tags
      for (const t of list) counter.set(t, (counter.get(t) ?? 0) + 1)
    }
    return [...counter.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [notes, activeNote])

  const folderMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!folderMenu) return []
    const { folder, subpath } = folderMenu
    const isTop = subpath === ''
    const label = isTop ? folder : subpath.split('/').slice(-1)[0]

    const items: ContextMenuItem[] = [
      {
        label: 'New note',
        onSelect: async () => {
          await createAndOpen(folder, subpath)
        }
      }
    ]
    // Quick Notes is a flat folder — no nested subfolders allowed.
    if (folder !== 'quick') {
      items.push({
        label: 'New folder',
        onSelect: async () => {
          const name = await prompt({
            title: `New folder inside "${label}"`,
            placeholder: 'Folder name',
            okLabel: 'Create',
            validate: (v) => {
              if (v.includes('/')) return 'Folder name cannot contain "/"'
              return null
            }
          })
          if (!name) return
          const clean = name.trim().replace(/^\/+|\/+$/g, '')
          if (!clean) return
          const nextSubpath = subpath ? `${subpath}/${clean}` : clean
          try {
            await createFolderAction(folder, nextSubpath)
          } catch (err) {
            window.alert((err as Error).message)
          }
        }
      })
    }

    if (!isTop) {
      items.push({ kind: 'separator' })
      items.push({
        label: 'Duplicate',
        onSelect: async () => {
          try {
            await duplicateFolderAction(folder, subpath)
          } catch (err) {
            window.alert((err as Error).message)
          }
        }
      })
    }

    items.push({ kind: 'separator' })
    items.push({
      label: 'Reveal in Finder',
      onSelect: async () => {
        await revealFolderAction(folder, subpath)
      }
    })
    items.push({
      label: 'Copy Path',
      onSelect: async () => {
        // Vault-relative POSIX path (e.g. `inbox/Work/Research`).
        const rel = subpath ? `${folder}/${subpath}` : folder
        window.zen.clipboardWriteText(rel)
      }
    })
    items.push({
      label: 'Copy Absolute Path',
      onSelect: async () => {
        // Native OS path using the platform separator — ready for Finder
        // / Explorer / terminal use.
        const root = vault?.root ?? ''
        const sep = root.includes('\\') ? '\\' : '/'
        const parts = [
          root.replace(/[\\/]+$/, ''),
          folder,
          ...subpath.split('/').filter(Boolean)
        ]
        window.zen.clipboardWriteText(parts.join(sep))
      }
    })

    if (!isTop) {
      items.push({ kind: 'separator' })
      items.push({
        label: 'Rename…',
        onSelect: async () => {
          const leaf = subpath.split('/').slice(-1)[0]
          const next = await prompt({
            title: 'Rename folder',
            initialValue: leaf,
            okLabel: 'Rename',
            validate: (v) => {
              if (v.includes('/')) return 'Use only a leaf name'
              return null
            }
          })
          if (!next) return
          const clean = next.trim().replace(/^\/+|\/+$/g, '')
          if (!clean || clean === leaf) return
          const parent = subpath.split('/').slice(0, -1).join('/')
          const nextSubpath = parent ? `${parent}/${clean}` : clean
          try {
            await renameFolderAction(folder, subpath, nextSubpath)
          } catch (err) {
            window.alert((err as Error).message)
          }
        }
      })
      items.push({
        label: 'Delete folder…',
        danger: true,
        onSelect: async () => {
          const ok = window.confirm(
            `Delete "${subpath}" and everything inside it? This cannot be undone.`
          )
          if (!ok) return
          try {
            await deleteFolderAction(folder, subpath)
          } catch (err) {
            window.alert((err as Error).message)
          }
        }
      })
    }

    return items
  }, [
    folderMenu,
    vault,
    createAndOpen,
    createFolderAction,
    renameFolderAction,
    deleteFolderAction,
    duplicateFolderAction,
    revealFolderAction,
    prompt
  ])

  const noteMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!noteMenu) return []
    const n = notes.find((note) => note.path === noteMenu.path)
    if (!n) return []
    const items: ContextMenuItem[] = [
      {
        label: 'Open',
        onSelect: async () => {
          await selectNote(n.path)
        }
      }
    ]
    if (tabsEnabled) {
      items.push({
        label: 'Open in New Tab',
        onSelect: async () => {
          await openNoteInTab(n.path)
        }
      })
    }
    if (n.folder !== 'trash') {
      items.push({
        label: 'Rename…',
        onSelect: async () => {
          const next = await prompt({
            title: 'Rename note',
            initialValue: n.title,
            okLabel: 'Rename',
            validate: (v) => {
              if (/[\\/]/.test(v)) return 'Title cannot contain / or \\'
              return null
            }
          })
          if (!next || next === n.title) return
          // If this note is currently open, use the live renameActive
          // so the editor state follows along. Otherwise rename via IPC.
          if (selectedPath === n.path) {
            await renameActive(next)
          } else {
            const meta = await window.zen.renameNote(n.path, next)
            useStore.setState((s) => ({
              notes: s.notes.map((note) => (note.path === n.path ? meta : note))
            }))
            await refreshNotes()
          }
        }
      })
      items.push({
        label: 'Duplicate',
        onSelect: async () => {
          const meta = await window.zen.duplicateNote(n.path)
          await refreshNotes()
          await selectNote(meta.path)
        }
      })
    }
    items.push({
      label: 'Copy as Wikilink',
      onSelect: async () => {
        window.zen.clipboardWriteText(`[[${n.title}]]`)
      }
    })
    items.push({
      label: 'Copy Path',
      onSelect: async () => {
        // Vault-relative POSIX path (what wikilinks and IPC use).
        window.zen.clipboardWriteText(n.path)
      }
    })
    items.push({
      label: 'Copy Absolute Path',
      onSelect: async () => {
        // Join with the platform separator so the result can be pasted
        // directly into Finder / Explorer / a terminal.
        const root = vault?.root ?? ''
        const sep = root.includes('\\') ? '\\' : '/'
        const segments = n.path.split('/').filter(Boolean)
        const abs = [root.replace(/[\\/]+$/, ''), ...segments].join(sep)
        window.zen.clipboardWriteText(abs)
      }
    })
    items.push({
      label: 'Open in Floating Window',
      onSelect: async () => {
        await window.zen.openNoteWindow(n.path)
      }
    })
    items.push({
      label: 'Reveal in Finder',
      onSelect: async () => {
        await window.zen.revealNote(n.path)
      }
    })
    items.push({ kind: 'separator' })
    if (n.folder === 'inbox' || n.folder === 'quick') {
      items.push({
        label: 'Archive',
        icon: <ArchiveIcon />,
        onSelect: async () => {
          await window.zen.archiveNote(n.path)
          await refreshNotes()
          if (selectedPath === n.path) await selectNote(null)
        }
      })
      items.push({
        label: 'Move to Trash',
        icon: <TrashIcon />,
        danger: true,
        onSelect: async () => {
          await window.zen.moveToTrash(n.path)
          await refreshNotes()
          if (selectedPath === n.path) await selectNote(null)
        }
      })
    } else if (n.folder === 'archive') {
      items.push({
        label: 'Move to Inbox',
        icon: <ArrowUpRightIcon />,
        onSelect: async () => {
          const meta = await window.zen.unarchiveNote(n.path)
          await refreshNotes()
          if (selectedPath === n.path) await selectNote(meta.path)
        }
      })
      items.push({
        label: 'Move to Trash',
        icon: <TrashIcon />,
        danger: true,
        onSelect: async () => {
          await window.zen.moveToTrash(n.path)
          await refreshNotes()
          if (selectedPath === n.path) await selectNote(null)
        }
      })
    } else {
      items.push({
        label: 'Restore',
        icon: <ArrowUpRightIcon />,
        onSelect: async () => {
          const meta = await window.zen.restoreFromTrash(n.path)
          await refreshNotes()
          if (selectedPath === n.path) await selectNote(meta.path)
        }
      })
      items.push({
        label: 'Delete Permanently',
        icon: <TrashIcon />,
        danger: true,
        onSelect: async () => {
          await window.zen.deleteNote(n.path)
          await refreshNotes()
          if (selectedPath === n.path) await selectNote(null)
        }
      })
    }
    return items
  }, [
    noteMenu,
    notes,
    selectNote,
    selectedPath,
    refreshNotes,
    prompt,
    renameActive,
    tabsEnabled,
    openNoteInTab
  ])

  const tagMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!tagMenu) return []
    const tag = tagMenu.tag
    return [
      {
        label: `Copy #${tag}`,
        onSelect: async () => {
          await navigator.clipboard.writeText(`#${tag}`)
        }
      },
      {
        label: 'Rename tag…',
        onSelect: async () => {
          const next = await prompt({
            title: `Rename #${tag}`,
            initialValue: tag,
            okLabel: 'Rename',
            validate: (v) => {
              const clean = v.replace(/^#/, '').trim()
              if (!/^[a-zA-Z][\w\-/]*$/.test(clean)) {
                return 'Tag must start with a letter and contain only letters, digits, -, _, or /'
              }
              return null
            }
          })
          if (!next) return
          const clean = next.replace(/^#/, '').trim()
          if (!clean || clean === tag) return
          await renameTag(tag, clean)
        }
      },
      { kind: 'separator' },
      {
        label: 'Delete tag from all notes',
        danger: true,
        onSelect: async () => {
          const ok = window.confirm(
            `Remove #${tag} from every note that contains it? The notes themselves are left intact.`
          )
          if (!ok) return
          await deleteTag(tag)
        }
      }
    ]
  }, [tagMenu, renameTag, deleteTag, prompt])

  // A folder only shows the strong "selected" accent highlight when
  // the view matches AND no specific note is selected. Once the user
  // opens a note, the note row owns the selection visual and the
  // parent folders drop back to a neutral state.
  const isFolderActive = (folder: NoteFolder, subpath: string): boolean =>
    !selectedPath &&
    view.kind === 'folder' &&
    view.folder === folder &&
    view.subpath === subpath

  const openFolderMenu = (
    e: React.MouseEvent,
    folder: NoteFolder,
    subpath: string
  ): void => {
    e.preventDefault()
    setFolderMenu({ x: e.clientX, y: e.clientY, folder, subpath })
  }

  const isSidebarFocused = focusedPanel === 'sidebar'
  // Mutable counter reset on each render — assigns sequential data-sidebar-idx to each item.
  const idxCounter = useRef<{ value: number }>({ value: 0 })
  idxCounter.current.value = 0
  const vimCursor = isSidebarFocused ? sidebarCursorIndex : -1
  // VimNav clamps cursor position via Math.min/Math.max on each
  // keystroke using the actual DOM element count — no extra clamping needed.

  useEffect(() => {
    if (!isSidebarFocused) return

    const findTarget = (): HTMLElement | null => {
      if (tagsViewActive && selectedTags.length > 0) {
        // When the Tags view is active, reveal the first currently-
        // selected tag's chip. The user can hop between them with j/k
        // from there once this scroll brings it into view.
        return document.querySelector(
          `[data-sidebar-type="tag"][data-sidebar-tag="${escapeForAttr(selectedTags[0])}"]`
        ) as HTMLElement | null
      }

      if (selectedPath && unifiedSidebar) {
        const noteEl = document.querySelector(
          `[data-sidebar-path="${escapeForAttr(selectedPath)}"]`
        ) as HTMLElement | null
        if (noteEl) return noteEl

        const parts = selectedPath.split('/')
        const folder = parts[0] as NoteFolder
        const segments = parts.slice(1, -1)
        for (let i = segments.length; i >= 0; i--) {
          const subpath = segments.slice(0, i).join('/')
          const folderEl = document.querySelector(
            `[data-sidebar-type="folder"][data-sidebar-folder="${folder}"][data-sidebar-subpath="${escapeForAttr(subpath)}"]`
          ) as HTMLElement | null
          if (folderEl) return folderEl
        }
      }

      if (view.kind === 'folder') {
        if (view.folder === 'trash') {
          return document.querySelector('[data-sidebar-type="trash"]') as HTMLElement | null
        }
        return document.querySelector(
          `[data-sidebar-type="folder"][data-sidebar-folder="${view.folder}"][data-sidebar-subpath="${escapeForAttr(view.subpath)}"]`
        ) as HTMLElement | null
      }

      return null
    }

    const target = findTarget()
    if (!target) return

    const idx = Number(target.dataset.sidebarIdx)
    if (Number.isFinite(idx) && idx !== sidebarCursorIndex) {
      useStore.getState().setSidebarCursorIndex(idx)
    }

    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'nearest' })
    })
  }, [isSidebarFocused, selectedPath, unifiedSidebar, view])

  return (
    <aside
      className={`glass-sidebar relative flex shrink-0 flex-col pb-3 pt-3${isSidebarFocused ? ' panel-focused' : ''}`}
      style={{ width: sidebarWidth }}
      onMouseDownCapture={() => setFocusedPanel('sidebar')}
      onFocusCapture={() => setFocusedPanel('sidebar')}
    >
      {/* Vault header + top-right actions */}
      <div className="flex items-center justify-between px-3 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <VaultBadge name={vault?.name ?? 'ZenNotes'} size={28} />
          <div className="truncate text-sm font-medium text-ink-800">
            {vault?.name ?? 'ZenNotes'}
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <IconBtn
            title="New note"
            onClick={() => void createAndOpen('inbox')}
          >
            <PlusIcon />
          </IconBtn>
          <IconBtn title="Hide sidebar (⌘1)" onClick={toggleSidebar}>
            <PanelLeftIcon />
          </IconBtn>
        </div>
      </div>

      {/* Search + toolbar on one row */}
      <div className="flex items-center gap-1 px-3">
        <button
          onClick={() => setSearchOpen(true)}
          className="group flex h-7 flex-1 min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-ink-700 transition-colors hover:bg-paper-200/70 hover:text-ink-900"
          title="Search (⌘P)"
        >
          <SearchIcon />
          <span className="flex-1 truncate">Search</span>
          <kbd className="rounded bg-paper-200 px-1 py-0.5 text-[10px] text-ink-500">
            ⌘P
          </kbd>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
        <IconBtn
          title="New note"
          onClick={() => {
            const view = useStore.getState().view
            const target =
              view.kind === 'folder' && view.folder !== 'trash'
                ? { folder: view.folder, sub: view.subpath }
                : { folder: 'inbox' as NoteFolder, sub: '' }
            void createAndOpen(target.folder, target.sub)
          }}
        >
          <NotePlusIcon />
        </IconBtn>
        <IconBtn
          title="New folder"
          onClick={async () => {
            const view = useStore.getState().view
            // Quick Notes is intentionally flat — fall back to inbox
            // when the user is currently viewing it.
            const noFolders =
              view.kind === 'folder' && (view.folder === 'trash' || view.folder === 'quick')
            const parentFolder: NoteFolder =
              view.kind === 'folder' && !noFolders ? view.folder : 'inbox'
            const parentSub =
              view.kind === 'folder' && !noFolders ? view.subpath : ''
            const name = await prompt({
              title: 'New folder',
              placeholder: 'Folder name',
              okLabel: 'Create',
              validate: (v) => {
                if (v.includes('/')) return 'Folder name cannot contain "/"'
                return null
              }
            })
            if (!name) return
            const clean = name.trim().replace(/^\/+|\/+$/g, '')
            if (!clean) return
            const next = parentSub ? `${parentSub}/${clean}` : clean
            try {
              await createFolderAction(parentFolder, next)
            } catch (err) {
              window.alert((err as Error).message)
            }
          }}
        >
          <FolderPlusIcon />
        </IconBtn>
        <IconBtn
          title={`Sort: ${sortOrderLabel(noteSortOrder)}${groupByKind ? ', Group by kind' : ''}`}
          onClick={(e) => setSortMenu({ x: e.clientX, y: e.clientY })}
          active={noteSortOrder !== 'none'}
        >
          <SortIcon />
        </IconBtn>
        <IconBtn
          title={autoReveal ? 'Auto-reveal: on' : 'Auto-reveal: off'}
          onClick={() => setAutoReveal(!autoReveal)}
          active={autoReveal}
        >
          <TargetIcon />
        </IconBtn>
        <IconBtn
          title="Collapse all"
          onClick={() => (collapsed.size >= allFolderKeys.length ? expandAll() : collapseAll())}
        >
          <ExpandAllIcon />
        </IconBtn>
        </div>
      </div>

      {/* Main scrollable tree area */}
      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-3">
        <TaskSidebarRow
          active={tasksViewActive}
          onClick={() => void openTasksView()}
          sidebarIdx={idxCounter.current.value++}
          vimHighlight={vimCursor === idxCounter.current.value - 1}
          sidebarFocused={isSidebarFocused}
        />

        <FolderTreeRoot
          label="Quick Notes"
          icon={<ZapIcon />}
          folder="quick"
          tree={trees.quick}
          isFolderActive={isFolderActive}
          collapsed={collapsed}
          toggleCollapse={toggleCollapse}
          setView={setView}
          onContextMenu={openFolderMenu}
          showNotes={unifiedSidebar}
          selectedPath={selectedPath}
          onSelectNote={(p) => void selectNote(p)}
          onNoteContextMenu={(e, n) => {
            e.preventDefault()
            setNoteMenu({ x: e.clientX, y: e.clientY, path: n.path })
          }}
          sortComparator={treeSortComparator}
          onDropOnFolder={handleDropOnFolder}
          idxCounter={idxCounter.current}
          vimCursor={vimCursor}
          sidebarFocused={isSidebarFocused}
          groupByKind={groupByKind}
          headerAction={
            <button
              type="button"
              title="New Quick Note (⇧⌘N)"
              aria-label="New Quick Note"
              onClick={(e) => {
                e.stopPropagation()
                const title = resolveQuickNoteTitle(notes, quickNoteDateTitle)
                void createAndOpen('quick', '', { title, focusTitle: true })
              }}
              className="mr-1 flex h-6 w-6 items-center justify-center rounded-md bg-current/0 text-current transition-colors hover:bg-current/15"
            >
              <PlusIcon width={16} height={16} strokeWidth={2.5} />
            </button>
          }
        />

        <FolderTreeRoot
          label="Inbox"
          icon={<InboxIcon />}
          folder="inbox"
          tree={trees.inbox}
          isFolderActive={isFolderActive}
          collapsed={collapsed}
          toggleCollapse={toggleCollapse}
          setView={setView}
          onContextMenu={openFolderMenu}
          showNotes={unifiedSidebar}
          selectedPath={selectedPath}
          onSelectNote={(p) => void selectNote(p)}
          onNoteContextMenu={(e, n) => {
            e.preventDefault()
            setNoteMenu({ x: e.clientX, y: e.clientY, path: n.path })
          }}
          sortComparator={treeSortComparator}
          onDropOnFolder={handleDropOnFolder}
          idxCounter={idxCounter.current}
          vimCursor={vimCursor}
          sidebarFocused={isSidebarFocused}
          groupByKind={groupByKind}
        />

        <FolderTreeRoot
          label="Archive"
          icon={<ArchiveIcon />}
          folder="archive"
          tree={trees.archive}
          isFolderActive={isFolderActive}
          collapsed={collapsed}
          toggleCollapse={toggleCollapse}
          setView={setView}
          onContextMenu={openFolderMenu}
          showNotes={unifiedSidebar}
          selectedPath={selectedPath}
          onSelectNote={(p) => void selectNote(p)}
          onNoteContextMenu={(e, n) => {
            e.preventDefault()
            setNoteMenu({ x: e.clientX, y: e.clientY, path: n.path })
          }}
          sortComparator={treeSortComparator}
          onDropOnFolder={handleDropOnFolder}
          idxCounter={idxCounter.current}
          vimCursor={vimCursor}
          sidebarFocused={isSidebarFocused}
          groupByKind={groupByKind}
        />

        <FolderTreeRoot
          label="Trash"
          icon={<TrashIcon />}
          folder="trash"
          tree={trees.trash}
          isFolderActive={isFolderActive}
          collapsed={collapsed}
          toggleCollapse={toggleCollapse}
          setView={setView}
          onContextMenu={openFolderMenu}
          showNotes={unifiedSidebar}
          selectedPath={selectedPath}
          onSelectNote={(p) => void selectNote(p)}
          onNoteContextMenu={(e, n) => {
            e.preventDefault()
            setNoteMenu({ x: e.clientX, y: e.clientY, path: n.path })
          }}
          sortComparator={treeSortComparator}
          onDropOnFolder={handleDropOnFolder}
          idxCounter={idxCounter.current}
          vimCursor={vimCursor}
          sidebarFocused={isSidebarFocused}
          groupByKind={groupByKind}
        />

        {/* Tag pills */}
        {tags.length > 0 && (
          <div className="mt-5">
            <button
              type="button"
              onClick={() => setTagsCollapsed(!tagsCollapsed)}
              title={tagsCollapsed ? 'Show tags' : 'Hide tags'}
              aria-expanded={!tagsCollapsed}
              className="flex w-full items-center gap-1 rounded px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-ink-500 transition-colors hover:text-ink-800"
            >
              <span
                aria-hidden
                className="inline-block transition-transform"
                style={{ transform: tagsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
              >
                ▾
              </span>
              <span>Tags</span>
              <span className="ml-1 text-ink-400 normal-case tracking-normal">{tags.length}</span>
            </button>
            {!tagsCollapsed && (
            <div className="flex flex-wrap gap-1.5 px-1">
              {tags.map(([tag, count]) => {
                // Tag chips feed into a single vault-wide Tags tab. If the
                // tab is already open, clicking a chip toggles that tag in
                // the selection (narrower / wider result set). Otherwise
                // opening one starts the selection with just this tag.
                const active = tagsViewActive && selectedTags.includes(tag)
                const tagIdx = idxCounter.current.value++
                const isVimHighlight = vimCursor === tagIdx
                return (
                  <button
                    key={tag}
                    onClick={() => {
                      void openTagView(tag)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setTagMenu({ x: e.clientX, y: e.clientY, tag })
                    }}
                    className={[
                      'rounded-full px-2.5 py-1 text-xs transition-colors',
                      active
                        ? isVimHighlight
                          ? 'vim-cursor-on-active bg-accent text-white'
                          : isSidebarFocused
                            ? 'text-accent'
                            : 'bg-accent text-white'
                        : isVimHighlight
                          ? 'vim-cursor'
                          : 'bg-paper-200 text-ink-800 hover:bg-paper-300'
                    ].join(' ')}
                    data-sidebar-idx={tagIdx}
                    data-sidebar-type="tag"
                    data-sidebar-tag={tag}
                  >
                    #{tag}
                    <span
                      className={[
                        'ml-1 text-[10px]',
                        active && !isSidebarFocused ? 'text-white/80' : 'text-ink-500'
                      ].join(' ')}
                    >
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
            )}
          </div>
        )}
      </div>

      {/* Footer — vault-level utilities. Kept deliberately small so the
       *  main tree area dominates; Help and Settings are also reachable
       *  from the command palette and (for Settings) ⌘,. Trash moved
       *  into the main tree above so its notes can be browsed inline. */}
      <div
        className="mt-2 flex items-center gap-0.5 px-3 py-2"
        style={{ borderTop: '1px solid var(--glass-stroke)' }}
      >
        {hasAssetsDir && (
          <SidebarFooterIcon
            icon={<FolderIcon open={false} />}
            label={`Attachments (${assetFiles.length})`}
            onClick={() => void revealAssetsDir()}
            sidebarIdx={idxCounter.current.value++}
            vimHighlight={vimCursor === idxCounter.current.value - 1}
            sidebarFocused={isSidebarFocused}
            sidebarData={{ type: 'assets' }}
          />
        )}
        <div className="flex-1" />
        <SidebarFooterIcon
          icon={<DocumentIcon />}
          label="Help"
          active={helpViewActive}
          onClick={() => void openHelpView()}
          sidebarIdx={idxCounter.current.value++}
          vimHighlight={vimCursor === idxCounter.current.value - 1}
          sidebarFocused={isSidebarFocused}
          sidebarData={{ type: 'help' }}
        />
        <SidebarFooterIcon
          icon={<SettingsIcon />}
          label="Settings (⌘,)"
          onClick={() => setSettingsOpen(true)}
          sidebarIdx={idxCounter.current.value++}
          vimHighlight={vimCursor === idxCounter.current.value - 1}
          sidebarFocused={isSidebarFocused}
          sidebarData={{ type: 'settings' }}
        />
      </div>

      {tagMenu && (
        <ContextMenu
          x={tagMenu.x}
          y={tagMenu.y}
          items={tagMenuItems}
          onClose={() => setTagMenu(null)}
        />
      )}
      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={folderMenuItems}
          onClose={() => setFolderMenu(null)}
        />
      )}
      {noteMenu && (
        <ContextMenu
          x={noteMenu.x}
          y={noteMenu.y}
          items={noteMenuItems}
          onClose={() => setNoteMenu(null)}
        />
      )}
      {promptModal}
      {sortMenu && (
        <ContextMenu
          x={sortMenu.x}
          y={sortMenu.y}
          items={[
            ...(
              [
              ['none', 'No sorting'],
              ['updated-desc', 'Modified (newest first)'],
              ['updated-asc', 'Modified (oldest first)'],
              ['created-desc', 'Created (newest first)'],
              ['created-asc', 'Created (oldest first)'],
              ['name-asc', 'Name (A → Z)'],
              ['name-desc', 'Name (Z → A)']
            ] as const
            ).map(([id, label]) => ({
              label: `${noteSortOrder === id ? '✓  ' : '    '}${label}`,
              onSelect: () => setNoteSortOrder(id as NoteSortOrder)
            })),
            { kind: 'separator' as const },
            {
              label: `${groupByKind ? '✓  ' : '    '}Group by kind`,
              onSelect: () => setGroupByKind(!groupByKind)
            }
          ]}
          onClose={() => setSortMenu(null)}
        />
      )}

      <ResizeHandle
        getWidth={() => sidebarWidth}
        onResize={(next) => {
          if (next === 0) return
          setSidebarWidth(next)
        }}
      />
    </aside>
  )
}

/* ---------- Folder tree data ---------- */

interface TreeNode {
  name: string
  subpath: string
  siblingOrder: number
  notes: NoteMeta[]
  children: TreeNode[]
}

type TreeRenderEntry =
  | { type: 'folder'; node: TreeNode }
  | { type: 'note'; note: NoteMeta }

function buildTree(
  notes: NoteMeta[],
  topFolder: NoteFolder,
  folders: FolderEntry[]
): TreeNode {
  const root: TreeNode = {
    name: topFolder,
    subpath: '',
    siblingOrder: -1,
    notes: [],
    children: []
  }
  const byPath = new Map<string, TreeNode>()
  byPath.set('', root)
  const folderOrder = new Map(
    folders.map((folder) => [folder.subpath, folder.siblingOrder] as const)
  )

  const ensureFolder = (subpath: string): TreeNode => {
    const existing = byPath.get(subpath)
    if (existing) return existing
    const segments = subpath.split('/')
    let parent = root
    let acc = ''
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg
      let node = byPath.get(acc)
      if (!node) {
        node = {
          name: seg,
          subpath: acc,
          siblingOrder: folderOrder.get(acc) ?? Number.MAX_SAFE_INTEGER,
          notes: [],
          children: []
        }
        byPath.set(acc, node)
        parent.children.push(node)
      }
      parent = node
    }
    return parent
  }

  // First pass: create nodes for every folder on disk (this is what
  // keeps empty folders visible in the tree).
  for (const f of folders) {
    if (!f.subpath) continue
    ensureFolder(f.subpath)
  }

  // Second pass: place every note inside its parent folder node.
  for (const n of notes) {
    const parts = n.path.split('/')
    const segments = parts.slice(1, -1)
    if (segments.length === 0) {
      root.notes.push(n)
      continue
    }
    const parent = ensureFolder(segments.join('/'))
    parent.notes.push(n)
  }
  return root
}

function getTreeRenderEntries(
  node: TreeNode,
  showNotes: boolean,
  sortComparator: ((a: NoteMeta, b: NoteMeta) => number) | null,
  groupByKind: boolean
): TreeRenderEntry[] {
  if (!showNotes) {
    return node.children.map((child) => ({ type: 'folder', node: child }))
  }

  if (sortComparator || groupByKind) {
    return [
      ...node.children.map((child) => ({ type: 'folder', node: child } as const)),
      ...node.notes
        .slice()
        .sort(sortComparator ?? ((a, b) => a.siblingOrder - b.siblingOrder))
        .map((note) => ({ type: 'note', note } as const))
    ]
  }

  return [
    ...node.children.map((child) => ({
      type: 'folder' as const,
      node: child,
      siblingOrder: child.siblingOrder
    })),
    ...node.notes.map((note) => ({
      type: 'note' as const,
      note,
      siblingOrder: note.siblingOrder
    }))
  ]
    .sort((a, b) => a.siblingOrder - b.siblingOrder)
    .map(({ siblingOrder: _siblingOrder, ...entry }) => entry)
}

function countNotesInTree(node: TreeNode): number {
  return node.notes.length + node.children.reduce((s, c) => s + countNotesInTree(c), 0)
}

/* ---------- Tree rendering ---------- */

/** Mutable counter threaded through tree rendering for sequential data-sidebar-idx attributes. */
interface IdxCounter { value: number }

interface TreeRenderProps {
  folder: NoteFolder
  isFolderActive: (folder: NoteFolder, subpath: string) => boolean
  collapsed: Set<string>
  toggleCollapse: (key: string) => void
  setView: (v: { kind: 'folder'; folder: NoteFolder; subpath: string }) => void
  onContextMenu: (e: React.MouseEvent, folder: NoteFolder, subpath: string) => void
  showNotes: boolean
  selectedPath: string | null
  onSelectNote: (path: string) => void
  onNoteContextMenu: (e: React.MouseEvent, n: NoteMeta) => void
  sortComparator: ((a: NoteMeta, b: NoteMeta) => number) | null
  onDropOnFolder: (
    payload: DragPayload,
    targetFolder: NoteFolder,
    targetSubpath: string
  ) => void | Promise<void>
  /** Sequential index counter for vim navigation data attributes. */
  idxCounter: IdxCounter
  /** The highlighted cursor index when sidebar is vim-focused (-1 if not focused). */
  vimCursor: number
  /** Whether the sidebar currently owns keyboard focus. */
  sidebarFocused: boolean
  /** Finder-style folders-first rendering toggle. */
  groupByKind: boolean
}

function FolderTreeRoot({
  label,
  icon,
  folder,
  tree,
  isFolderActive,
  collapsed,
  toggleCollapse,
  setView,
  onContextMenu,
  showNotes,
  selectedPath,
  onSelectNote,
  onNoteContextMenu,
  sortComparator,
  onDropOnFolder,
  idxCounter,
  vimCursor,
  sidebarFocused,
  groupByKind,
  headerAction
}: {
  label: string
  icon: JSX.Element
  tree: TreeNode
  /** Optional inline action shown on the right of the header row,
   *  revealed on hover. Used to surface a quick "+" for Quick Notes. */
  headerAction?: JSX.Element
} & TreeRenderProps): JSX.Element {
  const rootKey = `${folder}:`
  const isCollapsed = collapsed.has(rootKey)
  const total = countNotesInTree(tree)
  const entries = useMemo(
    () => getTreeRenderEntries(tree, showNotes, sortComparator, groupByKind),
    [tree, showNotes, sortComparator, groupByKind]
  )
  const hasChildren = entries.length > 0
  const [dragHover, setDragHover] = useState(false)
  const myIdx = idxCounter.value++

  const handleSelect = (): void => {
    setView({ kind: 'folder', folder, subpath: '' })
    // Click toggles the expand state on every folder row.
    if (hasChildren) toggleCollapse(rootKey)
  }

  return (
    <div className="flex flex-col">
      <TreeRow
        icon={icon}
        label={label}
        count={total}
        active={isFolderActive(folder, '')}
        expandable={hasChildren}
        collapsed={isCollapsed}
        depth={0}
        onToggle={() => toggleCollapse(rootKey)}
        onSelect={handleSelect}
        onContextMenu={(e) => onContextMenu(e, folder, '')}
        dropTarget={dragHover}
        onDragOver={(e) => {
          if (!hasZenItem(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDragHover(true)
        }}
        onDragLeave={() => setDragHover(false)}
        onDrop={(e) => {
          setDragHover(false)
          const payload = readDragPayload(e)
          if (!payload) return
          e.preventDefault()
          void onDropOnFolder(payload, folder, '')
        }}
        sidebarIdx={myIdx}
        vimHighlight={vimCursor === myIdx}
        sidebarFocused={sidebarFocused}
        sidebarData={{ type: 'folder', folder, subpath: '', key: rootKey }}
        trailing={headerAction}
      />
      {!isCollapsed && (
        <>
          {entries.map((entry) => {
            if (entry.type === 'folder') {
              return (
                <SubTree
                  key={entry.node.subpath}
                  node={entry.node}
                  depth={1}
                  folder={folder}
                  isFolderActive={isFolderActive}
                  collapsed={collapsed}
                  toggleCollapse={toggleCollapse}
                  setView={setView}
                  onContextMenu={onContextMenu}
                  showNotes={showNotes}
                  selectedPath={selectedPath}
                  onSelectNote={onSelectNote}
                  onNoteContextMenu={onNoteContextMenu}
                  sortComparator={sortComparator}
                  onDropOnFolder={onDropOnFolder}
                  idxCounter={idxCounter}
                  vimCursor={vimCursor}
                  sidebarFocused={sidebarFocused}
                  groupByKind={groupByKind}
                />
              )
            }

            const n = entry.note
            const noteIdx = idxCounter.value++
            return (
              <NoteLeaf
                key={n.path}
                note={n}
                depth={1}
                active={n.path === selectedPath}
                sidebarFocused={sidebarFocused}
                onSelect={() => onSelectNote(n.path)}
                onContextMenu={(e) => onNoteContextMenu(e, n)}
                sidebarIdx={noteIdx}
                vimHighlight={vimCursor === noteIdx}
              />
            )
          })}
        </>
      )}
    </div>
  )
}

function SubTree({
  node,
  depth,
  folder,
  isFolderActive,
  collapsed,
  toggleCollapse,
  setView,
  onContextMenu,
  showNotes,
  selectedPath,
  onSelectNote,
  onNoteContextMenu,
  sortComparator,
  onDropOnFolder,
  idxCounter,
  vimCursor,
  sidebarFocused,
  groupByKind
}: { node: TreeNode; depth: number } & TreeRenderProps): JSX.Element {
  const key = `${folder}:${node.subpath}`
  const isCollapsed = collapsed.has(key)
  const entries = useMemo(
    () => getTreeRenderEntries(node, showNotes, sortComparator, groupByKind),
    [node, showNotes, sortComparator, groupByKind]
  )
  const hasChildren = entries.length > 0
  const [dragHover, setDragHover] = useState(false)
  const myIdx = idxCounter.value++

  const handleSelect = (): void => {
    setView({ kind: 'folder', folder, subpath: node.subpath })
    if (hasChildren) toggleCollapse(key)
  }

  return (
    <div className="flex flex-col">
      <TreeRow
        icon={<FolderIcon open={!isCollapsed && hasChildren} />}
        label={node.name}
        count={countNotesInTree(node)}
        active={isFolderActive(folder, node.subpath)}
        expandable={hasChildren}
        collapsed={isCollapsed}
        depth={depth}
        onToggle={() => toggleCollapse(key)}
        onSelect={handleSelect}
        onContextMenu={(e) => onContextMenu(e, folder, node.subpath)}
        draggable
        onDragStart={(e) =>
          setDragPayload(e, { kind: 'folder', folder, subpath: node.subpath })
        }
        dropTarget={dragHover}
        onDragOver={(e) => {
          if (!hasZenItem(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDragHover(true)
        }}
        onDragLeave={() => setDragHover(false)}
        onDrop={(e) => {
          setDragHover(false)
          const payload = readDragPayload(e)
          if (!payload) return
          e.preventDefault()
          void onDropOnFolder(payload, folder, node.subpath)
        }}
        sidebarIdx={myIdx}
        vimHighlight={vimCursor === myIdx}
        sidebarFocused={sidebarFocused}
        sidebarData={{ type: 'folder', folder, subpath: node.subpath, key }}
      />
      {!isCollapsed && (
        <>
          {entries.map((entry) => {
            if (entry.type === 'folder') {
              return (
                <SubTree
                  key={entry.node.subpath}
                  node={entry.node}
                  depth={depth + 1}
                  folder={folder}
                  isFolderActive={isFolderActive}
                  collapsed={collapsed}
                  toggleCollapse={toggleCollapse}
                  setView={setView}
                  onContextMenu={onContextMenu}
                  showNotes={showNotes}
                  selectedPath={selectedPath}
                  onSelectNote={onSelectNote}
                  onNoteContextMenu={onNoteContextMenu}
                  sortComparator={sortComparator}
                  onDropOnFolder={onDropOnFolder}
                  idxCounter={idxCounter}
                  vimCursor={vimCursor}
                  sidebarFocused={sidebarFocused}
                  groupByKind={groupByKind}
                />
              )
            }

            const n = entry.note
            const noteIdx = idxCounter.value++
            return (
              <NoteLeaf
                key={n.path}
                note={n}
                depth={depth + 1}
                active={n.path === selectedPath}
                sidebarFocused={sidebarFocused}
                onSelect={() => onSelectNote(n.path)}
                onContextMenu={(e) => onNoteContextMenu(e, n)}
                sidebarIdx={noteIdx}
                vimHighlight={vimCursor === noteIdx}
              />
            )
          })}
        </>
      )}
    </div>
  )
}

function NoteLeaf({
  note,
  depth,
  active,
  sidebarFocused,
  onSelect,
  onContextMenu,
  sidebarIdx,
  vimHighlight
}: {
  note: NoteMeta
  depth: number
  active: boolean
  sidebarFocused: boolean
  onSelect: () => void
  onContextMenu: (e: React.MouseEvent) => void
  sidebarIdx?: number
  vimHighlight?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onSelect}
      onDoubleClick={() => void window.zen.openNoteWindow(note.path)}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={(e) => setDragPayload(e, { kind: 'note', path: note.path })}
      className={[
        'group flex h-8 items-center gap-1.5 rounded-lg px-1 text-left text-sm outline-none transition-colors focus:outline-none',
        active
          ? vimHighlight
            ? 'vim-cursor-on-active bg-accent text-white'
            : sidebarFocused
              ? 'text-accent'
              : 'bg-accent text-white'
          : vimHighlight
            ? 'vim-cursor'
            : 'text-ink-700 hover:bg-paper-200/70'
      ].join(' ')}
      style={{ paddingLeft: 4 + depth * 14 + 20 }}
      {...(sidebarIdx != null ? {
        'data-sidebar-idx': sidebarIdx,
        'data-sidebar-type': 'note',
        'data-sidebar-path': note.path
      } : {})}
      >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={
          active
            ? sidebarFocused && !vimHighlight
              ? 'text-accent/80'
              : 'text-white/80'
            : 'text-ink-400'
        }
      >
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z" />
        <path d="M14 3v6h6" />
      </svg>
      <span className="flex-1 truncate">{note.title}</span>
      {note.hasAttachments && (
        <span
          aria-label="Has attachments"
          title="Has embedded attachments"
          className={[
            'shrink-0',
            active
              ? sidebarFocused && !vimHighlight
                ? 'text-accent/70'
                : 'text-white/70'
              : 'text-ink-400'
          ].join(' ')}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m21.44 11.05-9.19 9.19a6 6 0 1 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8L9.41 17.34a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </span>
      )}
      {sidebarFocused && vimHighlight && (
        <RowKeyHint active={active} label="menu" keyLabel="m" />
      )}
    </button>
  )
}

/* ---------- Row primitives ---------- */

function TreeRow({
  icon,
  label,
  count,
  active,
  expandable,
  collapsed,
  depth,
  onToggle,
  onSelect,
  onContextMenu,
  draggable = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  dropTarget = false,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
  sidebarData,
  trailing
}: {
  icon: JSX.Element
  label: string
  count?: number
  active: boolean
  expandable: boolean
  collapsed: boolean
  depth: number
  onToggle: () => void
  onSelect: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  dropTarget?: boolean
  sidebarIdx?: number
  vimHighlight?: boolean
  sidebarFocused?: boolean
  sidebarData?: { type: string; folder: string; subpath: string; key: string }
  /** Optional inline action(s) shown on the right edge, revealed on hover. */
  trailing?: JSX.Element
}): JSX.Element {
  const strongActive = active && (!sidebarFocused || !!vimHighlight)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={[
        'group flex h-8 items-center gap-1.5 rounded-lg px-1 text-left text-sm outline-none transition-colors focus:outline-none',
        active
          ? vimHighlight
            ? 'vim-cursor-on-active bg-accent text-white'
            : sidebarFocused
              ? 'text-accent'
              : 'bg-accent text-white'
          : dropTarget
            ? 'bg-accent/20 text-ink-900 ring-1 ring-accent/60'
            : vimHighlight
              ? 'vim-cursor'
              : 'text-ink-800 hover:bg-paper-200/70'
      ].join(' ')}
      {...(sidebarIdx != null ? {
        'data-sidebar-idx': sidebarIdx,
        'data-sidebar-type': sidebarData?.type ?? 'folder',
        'data-sidebar-folder': sidebarData?.folder,
        'data-sidebar-subpath': sidebarData?.subpath,
        'data-sidebar-key': sidebarData?.key
      } : {})}
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      {expandable ? (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          data-vim-hint-ignore
          className={[
            'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors',
            strongActive
              ? 'text-white/80 hover:bg-white/15'
              : 'text-ink-500 hover:bg-paper-300/60'
          ].join(' ')}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
      ) : (
        <span className="h-5 w-5 shrink-0" />
      )}
      <span
        className={
          strongActive ? 'text-white' : 'text-ink-500 group-hover:text-ink-800'
        }
      >
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {sidebarFocused && vimHighlight && (
        <RowKeyHint active={active} keyLabel="m" compact={typeof count === 'number' && count > 0} />
      )}
      {trailing && <span className="shrink-0">{trailing}</span>}
      {typeof count === 'number' && count > 0 && (
        <span
          className={[
            'shrink-0 pr-2 text-xs',
            strongActive ? 'text-white/80' : 'text-ink-400'
          ].join(' ')}
        >
          {count}
        </span>
      )}
    </div>
  )
}

// Shares TreeRow's padding + chevron-slot layout so "Tasks" lines up with
// Quick Notes / Inbox / Archive. No count, no expand button, no drag-and-
// drop — it's a plain top-level navigation entry.
function TaskSidebarRow({
  active,
  onClick,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false
}: {
  active: boolean
  onClick: () => void
  sidebarIdx?: number
  vimHighlight?: boolean
  sidebarFocused?: boolean
}): JSX.Element {
  const strongActive = active && (!sidebarFocused || !!vimHighlight)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={[
        'group flex h-8 items-center gap-1.5 rounded-lg px-1 text-left text-sm outline-none transition-colors focus:outline-none',
        active
          ? vimHighlight
            ? 'vim-cursor-on-active bg-accent text-white'
            : sidebarFocused
              ? 'text-accent'
              : 'bg-accent text-white'
          : vimHighlight
            ? 'vim-cursor'
            : 'text-ink-800 hover:bg-paper-200/70'
      ].join(' ')}
      style={{ paddingLeft: 4 }}
      {...(sidebarIdx != null ? {
        'data-sidebar-idx': sidebarIdx,
        'data-sidebar-type': 'tasks'
      } : {})}
    >
      {/* Empty slot matches FolderTreeRoot's collapse-chevron column so the
          icon + label line up with Quick Notes / Inbox / Archive. */}
      <span className="h-5 w-5 shrink-0" />
      <span className={strongActive ? 'text-white' : 'text-ink-500 group-hover:text-ink-800'}>
        <CheckSquareIcon />
      </span>
      <span className="flex-1 truncate">Tasks</span>
    </div>
  )
}

function SidebarRow({
  icon,
  label,
  count,
  trailing,
  active,
  onClick,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
  sidebarData
}: {
  icon: JSX.Element
  label: string
  count?: number
  trailing?: JSX.Element
  active?: boolean
  onClick: () => void
  sidebarIdx?: number
  vimHighlight?: boolean
  sidebarFocused?: boolean
  sidebarData?: { type: string }
}): JSX.Element {
  const strongActive = !!active && (!sidebarFocused || !!vimHighlight)

  return (
    <button
      onClick={onClick}
      className={[
        'group flex h-8 items-center gap-2 rounded-lg px-2 text-sm outline-none transition-colors focus:outline-none',
        active
          ? vimHighlight
            ? 'vim-cursor-on-active bg-accent text-white'
            : sidebarFocused
              ? 'text-accent'
              : 'bg-accent text-white'
          : vimHighlight
            ? 'vim-cursor'
            : 'text-ink-800 hover:bg-paper-200/70'
      ].join(' ')}
      {...(sidebarIdx != null ? {
        'data-sidebar-idx': sidebarIdx,
        'data-sidebar-type': sidebarData?.type ?? 'settings'
      } : {})}
    >
      <span
        className={
          strongActive ? 'text-white' : 'text-ink-500 group-hover:text-ink-800'
        }
      >
        {icon}
      </span>
      <span className="flex-1 truncate text-left">{label}</span>
      {sidebarFocused && vimHighlight && (
        <RowKeyHint active={!!active} keyLabel="m" compact={typeof count === 'number' && count > 0} />
      )}
      {typeof count === 'number' && count > 0 && (
        <span
          className={[
            'text-xs',
            strongActive ? 'text-white/80' : 'text-ink-400'
          ].join(' ')}
        >
          {count}
        </span>
      )}
      {trailing}
    </button>
  )
}

/** Compact icon button used in the sidebar footer. Same vim-nav
 *  wiring as SidebarRow (sidebarIdx / sidebarData), but rendered as a
 *  square icon so three utilities (Attachments, Help, Settings) fit
 *  on one row without crowding. */
function SidebarFooterIcon({
  icon,
  label,
  active,
  onClick,
  sidebarIdx,
  vimHighlight,
  sidebarFocused = false,
  sidebarData
}: {
  icon: JSX.Element
  label: string
  active?: boolean
  onClick: () => void
  sidebarIdx?: number
  vimHighlight?: boolean
  sidebarFocused?: boolean
  sidebarData?: { type: string }
}): JSX.Element {
  const strongActive = !!active && (!sidebarFocused || !!vimHighlight)
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={[
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
        active
          ? vimHighlight
            ? 'vim-cursor-on-active bg-accent text-white'
            : sidebarFocused
              ? 'text-accent'
              : 'bg-accent text-white'
          : vimHighlight
            ? 'vim-cursor'
            : 'text-ink-500 hover:bg-paper-200/70 hover:text-ink-900'
      ].join(' ')}
      {...(sidebarIdx != null
        ? {
            'data-sidebar-idx': sidebarIdx,
            'data-sidebar-type': sidebarData?.type ?? 'settings'
          }
        : {})}
    >
      <span className={strongActive ? 'text-white' : undefined}>{icon}</span>
    </button>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  active
}: {
  children: JSX.Element
  onClick: (e: React.MouseEvent) => void
  title: string
  active?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className={[
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
        active
          ? 'bg-accent/15 text-accent'
          : 'text-ink-500 hover:bg-paper-200 hover:text-ink-800'
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function RowKeyHint({
  active,
  keyLabel,
  label,
  compact = false
}: {
  active: boolean
  keyLabel: string
  label?: string
  compact?: boolean
}): JSX.Element {
  return (
    <span
      className={[
        'pointer-events-none shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] leading-none',
        active
          ? 'border-white/25 bg-white/12 text-white/80'
          : 'border-paper-300/70 bg-paper-100/75 text-ink-500'
      ].join(' ')}
    >
      <span className="font-mono text-[10px]">{keyLabel}</span>
      {!compact && label ? <span className="ml-1">{label}</span> : null}
    </span>
  )
}

function sortOrderLabel(order: NoteSortOrder): string {
  switch (order) {
    case 'none':
      return 'No sorting'
    case 'updated-desc':
      return 'Modified (newest)'
    case 'updated-asc':
      return 'Modified (oldest)'
    case 'created-desc':
      return 'Created (newest)'
    case 'created-asc':
      return 'Created (oldest)'
    case 'name-asc':
      return 'Name (A → Z)'
    case 'name-desc':
      return 'Name (Z → A)'
  }
}

function FolderIcon({ open }: { open: boolean }): JSX.Element {
  // Simple folder glyph — filled when open, outlined when closed.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={open ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      fillOpacity={open ? 0.18 : 0}
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  )
}
