import { useEffect } from 'react'
import type { ReactNode } from 'react'
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
  data,
  children
}: ModalProps): JSX.Element {
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
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`overflow-hidden rounded-2xl bg-paper-100 shadow-float ring-1 ring-paper-300 ${SIZE_CLASS[size]} ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body
  )
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
