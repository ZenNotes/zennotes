/**
 * Persistent right-side outline panel — mirrors the ConnectionsPanel
 * layout and lives inside EditorPane so each split pane gets its own
 * outline for whichever note it's displaying.
 *
 * Jumping is delegated to the host via `onJump(line)` because the
 * panel doesn't own a CodeMirror view; EditorPane targets its local
 * `viewRef` so clicks work even when this isn't the active pane.
 */
import { useEffect, useMemo, useState } from 'react'
import type { NoteContent } from '@shared/ipc'
import { parseOutline } from '../lib/outline'

interface Props {
  note: NoteContent
  /** Jump the host pane's editor to the given 1-based line. */
  onJump: (line: number) => void
}

export function OutlinePanel({ note, onJump }: Props): JSX.Element {
  const items = useMemo(() => parseOutline(note.body), [note.body])
  const [query, setQuery] = useState('')

  // Reset the filter when the note changes so the outline reflects the
  // new document from the top.
  useEffect(() => setQuery(''), [note.path])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((item) => item.text.toLowerCase().includes(q))
  }, [items, query])

  return (
    <section
      aria-label="Outline"
      className="flex w-[clamp(208px,26vw,280px)] shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/18"
    >
      <div className="border-b border-paper-300/60 px-4 py-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-400">
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
            {filtered.map((item) => (
              <li key={`${item.line}-${item.from}`}>
                <button
                  type="button"
                  onClick={() => onJump(item.line)}
                  title={`Jump to line ${item.line}`}
                  className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-sm text-ink-700 transition-colors hover:bg-paper-200 hover:text-ink-900"
                  style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}
                >
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-400">
                    H{item.level}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
