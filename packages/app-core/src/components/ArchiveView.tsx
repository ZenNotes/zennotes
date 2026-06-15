import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SoftDeletedEntry } from '@shared/ipc'
import { isArchiveViewActive, useStore } from '../store'
import { useT } from '../lib/i18n';
import { formatDate } from '../lib/format-date'
import { ArchiveIcon, ArrowUpRightIcon, DatabaseIcon, DocumentTextIcon, PaperclipIcon, TrashIcon } from './icons'
import { FolderGlyphIcon } from './FolderIcons'
import { CollectionViewHeader } from './CollectionViewHeader'
import { confirmApp } from '../lib/confirm-requests'
import { advanceSequence, getKeymapBinding, matchesSequenceToken } from '../lib/keymaps'
import { resolveSystemFolderLabels } from '../lib/system-folder-labels'

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

export function ArchiveView(): JSX.Element {
  const t = useT();
  const language = useStore((s) => s.language)
  const softDeletedEntries = useStore((s) => s.softDeleted)
  const restoreSoftDeleted = useStore((s) => s.restoreSoftDeleted)
  const purgeSoftDeleted = useStore((s) => s.purgeSoftDeleted)
  const closeActiveNote = useStore((s) => s.closeActiveNote)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const vimMode = useStore((s) => s.vimMode)
  const amActive = useStore(isArchiveViewActive)
  const folderLabels = useMemo(
    () => resolveSystemFolderLabels(systemFolderLabels, t),
    [systemFolderLabels, t]
  )

  const [filter, setFilter] = useState('')
  const [cursorIndex, setCursorIndex] = useState(0)
  const filterRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()

  const kindLabel = useCallback(
    (kind: SoftDeletedEntry['kind']) =>
      kind === 'database'
        ? t('Form')
        : kind === 'asset'
          ? t('Asset')
          : kind === 'note'
            ? t('Note')
            : t('Folder'),
    [t]
  )

  // Everything archived, newest first — each kind (note/folder/form) is one
  // logical row sourced from the meta store. (Assets can't be archived.)
  const archived = useMemo(
    () =>
      softDeletedEntries
        .filter((e) => e.top === 'archive')
        .sort((a, b) => b.deletedAt - a.deletedAt),
    [softDeletedEntries]
  )

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return archived
    return archived.filter(
      (entry) =>
        entry.title.toLowerCase().includes(q) ||
        entry.originalRel.toLowerCase().includes(q) ||
        kindLabel(entry.kind).toLowerCase().includes(q)
    )
  }, [archived, filter, kindLabel])

  const safeCursor = Math.min(cursorIndex, Math.max(0, filtered.length - 1))
  const current = filtered[safeCursor] ?? null

  useEffect(() => {
    if (safeCursor !== cursorIndex) setCursorIndex(safeCursor)
  }, [cursorIndex, safeCursor])

  useEffect(() => {
    if (!current) return
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-archive-row="${cssEscape(current.id)}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const restoreEntry = useCallback(
    async (entry: SoftDeletedEntry) => {
      await restoreSoftDeleted(`${entry.top}/${entry.id}`)
    },
    [restoreSoftDeleted]
  )

  const deleteEntryForever = useCallback(
    async (entry: SoftDeletedEntry) => {
      const ok = await confirmApp({
        title: `${t('Permanently delete')} ${kindLabel(entry.kind)} "${entry.title}"?`,
        description: t('This cannot be undone.'),
        confirmLabel: t('Delete permanently'),
        danger: true
      })
      if (!ok) return
      await purgeSoftDeleted(`${entry.top}/${entry.id}`)
    },
    [purgeSoftDeleted, t, kindLabel]
  )

  useEffect(() => {
    if (!amActive || !vimMode) return
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
      if (
        (key === 'Enter' ||
          matchesSequenceToken(e, overrides, 'nav.restore') ||
          matchesSequenceToken(e, overrides, 'nav.unarchive')) &&
        current
      ) {
        consume()
        void restoreEntry(current)
        return
      }
      if ((matchesSequenceToken(e, overrides, 'nav.delete') || key === 'd') && current) {
        consume()
        void deleteEntryForever(current)
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
    deleteEntryForever,
    filter,
    filtered.length,
    keymapOverrides,
    restoreEntry,
    vimMode
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
          title={folderLabels.archive}
          description={t(
            'Review archived notes in one place and move anything active back into {inbox} when needed.'
          ).replace('{inbox}', folderLabels.inbox)}
          count={archived.length}
          filter={filter}
          onFilterChange={setFilter}
          filterPlaceholder={t('Filter archived notes…')}
          inputRef={filterRef}
        />

        <section
          ref={rootRef}
          className="overflow-hidden rounded-3xl border border-paper-300/70 bg-paper-50/34 shadow-[0_12px_42px_rgba(15,23,42,0.06)]"
        >
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-paper-300/70 bg-paper-100/85 text-ink-500">
                <ArchiveIcon width={24} height={24} />
              </div>
              <div className="text-lg font-medium text-ink-900">
                {archived.length === 0
                  ? t('{label} is empty.').replace('{label}', folderLabels.archive)
                  : t('No {label} notes match that filter.').replace(
                      '{label}',
                      folderLabels.archive.toLowerCase()
                    )}
              </div>
              <div className="max-w-xl text-sm leading-7 text-ink-500">
                {archived.length === 0
                  ? t(
                      '{label} is for notes you want to keep around without leaving them in the active workspace.'
                    ).replace('{label}', folderLabels.archive)
                  : t('Try a different title, path, or excerpt fragment.')}
              </div>
            </div>
          ) : (
            <div className="divide-y divide-paper-300/60">
              {filtered.map((entry, index) => {
                const active = index === safeCursor
                return (
                  <div
                    key={entry.id}
                    role="button"
                    tabIndex={-1}
                    data-archive-row={entry.id}
                    onMouseMove={() => setCursorIndex(index)}
                    className={[
                      'group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                      active ? 'bg-paper-200/80' : 'hover:bg-paper-100/80'
                    ].join(' ')}
                  >
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-paper-300/70 bg-paper-100/85 text-ink-500">
                      {entry.kind === 'database' ? (
                        <DatabaseIcon width={15} height={15} />
                      ) : entry.kind === 'asset' ? (
                        <PaperclipIcon width={15} height={15} />
                      ) : entry.kind === 'note' ? (
                        <DocumentTextIcon width={15} height={15} />
                      ) : (
                        <FolderGlyphIcon />
                      )}
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                        <span className="truncate text-sm font-medium text-ink-900">{entry.title}</span>
                        <span className="text-xs uppercase tracking-[0.16em] text-ink-500">
                          {kindLabel(entry.kind)} · {formatDate(entry.deletedAt, language)}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-ink-500">{entry.originalRel}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 self-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void restoreEntry(entry)
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-paper-100/85 px-2.5 py-1 text-xs font-medium text-ink-700 transition-colors hover:bg-paper-200 hover:text-ink-900"
                      >
                        <ArrowUpRightIcon width={13} height={13} />
                        {t('Restore')}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void deleteEntryForever(entry)
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-1 text-xs font-medium text-[rgb(var(--z-red))] transition-colors hover:bg-red-500/16"
                      >
                        <TrashIcon width={13} height={13} />
                        {t('Delete')}
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
