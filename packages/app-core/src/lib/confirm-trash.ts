import { confirmApp } from './confirm-requests'

export function confirmMoveToTrash(
  title: string | null | undefined,
  t: (s: string) => string
): Promise<boolean> {
  const trimmed = title?.trim()
  const target = trimmed ? `"${trimmed}"` : t('this note')
  return confirmApp({
    title: t('Move {target} to Trash?').replace('{target}', target),
    description: t('You can restore it later from the Trash view.'),
    confirmLabel: t('Move to Trash')
  })
}
