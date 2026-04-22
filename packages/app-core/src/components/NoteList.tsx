import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { AssetMeta, NoteMeta } from '@shared/ipc'
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  ColumnsIcon,
  PlusIcon,
  TrashIcon
} from './icons'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ResizeHandle } from './ResizeHandle'
import { confirmMoveToTrash } from '../lib/confirm-trash'
import { buildMoveNotePrompt, parseMoveNoteTarget } from '../lib/move-note'
import { extractTags } from '../lib/tags'
import { setDragPayload } from '../lib/dnd'
import { usePrompt } from './PromptModal'
import { resolveSystemFolderLabels } from '../lib/system-folder-labels'
import {
  assetBelongsToFolderView,
  isPrimaryNotesAtRoot,
  noteBelongsToFolderView
} from '../lib/vault-layout'

function escapeForAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

function formatDate(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric'
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KB`
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const ASSET_LAYOUT_KEY = 'zen:assets-layout:v1'
type AssetLayout = 'grid' | 'list'

export function NoteList(): JSX.Element {
  const vault = useStore((s) => s.vault)
  const notes = useStore((s) => s.notes)
  const folders = useStore((s) => s.folders)
  const assetFiles = useStore((s) => s.assetFiles)
  const activeNote = useStore((s) => s.activeNote)
  const view = useStore((s) => s.view)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const selectedPath = useStore((s) => s.selectedPath)
  const selectNote = useStore((s) => s.selectNote)
  const createAndOpen = useStore((s) => s.createAndOpen)
  const toggleNoteList = useStore((s) => s.toggleNoteList)
  const refreshNotes = useStore((s) => s.refreshNotes)
  const noteListWidth = useStore((s) => s.noteListWidth)
  const setNoteListWidth = useStore((s) => s.setNoteListWidth)
  const noteSortOrder = useStore((s) => s.noteSortOrder)
  const renameNote = useStore((s) => s.renameNote)
  const moveNote = useStore((s) => s.moveNote)
  const tabsEnabled = useStore((s) => s.tabsEnabled)
  const openNoteInTab = useStore((s) => s.openNoteInTab)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const noteListCursorIndex = useStore((s) => s.noteListCursorIndex)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const workspaceMode = useStore((s) => s.workspaceMode)
  const { prompt, modal: promptModal } = usePrompt()
  const canRevealInFileManager =
    window.zen.getAppInfo().runtime === 'desktop' && workspaceMode !== 'remote'
  const absolutePathLabel =
    workspaceMode === 'remote' ? 'Copy Server Path' : 'Copy Absolute Path'
  const folderLabels = useMemo(
    () => resolveSystemFolderLabels(systemFolderLabels),
    [systemFolderLabels]
  )
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const [assetMenu, setAssetMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const [assetLayout, setAssetLayout] = useState<AssetLayout>(() => {
    try {
      const raw = localStorage.getItem(ASSET_LAYOUT_KEY)
      return raw === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(ASSET_LAYOUT_KEY, assetLayout)
    } catch {
      /* ignore */
    }
  }, [assetLayout])
  const emptyTrash = async (): Promise<void> => {
    await window.zen.emptyTrash()
    await useStore.getState().refreshNotes()
  }

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return []
    const n = notes.find((note) => note.path === menu.path)
    if (!n) return []
    const onOpen = async (): Promise<void> => {
      await selectNote(n.path)
    }
    const onDuplicate = async (): Promise<void> => {
      const meta = await window.zen.duplicateNote(n.path)
      await refreshNotes()
      await selectNote(meta.path)
    }
    const onReveal = async (): Promise<void> => {
      await window.zen.revealNote(n.path)
    }
    const onCopyWikilink = async (): Promise<void> => {
      await navigator.clipboard.writeText(`[[${n.title}]]`)
    }
    const onArchive = async (): Promise<void> => {
      await window.zen.archiveNote(n.path)
      await refreshNotes()
      if (selectedPath === n.path) await selectNote(null)
    }
    const onUnarchive = async (): Promise<void> => {
      const meta = await window.zen.unarchiveNote(n.path)
      await refreshNotes()
      if (selectedPath === n.path) await selectNote(meta.path)
    }
    const onTrash = async (): Promise<void> => {
      if (!(await confirmMoveToTrash(n.title))) return
      await window.zen.moveToTrash(n.path)
      await refreshNotes()
      if (selectedPath === n.path) await selectNote(null)
    }
    const onMove = async (): Promise<void> => {
      const target = await prompt(buildMoveNotePrompt(n, folders))
      if (!target) return
      const dest = parseMoveNoteTarget(target)
      await moveNote(n.path, dest.folder, dest.subpath)
    }
    const onRestore = async (): Promise<void> => {
      const meta = await window.zen.restoreFromTrash(n.path)
      await refreshNotes()
      if (selectedPath === n.path) await selectNote(meta.path)
    }
    const onDeleteForever = async (): Promise<void> => {
      await window.zen.deleteNote(n.path)
      await refreshNotes()
      if (selectedPath === n.path) await selectNote(null)
    }
    const onNew = async (): Promise<void> => {
      await useStore
        .getState()
        .createAndOpen(n.folder === 'trash' ? 'inbox' : n.folder)
    }

    const items: ContextMenuItem[] = []
    items.push({ label: 'Open', onSelect: onOpen })
    if (tabsEnabled) {
      items.push({ label: 'Open in New Tab', onSelect: async () => openNoteInTab(n.path) })
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
          await renameNote(n.path, next)
        }
      })
      items.push({ label: 'Move…', onSelect: onMove })
      items.push({ label: 'Duplicate', onSelect: onDuplicate })
    }
    items.push({ label: 'Copy as Wiki Link', onSelect: onCopyWikilink })
    items.push({
      label: 'Open in Floating Window',
      onSelect: async () => {
        await window.zen.openNoteWindow(n.path)
      }
    })
    if (canRevealInFileManager) {
      items.push({ label: 'Reveal in File Manager', onSelect: onReveal })
    }
    items.push({ kind: 'separator' })

    if (n.folder === 'inbox' || n.folder === 'quick') {
      items.push({ label: folderLabels.archive, icon: <ArchiveIcon />, onSelect: onArchive })
      items.push({
        label: `Move to ${folderLabels.trash}`,
        icon: <TrashIcon />,
        danger: true,
        onSelect: onTrash
      })
    } else if (n.folder === 'archive') {
      items.push({
        label: `Move to ${folderLabels.inbox}`,
        icon: <ArrowUpRightIcon />,
        onSelect: onUnarchive
      })
      items.push({
        label: `Move to ${folderLabels.trash}`,
        icon: <TrashIcon />,
        danger: true,
        onSelect: onTrash
      })
    } else {
      items.push({
        label: 'Restore',
        icon: <ArrowUpRightIcon />,
        onSelect: onRestore
      })
      items.push({
        label: 'Delete Permanently',
        icon: <TrashIcon />,
        danger: true,
        onSelect: onDeleteForever
      })
    }

    return items
  }, [
    canRevealInFileManager,
    menu,
    notes,
    folders,
    refreshNotes,
    selectedPath,
    selectNote,
    prompt,
    renameNote,
    moveNote,
    tabsEnabled,
    openNoteInTab,
    folderLabels.archive,
    folderLabels.inbox,
    folderLabels.trash
  ])

  const assetMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!assetMenu) return []
    const asset = assetFiles.find((entry) => entry.path === assetMenu.path)
    if (!asset) return []

    const url = assetUrl(vault?.root ?? null, asset.path)
    const root = vault?.root ?? ''
    const sep = root.includes('\\') ? '\\' : '/'
    const abs = [root.replace(/[\\/]+$/, ''), ...asset.path.split('/').filter(Boolean)].join(sep)

    const items: ContextMenuItem[] = [
      {
        label: 'Open',
        onSelect: async () => {
          if (url) window.open(url, '_blank')
        }
      },
      {
        label: 'Copy Path',
        onSelect: async () => {
          window.zen.clipboardWriteText(asset.path)
        }
      },
      {
        label: absolutePathLabel,
        onSelect: async () => {
          window.zen.clipboardWriteText(abs)
        }
      }
    ]

    if (canRevealInFileManager) {
      items.push({
        label: 'Reveal in File Manager',
        onSelect: async () => {
          await window.zen.revealNote(asset.path)
        }
      })
    }

    return items
  }, [assetMenu, assetFiles, canRevealInFileManager, absolutePathLabel, vault])

  /**
   * Filter notes for the current view. For folder views we match the
   * top-level folder AND, when a subpath is active, limit to notes
   * inside that subfolder (including deeper descendants). The tag view
   * is its own full-surface tab now (see TagView), so NoteList no longer
   * handles tag filtering.
   */
  const filtered = useMemo<NoteMeta[]>(() => {
    if (view.kind === 'assets') return []
    return notes.filter((n) =>
      noteBelongsToFolderView(n, view.folder, view.subpath, vaultSettings)
    )
  }, [notes, view, vaultSettings])

  const filteredAssets = useMemo<AssetMeta[]>(() => {
    if (view.kind === 'assets') return assetFiles
    return assetFiles.filter((asset) =>
      assetBelongsToFolderView(asset, view.folder, view.subpath, vaultSettings)
    )
  }, [assetFiles, view, vaultSettings])

  /**
   * Stable ordering: we want the list sorted by updatedAt when the user
   * switches views or the set of notes changes, but not re-sorted every
   * time an edit bumps a single note's mtime (that makes the row the
   * user is typing in jump to the top mid-sentence). We cache the last
   * known ordering as a path list, and only rebuild it when the view
   * changes or a note is added / removed.
   */
  const orderRef = useRef<{ viewKey: string; paths: string[] }>({
    viewKey: '',
    paths: []
  })
  const viewKey =
    view.kind === 'folder'
      ? `folder:${view.folder}:${view.subpath}`
      : 'assets'
  const sortComparator = useMemo<((a: NoteMeta, b: NoteMeta) => number) | null>(() => {
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

  const assetSortComparator = useMemo<((a: AssetMeta, b: AssetMeta) => number) | null>(() => {
    switch (noteSortOrder) {
      case 'none':
        return null
      case 'updated-asc':
        return (a: AssetMeta, b: AssetMeta) => a.updatedAt - b.updatedAt
      case 'created-desc':
      case 'updated-desc':
        return (a: AssetMeta, b: AssetMeta) => b.updatedAt - a.updatedAt
      case 'created-asc':
        return (a: AssetMeta, b: AssetMeta) => a.updatedAt - b.updatedAt
      case 'name-asc':
        return (a: AssetMeta, b: AssetMeta) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      case 'name-desc':
        return (a: AssetMeta, b: AssetMeta) =>
          b.name.localeCompare(a.name, undefined, { sensitivity: 'base' })
      default:
        return (a: AssetMeta, b: AssetMeta) => b.updatedAt - a.updatedAt
    }
  }, [noteSortOrder])

  const orderedFiltered = useMemo(() => {
    if (noteSortOrder === 'none' || !sortComparator) {
      orderRef.current = {
        viewKey: viewKey + ':' + noteSortOrder,
        paths: filtered.map((n) => n.path)
      }
      return filtered
    }

    const prev = orderRef.current
    const currentSet = new Set(filtered.map((n) => n.path))

    const viewChanged = prev.viewKey !== viewKey + ':' + noteSortOrder
    const prevKnown = new Set(prev.paths)
    const added = filtered.filter((n) => !prevKnown.has(n.path))
    const removed = prev.paths.filter((p) => !currentSet.has(p))
    const structuralChange = added.length > 0 || removed.length > 0

    if (viewChanged || structuralChange || prev.paths.length === 0) {
      const fresh = filtered.slice().sort(sortComparator)
      orderRef.current = {
        viewKey: viewKey + ':' + noteSortOrder,
        paths: fresh.map((n) => n.path)
      }
      return fresh
    }

    // Reuse the previous order but swap in the new NoteMeta references
    // (so updated `updatedAt` / tags / excerpt still flow through to
    // the row without changing position).
    const byPath = new Map(filtered.map((n) => [n.path, n] as const))
    const result: NoteMeta[] = []
    for (const p of prev.paths) {
      const n = byPath.get(p)
      if (n) result.push(n)
    }
    return result
  }, [filtered, viewKey, sortComparator, noteSortOrder])

  const orderedFolderEntries = useMemo<
    Array<{ type: 'note'; note: NoteMeta } | { type: 'asset'; asset: AssetMeta }>
  >(() => {
    if (view.kind === 'assets') {
      return filteredAssets.map((asset) => ({ type: 'asset' as const, asset }))
    }

    if (noteSortOrder === 'none') {
      return [
        ...orderedFiltered.map((note) => ({
          type: 'note' as const,
          note,
          siblingOrder: note.siblingOrder
        })),
        ...filteredAssets.map((asset) => ({
          type: 'asset' as const,
          asset,
          siblingOrder: asset.siblingOrder
        }))
      ]
        .sort((a, b) => a.siblingOrder - b.siblingOrder)
        .map(({ siblingOrder: _siblingOrder, ...entry }) => entry)
    }

    return [
      ...orderedFiltered.map((note) => ({ type: 'note' as const, note })),
      ...filteredAssets
        .slice()
        .sort(assetSortComparator ?? ((a, b) => a.siblingOrder - b.siblingOrder))
        .map((asset) => ({ type: 'asset' as const, asset }))
    ]
  }, [assetSortComparator, filteredAssets, noteSortOrder, orderedFiltered, view.kind])

  const heading =
    view.kind === 'assets'
      ? 'Files'
      : view.subpath
        ? view.subpath.split('/').slice(-1)[0]
        : view.folder === 'inbox' && isPrimaryNotesAtRoot(vaultSettings)
          ? vault?.name ?? 'Vault'
          : folderLabels[view.folder]

  const newTarget =
    view.kind === 'folder' && view.folder !== 'trash'
      ? { folder: view.folder, subpath: view.subpath }
      : { folder: 'inbox' as const, subpath: '' }

  const isNoteListFocused = focusedPanel === 'notelist'

  useEffect(() => {
    if (!isNoteListFocused) return
    const next =
      orderedFolderEntries.length === 0
        ? 0
        : Math.min(noteListCursorIndex, orderedFolderEntries.length - 1)
    if (next !== noteListCursorIndex) {
      useStore.getState().setNoteListCursorIndex(next)
    }
  }, [isNoteListFocused, noteListCursorIndex, orderedFolderEntries.length])

  useEffect(() => {
    if (!isNoteListFocused || !selectedPath) return
    const target = document.querySelector(
      `[data-notelist-path="${escapeForAttr(selectedPath)}"]`
    ) as HTMLElement | null
    if (!target) return

    const idx = Number(target.dataset.notelistIdx)
    if (Number.isFinite(idx) && idx !== noteListCursorIndex) {
      useStore.getState().setNoteListCursorIndex(idx)
    }

    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'nearest' })
    })
  }, [isNoteListFocused, selectedPath, noteListCursorIndex])

  return (
    <section
      className={`glass-column relative flex shrink-0 flex-col${isNoteListFocused ? ' panel-focused' : ''}`}
      style={{ width: noteListWidth }}
      onMouseDownCapture={() => setFocusedPanel('notelist')}
      onFocusCapture={() => setFocusedPanel('notelist')}
    >
      <header className="glass-header flex h-12 shrink-0 items-center justify-between px-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-ink-900">{heading}</h2>
          <span className="text-xs text-ink-400">
            {view.kind === 'assets' ? assetFiles.length : orderedFolderEntries.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {view.kind === 'assets' ? (
            <div className="flex items-center gap-1 rounded-md bg-paper-200/70 p-0.5 text-xs">
              {(['grid', 'list'] as const).map((layout) => (
                <button
                  key={layout}
                  onClick={() => setAssetLayout(layout)}
                  className={[
                    'rounded px-2 py-1 transition-colors',
                    assetLayout === layout
                      ? 'bg-paper-50 text-ink-900 shadow-sm'
                      : 'text-ink-500 hover:text-ink-800'
                  ].join(' ')}
                >
                  {layout === 'grid' ? 'Grid' : 'List'}
                </button>
              ))}
            </div>
          ) : view.kind === 'folder' && view.folder === 'trash' && filtered.length > 0 && (
            <button
              onClick={() => void emptyTrash()}
              className="rounded-md px-2 py-1 text-xs text-ink-500 hover:bg-paper-200 hover:text-ink-800"
            >
              Empty
            </button>
          )}
          {view.kind !== 'assets' && (
            <button
              className="flex h-6 w-6 items-center justify-center rounded-md text-ink-500 hover:bg-paper-200 hover:text-ink-800"
              title="New note"
              onClick={() => void createAndOpen(newTarget.folder, newTarget.subpath)}
            >
              <PlusIcon />
            </button>
          )}
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-500 hover:bg-paper-200 hover:text-ink-800"
            title="Hide note list"
            onClick={toggleNoteList}
          >
            <ColumnsIcon />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {view.kind === 'assets' ? (
          assetFiles.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-ink-400">
              No files yet. Files anywhere inside the vault show up here.
            </div>
          ) : assetLayout === 'grid' ? (
            <div className="grid grid-cols-2 gap-2 px-1">
              {assetFiles.map((asset) => (
                <AssetCard
                  key={asset.path}
                  asset={asset}
                  vaultRoot={vault?.root ?? null}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setAssetMenu({ x: e.clientX, y: e.clientY, path: asset.path })
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {assetFiles.map((asset) => (
                <AssetRow
                  key={asset.path}
                  asset={asset}
                  vaultRoot={vault?.root ?? null}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setAssetMenu({ x: e.clientX, y: e.clientY, path: asset.path })
                  }}
                />
              ))}
            </div>
          )
        ) : orderedFolderEntries.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-ink-400">
            {view.kind === 'folder' && view.folder === 'trash'
              ? `${folderLabels.trash} is empty.`
              : 'No files here yet.'}
          </div>
        ) : (
          orderedFolderEntries.map((entry, i) =>
            entry.type === 'note' ? (
              <NoteRow
                key={entry.note.path}
                note={entry.note}
                active={entry.note.path === selectedPath}
                onSelect={() => void selectNote(entry.note.path)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, path: entry.note.path })
                }}
                noteListIdx={i}
                vimHighlight={isNoteListFocused && noteListCursorIndex === i}
              />
            ) : (
              <FolderAssetRow
                key={entry.asset.path}
                asset={entry.asset}
                vaultRoot={vault?.root ?? null}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setAssetMenu({ x: e.clientX, y: e.clientY, path: entry.asset.path })
                }}
                noteListIdx={i}
                vimHighlight={isNoteListFocused && noteListCursorIndex === i}
              />
            ),
          )
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {assetMenu && (
        <ContextMenu
          x={assetMenu.x}
          y={assetMenu.y}
          items={assetMenuItems}
          onClose={() => setAssetMenu(null)}
        />
      )}
      {promptModal}

      <ResizeHandle
        getWidth={() => noteListWidth}
        onResize={(next) => {
          if (next === 0) return
          setNoteListWidth(next)
        }}
      />
    </section>
  )
}

function NoteRow({
  note,
  active,
  onSelect,
  onContextMenu,
  noteListIdx,
  vimHighlight
}: {
  note: NoteMeta
  active: boolean
  onSelect: () => void
  onContextMenu: (e: React.MouseEvent) => void
  noteListIdx?: number
  vimHighlight?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onSelect}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={(e) => setDragPayload(e, { kind: 'note', path: note.path })}
      className={[
        'list-row mb-1 flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left outline-none focus:outline-none',
        active
          ? `${vimHighlight ? 'vim-cursor-on-selected ' : ''}bg-paper-200`
          : vimHighlight
            ? 'vim-cursor'
            : 'hover:bg-paper-200/60'
      ].join(' ')}
      style={
        active
          ? {
              boxShadow: vimHighlight
                ? 'inset 0 0 0 1px rgb(var(--z-accent) / 0.35), inset 0 0 0 2px rgb(var(--z-accent) / 0.65)'
                : 'inset 0 0 0 1px rgb(var(--z-accent) / 0.35)'
            }
          : vimHighlight
            ? { boxShadow: 'inset 0 0 0 1px rgb(var(--z-accent) / 0.35)' }
            : undefined
      }
      {...(noteListIdx != null ? {
        'data-notelist-idx': noteListIdx,
        'data-notelist-path': note.path
      } : {})}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-ink-900">{note.title}</span>
        <span className="shrink-0 text-[11px] text-ink-400">{formatDate(note.updatedAt)}</span>
      </div>
      <span className="line-clamp-2 text-xs text-ink-500">
        {note.excerpt || 'Empty note'}
      </span>
    </button>
  )
}

function FolderAssetRow({
  asset,
  vaultRoot,
  onContextMenu,
  noteListIdx,
  vimHighlight
}: {
  asset: AssetMeta
  vaultRoot: string | null
  onContextMenu: (e: React.MouseEvent) => void
  noteListIdx?: number
  vimHighlight?: boolean
}): JSX.Element {
  const url = assetUrl(vaultRoot, asset.path)
  const extension = asset.name.includes('.') ? asset.name.split('.').pop()?.toUpperCase() ?? '' : ''

  return (
    <button
      type="button"
      onClick={() => {
        if (url) window.open(url, '_blank')
      }}
      onContextMenu={onContextMenu}
      className={[
        'list-row mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none focus:outline-none',
        vimHighlight ? 'vim-cursor' : 'hover:bg-paper-200/60'
      ].join(' ')}
      style={vimHighlight ? { boxShadow: 'inset 0 0 0 1px rgb(var(--z-accent) / 0.35)' } : undefined}
      {...(noteListIdx != null
        ? {
            'data-notelist-idx': noteListIdx,
            'data-notelist-path': asset.path
          }
        : {})}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-paper-200/45">
        {asset.kind === 'image' && url ? (
          <img
            src={url}
            alt={asset.name}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className="text-[10px] uppercase tracking-[0.16em] text-ink-500">
            {asset.kind}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink-900">{asset.name}</div>
        <div className="truncate text-xs text-ink-500">{asset.path}</div>
      </div>
      <div className="shrink-0 text-[10px] uppercase tracking-wide text-ink-400">
        {extension || formatBytes(asset.size)}
      </div>
    </button>
  )
}

function assetUrl(vaultRoot: string | null, assetPath: string): string | null {
  if (!vaultRoot) return null
  return window.zen.resolveVaultAssetUrl(vaultRoot, assetPath)
}

function AssetCard({
  asset,
  vaultRoot,
  onContextMenu
}: {
  asset: AssetMeta
  vaultRoot: string | null
  onContextMenu?: (e: React.MouseEvent) => void
}): JSX.Element {
  const url = assetUrl(vaultRoot, asset.path)
  const open = (): void => {
    if (url) window.open(url, '_blank')
  }

  return (
    <button
      type="button"
      onClick={open}
      onContextMenu={onContextMenu}
      className="flex min-h-[154px] flex-col overflow-hidden rounded-xl border border-paper-300/70 bg-paper-50/24 text-left transition-colors hover:border-paper-400 hover:bg-paper-100/40"
    >
      <div className="flex min-h-0 flex-1 items-center justify-center bg-paper-200/25">
        {asset.kind === 'image' && url ? (
          <img
            src={url}
            alt={asset.name}
            className="max-h-[170px] w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="px-4 text-xs uppercase tracking-[0.18em] text-ink-400">
            {asset.kind}
          </div>
        )}
      </div>
      <div className="border-t border-paper-300/70 px-3 py-2">
        <div className="truncate text-sm font-medium text-ink-900">{asset.name}</div>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-ink-500">
          <span className="truncate">{asset.path}</span>
          <span className="shrink-0">{formatBytes(asset.size)}</span>
        </div>
      </div>
    </button>
  )
}

function AssetRow({
  asset,
  vaultRoot,
  onContextMenu
}: {
  asset: AssetMeta
  vaultRoot: string | null
  onContextMenu?: (e: React.MouseEvent) => void
}): JSX.Element {
  const url = assetUrl(vaultRoot, asset.path)
  const open = (): void => {
    if (url) window.open(url, '_blank')
  }

  return (
    <button
      type="button"
      onClick={open}
      onContextMenu={onContextMenu}
      className="flex items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:border-paper-300/70 hover:bg-paper-200/45"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-paper-200/45">
        {asset.kind === 'image' && url ? (
          <img
            src={url}
            alt={asset.name}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className="text-[10px] uppercase tracking-[0.16em] text-ink-500">{asset.kind}</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink-900">{asset.name}</div>
        <div className="truncate text-xs text-ink-500">{asset.path}</div>
      </div>
      <div className="shrink-0 text-[11px] text-ink-400">
        {formatBytes(asset.size)}
      </div>
    </button>
  )
}
