import { useEffect } from 'react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

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
  // Modal owns Escape (→ cancel); we only add Enter (→ confirm) here.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        onConfirm()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onConfirm])

  return (
    <Modal
      size="sm"
      layer="modal"
      onClose={onCancel}
      data={{ 'data-confirm-modal': '', 'data-prompt-modal': '' }}
    >
      <Modal.Header title={options.title} description={options.description} />
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          {options.cancelLabel ?? 'Cancel'}
        </Button>
        <Button variant={options.danger ? 'danger' : 'primary'} onClick={onConfirm}>
          {options.confirmLabel ?? 'Confirm'}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
