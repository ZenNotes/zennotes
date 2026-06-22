import type { FolderColorId } from '@shared/ipc'
import { FOLDER_COLOR_OPTIONS } from './FolderColors'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

export function FolderColorPickerModal({
  targetLabel,
  currentColorId,
  onSelect,
  onReset,
  onCancel
}: {
  targetLabel: string
  currentColorId: FolderColorId | null
  onSelect: (colorId: FolderColorId) => void
  onReset: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <Modal size="md" layer="modal" onClose={onCancel}>
      <Modal.Header
        title="Choose color"
        description={
          <>
            Pick an accent color for{' '}
            <span className="font-medium text-ink-700">{targetLabel}</span>.
          </>
        }
      />
      <Modal.Body className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {FOLDER_COLOR_OPTIONS.map((option) => {
          const active = option.id === currentColorId
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onSelect(option.id)}
              className={[
                'flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors',
                active
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-paper-300 bg-paper-50 text-ink-800 hover:border-paper-400 hover:bg-paper-200/70'
              ].join(' ')}
            >
              <span className={`h-4 w-4 shrink-0 rounded-full ${option.swatchClass}`} />
              <span className="truncate text-sm font-medium">{option.label}</span>
            </button>
          )
        })}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        {currentColorId && (
          <Button variant="ghost" onClick={onReset}>
            Reset color
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  )
}
