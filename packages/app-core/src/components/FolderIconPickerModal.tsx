import type { FolderIconId } from '@shared/ipc'
import { FOLDER_ICON_OPTIONS } from './FolderIcons'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

export function FolderIconPickerModal({
  targetLabel,
  currentIconId,
  onSelect,
  onCancel
}: {
  targetLabel: string
  currentIconId: FolderIconId
  onSelect: (iconId: FolderIconId) => void
  onCancel: () => void
}): JSX.Element {
  return (
    <Modal size="md" layer="modal" onClose={onCancel}>
      <Modal.Header
        title="Choose icon"
        description={
          <>
            Select a sidebar icon for{' '}
            <span className="font-medium text-ink-700">{targetLabel}</span>.
          </>
        }
      />
      <Modal.Body className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {FOLDER_ICON_OPTIONS.map((option) => {
          const active = option.id === currentIconId
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
              <span className={active ? 'text-accent' : 'text-ink-500'}>{option.icon}</span>
              <span className="truncate text-sm font-medium">{option.label}</span>
            </button>
          )
        })}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
