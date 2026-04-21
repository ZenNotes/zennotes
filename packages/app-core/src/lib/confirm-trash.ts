import { confirmApp } from '../components/ConfirmHost'

export function confirmMoveToTrash(title?: string | null): Promise<boolean> {
  const trimmed = title?.trim()
  const target = trimmed ? `"${trimmed}"` : 'this note'
  return confirmApp({
    title: `Move ${target} to Trash?`,
    description: 'You can restore it later from the Trash view.',
    confirmLabel: 'Move to Trash'
  })
}
