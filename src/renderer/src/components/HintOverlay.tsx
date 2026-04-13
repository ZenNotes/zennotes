import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { generateHintLabels } from '../lib/vim-nav'

interface HintTarget {
  element: HTMLElement
  label: string
  rect: DOMRect
  left: number
  top: number
}

function getVisibleInteractiveElements(): HTMLElement[] {
  const selectors = [
    'button:not([disabled])',
    'a[href]',
    '[role="button"]',
    '[role="link"]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])'
  ].join(', ')

  const all = document.querySelectorAll<HTMLElement>(selectors)
  const visible: HTMLElement[] = []

  for (const el of all) {
    // Skip elements inside the hint overlay itself
    if (el.closest('.vim-hint-overlay')) continue
    if (el.matches('[data-vim-hint-ignore]') || el.closest('[data-vim-hint-ignore]')) continue
    // Skip hidden elements
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    // Skip off-screen elements
    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) continue
    // Skip elements hidden by CSS
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
    visible.push(el)
  }
  return visible
}

function overlaps(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number }
): boolean {
  return !(
    a.left + a.width <= b.left ||
    b.left + b.width <= a.left ||
    a.top + a.height <= b.top ||
    b.top + b.height <= a.top
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getHintPlacement(
  rect: DOMRect,
  label: string,
  placed: Array<{ left: number; top: number; width: number; height: number }>
): { left: number; top: number } {
  const width = Math.max(18, label.length * 8 + 10)
  const height = 18
  const gutter = 4
  const maxLeft = Math.max(gutter, window.innerWidth - width - gutter)
  const maxTop = Math.max(gutter, window.innerHeight - height - gutter)
  const candidates = [
    { left: rect.left + gutter, top: rect.top + gutter },
    { left: rect.left + gutter, top: rect.top - height - gutter },
    { left: rect.right - width - gutter, top: rect.top + gutter },
    { left: rect.right - width - gutter, top: rect.top - height - gutter },
    { left: rect.left + gutter, top: rect.bottom - height - gutter },
    { left: rect.right - width - gutter, top: rect.bottom - height - gutter }
  ].map((pos) => ({
    left: clamp(pos.left, gutter, maxLeft),
    top: clamp(pos.top, gutter, maxTop)
  }))

  for (const candidate of candidates) {
    const box = { ...candidate, width, height }
    if (!placed.some((existing) => overlaps(box, existing))) {
      return candidate
    }
  }

  const fallback = candidates[0]
  for (let offset = 0; offset < window.innerHeight; offset += height + gutter) {
    const candidate = {
      left: fallback.left,
      top: clamp(fallback.top + offset, gutter, maxTop)
    }
    const box = { ...candidate, width, height }
    if (!placed.some((existing) => overlaps(box, existing))) {
      return candidate
    }
  }

  return fallback
}

export function HintOverlay({
  onActivate,
  onCancel
}: {
  onActivate: () => void
  onCancel: () => void
}): JSX.Element | null {
  const [buffer, setBuffer] = useState('')

  const targets = useMemo<HintTarget[]>(() => {
    const elements = getVisibleInteractiveElements()
    const labels = generateHintLabels(elements.length)
    const placed: Array<{ left: number; top: number; width: number; height: number }> = []

    return elements.map((element, i) => {
      const label = labels[i]
      const rect = element.getBoundingClientRect()
      const position = getHintPlacement(rect, label, placed)
      placed.push({
        ...position,
        width: Math.max(18, label.length * 8 + 10),
        height: 18
      })
      return {
        element,
        label,
        rect,
        ...position
      }
    })
  }, [])

  // Filter targets based on current buffer
  const matching = useMemo(
    () => targets.filter((t) => t.label.startsWith(buffer)),
    [targets, buffer]
  )

  useEffect(() => {
    // If exactly one match, click it
    if (buffer.length > 0 && matching.length === 1) {
      const target = matching[0]
      // Small delay so the user sees the match before it fires
      const t = setTimeout(() => {
        target.element.click()
        target.element.focus()
        onActivate()
      }, 50)
      return () => clearTimeout(t)
    }
    // If no matches, exit
    if (buffer.length > 0 && matching.length === 0) {
      onCancel()
    }
    return undefined
  }, [buffer, matching, onActivate, onCancel])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        onCancel()
        return
      }

      // Only accept lowercase letters
      if (e.key.length === 1 && /^[a-z]$/.test(e.key)) {
        setBuffer((b) => b + e.key)
        return
      }

      // Backspace removes last character
      if (e.key === 'Backspace') {
        setBuffer((b) => (b.length > 0 ? b.slice(0, -1) : b))
        return
      }

      // Any other key exits
      onCancel()
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onCancel])

  useEffect(() => {
    if (targets.length === 0) onCancel()
  }, [targets.length, onCancel])

  if (targets.length === 0) return null

  return createPortal(
    <div className="vim-hint-overlay" style={{ position: 'fixed', inset: 0, zIndex: 9999, pointerEvents: 'none' }}>
      {targets.map((t) => {
        const isMatch = t.label.startsWith(buffer)
        const matchedPart = buffer
        const remainingPart = t.label.slice(buffer.length)
        return (
          <span
            key={t.label}
            className={isMatch ? 'vim-hint' : 'vim-hint vim-hint-dim'}
            style={{
              position: 'absolute',
              left: t.left,
              top: t.top
            }}
          >
            {matchedPart && <span className="vim-hint-matched">{matchedPart}</span>}
            {remainingPart}
          </span>
        )
      })}
    </div>,
    document.body
  )
}
