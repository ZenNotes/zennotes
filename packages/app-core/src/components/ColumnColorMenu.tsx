import { KANBAN_COLUMN_COLORS, kanbanColumnColorCss, type KanbanColumnColor } from '../lib/kanban-column-colors'
import type { ContextMenuItem } from './ContextMenu'

/**
 * The palette as a menu, the current color checked so the cursor starts on it.
 * One list for both boards, so a Tasks column and a database column offer the
 * same choices under the same names.
 */
export function columnColorMenuItems(
  current: KanbanColumnColor | null | undefined,
  onPick: (color: KanbanColumnColor | null) => void
): ContextMenuItem[] {
  const items: ContextMenuItem[] = KANBAN_COLUMN_COLORS.map((color) => ({
    label: color.label,
    icon: (
      <span
        className="block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: kanbanColumnColorCss(color.id) }}
        aria-hidden="true"
      />
    ),
    checked: current === color.id,
    keywords: color.id === 'gray' ? ['grey'] : color.id === 'teal' ? ['aqua'] : undefined,
    onSelect: () => onPick(color.id)
  }))
  items.push(
    { kind: 'separator' },
    {
      label: 'No color',
      checked: !current,
      keywords: ['none', 'clear', 'remove'],
      onSelect: () => onPick(null)
    }
  )
  return items
}
