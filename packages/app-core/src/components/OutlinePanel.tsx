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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteContent } from '@shared/ipc'
import { parseOutline, type OutlineItem } from '../lib/outline'
import { useStore } from '../store'
import { useT } from '../lib/i18n'
import { usePanelResize } from '../lib/use-panel-resize'
import { PanelResizeHandle } from './PanelResizeHandle'

interface Props {
  note: NoteContent
  /** 1-based line of the heading the host wants visually marked. */
  activeLine?: number | null
  /** Jump the host pane's editor to the given 1-based line. */
  onJump: (line: number) => void
}

interface OutlineRow {
  item: OutlineItem
  key: string
  hasChildren: boolean
  ancestors: string[]
}

function outlineKey(item: OutlineItem): string {
  return `${item.line}:${item.from}`
}

function buildOutlineRows(items: OutlineItem[]): OutlineRow[] {
  const rows: OutlineRow[] = []
  const stack: OutlineRow[] = []

  items.forEach((item, index) => {
    while (stack.length > 0 && stack[stack.length - 1].item.level >= item.level) {
      stack.pop()
    }

    const row: OutlineRow = {
      item,
      key: outlineKey(item),
      hasChildren: item.level > 1 && (items[index + 1]?.level ?? 0) > item.level,
      ancestors: stack.map((ancestor) => ancestor.key)
    }
    rows.push(row)
    stack.push(row)
  })

  return rows
}

function visibleOutlineRows(
  rows: OutlineRow[],
  collapsedKeys: Set<string>,
  query: string
): OutlineRow[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    return rows.filter((row) => row.ancestors.every((key) => !collapsedKeys.has(key)))
  }

  const visibleKeys = new Set<string>()
  rows.forEach((row) => {
    if (!row.item.text.toLowerCase().includes(q)) return
    visibleKeys.add(row.key)
    row.ancestors.forEach((key) => visibleKeys.add(key))
  })

  return rows.filter((row) => visibleKeys.has(row.key))
}

export function OutlinePanel({ note, activeLine, onJump }: Props): JSX.Element {
  const t = useT()
  const items = useMemo(() => parseOutline(note.body), [note.body])
  const rows = useMemo(() => buildOutlineRows(items), [items])
  const [query, setQuery] = useState('')
  const [collapsedKeys, setCollapsedKeys] = useState<string[]>([])
  const activeItemRef = useRef<HTMLLIElement | null>(null)
  const width = useStore((s) => s.panelWidths.outline)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const { startResize } = usePanelResize(width, (px) => setPanelWidth('outline', px))

  // Reset the filter when the note changes so the outline reflects the
  // new document from the top.
  useEffect(() => {
    setQuery('')
    setCollapsedKeys([])
  }, [note.path])

  const collapsedKeySet = useMemo(() => new Set(collapsedKeys), [collapsedKeys])
  const visibleRows = useMemo(
    () => visibleOutlineRows(rows, collapsedKeySet, query),
    [collapsedKeySet, query, rows]
  )

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsedKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    )
  }, [])

  // Keep the active heading in view as the user scrolls. `nearest`
  // avoids fighting them when the row is already visible.
  useEffect(() => {
    if (activeLine == null) return
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeLine])

  return (
    <section
      aria-label={t("Outline")}
      style={{ width }}
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
            placeholder={t("Filter…")}
            className="mt-3 w-full rounded-md border border-paper-300/60 bg-paper-100 px-2 py-1 text-xs text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/60"
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {visibleRows.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-ink-400">
            {items.length === 0 ? t('Nothing to show.') : t('No matches.')}
          </div>
        ) : (
          <ul className="flex flex-col">
            {visibleRows.map((row) => {
              const { item } = row
              const isActive = activeLine != null && item.line === activeLine
              const isCollapsed = collapsedKeySet.has(row.key)
              const labelIndent = 8 + (item.level - 1) * 12
              const rowIndent = row.hasChildren ? Math.max(0, labelIndent - 16) : labelIndent
              return (
                <li
                  key={row.key}
                  ref={isActive ? activeItemRef : undefined}
                >
                  <div
                    className={[
                      'group flex w-full min-w-0 items-center rounded text-sm transition-colors',
                      isActive
                        ? 'bg-accent/12 font-medium text-accent'
                        : 'text-ink-700 hover:bg-paper-200 hover:text-ink-900'
                    ].join(' ')}
                    style={{ paddingLeft: `${rowIndent}px` }}
                  >
                    {row.hasChildren ? (
                      <button
                        type="button"
                        onClick={() => toggleCollapsed(row.key)}
                        aria-label={isCollapsed ? t('Expand') : t('Collapse')}
                        aria-expanded={!isCollapsed}
                        className={[
                          'flex h-5 w-4 shrink-0 items-center justify-center rounded transition-colors',
                          isActive
                            ? 'text-accent/80 hover:bg-accent/10'
                            : 'text-ink-500 hover:bg-paper-300/60'
                        ].join(' ')}
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                        >
                          <path d="m9 6 6 6-6 6" />
                        </svg>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onJump(item.line)}
                      title={`Jump to line ${item.line}`}
                      aria-current={isActive ? 'true' : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded py-1 pr-1 text-left text-current outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                    >
                      <span
                        className={[
                          'shrink-0 text-2xs uppercase tracking-wide',
                          isActive ? 'text-accent/75' : 'text-ink-400'
                        ].join(' ')}
                      >
                        H{item.level}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.text}</span>
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
