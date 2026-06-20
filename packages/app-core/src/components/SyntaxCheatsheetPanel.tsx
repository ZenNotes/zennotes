/**
 * Collapsible left-side syntax cheatsheet panel — displays markdown extensions
 * and standard syntax reference. Only shown when markdownExtensionsEnabled is true.
 *
 * The panel lives on the LEFT side of the editor, with a resize handle on its
 * RIGHT edge. Width is persisted via store panelWidths.cheatsheet.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import CHEAT_SHEET from '../lib/syntax-cheatsheet'
import { getCategoryTitle, getItemDesc, type SyntaxCategory, type SyntaxItem } from '../lib/syntax-cheatsheet'
import { useStore } from '../store'
import { useLeftPanelResize } from '../lib/use-panel-resize'

// Left-side resize handle (on the RIGHT edge of the left panel)
function LeftPanelResizeHandle({
  onStart
}: {
  onStart: (e: React.MouseEvent<HTMLElement>) => void
}): JSX.Element {
  return (
    <div
      onMouseDown={onStart}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      title="Drag to resize"
      className="group absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize select-none"
    >
      <div className="absolute right-0 top-0 h-full w-px bg-transparent transition-colors group-hover:bg-accent/50" />
    </div>
  )
}

function getLocale(): string {
  if (typeof navigator !== 'undefined') {
    const lang = navigator.language.split('-')[0].toLowerCase()
    return ['de', 'en', 'it', 'fr'].includes(lang) ? lang : 'en'
  }
  return 'en'
}

export function SyntaxCheatsheetPanel({
  onInsert
}: {
  onInsert: (item: SyntaxItem) => void
}): JSX.Element | null {
  const markdownExtensionsEnabled = useStore((s) => s.markdownExtensionsEnabled)
  const locale = getLocale()
  const width = useStore((s) => s.panelWidths.cheatsheet)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const { startResize } = useLeftPanelResize(width, (px) => setPanelWidth('cheatsheet', px))
  const [query, setQuery] = useState('')

  if (!markdownExtensionsEnabled) return null

  const filteredCategories = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return CHEAT_SHEET
    return CHEAT_SHEET.map((cat: SyntaxCategory) => ({
      ...cat,
      items: cat.items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          getItemDesc(item, locale).toLowerCase().includes(q)
      ),
    })).filter((cat) => cat.items.length > 0)
  }, [locale, query])

  const totalItems = useMemo(
    () => filteredCategories.reduce((sum, cat) => sum + cat.items.length, 0),
    [filteredCategories]
  )

  const handleInsert = (item: SyntaxItem) => {
    onInsert(item)
  }

  return (
    <section
      aria-label="Syntax Cheatsheet"
      style={{ width }}
      className="relative flex shrink-0 flex-col overflow-hidden border-r border-paper-300/70 bg-paper-50/18 transition-all duration-150 min-w-[180px] max-w-[380px]"
    >
      <LeftPanelResizeHandle onStart={startResize} />
      <div
        className="border-b border-paper-300/60 px-3 py-3 transition-opacity duration-150"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-ink-400 flex-1 truncate">
            Cheatsheet
          </div>
        </div>
        <div className="mt-2 text-[10px] text-ink-500">
          {totalItems === 0 ? 'No matches.' : `${totalItems} item${totalItems === 1 ? '' : 's'}`}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="mt-2 w-full rounded-md border border-paper-300/60 bg-paper-100 px-2 py-1 text-[11px] text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent/60"
          aria-label="Filter syntax items"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {totalItems === 0 ? (
          <div className="px-2 py-4 text-center text-[11px] text-ink-400">
            {CHEAT_SHEET.length === 0 ? 'Nothing to show.' : 'No matches.'}
          </div>
        ) : (
          <>
            {filteredCategories.map((cat: SyntaxCategory) => (
              <div key={cat.id} className="mb-4">
                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-ink-400">
                  {getCategoryTitle(cat, locale)}
                </div>
                <ul className="flex flex-col gap-0.5">
                  {cat.items.map((item, idx) => (
                    <li key={`${cat.id}-${idx}`}>
                      <button
                        type="button"
                        onClick={() => handleInsert(item)}
                        onMouseDown={(e) => e.preventDefault()}
                        title={getItemDesc(item, locale)}
                        className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors text-ink-700 hover:bg-paper-200 hover:text-ink-900 focus:outline-none focus:ring-1 focus:ring-accent/50"
                      >
                        <code className="shrink-0 font-mono text-[11px] bg-paper-200 px-1.5 py-0.5 rounded text-ink-600">
                          {item.label}
                        </code>
                        <span className="min-w-0 flex-1 truncate text-ink-500">
                          {getItemDesc(item, locale)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  )
}