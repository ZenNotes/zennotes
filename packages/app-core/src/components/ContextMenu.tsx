import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  kind?: 'item' | 'separator'
  label?: string
  /** Optional SVG icon to the left of the label. */
  icon?: JSX.Element
  /** Right-aligned hint, e.g. a keyboard shortcut. */
  hint?: string
  /** Displayed in muted red (used for destructive actions). */
  danger?: boolean
  disabled?: boolean
  onSelect?: () => void | Promise<void>
}

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

/**
 * Floating context menu. Positions itself at (x, y), flips when it
 * would run off the edge of the viewport, and closes on outside
 * click / escape / window blur.
 *
 * Supports type-to-filter: any printable character typed while the menu
 * is open narrows the visible items by case-insensitive substring match
 * on their label. A small header bar appears showing the current query
 * so the user knows they're filtering. Backspace deletes a character,
 * Escape clears the query (one level) before closing the menu.
 */
export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [activeIdx, setActiveIdx] = useState<number>(0)
  const [query, setQuery] = useState('')

  // Build the filtered list. Each entry knows its original index so
  // reorder / filter doesn't lose the onSelect wiring.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: Array<{ item: ContextMenuItem; originalIdx: number }> = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (q) {
        // Hide separators during filtering — they don't pair with any
        // specific item once the list has been shuffled.
        if (item.kind === 'separator') continue
        const label = item.label?.toLowerCase() ?? ''
        if (!label.includes(q)) continue
      }
      out.push({ item, originalIdx: i })
    }
    return out
  }, [items, query])

  // Track the cursor as an index into the *visible* list so filtering
  // doesn't send us to a separator / hidden row.
  const [visibleActive, setVisibleActive] = useState(0)
  useEffect(() => {
    // Snap to the first enabled row whenever filtering changes the set.
    const firstEnabled = visible.findIndex(
      (v) => v.item.kind !== 'separator' && !v.item.disabled
    )
    setVisibleActive(firstEnabled >= 0 ? firstEnabled : 0)
  }, [visible])

  // Clamp inside the viewport so the menu never spills off-screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (left + rect.width + 8 > vw) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height + 8 > vh) top = Math.max(8, vh - rect.height - 8)
    setPos({ left, top })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (query) setQuery('')
        else onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setVisibleActive((i) => stepVisible(visible, i, 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setVisibleActive((i) => stepVisible(visible, i, -1))
        return
      }
      // Ctrl-N / Ctrl-P also navigate, so vim-minded users keep access
      // to downward / upward motion while `j` / `k` are reserved for
      // typing into the filter.
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        setVisibleActive((i) => stepVisible(visible, i, 1))
        return
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        setVisibleActive((i) => stepVisible(visible, i, -1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const entry = visible[visibleActive]
        if (entry && entry.item.kind !== 'separator' && !entry.item.disabled) {
          onClose()
          void Promise.resolve(entry.item.onSelect?.())
        }
        return
      }
      if (e.key === 'Backspace') {
        // Only react while there's a query — otherwise let the keystroke
        // pass through to whatever had focus before the menu opened.
        if (query) {
          e.preventDefault()
          setQuery((q) => q.slice(0, -1))
        }
        return
      }
      // Type-to-filter: accept printable characters (single-char keys
      // that aren't a modifier chord). Skip when a modifier other than
      // Shift is held so shortcuts don't get swallowed.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length === 1) {
        e.preventDefault()
        setQuery((q) => q + e.key)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, visible, visibleActive, query])

  // Keep active index in sync when items change externally.
  useEffect(() => {
    setActiveIdx(visible[visibleActive]?.originalIdx ?? -1)
  }, [visible, visibleActive])

  return createPortal(
    <div
      ref={ref}
      data-ctx-menu
      className="fixed z-[60] min-w-[220px] overflow-hidden rounded-xl bg-paper-100 p-1 shadow-float ring-1 ring-paper-300"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {query && (
        <div className="mb-1 flex items-center gap-1 rounded-md bg-paper-200/80 px-2 py-1 font-mono text-[11px] text-ink-700">
          <span className="text-ink-400">filter</span>
          <span className="flex-1 truncate text-ink-900">{query}</span>
          <span className="text-ink-400">{visible.length}</span>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="px-3 py-2 text-center text-xs text-ink-400">
          No matches
        </div>
      ) : (
        visible.map(({ item, originalIdx }, i) => {
          if (item.kind === 'separator') {
            return (
              <div
                key={`sep-${originalIdx}`}
                className="my-1 h-px bg-paper-300/60"
              />
            )
          }
          const active = i === visibleActive
          return (
            <button
              key={`${originalIdx}-${item.label}`}
              disabled={item.disabled}
              onMouseEnter={() => setVisibleActive(i)}
              onClick={() => {
                if (item.disabled) return
                onClose()
                void Promise.resolve(item.onSelect?.())
              }}
              className={[
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                item.disabled
                  ? 'cursor-default text-ink-400'
                  : item.danger
                    ? active
                      ? 'bg-red-500/90 text-white'
                      : 'text-[rgb(var(--z-red))] hover:bg-red-500/10'
                    : active
                      ? 'bg-paper-200 text-ink-900'
                      : 'text-ink-800 hover:bg-paper-200/70'
              ].join(' ')}
            >
              {item.icon && <span className="shrink-0">{item.icon}</span>}
              <span className="flex-1 truncate">
                {highlightMatch(item.label ?? '', query)}
              </span>
              {item.hint && (
                <span
                  className={[
                    'shrink-0 text-[11px]',
                    active && !item.danger ? 'text-ink-600' : 'text-ink-400'
                  ].join(' ')}
                >
                  {item.hint}
                </span>
              )}
            </button>
          )
        })
      )}
    </div>,
    document.body
  )
  // `activeIdx` is exposed so mouse-hover callers can sync highlight
  // externally if they want — not used internally but cheap to keep.
  void activeIdx
}

/** Move the cursor over the visible list, skipping separators and
 *  disabled rows. Wraps at both ends. */
function stepVisible(
  visible: Array<{ item: ContextMenuItem; originalIdx: number }>,
  from: number,
  delta: 1 | -1
): number {
  if (visible.length === 0) return 0
  let i = from
  for (let k = 0; k < visible.length; k++) {
    i = (i + delta + visible.length) % visible.length
    const { item } = visible[i]
    if (item.kind !== 'separator' && !item.disabled) return i
  }
  return from
}

/** Render a label with the filter substring highlighted — makes it
 *  obvious WHY a row matched the current query. */
function highlightMatch(label: string, query: string): JSX.Element {
  const q = query.trim()
  if (!q) return <>{label}</>
  const idx = label.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return <>{label}</>
  return (
    <>
      {label.slice(0, idx)}
      <mark className="bg-transparent font-semibold text-[rgb(var(--z-accent))]">
        {label.slice(idx, idx + q.length)}
      </mark>
      {label.slice(idx + q.length)}
    </>
  )
}
