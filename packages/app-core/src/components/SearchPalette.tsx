import { useEffect, useMemo, useRef, useState } from 'react'
import Fuse from 'fuse.js'
import { useStore } from '../store'
import type { NoteMeta } from '@shared/ipc'

export function SearchPalette(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const selectNote = useStore((s) => s.selectNote)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const fuse = useMemo(
    () =>
      new Fuse(notes, {
        keys: [
          { name: 'title', weight: 0.6 },
          { name: 'excerpt', weight: 0.3 },
          { name: 'tags', weight: 0.1 }
        ],
        threshold: 0.35,
        ignoreLocation: true,
        includeMatches: false
      }),
    [notes]
  )

  // Strip `#tag` tokens off the query so the user can narrow by one or
  // more tags inline: `#ops #prod migration` means "notes tagged with
  // #ops AND #prod, fuzzy-matching 'migration'". Pure-tag queries (no
  // free text) still work — in that case we just list matching notes.
  const { freeText, tagTokens } = useMemo(() => {
    const rawTokens = query.split(/\s+/)
    const tags: string[] = []
    const text: string[] = []
    for (const tok of rawTokens) {
      if (!tok) continue
      if (tok.startsWith('#') && tok.length > 1) {
        tags.push(tok.slice(1).toLowerCase())
      } else {
        text.push(tok)
      }
    }
    return { freeText: text.join(' ').trim(), tagTokens: tags }
  }, [query])

  const results = useMemo(() => {
    const byTag = (n: NoteMeta): boolean => {
      if (tagTokens.length === 0) return true
      const tagsLower = n.tags.map((t) => t.toLowerCase())
      // AND semantics for search — every hashtag token must match. This
      // narrows the result set the more tags you add, matching how users
      // expect search filters to compose.
      return tagTokens.every((t) => tagsLower.includes(t))
    }
    const live = notes.filter((n) => n.folder !== 'trash' && byTag(n))
    if (!freeText) return live.slice(0, 20)
    const set = new Set(live.map((n) => n.path))
    return fuse
      .search(freeText)
      .map((r) => r.item)
      .filter((n) => set.has(n.path))
      .slice(0, 20)
  }, [fuse, freeText, tagTokens, notes])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => setActive(0), [query])

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
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(results.length - 1, a + 1))
              } else if (e.key === 'ArrowUp') {
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
        <div className="max-h-[50vh] overflow-x-hidden overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-ink-400">No matches.</div>
          ) : (
            results.map((n, i) => (
              <button
                key={n.path}
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
            <kbd className="rounded bg-paper-200 px-1">↑↓</kbd> move
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
