/**
 * Palette commands that act on the open database's views (#971 keys them).
 *
 * What they act on lives in component state, not the store: whether the
 * Columns popover is open is the header's, and which rows are selected is
 * the Table's. So a command names the database it means and announces
 * itself on a window event, and the DatabaseView in the ACTIVE pane (the
 * same database can be open in two) carries it out.
 */
import { useEffect, useRef } from 'react'
import { csvPathFromDatabaseTab, isDatabaseCsvPath } from '@shared/databases'
import { assetPathFromTab } from './asset-tabs'

export type DatabaseViewCommand =
  | 'columns'
  | 'new-table-view'
  | 'duplicate-view'
  | 'pick-selected'
  | 'show-all-rows'

export const DATABASE_VIEW_COMMAND_EVENT = 'zen:database-view-command'

interface DatabaseViewCommandDetail {
  csvPath: string
  command: DatabaseViewCommand
}

/** The database a tab shows: a `zen://database/` tab, or a `.csv` opened as
 *  an asset tab, which renders the same grid. */
export function databaseCsvPathForTab(tab: string | null | undefined): string | null {
  const direct = csvPathFromDatabaseTab(tab)
  if (direct) return direct
  const asset = assetPathFromTab(tab)
  return asset && isDatabaseCsvPath(asset) ? asset : null
}

export function requestDatabaseViewCommand(csvPath: string, command: DatabaseViewCommand): void {
  window.dispatchEvent(
    new CustomEvent<DatabaseViewCommandDetail>(DATABASE_VIEW_COMMAND_EVENT, {
      detail: { csvPath, command }
    })
  )
}

/** Run `handler` for commands addressed to `csvPath`, while `isActive`. */
export function useDatabaseViewCommand(
  csvPath: string | null,
  isActive: boolean,
  handler: (command: DatabaseViewCommand) => void
): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    if (!csvPath || !isActive) return
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<DatabaseViewCommandDetail>).detail
      if (detail?.csvPath === csvPath) latest.current(detail.command)
    }
    window.addEventListener(DATABASE_VIEW_COMMAND_EVENT, listener)
    return () => window.removeEventListener(DATABASE_VIEW_COMMAND_EVENT, listener)
  }, [csvPath, isActive])
}
