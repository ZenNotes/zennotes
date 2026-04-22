import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { FolderIconId } from '@shared/ipc'
import { FOLDER_ICON_OPTIONS } from './FolderIcons'

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
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 pt-[14vh] backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[min(560px,92vw)] overflow-hidden rounded-xl bg-paper-100 shadow-float ring-1 ring-paper-300"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-5 pt-5">
          <div className="text-sm font-semibold text-ink-900">Choose icon</div>
          <div className="mt-1 text-xs text-ink-500">
            Select a sidebar icon for <span className="font-medium text-ink-700">{targetLabel}</span>.
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 px-5 py-4 sm:grid-cols-3">
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
        </div>
        <div className="flex justify-end gap-2 border-t border-paper-300/50 bg-paper-50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-paper-300 bg-paper-100 px-3 py-1.5 text-sm text-ink-800 hover:bg-paper-200"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
