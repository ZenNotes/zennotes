import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteMeta } from '@shared/ipc'
import { isTrashViewActive, useStore } from '../store'
import { ArrowUpRightIcon, TrashIcon } from './icons'
import { CollectionViewHeader } from './CollectionViewHeader'
import { advanceSequence, getKeymapBinding, matchesSequenceToken } from '../lib/keymaps'
import { getSystemFolderLabel } from '../lib/system-folder-labels'
import { confirmApp } from './ConfirmHost'

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

export function TrashView(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const refreshNotes = useStore((s) => s.refreshNotes)
  const selectNote = useStore((s) => s.selectNote)
  const closeActiveNote = useStore((s) => s.closeActiveNote)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const amActive = useStore(isTrashViewActive)
  const trashLabel = getSystemFolderLabel('trash', systemFolderLabels)

  const [filter, setFilter] = useState('')
  const [cursorIndex, setCursorIndex] = useState(0)
  const filterRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()

  const trashed = useMemo(
    () =>
      notes
        .filter((note) => note.folder === 'trash')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [notes]
  )

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return trashed
    return trashed.filter(
      (note) =>
        note.title.toLowerCase().includes(q) ||
        note.excerpt.toLowerCase().includes(q) ||
        note.path.toLowerCase().includes(q)
    )
  }, [trashed, filter])

  const safeCursor = Math.min(cursorIndex, Math.max(0, filtered.length - 1))
  const current = filtered[safeCursor] ?? null

  useEffect(() => {
    if (safeCursor !== cursorIndex) setCursorIndex(safeCursor)
  }, [cursorIndex, safeCursor])

  useEffect(() => {
    if (!current) return
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-trash-row="${cssEscape(current.path)}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const openNote = useCallback(async (note: NoteMeta) => {
    await selectNote(note.path)
    useStore.getState().setFocusedPanel('editor')
    requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
  }, [selectNote])

  const openCurrent = useCallback(async () => {
    if (!current) return
    await openNote(current)
  }, [current, openNote])

  const restoreNote = useCallback(
    async (note: NoteMeta) => {
      await window.zen.restoreFromTrash(note.path)
      await refreshNotes()
    },
    [refreshNotes]
  )

  const deleteNoteForever = useCallback(
    async (note: NoteMeta) => {
      const ok = await confirmApp({
        title: `Delete "${note.title}" permanently?`,
        description: 'This cannot be undone.',
        confirmLabel: 'Delete permanently',
        danger: true
      })
      if (!ok) return
      await window.zen.deleteNote(note.path)
      await refreshNotes()
    },
    [refreshNotes]
  )

  const emptyTrash = useCallback(async () => {
    if (trashed.length === 0) return
    const ok = await confirmApp({
      title: `Delete ${trashed.length} trashed note${trashed.length === 1 ? '' : 's'} permanently?`,
      description: 'This cannot be undone.',
      confirmLabel: 'Empty trash',
      danger: true
    })
    if (!ok) return
    await window.zen.emptyTrash()
    await refreshNotes()
  }, [refreshNotes, trashed.length])

  useEffect(() => {
    if (!amActive) return
    const handler = (e: KeyboardEvent): void => {
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
        void openCurrent()
        return
      }
      if (matchesSequenceToken(e, overrides, 'nav.restore') && current) {
        consume()
        void restoreNote(current)
        return
      }
      if ((matchesSequenceToken(e, overrides, 'nav.delete') || key === 'd') && current) {
        consume()
        void deleteNoteForever(current)
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
    deleteNoteForever,
    filter,
    filtered.length,
    keymapOverrides,
    openCurrent,
    restoreNote
  ])

  return (
    <div
      data-preview-scroll
      tabIndex={0}
      onMouseDownCapture={() => setFocusedPanel('editor')}
      onFocusCapture={() => setFocusedPanel('editor')}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-6">
        <CollectionViewHeader
          badge="Recovery"
          badgeIcon={<TrashIcon width={13} height={13} />}
          title={trashLabel}
          description="Review deleted notes, restore what you still need, and only empty the bin when you want permanent removal."
          count={trashed.length}
          filter={filter}
          onFilterChange={setFilter}
          filterPlaceholder="Filter trashed notes…"
          inputRef={filterRef}
          actions={
            <button
              type="button"
              onClick={() => void emptyTrash()}
              disabled={trashed.length === 0}
              className={[
                'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
                trashed.length === 0
                  ? 'cursor-default bg-paper-100/60 text-ink-400'
                  : 'bg-red-500/10 text-[rgb(var(--z-red))] hover:bg-red-500/16'
              ].join(' ')}
            >
              <TrashIcon width={15} height={15} />
              {`Empty ${trashLabel}`}
            </button>
          }
        />

        <section
          ref={rootRef}
          className="overflow-hidden rounded-[24px] border border-paper-300/70 bg-paper-50/34 shadow-[0_12px_42px_rgba(15,23,42,0.06)]"
        >
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-paper-300/70 bg-paper-100/85 text-ink-500">
                <TrashIcon width={24} height={24} />
              </div>
              <div className="text-lg font-medium text-ink-900">
                {trashed.length === 0
                  ? `${trashLabel} is empty.`
                  : `No ${trashLabel.toLowerCase()} notes match that filter.`}
              </div>
              <div className="max-w-xl text-sm leading-7 text-ink-500">
                {trashed.length === 0
                  ? 'Deleted notes land here first so you can recover them before removing them permanently.'
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
                    data-trash-row={note.path}
                    onMouseMove={() => setCursorIndex(index)}
                    onClick={() => void openNote(note)}
                    className={[
                      'group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                      active ? 'bg-paper-200/80' : 'hover:bg-paper-100/80'
                    ].join(' ')}
                  >
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-paper-300/70 bg-paper-100/85 text-ink-500">
                      <TrashIcon width={15} height={15} />
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
                          void restoreNote(note)
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-paper-100/85 px-2.5 py-1 text-[11px] font-medium text-ink-700 transition-colors hover:bg-paper-200 hover:text-ink-900"
                      >
                        <ArrowUpRightIcon width={13} height={13} />
                        Restore
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void deleteNoteForever(note)
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-[rgb(var(--z-red))] transition-colors hover:bg-red-500/16"
                      >
                        <TrashIcon width={13} height={13} />
                        Delete
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
  )
}
