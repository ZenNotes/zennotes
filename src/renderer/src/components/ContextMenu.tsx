import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
 */
export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [activeIdx, setActiveIdx] = useState<number>(-1)

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
        onClose()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        setActiveIdx((i) => {
          let next = i
          for (let k = 0; k < items.length; k++) {
            next = (next + 1) % items.length
            if (items[next].kind !== 'separator' && !items[next].disabled) return next
          }
          return i
        })
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        setActiveIdx((i) => {
          let next = i
          for (let k = 0; k < items.length; k++) {
            next = next <= 0 ? items.length - 1 : next - 1
            if (items[next].kind !== 'separator' && !items[next].disabled) return next
          }
          return i
        })
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = items[activeIdx]
        if (item && item.kind !== 'separator' && !item.disabled) {
          onClose()
          void Promise.resolve(item.onSelect?.())
        }
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
  }, [onClose, items, activeIdx])

  return createPortal(
    <div
      ref={ref}
      data-ctx-menu
      className="fixed z-[60] min-w-[220px] overflow-hidden rounded-xl bg-paper-100 p-1 shadow-float ring-1 ring-paper-300"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.kind === 'separator') {
          return <div key={`sep-${i}`} className="my-1 h-px bg-paper-300/60" />
        }
        const active = i === activeIdx
        return (
          <button
            key={`${i}-${item.label}`}
            disabled={item.disabled}
            onMouseEnter={() => setActiveIdx(i)}
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
            <span className="flex-1 truncate">{item.label}</span>
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
      })}
    </div>,
    document.body
  )
}
