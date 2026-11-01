/**
 * The colours a Kanban column can carry (#1037). A short palette on the
 * theme's own hue tokens rather than fixed hexes, so each bundled theme (and
 * a custom one) draws Blue in its own blue, light and dark alike. Stored by
 * name, which is also what a person types in config.toml.
 */
export const KANBAN_COLUMN_COLORS = [
  { id: 'gray', label: 'Gray', token: '--z-grey-1' },
  { id: 'red', label: 'Red', token: '--z-red' },
  { id: 'yellow', label: 'Yellow', token: '--z-yellow' },
  { id: 'green', label: 'Green', token: '--z-green' },
  { id: 'teal', label: 'Teal', token: '--z-aqua' },
  { id: 'blue', label: 'Blue', token: '--z-blue' },
  { id: 'purple', label: 'Purple', token: '--z-purple' }
] as const

export type KanbanColumnColor = (typeof KANBAN_COLUMN_COLORS)[number]['id']

// The other spelling of a name, and the theme token's own name for teal.
const ALIASES: Record<string, KanbanColumnColor> = { grey: 'gray', aqua: 'teal' }

/** A colour name as stored or typed (`Blue`, ` grey `), or null when it names
 *  none of the palette. */
export function parseKanbanColumnColor(raw: unknown): KanbanColumnColor | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim().toLowerCase()
  const known = KANBAN_COLUMN_COLORS.find((color) => color.id === name)
  return known ? known.id : (ALIASES[name] ?? null)
}

export function kanbanColumnColorLabel(color: KanbanColumnColor): string {
  return KANBAN_COLUMN_COLORS.find((entry) => entry.id === color)?.label ?? color
}

/** The theme token behind a palette entry, as `var(--z-blue)`: an RGB
 *  triplet, for `rgb(...)` with or without an alpha. */
export function kanbanColumnColorVar(color: KanbanColumnColor): string {
  const token = KANBAN_COLUMN_COLORS.find((entry) => entry.id === color)?.token ?? '--z-grey-1'
  return `var(${token})`
}

/** The CSS colour of a palette entry, from the active theme's token. */
export function kanbanColumnColorCss(color: KanbanColumnColor): string {
  return `rgb(${kanbanColumnColorVar(color)})`
}
