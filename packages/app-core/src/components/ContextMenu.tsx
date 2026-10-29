import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { CheckIcon, SearchIcon } from './icons'

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
  /** The choice in force, of a set the menu picks from: drawn with a check,
   *  and where the cursor starts. */
  checked?: boolean
  /** More words the filter finds the item by (aliases), besides its label. */
  keywords?: string[]
  onSelect?: () => void | Promise<void>
}

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
  /** A heading above the items, for a menu that picks one of a set. */
  title?: string
  /** A find field above the items, with this placeholder, for a long list:
   *  the list scrolls under it, the best matches come first, and a touch
   *  keyboard has somewhere to type (the code block language picker). */
  findPlaceholder?: string
  /** The top edge of what opened the menu, when (x, y) is just below it: a
   *  menu with no room below opens above it instead of covering it. */
  anchorTop?: number
  onClose: () => void
}

/** How well a row matches the filter, best first: its label or a keyword is
 *  the query, starts with it, has a word that starts with it, or holds it.
 *  Null when it does not match. */
export function contextMenuMatchRank(item: ContextMenuItem, query: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const texts = [item.label?.toLowerCase() ?? '', ...(item.keywords ?? []).map((k) => k.toLowerCase())]
  if (texts.some((text) => text === q)) return 0
  if (texts.some((text) => text.startsWith(q))) return 1
  if (texts.some((text) => text.split(/[^a-z0-9+#]+/).some((word) => word.startsWith(q)))) return 2
  if (texts.some((text) => text.includes(q))) return 3
  return null
}

/** A touch screen with a list to tap opens on the list, not the keyboard
 *  (the PromptModal rule): the keyboard would cover the very rows it picks. */
function coarsePointer(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false)
}

/**
 * Floating context menu. Positions itself at (x, y), flips when it
 * would run off the edge of the viewport, and closes on outside
 * click / escape / window blur.
 *
 * Supports type-to-filter: any printable character typed while the menu
 * is open narrows the visible items by case-insensitive substring match
 * on their label. With Vim mode on, j and k move instead; with it off they
 * are letters like any other, and only the arrows, Enter and Escape act. A small header bar appears showing the current query
 * so the user knows they're filtering. Backspace deletes a character,
 * Escape clears the query (one level) before closing the menu.
 *
 * With `findPlaceholder` the query lives in a find field instead of that bar,
 * the rows scroll under it with the best matches first, and Ctrl+N / Ctrl+P
 * and the arrows move from inside the field, where every letter is text.
 */
export function ContextMenu({ x, y, items, title, findPlaceholder, anchorTop, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const findRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [activeIdx, setActiveIdx] = useState<number>(0)
  const [query, setQuery] = useState('')
  const vimMode = useStore((s) => s.vimMode)

  // Build the filtered list. Each entry knows its original index so
  // reorder / filter doesn't lose the onSelect wiring.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: Array<{ item: ContextMenuItem; originalIdx: number; rank: number }> = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      let rank = 0
      if (q) {
        // Hide separators during filtering — they don't pair with any
        // specific item once the list has been shuffled.
        if (item.kind === 'separator') continue
        const matched = contextMenuMatchRank(item, q)
        if (matched === null) continue
        rank = matched
      }
      out.push({ item, originalIdx: i, rank })
    }
    // A long list puts the best match first, so `c` then Enter is C, not the
    // first name with a c in it. Stable: equal matches keep their order.
    if (q && findPlaceholder) out.sort((a, b) => a.rank - b.rank)
    return out
  }, [items, query, findPlaceholder])

  // Track the cursor as an index into the *visible* list so filtering
  // doesn't send us to a separator / hidden row.
  const [visibleActive, setVisibleActive] = useState(0)
  useEffect(() => {
    // Snap to the first enabled row whenever filtering changes the set; with
    // no filter, a menu that picks one of a set starts on the current one.
    const enabled = (v: { item: ContextMenuItem }): boolean =>
      v.item.kind !== 'separator' && !v.item.disabled
    const checked = query ? -1 : visible.findIndex((v) => enabled(v) && v.item.checked)
    const firstEnabled = visible.findIndex(enabled)
    setVisibleActive(checked >= 0 ? checked : firstEnabled >= 0 ? firstEnabled : 0)
  }, [visible, query])

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
    if (top + rect.height + 8 > vh) {
      const above = anchorTop === undefined ? -1 : anchorTop - rect.height - 4
      top = above >= 8 ? above : Math.max(8, vh - rect.height - 8)
    }
    setPos({ left, top })
  }, [x, y, anchorTop])

  // Take the keyboard as the menu mounts, so a key pressed before the next
  // frame cannot reach whatever held focus (the calendar panel, after a
  // keyboard drop), and again on that frame in case the event that opened the
  // menu moves focus after mount (#850). Closing hands focus back.
  //
  // A menu with a find field gives it the keyboard when letters are text,
  // that is with Vim off; with Vim on the list keeps it, where j and k move
  // and `/` goes to the field. On a touch screen the list keeps it either way.
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const target = (): HTMLElement | null =>
      findPlaceholder && !useStore.getState().vimMode && !coarsePointer() ? findRef.current : ref.current
    target()?.focus({ preventScroll: true })
    const id = requestAnimationFrame(() => {
      target()?.focus({ preventScroll: true })
    })
    return () => {
      cancelAnimationFrame(id)
      previousFocusRef.current?.focus?.({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  // Keep active index in sync when items change externally.
  useEffect(() => {
    setActiveIdx(visible[visibleActive]?.originalIdx ?? -1)
  }, [visible, visibleActive])

  // A list that scrolls keeps the cursor's row in sight.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-ctx-active]')
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [visible, visibleActive])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Typing in the find field is the field's: every letter is text there, j
    // and k too. Only the keys that act on the list come through.
    const inFind = findRef.current !== null && e.target === findRef.current
    if (inFind && e.nativeEvent.isComposing) {
      // An input method's Enter commits the word; it does not pick a row.
      e.stopPropagation()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (query) setQuery('')
      else onClose()
      return
    }
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey
    if (!inFind && findRef.current && vimMode && plain && e.key === '/') {
      e.preventDefault()
      e.stopPropagation()
      findRef.current.focus({ preventScroll: true })
      return
    }
    if (e.key === 'ArrowDown' || (vimMode && plain && !inFind && e.key === 'j')) {
      e.preventDefault()
      e.stopPropagation()
      setVisibleActive((i) => stepVisible(visible, i, 1))
      return
    }
    if (e.key === 'ArrowUp' || (vimMode && plain && !inFind && e.key === 'k')) {
      e.preventDefault()
      e.stopPropagation()
      setVisibleActive((i) => stepVisible(visible, i, -1))
      return
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault()
      e.stopPropagation()
      setVisibleActive((i) => stepVisible(visible, i, 1))
      return
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault()
      e.stopPropagation()
      setVisibleActive((i) => stepVisible(visible, i, -1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const entry = visible[visibleActive]
      if (entry && entry.item.kind !== 'separator' && !entry.item.disabled) {
        onClose()
        void Promise.resolve(entry.item.onSelect?.())
      }
      return
    }
    if (inFind) {
      // The field edits itself; the keys must not reach the editor below.
      e.stopPropagation()
      return
    }
    if (e.key === 'Backspace') {
      if (query) {
        e.preventDefault()
        e.stopPropagation()
        setQuery((q) => q.slice(0, -1))
      }
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key.length === 1) {
      e.preventDefault()
      e.stopPropagation()
      setQuery((q) => q + e.key)
    }
  }

  return createPortal(
    <div
      ref={ref}
      data-ctx-menu
      role="menu"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={[
        'fixed z-[60] overflow-hidden rounded-xl bg-paper-100 p-1 shadow-float ring-1 ring-paper-300',
        // A fixed width, so filtering a long list does not resize it under
        // the pointer; never wider than a phone's screen.
        findPlaceholder ? 'w-72 max-w-[calc(100vw-1rem)]' : 'min-w-[220px]'
      ].join(' ')}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {title && (
        <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-ink-500">{title}</div>
      )}
      {findPlaceholder && (
        <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-md border border-paper-300 bg-paper-50 px-2 focus-within:border-accent">
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-ink-500" />
          <input
            ref={findRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={findPlaceholder}
            aria-label={findPlaceholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
      )}
      {query && !findPlaceholder && (
        <div className="mb-1 flex items-center gap-1 rounded-md bg-paper-200/80 px-2 py-1 font-mono text-xs text-ink-700">
          <span className="text-ink-400">filter</span>
          <span className="flex-1 truncate text-ink-900">{query}</span>
          <span className="text-ink-400">{visible.length}</span>
        </div>
      )}
      <div ref={listRef} className={findPlaceholder ? 'max-h-[52vh] overflow-y-auto' : undefined}>
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
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked === undefined ? undefined : item.checked}
              data-ctx-active={active ? '' : undefined}
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
                    'shrink-0 text-xs',
                    active && !item.danger ? 'text-ink-600' : 'text-ink-400'
                  ].join(' ')}
                >
                  {item.hint}
                </span>
              )}
              {item.checked && (
                <CheckIcon width={14} height={14} className="shrink-0 text-ink-600" />
              )}
            </button>
          )
        })
      )}
      </div>
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
