import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isQuickNotesViewActive, useStore } from '../store'
import { ArrowUpRightIcon, PlusIcon, ZapIcon } from './icons'
import { CollectionViewHeader } from './CollectionViewHeader'
import { resolveQuickNoteTitle } from '../lib/quick-note-title'
import { advanceSequence, getKeymapBinding, matchesSequenceToken } from '../lib/keymaps'
import { getSystemFolderLabel } from '../lib/system-folder-labels'

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

export function QuickNotesView(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const selectNote = useStore((s) => s.selectNote)
  const closeActiveNote = useStore((s) => s.closeActiveNote)
  const createAndOpen = useStore((s) => s.createAndOpen)
  const quickNoteDateTitle = useStore((s) => s.quickNoteDateTitle)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const amActive = useStore(isQuickNotesViewActive)
  const quickLabel = getSystemFolderLabel('quick', systemFolderLabels)

  const [filter, setFilter] = useState('')
  const [cursorIndex, setCursorIndex] = useState(0)
  const filterRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()

  const quickNotes = useMemo(
    () =>
      notes
        .filter((note) => note.folder === 'quick')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [notes]
  )

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return quickNotes
    return quickNotes.filter(
      (note) =>
        note.title.toLowerCase().includes(q) ||
        note.excerpt.toLowerCase().includes(q) ||
        note.path.toLowerCase().includes(q)
    )
  }, [quickNotes, filter])

  const safeCursor = Math.min(cursorIndex, Math.max(0, filtered.length - 1))
  const current = filtered[safeCursor] ?? null

  useEffect(() => {
    if (safeCursor !== cursorIndex) setCursorIndex(safeCursor)
  }, [cursorIndex, safeCursor])

  useEffect(() => {
    if (!current) return
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-quick-row="${cssEscape(current.path)}"]`
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

  const createQuickNote = useCallback(async () => {
    const title = resolveQuickNoteTitle(useStore.getState().notes, quickNoteDateTitle)
    await createAndOpen('quick', '', { title, focusTitle: true })
  }, [createAndOpen, quickNoteDateTitle])

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

      if (matchesSequenceToken(e, overrides, 'nav.newQuickNote')) {
        consume()
        void createQuickNote()
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
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => {
      if (gTimer.current) clearTimeout(gTimer.current)
      window.removeEventListener('keydown', handler, true)
    }
  }, [amActive, closeActiveNote, createQuickNote, current, filter, filtered.length, keymapOverrides, openNote])

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
          badge="Capture"
          badgeIcon={<ZapIcon width={13} height={13} />}
          title={quickLabel}
          description="Browse quick captures, filter by title or path, and jump straight into the one you want."
          count={quickNotes.length}
          filter={filter}
          onFilterChange={setFilter}
          filterPlaceholder="Filter quick notes…"
          inputRef={filterRef}
          actions={
            <button
              type="button"
              onClick={() => void createQuickNote()}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white transition-colors hover:opacity-95"
            >
              <PlusIcon width={15} height={15} />
              New Note
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
                <ZapIcon width={24} height={24} />
              </div>
              <div className="text-lg font-medium text-ink-900">
                {quickNotes.length === 0
                  ? `No ${quickLabel} yet.`
                  : `No ${quickLabel.toLowerCase()} match that filter.`}
              </div>
              <div className="max-w-xl text-sm leading-7 text-ink-500">
                {quickNotes.length === 0
                  ? `${quickLabel} are for fast capture. Create a note and it will show up here immediately.`
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
                    data-quick-row={note.path}
                    onMouseMove={() => setCursorIndex(index)}
                    onClick={() => void openNote(note.path)}
                    className={[
                      'group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                      active ? 'bg-paper-200/80' : 'hover:bg-paper-100/80'
                    ].join(' ')}
                  >
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-paper-300/70 bg-paper-100/85 text-ink-500">
                      <ZapIcon width={15} height={15} />
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
