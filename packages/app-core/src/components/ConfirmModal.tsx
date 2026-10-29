import { useEffect, useRef } from 'react'
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
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Modal owns Escape (→ cancel). Enter presses the focused button, so the
  // button a question opens on is its answer to Enter: a danger question
  // (delete, discard, remove) opens on Cancel, and Tab then Enter confirms;
  // any other opens on its confirm button, so Enter confirms as it always
  // did. Taken in the capture phase so nothing behind the dialog sees it.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      e.stopPropagation()
      const focused = document.activeElement
      if (focused === cancelRef.current) onCancel()
      else if (focused === confirmRef.current) onConfirm()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onConfirm, onCancel])

  return (
    <Modal
      size="sm"
      layer="modal"
      onClose={onCancel}
      initialFocus={options.danger ? cancelRef : confirmRef}
      data={{ 'data-confirm-modal': '', 'data-prompt-modal': '' }}
    >
      <Modal.Header title={options.title} description={options.description} />
      <Modal.Footer>
        <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
          {options.cancelLabel ?? 'Cancel'}
        </Button>
        <Button ref={confirmRef} variant={options.danger ? 'danger' : 'primary'} onClick={onConfirm}>
          {options.confirmLabel ?? 'Confirm'}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
