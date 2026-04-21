/**
 * Space-p / :outline — a search-style overlay that lists every heading
 * in the active note and jumps the editor to the chosen line on Enter.
 * Styled to match SearchPalette and BufferPalette.
 *
 * Virtual tabs (Tasks / Tags / Help) and a missing active note produce
 * an empty state instead of a crash; the palette is always safe to open.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { rankItems } from '../lib/fuzzy-score'
import { parseOutline, type OutlineItem } from '../lib/outline'
import { isHelpTabPath } from '@shared/help'
import { isArchiveTabPath } from '@shared/archive'
import { isTagsTabPath } from '@shared/tags'
import { isTasksTabPath } from '@shared/tasks'
import { isTrashTabPath } from '@shared/trash'
import { isQuickNotesTabPath } from '@shared/quick-notes'

function isVirtualPath(path: string | null): boolean {
  if (!path) return true
  return (
    isQuickNotesTabPath(path) ||
    isTasksTabPath(path) ||
    isTagsTabPath(path) ||
    isHelpTabPath(path) ||
    isArchiveTabPath(path) ||
    isTrashTabPath(path)
  )
}

export function OutlinePalette(): JSX.Element {
  const setOpen = useStore((s) => s.setOutlinePaletteOpen)
  const selectedPath = useStore((s) => s.selectedPath)
  const noteContents = useStore((s) => s.noteContents)

  const body =
    selectedPath && !isVirtualPath(selectedPath) ? noteContents[selectedPath]?.body ?? '' : ''

  const items = useMemo(() => parseOutline(body), [body])

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const results = useMemo<OutlineItem[]>(
    () => rankItems(items, query, [{ get: (item) => item.text, weight: 1 }]),
    [items, query]
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-outline-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const jump = (item: OutlineItem): void => {
    setOpen(false)
    window.dispatchEvent(
      new CustomEvent('zen:outline-jump', {
        detail: { line: item.line }
      })
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[15vh] backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[min(560px,90vw)] overflow-hidden rounded-xl bg-paper-100 shadow-float ring-1 ring-paper-300/70"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-paper-300/70 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            placeholder="Jump to heading…"
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
                const item = results[active]
                if (item) jump(item)
              }
            }}
            className="w-full bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-x-hidden overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-ink-400">
              {items.length === 0
                ? isVirtualPath(selectedPath)
                  ? 'No outline for this view.'
                  : 'No headings in this note.'
                : 'No matching headings.'}
            </div>
          ) : (
            results.map((item, i) => (
              <button
                key={`${item.line}-${item.from}`}
                data-outline-idx={i}
                onClick={() => jump(item)}
                onMouseMove={() => setActive(i)}
                className={[
                  'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                  i === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                ].join(' ')}
                style={{ paddingLeft: `${16 + (item.level - 1) * 14}px` }}
              >
                <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-400">
                  H{item.level}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-900">{item.text}</span>
                <span className="shrink-0 text-[11px] text-ink-400">L{item.line}</span>
              </button>
            ))
          )}
        </div>
        <div className="flex items-center justify-end gap-4 border-t border-paper-300/70 bg-paper-100 px-4 py-2 text-[11px] text-ink-500">
          <span>
            <kbd className="rounded bg-paper-200 px-1">↑↓</kbd> move
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">↵</kbd> jump
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
