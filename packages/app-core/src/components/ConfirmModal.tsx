import { useEffect } from 'react'
import { createPortal } from 'react-dom'

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export function ConfirmModal({
  options,
  onConfirm,
  onCancel
}: {
  options: ConfirmOptions
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        onConfirm()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onCancel, onConfirm])

  return createPortal(
    <div
      data-confirm-modal
      data-prompt-modal
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 pt-[18vh] backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[min(440px,92vw)] overflow-hidden rounded-xl bg-paper-100 shadow-float ring-1 ring-paper-300"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5">
          <div className="text-sm font-semibold text-ink-900">{options.title}</div>
          {options.description && (
            <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-500">
              {options.description}
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t border-paper-300/50 bg-paper-50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-paper-300 bg-paper-100 px-3 py-1.5 text-sm text-ink-800 hover:bg-paper-200"
          >
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={[
              'rounded-md px-3 py-1.5 text-sm font-medium',
              options.danger
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-ink-900 text-paper-50 hover:bg-ink-800'
            ].join(' ')}
          >
            {options.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
