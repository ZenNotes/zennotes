import { Button } from './ui/Button'

/** "Showing 1 picked row" / "Showing 12 picked rows". */
export function pickedRowsLabel(count: number): string {
  return `Showing ${count} picked ${count === 1 ? 'row' : 'rows'}`
}

/**
 * The line under the database header while a view shows only its picked
 * rows, so a view that hides most records always says so. Edit picks is the
 * Table's (a board has no row selection to edit them with); Show all rows
 * drops the picks on either.
 */
export function DatabasePicksStrip({
  count,
  onEdit,
  onShowAll
}: {
  count: number
  onEdit?: () => void
  onShowAll: () => void
}): JSX.Element {
  return (
    <div
      data-db-picks-strip
      className="flex shrink-0 items-center gap-1 border-b border-paper-300/70 bg-accent/5 px-3 py-1 text-xs"
    >
      <span className="mr-2 font-medium text-ink-700">{pickedRowsLabel(count)}</span>
      {onEdit && (
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Edit picks
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onShowAll}>
        Show all rows
      </Button>
    </div>
  )
}
