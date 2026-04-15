export function confirmMoveToTrash(title?: string | null): boolean {
  const trimmed = title?.trim()
  const target = trimmed ? `"${trimmed}"` : 'this note'
  return window.confirm(
    `Move ${target} to Trash?\n\nYou can restore it later from the Trash view.`
  )
}
