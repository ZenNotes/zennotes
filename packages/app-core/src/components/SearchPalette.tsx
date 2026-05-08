import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { NoteMeta } from '@shared/ipc'
import { isPaletteNextKey, isPalettePreviousKey } from '../lib/palette-nav'
import {
  buildNoteSearchIndex,
  parseNoteSearchQuery,
  searchNoteIndex
} from '../lib/note-search'

export function SearchPalette(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const selectNote = useStore((s) => s.selectNote)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const searchIndex = useMemo(() => buildNoteSearchIndex(notes), [notes])

  // Strip `#tag` tokens off the query so the user can narrow by one or
  // more tags inline: `#ops #prod migration` means "notes tagged with
  // #ops AND #prod, fuzzy-matching 'migration'". Pure-tag queries (no
  // free text) still work — in that case we just list matching notes.
  const { tagTokens } = useMemo(() => parseNoteSearchQuery(query), [query])

  const results = useMemo(() => {
    return searchNoteIndex(searchIndex, query, { limit: 20 })
  }, [query, searchIndex])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-search-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const open = async (note: NoteMeta): Promise<void> => {
    setSearchOpen(false)
    await selectNote(note.path)
    setFocusedPanel('editor')
    requestAnimationFrame(() => {
      useStore.getState().editorViewRef?.focus()
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[15vh] backdrop-blur-sm"
      onClick={() => setSearchOpen(false)}
    >
      <div
        className="w-[min(560px,90vw)] overflow-hidden rounded-xl bg-paper-100 shadow-float ring-1 ring-paper-300/70"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-paper-300/70 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            placeholder="Search notes…  ·  use #tag to filter"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (isPaletteNextKey(e)) {
                e.preventDefault()
                setActive((a) => Math.min(results.length - 1, a + 1))
              } else if (isPalettePreviousKey(e)) {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const note = results[active]
                if (note) open(note)
              }
            }}
            className="w-full bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
          />
          {tagTokens.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tagTokens.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-accent"
                >
                  #{t}
                </span>
              ))}
              <span className="text-[11px] text-ink-500">
                notes must carry {tagTokens.length === 1 ? 'this tag' : 'all of these tags'}
              </span>
            </div>
          )}
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-x-hidden overflow-y-auto py-1">
          {results.length === 0 ? (
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
                <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-400">
                  {n.folder}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="flex items-center justify-end gap-4 border-t border-paper-300/70 bg-paper-100 px-4 py-2 text-[11px] text-ink-500">
          <span>
            <kbd className="rounded bg-paper-200 px-1">↑↓</kbd>{' '}
            <kbd className="rounded bg-paper-200 px-1">Ctrl+N/P</kbd> move
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">↵</kbd> open
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
