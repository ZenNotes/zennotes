import { confirmApp } from './confirm-requests'

export function confirmMoveToTrash(title?: string | null, systemTrash = false): Promise<boolean> {
  const trimmed = title?.trim()
  const target = trimmed ? `"${trimmed}"` : 'this note'
  return confirmApp({
    title: `Move ${target} to Trash?`,
    description: systemTrash
      ? 'The file will move to your system Trash. Restore it using your file manager.'
      : 'You can restore it later from the Trash view.',
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

/** Deleting a comment from the Comments panel's keys (d with Vim on, Backspace
 *  or Delete in either mode). A comment has no Trash to come back from, and
 *  Backspace is the key most often pressed by accident. The card's own Delete
 *  button does not ask. */
export function confirmDeleteComment(): Promise<boolean> {
  return confirmApp({
    title: 'Delete this comment?',
    description: 'This cannot be undone.',
    confirmLabel: 'Delete comment',
    danger: true
  })
}
