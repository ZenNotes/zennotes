/**
 * Persistent right-side outline panel — mirrors the ConnectionsPanel
 * layout and lives inside EditorPane so each split pane gets its own
 * outline for whichever note it's displaying.
 *
 * Jumping is delegated to the host via `onJump(line)` because the
 * panel doesn't own a CodeMirror view; EditorPane targets its local
 * `viewRef` so clicks work even when this isn't the active pane.
 *
 * `activeLine` (when provided) marks which heading the host considers
 * "currently visible" based on scroll position. The matching row is
 * highlighted and auto-scrolled into view so users can orient at a
 * glance as they scroll through long notes.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteContent } from '@shared/ipc'
import { parseOutline } from '../lib/outline'
import { useStore } from '../store'
import { usePanelResize } from '../lib/use-panel-resize'
import { PanelResizeHandle } from './PanelResizeHandle'

interface Props {
  /** Width to render at when the pane has less room than the width the user
   *  chose; see lib/side-panel-fit. (#805) */
  fitWidth?: number
  note: NoteContent
  /** 1-based line of the heading the host wants visually marked. */
  activeLine?: number | null
  /** Jump the host pane's editor to the given 1-based line. */
  onJump: (line: number) => void
}

export function OutlinePanel({ note, activeLine, onJump, fitWidth }: Props): JSX.Element {
  const items = useMemo(() => parseOutline(note.body), [note.body])
  const [query, setQuery] = useState('')
  const activeItemRef = useRef<HTMLLIElement | null>(null)
  const width = useStore((s) => s.panelWidths.outline)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const cursorIndex = useStore((s) => s.outlineCursorIndex)
  const setCursorIndex = useStore((s) => s.setOutlineCursorIndex)
  const { startResize } = usePanelResize(fitWidth ?? width, (px) => setPanelWidth('outline', px))
  const isOutlineFocused = focusedPanel === 'outline'

  // Reset the filter when the note changes so the outline reflects the
  // new document from the top.
  useEffect(() => setQuery(''), [note.path])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((item) => item.text.toLowerCase().includes(q))
  }, [items, query])

  // Keep the row cursor inside the list as headings are added, removed, or
  // filtered away — same clamp the connections panel does. (#477)
  useEffect(() => {
    if (!isOutlineFocused) return
    const next = filtered.length === 0 ? 0 : Math.min(cursorIndex, filtered.length - 1)
    if (next !== cursorIndex) setCursorIndex(next)
  }, [cursorIndex, filtered.length, isOutlineFocused, setCursorIndex])

  // Keep the active heading in view as the user scrolls. `nearest`
  // avoids fighting them when the row is already visible.
  useEffect(() => {
    if (activeLine == null) return
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeLine])

  return (
    <section
      aria-label="Outline"
      data-outline-panel
      style={{ width: fitWidth ?? width }}
      className="relative flex shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/18"
    >
      <PanelResizeHandle onStart={startResize} />
      <div className="border-b border-paper-300/60 px-4 py-4">
        <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-400">
          Outline
        </div>
        <div className="mt-2 text-xs text-ink-500">
          {items.length === 0
            ? 'No headings yet — add `#` to build an outline.'
            : `${items.length} heading${items.length === 1 ? '' : 's'}`}
        </div>
        {items.length > 0 && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            className="mt-3 w-full rounded-md border border-paper-300/60 bg-paper-100 px-2 py-1 text-xs text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/60"
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {filtered.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-ink-400">
            {items.length === 0 ? 'Nothing to show.' : 'No matches.'}
          </div>
        ) : (
          <ul className="flex flex-col">
            {filtered.map((item, rowIndex) => {
              const isActive = activeLine != null && item.line === activeLine
              // The keyboard cursor is separate from the scroll-position marker:
              // one says "where you are typing", the other "where you are
              // about to jump". Only the cursor gets the solid highlight.
              const isCursor = isOutlineFocused && cursorIndex === rowIndex
              return (
                <li
                  key={`${item.line}-${item.from}`}
                  ref={isActive ? activeItemRef : undefined}
                >
                  <button
                    type="button"
                    onClick={() => onJump(item.line)}
                    title={`Jump to line ${item.line}`}
                    aria-current={isActive ? 'true' : undefined}
                    data-outline-idx={rowIndex}
                    data-outline-line={item.line}
                    data-outline-cursor={isCursor ? 'true' : undefined}
                    className={[
                      'flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-sm transition-colors',
                      isCursor
                        ? 'bg-accent text-white ring-2 ring-white/45'
                        : isActive
                          ? 'bg-accent/12 font-medium text-accent'
                          : 'text-ink-700 hover:bg-paper-200 hover:text-ink-900'
                    ].join(' ')}
                    style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}
                  >
                    <span
                      className={[
                        'shrink-0 text-2xs uppercase tracking-wide',
                        isCursor ? 'text-white/75' : isActive ? 'text-accent/75' : 'text-ink-400'
                      ].join(' ')}
                    >
                      H{item.level}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.text}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
