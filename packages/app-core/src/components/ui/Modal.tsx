import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * Shared modal/overlay shell. Consolidates the backdrop, panel, portal, and
 * Escape handling that every dialog and palette previously hand-rolled with
 * slightly different padding, radius, footer background, and (worst of all)
 * undocumented z-indexes. Content composes the optional Header/Body/Footer
 * subcomponents, or — for input-first palettes — renders custom children
 * inside the shared shell.
 */
export type ModalSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'
export type ModalLayer = 'palette' | 'modal' | 'nested' | 'popover'

// vw caps keep the panel on-screen on small windows; the px ceiling comes
// from the `dialog-*` maxWidth tokens in tailwind.config.js.
const SIZE_CLASS: Record<ModalSize, string> = {
  xs: 'w-[92vw] max-w-dialog-xs',
  sm: 'w-[92vw] max-w-dialog-sm',
  md: 'w-[92vw] max-w-dialog-md',
  lg: 'w-[94vw] max-w-dialog-lg',
  xl: 'w-[94vw] max-w-dialog-xl',
  '2xl': 'w-[96vw] max-w-dialog-2xl',
  '3xl': 'w-[96vw] max-w-dialog-3xl'
}

const LAYER_CLASS: Record<ModalLayer, string> = {
  palette: 'z-palette',
  modal: 'z-modal',
  nested: 'z-nested',
  popover: 'z-popover'
}

export interface ModalProps {
  /** Width step; maps to the `dialog-*` maxWidth tokens. */
  size?: ModalSize
  /** Stacking layer; maps to the documented z-index scale. */
  layer?: ModalLayer
  /** 'top' anchors near the top (dropdown feel); 'center' for tall dialogs. */
  align?: 'top' | 'center'
  onClose: () => void
  /** Close when the backdrop is clicked. Default true. */
  closeOnBackdrop?: boolean
  /**
   * Close on Escape via a global capture listener. Default true. Set false
   * for content that owns nuanced Escape behavior (e.g. palettes that first
   * dismiss their suggestion list).
   */
  closeOnEsc?: boolean
  /** Extra classes on the panel (e.g. fixed height + inner flex for Settings). */
  className?: string
  /** id of the element labelling the dialog, for aria-labelledby. */
  labelledBy?: string
  /**
   * Control to focus when the dialog opens. Without it the first focusable
   * element in the panel takes focus, and the panel itself when there is
   * none. Content that focuses itself (palettes focusing their input) keeps
   * that focus: the shell never moves focus already inside the panel.
   */
  initialFocus?: RefObject<HTMLElement | null>
  /** data-* hooks set on the backdrop, preserved for existing selectors. */
  data?: Record<string, string>
  children: ReactNode
}

function ModalRoot({
  size = 'md',
  layer = 'modal',
  align = 'top',
  onClose,
  closeOnBackdrop = true,
  closeOnEsc = true,
  className = '',
  labelledBy,
  initialFocus,
  data,
  children
}: ModalProps): JSX.Element {
  const panel = useRef<HTMLDivElement>(null)

  // Focus, for every dialog at once. Opening one moves focus into the panel,
  // Tab cycles inside it, and closing hands focus back to whatever opened it.
  // Without this a modal leaves the keyboard on the page underneath, where
  // global handlers keep firing behind the backdrop.
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const target = panel.current
    if (target && !target.contains(document.activeElement)) {
      const focusTarget = initialFocus?.current ?? firstFocusable(target) ?? target
      focusTarget.focus({ preventScroll: true })
    }
    return () => {
      // Content that hands focus somewhere on close (a palette returning it to
      // the editor) has already claimed it by the time this runs. Only focus
      // left on <body> by the panel's removal comes back to the opener.
      const active = document.activeElement
      if (active !== null && active !== document.body) return
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
    // Focus is claimed once per dialog; a changed `initialFocus` ref does not
    // re-open it.
  }, [])

  useEffect(() => {
    if (!closeOnEsc) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [closeOnEsc, onClose])

  const backdropAlign = align === 'center' ? 'items-center' : 'items-start pt-[14vh]'

  return createPortal(
    <div
      {...data}
      className={`fixed inset-0 ${LAYER_CLASS[layer]} flex justify-center ${backdropAlign} bg-black/45 backdrop-blur-sm`}
      onClick={closeOnBackdrop ? onClose : undefined}
      role="presentation"
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`overflow-hidden rounded-2xl bg-paper-100 shadow-float outline-none ring-1 ring-paper-300 ${SIZE_CLASS[size]} ${className}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => trapTab(e, panel.current)}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.getAttribute('aria-hidden') !== 'true' && !el.hasAttribute('inert')
  )
}

function firstFocusable(panel: HTMLElement): HTMLElement | null {
  return focusableWithin(panel)[0] ?? null
}

/**
 * Keep Tab inside the panel. The panel itself is a tab stop only as a
 * fallback (an empty dialog), so shift-tabbing off it wraps to the end.
 */
function trapTab(
  e: ReactKeyboardEvent<HTMLDivElement>,
  panel: HTMLElement | null
): void {
  if (e.key !== 'Tab' || !panel) return
  const stops = focusableWithin(panel)
  if (stops.length === 0) {
    e.preventDefault()
    panel.focus({ preventScroll: true })
    return
  }
  const first = stops[0]
  const last = stops[stops.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === panel)) {
    e.preventDefault()
    last.focus({ preventScroll: true })
    return
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus({ preventScroll: true })
  }
}

function ModalHeader({
  title,
  description,
  titleId,
  children
}: {
  title?: ReactNode
  description?: ReactNode
  titleId?: string
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="px-5 pt-5">
      {title !== undefined && (
        <div id={titleId} className="text-sm font-semibold text-ink-900">
          {title}
        </div>
      )}
      {description !== undefined && description !== null && (
        <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-500">{description}</div>
      )}
      {children}
    </div>
  )
}

function ModalBody({
  className = '',
  children
}: {
  className?: string
  children: ReactNode
}): JSX.Element {
  return <div className={`px-5 py-4 ${className}`.trim()}>{children}</div>
}

function ModalFooter({
  className = '',
  children
}: {
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div
      className={`mt-4 flex justify-end gap-2 border-t border-paper-300/50 bg-paper-50 px-5 py-3 ${className}`.trim()}
    >
      {children}
    </div>
  )
}

export const Modal = Object.assign(ModalRoot, {
  Header: ModalHeader,
  Body: ModalBody,
  Footer: ModalFooter
})
