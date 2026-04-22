import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ContextMenuItem } from './ContextMenu'
import type { NoteMeta } from '@shared/ipc'
import { isArchiveViewActive, useStore } from '../store'
import { ArchiveIcon, ArrowUpRightIcon, TrashIcon } from './icons'
import { CollectionViewHeader } from './CollectionViewHeader'
import { confirmMoveToTrash } from '../lib/confirm-trash'
import { ContextMenu } from './ContextMenu'
import { buildMoveNotePrompt, parseMoveNoteTarget } from '../lib/move-note'
import { usePrompt } from './PromptModal'
import { advanceSequence, getKeymapBinding, matchesSequenceToken } from '../lib/keymaps'
import { resolveSystemFolderLabels } from '../lib/system-folder-labels'

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

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

export function ArchiveView(): JSX.Element {
  const vault = useStore((s) => s.vault)
  const notes = useStore((s) => s.notes)
  const folders = useStore((s) => s.folders)
  const refreshNotes = useStore((s) => s.refreshNotes)
  const selectNote = useStore((s) => s.selectNote)
  const closeActiveNote = useStore((s) => s.closeActiveNote)
  const openNoteInTab = useStore((s) => s.openNoteInTab)
  const moveNote = useStore((s) => s.moveNote)
  const tabsEnabled = useStore((s) => s.tabsEnabled)
  const selectedPath = useStore((s) => s.selectedPath)
  const renameNote = useStore((s) => s.renameNote)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const workspaceMode = useStore((s) => s.workspaceMode)
  const amActive = useStore(isArchiveViewActive)
  const { prompt, modal: promptModal } = usePrompt()
  const folderLabels = useMemo(
    () => resolveSystemFolderLabels(systemFolderLabels),
    [systemFolderLabels]
  )
  const canRevealInFileManager =
    window.zen.getAppInfo().runtime === 'desktop' && workspaceMode !== 'remote'
  const absolutePathLabel =
    workspaceMode === 'remote' ? 'Copy Server Path' : 'Copy Absolute Path'

  const [filter, setFilter] = useState('')
  const [cursorIndex, setCursorIndex] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()

  const archived = useMemo(
    () =>
      notes
        .filter((note) => note.folder === 'archive')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [notes]
  )

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return archived
    return archived.filter(
      (note) =>
        note.title.toLowerCase().includes(q) ||
        note.excerpt.toLowerCase().includes(q) ||
        note.path.toLowerCase().includes(q)
    )
  }, [archived, filter])

  const safeCursor = Math.min(cursorIndex, Math.max(0, filtered.length - 1))
  const current = filtered[safeCursor] ?? null

  useEffect(() => {
    if (safeCursor !== cursorIndex) setCursorIndex(safeCursor)
  }, [cursorIndex, safeCursor])

  useEffect(() => {
    if (!current) return
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-archive-row="${cssEscape(current.path)}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const openNote = useCallback(
    async (path: string) => {
      await selectNote(path)
      useStore.getState().setFocusedPanel('editor')
      requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
    },
    [selectNote]
  )

  const unarchiveNote = useCallback(
    async (note: NoteMeta) => {
      await window.zen.unarchiveNote(note.path)
      await refreshNotes()
    },
    [refreshNotes]
  )

  const moveNoteToTrash = useCallback(
    async (note: NoteMeta) => {
      if (!(await confirmMoveToTrash(note.title))) return
      await window.zen.moveToTrash(note.path)
      await refreshNotes()
    },
    [refreshNotes]
  )

  const openMenuForCurrent = useCallback(() => {
    if (!current) return
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-archive-row="${cssEscape(current.path)}"]`
    )
    if (!el) return
    const rect = el.getBoundingClientRect()
    setMenu({
      path: current.path,
      x: Math.min(window.innerWidth - 12, Math.max(12, rect.left + Math.min(rect.width * 0.45, 240))),
      y: Math.min(window.innerHeight - 12, Math.max(12, rect.top + rect.height / 2))
    })
  }, [current])

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return []
    const note = notes.find((item) => item.path === menu.path)
    if (!note) return []

    const items: ContextMenuItem[] = [
      {
        label: 'Open',
        onSelect: async () => {
          await openNote(note.path)
        }
      }
    ]

    if (tabsEnabled) {
      items.push({
        label: 'Open in New Tab',
        onSelect: async () => {
          await openNoteInTab(note.path)
        }
      })
    }

    items.push({
      label: 'Rename…',
      onSelect: async () => {
        const next = await prompt({
          title: 'Rename note',
          initialValue: note.title,
          okLabel: 'Rename',
          validate: (value) => {
            if (/[\\/]/.test(value)) return 'Title cannot contain / or \\'
            return null
          }
        })
        if (!next || next === note.title) return
        await renameNote(note.path, next)
      }
    })
    items.push({
      label: 'Move…',
      onSelect: async () => {
        const target = await prompt(buildMoveNotePrompt(note, folders))
        if (!target) return
        const dest = parseMoveNoteTarget(target)
        await moveNote(note.path, dest.folder, dest.subpath)
      }
    })
    items.push({
      label: 'Duplicate',
      onSelect: async () => {
        const meta = await window.zen.duplicateNote(note.path)
        await refreshNotes()
        await selectNote(meta.path)
      }
    })
    items.push({
      label: 'Copy as Wikilink',
      onSelect: async () => {
        window.zen.clipboardWriteText(`[[${note.title}]]`)
      }
    })
    items.push({
      label: 'Copy Path',
      onSelect: async () => {
        window.zen.clipboardWriteText(note.path)
      }
    })
    items.push({
      label: absolutePathLabel,
      onSelect: async () => {
        const root = vault?.root ?? ''
        const sep = root.includes('\\') ? '\\' : '/'
        const abs = [root.replace(/[\\/]+$/, ''), ...note.path.split('/').filter(Boolean)].join(sep)
        window.zen.clipboardWriteText(abs)
      }
    })
    items.push({
      label: 'Open in Floating Window',
      onSelect: async () => {
        await window.zen.openNoteWindow(note.path)
      }
    })
    if (canRevealInFileManager) {
      items.push({
        label: 'Reveal in File Manager',
        onSelect: async () => {
          await window.zen.revealNote(note.path)
        }
      })
    }
    items.push({ kind: 'separator' })
    items.push({
      label: `Move to ${folderLabels.inbox}`,
      icon: <ArrowUpRightIcon />,
      onSelect: async () => {
        const meta = await window.zen.unarchiveNote(note.path)
        await refreshNotes()
        if (selectedPath === note.path) await selectNote(meta.path)
      }
    })
    items.push({
      label: `Move to ${folderLabels.trash}`,
      icon: <TrashIcon />,
      danger: true,
      onSelect: async () => {
        if (!(await confirmMoveToTrash(note.title))) return
        await window.zen.moveToTrash(note.path)
        await refreshNotes()
        if (selectedPath === note.path) await selectNote(null)
      }
    })

    return items
  }, [
    folders,
    menu,
    moveNote,
    notes,
    openNote,
    openNoteInTab,
    prompt,
    refreshNotes,
    renameNote,
    selectNote,
    selectedPath,
    tabsEnabled,
    canRevealInFileManager,
    absolutePathLabel,
    vault?.root,
    folderLabels.inbox,
    folderLabels.trash
  ])

  useEffect(() => {
    if (!amActive) return
    const handler = (e: KeyboardEvent): void => {
      if (document.querySelector('[data-ctx-menu]') || document.querySelector('[data-prompt-modal]')) {
        return
      }
      const active = document.activeElement as HTMLElement | null
      if (active) {
        const tag = active.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const key = e.key
      const overrides = keymapOverrides
      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }

      if (key === 'Escape') {
        if (filter) {
          consume()
          setFilter('')
          return
        }
        consume()
        void closeActiveNote()
        return
      }

      if (matchesSequenceToken(e, overrides, 'nav.filter')) {
        consume()
        filterRef.current?.focus()
        filterRef.current?.select()
        return
      }

      if (matchesSequenceToken(e, overrides, 'nav.contextMenu') && current) {
        consume()
        openMenuForCurrent()
        return
      }

      if (matchesSequenceToken(e, overrides, 'nav.moveDown') || key === 'ArrowDown') {
        consume()
        setCursorIndex((i) => Math.max(0, Math.min(filtered.length - 1, i + 1)))
        return
      }
      if (matchesSequenceToken(e, overrides, 'nav.moveUp') || key === 'ArrowUp') {
        consume()
        setCursorIndex((i) => Math.max(0, Math.min(filtered.length - 1, i - 1)))
        return
      }
      if (matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
        consume()
        setCursorIndex(filtered.length - 1)
        return
      }
      if (
        advanceSequence(
          e,
          getKeymapBinding(overrides, 'nav.jumpTop'),
          gPending,
          gTimer,
          () => setCursorIndex(0),
          consume,
          500
        )
      ) {
        return
      }
      if ((key === 'Enter' || matchesSequenceToken(e, overrides, 'nav.openResult')) && current) {
        consume()
        void openNote(current.path)
        return
      }
      if (matchesSequenceToken(e, overrides, 'nav.unarchive') && current) {
        consume()
        void unarchiveNote(current)
        return
      }
      if ((matchesSequenceToken(e, overrides, 'nav.delete') || key === 'd') && current) {
        consume()
        void moveNoteToTrash(current)
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => {
      if (gTimer.current) clearTimeout(gTimer.current)
      window.removeEventListener('keydown', handler, true)
    }
  }, [
    amActive,
    closeActiveNote,
    current,
    filter,
    filtered.length,
    keymapOverrides,
    moveNoteToTrash,
    openMenuForCurrent,
    openNote,
    unarchiveNote
  ])

  return (
    <Fragment>
      <div
        data-preview-scroll
        tabIndex={0}
        onMouseDownCapture={() => setFocusedPanel('editor')}
        onFocusCapture={() => setFocusedPanel('editor')}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none"
      >
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-6">
          <CollectionViewHeader
            badge={folderLabels.archive}
            badgeIcon={<ArchiveIcon width={13} height={13} />}
            title={folderLabels.archive}
            description={`Review archived notes in one place and move anything active back into ${folderLabels.inbox} when needed.`}
            count={archived.length}
            filter={filter}
            onFilterChange={setFilter}
            filterPlaceholder="Filter archived notes…"
            inputRef={filterRef}
          />

          <section
            ref={rootRef}
            className="overflow-hidden rounded-[24px] border border-paper-300/70 bg-paper-50/34 shadow-[0_12px_42px_rgba(15,23,42,0.06)]"
          >
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-paper-300/70 bg-paper-100/85 text-ink-500">
                  <ArchiveIcon width={24} height={24} />
                </div>
                <div className="text-lg font-medium text-ink-900">
                  {archived.length === 0
                    ? `${folderLabels.archive} is empty.`
                    : `No ${folderLabels.archive.toLowerCase()} notes match that filter.`}
                </div>
                <div className="max-w-xl text-sm leading-7 text-ink-500">
                  {archived.length === 0
                    ? `${folderLabels.archive} is for notes you want to keep around without leaving them in the active workspace.`
                    : 'Try a different title, path, or excerpt fragment.'}
                </div>
              </div>
            ) : (
              <div className="divide-y divide-paper-300/60">
                {filtered.map((note, index) => {
                  const active = index === safeCursor
                  return (
                  <div
                    key={note.path}
                    role="button"
                    tabIndex={-1}
                    data-archive-row={note.path}
                      onMouseMove={() => setCursorIndex(index)}
                      onClick={() => void openNote(note.path)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setCursorIndex(index)
                      setMenu({ x: e.clientX, y: e.clientY, path: note.path })
                    }}
                    className={[
                      'group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                      active ? 'bg-paper-200/80' : 'hover:bg-paper-100/80'
                    ].join(' ')}
                  >
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-paper-300/70 bg-paper-100/85 text-ink-500">
                      <ArchiveIcon width={15} height={15} />
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                        <span className="truncate text-sm font-medium text-ink-900">{note.title}</span>
                        <span className="text-[11px] uppercase tracking-[0.16em] text-ink-400">
                          {formatDate(note.updatedAt)}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-ink-400">{note.path}</div>
                      <div className="mt-1 line-clamp-1 text-[13px] leading-5 text-ink-600">
                        {note.excerpt || 'Empty note'}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 self-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void openNote(note.path)
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-paper-100/85 px-2.5 py-1 text-[11px] font-medium text-ink-700 transition-colors hover:bg-paper-200 hover:text-ink-900"
                      >
                        <ArrowUpRightIcon width={13} height={13} />
                        Open
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void unarchiveNote(note)
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-paper-100/85 px-2.5 py-1 text-[11px] font-medium text-ink-700 transition-colors hover:bg-paper-200 hover:text-ink-900"
                      >
                        <ArrowUpRightIcon width={13} height={13} />
                        Unarchive
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void moveNoteToTrash(note)
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-[rgb(var(--z-red))] transition-colors hover:bg-red-500/16"
                      >
                        <TrashIcon width={13} height={13} />
                        Trash
                      </button>
                    </div>
                  </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
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
    </Fragment>
  )
}
