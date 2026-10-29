import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import type { DatabaseDoc, DbView } from '@shared/databases'
import {
  hideAllColumns,
  isLastVisibleColumn,
  setColumnHidden,
  showAllColumns,
  viewColumnFields
} from '../lib/database-cells'
import { useStore } from '../store'
import { Button } from './ui/Button'
import { SearchIcon } from './icons'

const PANEL_WIDTH = 288

/**
 * Popover that picks the columns one table view shows: a find field, Show all
 * and Hide all, and a checklist of the view's columns in its column order.
 * Every toggle writes this view's `hiddenFieldIds`, so each saved view keeps
 * its own columns, and the last visible column cannot be hidden.
 *
 * Keys: with Vim on the list holds the keyboard (j / k move, Space or x
 * toggles, / jumps to the find field); with Vim off the find field does
 * (the arrows move, Space or Enter on a focused column toggles it). Escape
 * closes in both. The panel carries `data-db-columns-menu`, one of the
 * SELF_KEYED_SURFACES, so the global Vim layer leaves these keys alone.
 */
export function DatabaseColumnsMenu({
  csvPath,
  doc,
  view,
  anchor,
  onClose,
  ignoreRef
}: {
  csvPath: string
  doc: DatabaseDoc
  view: DbView
  anchor: DOMRect
  onClose: () => void
  /** The trigger element: clicks on it are ignored so it can toggle cleanly. */
  ignoreRef?: RefObject<HTMLElement>
}): JSX.Element {
  const updateDatabaseSchema = useStore((s) => s.updateDatabaseSchema)
  const vimMode = useStore((s) => s.vimMode)
  const panelRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')

  const columns = useMemo(() => viewColumnFields(doc, view), [doc, view])
  const hidden = useMemo(() => new Set(view.hiddenFieldIds ?? []), [view.hiddenFieldIds])
  const shownCount = columns.filter((f) => !hidden.has(f.id)).length
  const needle = query.trim().toLowerCase()
  const matches = needle ? columns.filter((f) => f.name.toLowerCase().includes(needle)) : columns

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (ignoreRef?.current?.contains(target)) return // let the trigger toggle
      if (panelRef.current && !panelRef.current.contains(target)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, ignoreRef])

  // Vim mode starts on the list, where j / k work; otherwise the find field
  // takes the typing, since letters are never shortcuts with Vim off.
  useEffect(() => {
    if (vimMode) focusItem(0)
    else findRef.current?.focus()
    // Once, on open: a later Vim toggle should not yank focus around.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const items = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-column-id]') ?? [])
  function focusItem(index: number): void {
    const list = items()
    if (list.length === 0) return
    list[Math.max(0, Math.min(index, list.length - 1))].focus()
  }

  const write = (next: DatabaseDoc): void => {
    if (next !== doc) updateDatabaseSchema(csvPath, next)
  }
  const toggle = (fieldId: string): void =>
    write(setColumnHidden(doc, view.id, fieldId, !hidden.has(fieldId)))

  const onFindKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault()
      focusItem(0)
    }
  }

  const onItemKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number, fieldId: string): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const key = e.key
    const down = key === 'ArrowDown' || (vimMode && key === 'j')
    const up = key === 'ArrowUp' || (vimMode && key === 'k')
    if (down) {
      e.preventDefault()
      focusItem(index + 1)
    } else if (up) {
      e.preventDefault()
      if (index === 0) findRef.current?.focus()
      else focusItem(index - 1)
    } else if (key === 'Home') {
      e.preventDefault()
      focusItem(0)
    } else if (key === 'End') {
      e.preventDefault()
      focusItem(Number.MAX_SAFE_INTEGER)
    } else if (vimMode && key === 'x') {
      e.preventDefault()
      toggle(fieldId)
    } else if (vimMode && key === '/') {
      e.preventDefault()
      findRef.current?.focus()
      findRef.current?.select()
    }
    // Space and Enter fall through to the button's own click.
  }

  const style: CSSProperties = {
    position: 'fixed',
    top: anchor.bottom + 6,
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - PANEL_WIDTH - 8)),
    width: PANEL_WIDTH
  }

  return createPortal(
    <div
      ref={panelRef}
      style={style}
      role="dialog"
      aria-label="Columns"
      data-db-columns-menu
      // Keys typed here are the popover's: keep them from reaching the grid
      // or any pane handler above it in the React tree.
      onKeyDown={(e) => e.stopPropagation()}
      className="z-popover flex flex-col gap-2 rounded-lg border border-paper-300 bg-paper-100 p-2 text-ink-900 shadow-float"
    >
      <div className="flex items-center gap-1.5 rounded-md border border-paper-300 bg-paper-50 px-2 focus-within:border-accent">
        <SearchIcon className="h-3.5 w-3.5 shrink-0 text-ink-500" />
        <input
          ref={findRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFindKeyDown}
          placeholder="Find a column"
          aria-label="Find a column"
          className="min-w-0 flex-1 bg-transparent py-1 text-xs text-ink-900 outline-none placeholder:text-ink-400"
        />
      </div>

      <div className="flex items-center gap-1 px-1 text-xs text-ink-500">
        <span className="mr-auto">
          {shownCount} of {columns.length} shown
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={shownCount === columns.length}
          onClick={() => write(showAllColumns(doc, view.id))}
        >
          Show all
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={shownCount <= 1}
          title="Hides every column but the title"
          onClick={() => write(hideAllColumns(doc, view.id))}
        >
          Hide all
        </Button>
      </div>

      <div ref={listRef} role="group" aria-label="Columns in this view" className="max-h-[52vh] overflow-y-auto">
        {matches.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-ink-500">No column matches.</p>
        ) : (
          matches.map((field, index) => {
            const checked = !hidden.has(field.id)
            const locked = checked && isLastVisibleColumn(doc, view, field.id)
            return (
              <button
                key={field.id}
                type="button"
                role="checkbox"
                aria-checked={checked}
                aria-disabled={locked || undefined}
                data-column-id={field.id}
                title={locked ? 'A view keeps at least one column' : undefined}
                onClick={() => {
                  if (!locked) toggle(field.id)
                }}
                onKeyDown={(e) => onItemKeyDown(e, index, field.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-ink-800 outline-none hover:bg-paper-200 focus:bg-paper-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
              >
                <span
                  aria-hidden="true"
                  className={[
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    checked ? 'border-accent bg-accent text-white' : 'border-paper-400 text-transparent',
                    locked ? 'opacity-60' : ''
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
                  >
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                </span>
                <span className={['min-w-0 flex-1 truncate', checked ? '' : 'text-ink-500'].join(' ')}>
                  {field.name}
                </span>
              </button>
            )
          })
        )}
      </div>

      {vimMode && (
        <p className="px-1 text-2xs text-ink-500">j / k move · Space or x toggles · / finds · Esc closes</p>
      )}
    </div>,
    document.body
  )
}
