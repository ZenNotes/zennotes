import { confirmApp } from './confirm-requests'

export function confirmMoveToTrash(title?: string | null): Promise<boolean> {
  const trimmed = title?.trim()
  const target = trimmed ? `"${trimmed}"` : 'this note'
  return confirmApp({
    title: `Move ${target} to Trash?`,
    description: 'You can restore it later from the Trash view.',
    confirmLabel: 'Move to Trash'
  })
}

/** The one wording for deleting a note for good, wherever it is offered: the
 *  Trash view's row action, the editor header of a trashed note, the command
 *  palette. */
export function confirmDeletePermanently(title?: string | null): Promise<boolean> {
  const trimmed = title?.trim()
  const target = trimmed ? `"${trimmed}"` : 'this note'
  return confirmApp({
    title: `Delete ${target} permanently?`,
    description: 'This cannot be undone.',
    confirmLabel: 'Delete permanently',
    danger: true
  })
}
