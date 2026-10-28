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
import {
  focusEditorAfterReadOpen,
  focusEditorAfterPaletteClose,
  focusEditorNormalMode
} from '../lib/editor-focus'
import {
  destinationLabel,
  parseDestinationText,
  searchCreateDraft,
  type AreaLabels,
  type SearchCreateDraft
} from '../lib/search-create'
import { resolveSystemFolderLabels } from '../lib/system-folder-labels'
import { isPrimaryNotesAtRoot, noteFolderLabel } from '../lib/vault-layout'
import { useToastStore } from '../lib/toast'
import { openTaggedBlock, useTagBlockIndex } from '../lib/tag-block-index'
import { buildSearchPaletteRows, type SearchPaletteRow } from '../lib/search-palette-rows'
import { Modal } from './ui/Modal'
import { SearchCreateForm, type SearchCreateTarget } from './SearchCreateForm'
import { TaggedBlockText } from './TaggedBlockText'

const NO_NOTES: NoteMeta[] = []
const RESULT_LIMIT = 20
// The cursor's key for the create row, which no note path can equal.
const CREATE_ROW_KEY = '\0create'

export function SearchPalette(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const selectNote = useStore((s) => s.selectNote)
  const createAndOpen = useStore((s) => s.createAndOpen)
  const trashNote = useStore((s) => s.trashNote)
  const vault = useStore((s) => s.vault)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const searchTaggedBlocks = useStore((s) => s.searchTaggedBlocks)
  const openTagViewFor = useStore((s) => s.openTagViewFor)
  const [query, setQuery] = useState('')
  // The cursor follows a row's key: tagged blocks fill in under their notes
  // after the notes list, and the highlighted row must not drift while they
  // do. `index` is the fallback when the key leaves the list.
  const [cursor, setCursor] = useState<{ key: string | null; index: number }>({
    key: null,
    index: 0
  })
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
    return searchNoteIndex(searchIndex, query, { limit: RESULT_LIMIT })
  }, [query, searchIndex])

  // Tagged blocks under the notes (#837), only for a query with a #tag and
  // the setting on. Free text can match a block anywhere in a tagged note, so
  // it reads every note carrying the tags; a bare tag query lists the results'
  // blocks only, and only those are read.
  const showBlocks = searchTaggedBlocks && tagTokens.length > 0
  const taggedNotes = useMemo(() => {
    if (!showBlocks) return NO_NOTES
    return notes.filter(
      (n) =>
        n.folder !== 'trash' &&
        tagTokens.every((tag) => n.tags.some((t) => t.toLowerCase() === tag))
    )
  }, [showBlocks, notes, tagTokens])
  const tagBlocks = useTagBlockIndex(showBlocks ? (freeText ? taggedNotes : results) : NO_NOTES)
  const rows = useMemo(
    () =>
      buildSearchPaletteRows({
        results,
        tagged: taggedNotes,
        blocksByPath: tagBlocks.blocksByPath,
        tagTokens,
        freeText,
        enabled: searchTaggedBlocks,
        limit: RESULT_LIMIT
      }),
    [results, taggedNotes, tagBlocks.blocksByPath, tagTokens, freeText, searchTaggedBlocks]
  )

  // A search that finds nothing is often the moment the note should start
  // existing (#826). The free text drafts the note to create (its `#tags`
  // become the note's tags); the create row sits after the result rows, at
  // index rows.length, and leads to a form where the name, folder and tags can
  // still change, so it shows even when the name is taken or not yet valid.
  const createRow = useMemo(() => searchCreateDraft(freeText, tagTokens), [freeText, tagTokens])
  const rowKeys = useMemo(
    () => [...rows.map((row) => row.key), ...(createRow ? [CREATE_ROW_KEY] : [])],
    [rows, createRow]
  )
  const rowCount = rowKeys.length
  const active = useMemo(() => {
    if (cursor.key !== null) {
      const at = rowKeys.indexOf(cursor.key)
      if (at >= 0) return at
    }
    return Math.max(0, Math.min(cursor.index, rowCount - 1))
  }, [rowKeys, rowCount, cursor])
  const setActive = (index: number): void =>
    setCursor({ key: rowKeys[index] ?? null, index })
  const createRowIndex = rows.length
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

  useEffect(() => setCursor({ key: null, index: 0 }), [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-search-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const open = async (note: NoteMeta): Promise<void> => {
    setSearchOpen(false)
    await selectNote(note.path)
    focusEditorAfterReadOpen()
  }

  // A block opens its note at the block's line, highlighted, and records the
  // jump (Ctrl+O comes back); "+N more" opens the rest in the Tags view with
  // the free text still filtering.
  const openRow = async (row: SearchPaletteRow): Promise<void> => {
    if (row.kind === 'note') return open(row.note)
    setSearchOpen(false)
    if (row.kind === 'block') {
      await openTaggedBlock(row.note.path, row.block.startLine)
      focusEditorAfterReadOpen()
      return
    }
    await openTagViewFor(tagTokens, freeText)
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
    focusEditorAfterPaletteClose()
  }

  // Trash the highlighted note without leaving the palette (Discord ask: a
  // search that ends in "this needs to go" used to mean opening the note or
  // hunting for it in the sidebar). Same confirmation and clean-up as every
  // other Move to Trash; the row disappears because search never lists trash.
  // Note rows only: a block or "+N more" row is a place inside a note, and
  // trashing the whole note from it would be a surprise.
  const trashSelected = async (): Promise<void> => {
    const row = rows[active]
    if (row?.kind !== 'note') return
    const note = row.note
    const moved = await trashNote(note.path)
    inputRef.current?.focus()
    if (!moved) return
    useToastStore.getState().addToast(`Moved "${note.title}" to Trash`, 'success')
    setCursor({ key: null, index: Math.max(0, Math.min(active, rowCount - 2)) })
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
                setActive(Math.max(0, Math.min(rowCount - 1, active + 1)))
              } else if (isPalettePreviousKey(e)) {
                e.preventDefault()
                e.stopPropagation()
                setActive(Math.max(0, active - 1))
              } else if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault()
                e.stopPropagation()
                if (createRow) setDraft(createRow)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const row = rows[active]
                if (row) void openRow(row)
                else if (createRow && active === createRowIndex) setDraft(createRow)
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
            rows.map((row, i) => {
              const isActive = i === active
              if (row.kind === 'block') {
                return (
                  <button
                    key={row.key}
                    data-search-idx={i}
                    data-search-block={`${row.note.path}:${row.block.startLine + 1}`}
                    onClick={() => void openRow(row)}
                    onMouseMove={() => setActive(i)}
                    className={[
                      'flex w-full min-w-0 items-start gap-2 py-1.5 pl-8 pr-4 text-left',
                      isActive ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                    ].join(' ')}
                  >
                    <span className="min-w-0 flex-1 border-l-2 border-paper-300/70 pl-2.5 text-ink-800">
                      <TaggedBlockText
                        block={row.block}
                        tags={tagTokens}
                        highlight={freeText}
                        clampClassName="line-clamp-2"
                      />
                    </span>
                    <span className="shrink-0 pt-0.5 font-mono text-2xs text-ink-400">
                      L{row.block.startLine + 1}
                    </span>
                  </button>
                )
              }
              if (row.kind === 'more') {
                return (
                  <button
                    key={row.key}
                    data-search-idx={i}
                    data-search-more={row.note.path}
                    onClick={() => void openRow(row)}
                    onMouseMove={() => setActive(i)}
                    className={[
                      'flex w-full min-w-0 items-center gap-2 py-1 pl-8 pr-4 text-left',
                      isActive ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                    ].join(' ')}
                  >
                    <span className="min-w-0 flex-1 truncate border-l-2 border-paper-300/70 pl-2.5 text-xs text-ink-500">
                      +{row.hidden} more tagged {row.hidden === 1 ? 'block' : 'blocks'}
                    </span>
                    <span className="shrink-0 text-xs text-ink-400">open in Tags</span>
                  </button>
                )
              }
              const n = row.note
              const dir = noteFolderLabel(n, vaultSettings)
              return (
                <button
                  key={row.key}
                  data-search-idx={i}
                  onClick={() => open(n)}
                  onMouseMove={() => setActive(i)}
                  className={[
                    'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                    isActive ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                  ].join(' ')}
                >
                  {/* Notes that share a name differ only by folder, so the row
                      shows the folder the way the buffer switcher and the [[
                      picker do (noteFolderLabel, #635, #982): the title keeps
                      its natural width and the path takes what is left, losing
                      its head first (dir="rtl", with the LRE/PDF embedding
                      keeping the path itself left-to-right). A note at the top
                      of the main notes area has no folder to show and keeps its
                      area label. */}
                  <span className="min-w-0 truncate text-sm font-medium text-ink-900">
                    {n.title}
                  </span>
                  {dir ? (
                    <span
                      dir="rtl"
                      data-search-dir
                      className="min-w-0 flex-1 truncate text-xs text-ink-400"
                    >
                      {`\u202A${dir}\u202C`}
                    </span>
                  ) : (
                    <span className="ml-auto shrink-0 text-xs uppercase tracking-wide text-ink-400">
                      {n.folder}
                    </span>
                  )}
                </button>
              )
            })
          )}
          {createRow && rows.length > 0 && (
            <div className="my-1 border-t border-paper-300/70" aria-hidden="true" />
          )}
          {createRow && (
            <button
              data-search-idx={createRowIndex}
              data-search-create=""
              onClick={() => setDraft(createRow)}
              onMouseMove={() => setActive(createRowIndex)}
              className={[
                'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                active === createRowIndex ? 'bg-paper-200' : 'hover:bg-paper-200/70'
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
