import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { NoteMeta } from '@shared/ipc'
import { isPaletteNextKey, isPalettePreviousKey } from '../lib/palette-nav'
import { isImeComposing } from '../lib/ime'
import {
  buildNoteSearchIndex,
  parseNoteSearchQuery,
  searchNoteIndex
} from '../lib/note-search'
import { focusEditorNormalMode } from '../lib/editor-focus'
import {
  destinationLabel,
  parseDestinationText,
  searchCreateDraft,
  type AreaLabels,
  type SearchCreateDraft
} from '../lib/search-create'
import { resolveSystemFolderLabels } from '../lib/system-folder-labels'
import { isPrimaryNotesAtRoot } from '../lib/vault-layout'
import { useToastStore } from '../lib/toast'
import { Modal } from './ui/Modal'
import { SearchCreateForm, type SearchCreateTarget } from './SearchCreateForm'

export function SearchPalette(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const selectNote = useStore((s) => s.selectNote)
  const createAndOpen = useStore((s) => s.createAndOpen)
  const trashNote = useStore((s) => s.trashNote)
  const vault = useStore((s) => s.vault)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // While set, the palette shows the New note form instead of the results.
  const [draft, setDraft] = useState<SearchCreateDraft | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const searchIndex = useMemo(() => buildNoteSearchIndex(notes), [notes])

  // Strip `#tag` tokens off the query so the user can narrow by one or
  // more tags inline: `#ops #prod migration` means "notes tagged with
  // #ops AND #prod, fuzzy-matching 'migration'". Pure-tag queries (no
  // free text) still work — in that case we just list matching notes.
  const { freeText, tagTokens } = useMemo(() => parseNoteSearchQuery(query), [query])

  const results = useMemo(() => {
    return searchNoteIndex(searchIndex, query, { limit: 20 })
  }, [query, searchIndex])

  // A search that finds nothing is often the moment the note should start
  // existing (#826). The free text drafts the note to create (its `#tags`
  // become the note's tags); the create row sits after the results, at index
  // results.length, and leads to a form where the name, folder and tags can
  // still change, so it shows even when the name is taken or not yet valid.
  const createRow = useMemo(() => searchCreateDraft(freeText, tagTokens), [freeText, tagTokens])
  const rowCount = results.length + (createRow ? 1 : 0)
  const labels: AreaLabels = useMemo(() => {
    const resolved = resolveSystemFolderLabels(systemFolderLabels)
    return {
      ...resolved,
      inbox: isPrimaryNotesAtRoot(vaultSettings) ? (vault?.name ?? 'Vault') : resolved.inbox
    }
  }, [systemFolderLabels, vault?.name, vaultSettings])
  const createRowWhere = useMemo(() => {
    if (!createRow) return ''
    const parsed = parseDestinationText(createRow.folderText)
    return parsed.destination ? destinationLabel(parsed.destination, labels) : ''
  }, [createRow, labels])

  // The input unmounts while the form shows, so focus it again when the form
  // hands back (and on open, when there is no form yet).
  useEffect(() => {
    if (!draft) inputRef.current?.focus()
  }, [draft])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-search-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const open = async (note: NoteMeta): Promise<void> => {
    setSearchOpen(false)
    await selectNote(note.path)
    focusEditorNormalMode()
  }

  // Same landing as `:e name` and the dead-wikilink flow: the new note opens
  // with the editor focused, because its name was settled in the form.
  const createFromForm = async (target: SearchCreateTarget): Promise<void> => {
    setSearchOpen(false)
    await createAndOpen(target.destination.folder, target.destination.subpath, {
      title: target.title,
      tags: target.tags
    })
    focusEditorNormalMode()
  }

  const close = (): void => {
    setSearchOpen(false)
    focusEditorNormalMode()
  }

  // Trash the highlighted note without leaving the palette (Discord ask: a
  // search that ends in "this needs to go" used to mean opening the note or
  // hunting for it in the sidebar). Same confirmation and clean-up as every
  // other Move to Trash; the row disappears because search never lists trash.
  const trashSelected = async (): Promise<void> => {
    const note = results[active]
    if (!note) return
    const moved = await trashNote(note.path)
    inputRef.current?.focus()
    if (!moved) return
    useToastStore.getState().addToast(`Moved "${note.title}" to Trash`, 'success')
    setActive((a) => Math.max(0, Math.min(a, results.length - 2)))
  }

  if (draft) {
    return (
      <Modal size="md" layer="palette" onClose={close} closeOnEsc={false}>
        <SearchCreateForm
          draft={draft}
          onBack={() => setDraft(null)}
          onCreate={(target) => void createFromForm(target)}
          onOpenExisting={(note) => void open(note)}
        />
      </Modal>
    )
  }

  return (
    <Modal size="md" layer="palette" onClose={close} closeOnEsc={false}>
      <div className="border-b border-paper-300/70 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            placeholder="Search notes…  ·  use #tag to filter"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // While composing (IME), let the input own Enter/Arrows. (#183)
              if (isImeComposing(e)) return
              if (isPaletteNextKey(e)) {
                e.preventDefault()
                e.stopPropagation()
                setActive((a) => Math.max(0, Math.min(rowCount - 1, a + 1)))
              } else if (isPalettePreviousKey(e)) {
                e.preventDefault()
                e.stopPropagation()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault()
                e.stopPropagation()
                if (createRow) setDraft(createRow)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const note = results[active]
                if (note) void open(note)
                else if (createRow && active === results.length) setDraft(createRow)
              } else if (
                e.ctrlKey &&
                !e.metaKey &&
                !e.altKey &&
                !e.shiftKey &&
                e.key.toLowerCase() === 'd'
              ) {
                e.preventDefault()
                e.stopPropagation()
                void trashSelected()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                close()
              }
            }}
            className="w-full bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
          />
          {tagTokens.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tagTokens.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent ring-1 ring-accent/30"
                >
                  #{t}
                </span>
              ))}
              <span className="text-xs text-ink-500">
                notes must carry {tagTokens.length === 1 ? 'this tag' : 'all of these tags'}
              </span>
            </div>
          )}
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-x-hidden overflow-y-auto py-1">
          {rowCount === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-ink-400">No matches.</div>
          ) : (
            results.map((n, i) => (
              <button
                key={n.path}
                data-search-idx={i}
                onClick={() => open(n)}
                onMouseMove={() => setActive(i)}
                className={[
                  'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                  i === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                ].join(' ')}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">
                  {n.title}
                </span>
                <span className="shrink-0 text-xs uppercase tracking-wide text-ink-400">
                  {n.folder}
                </span>
              </button>
            ))
          )}
          {createRow && results.length > 0 && (
            <div className="my-1 border-t border-paper-300/70" aria-hidden="true" />
          )}
          {createRow && (
            <button
              data-search-idx={results.length}
              data-search-create=""
              onClick={() => setDraft(createRow)}
              onMouseMove={() => setActive(results.length)}
              className={[
                'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                active === results.length ? 'bg-paper-200' : 'hover:bg-paper-200/70'
              ].join(' ')}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                <span className="text-ink-500">Create </span>
                <span className="font-medium">"{createRow.name}"</span>
                <span className="text-ink-500">…</span>
              </span>
              <span className="shrink-0 text-xs text-ink-400">{createRowWhere}</span>
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 border-t border-paper-300/70 bg-paper-100 px-4 py-2 text-xs text-ink-500">
          <span>
            <kbd className="rounded bg-paper-200 px-1">↑↓</kbd>{' '}
            <kbd className="rounded bg-paper-200 px-1">Ctrl+N/P</kbd> move
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">↵</kbd> open
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">Shift+↵</kbd> new note
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">Ctrl+D</kbd> trash
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd> close
          </span>
        </div>
    </Modal>
  )
}
