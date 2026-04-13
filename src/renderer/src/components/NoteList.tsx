import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { NoteMeta } from '@shared/ipc'
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  ColumnsIcon,
  PlusIcon,
  TrashIcon
} from './icons'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ResizeHandle } from './ResizeHandle'
import { extractTags } from '../lib/tags'
import { setDragPayload } from '../lib/dnd'
import { usePrompt } from './PromptModal'

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

export function NoteList(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const activeNote = useStore((s) => s.activeNote)
  const view = useStore((s) => s.view)
  const selectedPath = useStore((s) => s.selectedPath)
  const selectNote = useStore((s) => s.selectNote)
  const createAndOpen = useStore((s) => s.createAndOpen)
  const toggleNoteList = useStore((s) => s.toggleNoteList)
  const refreshNotes = useStore((s) => s.refreshNotes)
  const noteListWidth = useStore((s) => s.noteListWidth)
  const setNoteListWidth = useStore((s) => s.setNoteListWidth)
  const noteSortOrder = useStore((s) => s.noteSortOrder)
  const renameActive = useStore((s) => s.renameActive)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const noteListCursorIndex = useStore((s) => s.noteListCursorIndex)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const { prompt, modal: promptModal } = usePrompt()
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)
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
      await window.zen.moveToTrash(n.path)
      await refreshNotes()
      if (selectedPath === n.path) await selectNote(null)
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
      items.push({ label: 'Duplicate', onSelect: onDuplicate })
    }
    items.push({ label: 'Copy as Wiki Link', onSelect: onCopyWikilink })
    items.push({ label: 'Reveal in Finder', onSelect: onReveal })
    items.push({ kind: 'separator' })

    if (n.folder === 'inbox') {
      items.push({ label: 'Archive', icon: <ArchiveIcon />, onSelect: onArchive })
      items.push({
        label: 'Move to Trash',
        icon: <TrashIcon />,
        danger: true,
        onSelect: onTrash
      })
    } else if (n.folder === 'archive') {
      items.push({
        label: 'Move to Inbox',
        icon: <ArrowUpRightIcon />,
        onSelect: onUnarchive
      })
      items.push({
        label: 'Move to Trash',
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
  }, [menu, notes, refreshNotes, selectedPath, selectNote, prompt, renameActive])

  /**
   * Filter notes for the current view. For folder views we match the
   * top-level folder AND, when a subpath is active, limit to notes
   * inside that subfolder (including deeper descendants). For tag
   * views we match against the tag index — with live re-extraction
   * from the active note's body so newly typed hashtags work instantly.
   */
  const filtered = useMemo<NoteMeta[]>(() => {
    if (view.kind === 'folder') {
      const prefix = view.subpath
        ? `${view.folder}/${view.subpath}/`
        : `${view.folder}/`
      return notes.filter(
        (n) => n.folder === view.folder && n.path.startsWith(prefix)
      )
    }
    return notes.filter((n) => {
      if (n.folder === 'trash') return false
      if (activeNote && activeNote.path === n.path) {
        return extractTags(activeNote.body).includes(view.tag)
      }
      return n.tags.includes(view.tag)
    })
  }, [notes, view, activeNote])

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
    view.kind === 'folder' ? `folder:${view.folder}:${view.subpath}` : `tag:${view.tag}`
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

  const heading =
    view.kind === 'folder'
      ? view.subpath
        ? view.subpath.split('/').slice(-1)[0]
        : view.folder[0].toUpperCase() + view.folder.slice(1)
      : `#${view.tag}`

  const newTargetFolder = view.kind === 'folder' && view.folder !== 'trash' ? view.folder : 'inbox'

  const isNoteListFocused = focusedPanel === 'notelist'

  useEffect(() => {
    if (!isNoteListFocused) return
    const next =
      orderedFiltered.length === 0 ? 0 : Math.min(noteListCursorIndex, orderedFiltered.length - 1)
    if (next !== noteListCursorIndex) {
      useStore.getState().setNoteListCursorIndex(next)
    }
  }, [isNoteListFocused, noteListCursorIndex, orderedFiltered.length])

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
          <span className="text-xs text-ink-400">{filtered.length}</span>
        </div>
        <div className="flex items-center gap-1">
          {view.kind === 'folder' && view.folder === 'trash' && filtered.length > 0 && (
            <button
              onClick={() => void emptyTrash()}
              className="rounded-md px-2 py-1 text-xs text-ink-500 hover:bg-paper-200 hover:text-ink-800"
            >
              Empty
            </button>
          )}
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-500 hover:bg-paper-200 hover:text-ink-800"
            title="New note"
            onClick={() => void createAndOpen(newTargetFolder)}
          >
            <PlusIcon />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-500 hover:bg-paper-200 hover:text-ink-800"
            title="Hide note list (⌘2)"
            onClick={toggleNoteList}
          >
            <ColumnsIcon />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-ink-400">
            {view.kind === 'folder' && view.folder === 'trash'
              ? 'Trash is empty.'
              : 'No notes here yet.'}
          </div>
        ) : (
          orderedFiltered.map((n, i) => (
            <NoteRow
              key={n.path}
              note={n}
              active={n.path === selectedPath}
              onSelect={() => void selectNote(n.path)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, path: n.path })
              }}
              noteListIdx={i}
              vimHighlight={isNoteListFocused && noteListCursorIndex === i}
            />
          ))
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
