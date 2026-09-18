import { CALENDAR_PANEL_CLOSED, type CalendarPanelState } from './calendar-panel-auto'

/**
 * Which right-hand panels an editor pane shows: Connections, Outline, Comments
 * and the Calendar (whose open carries the provenance bit from #502).
 *
 * Panels have always been sticky per pane, Obsidian-style: open the Outline
 * and it stays while you browse. With "Keep panels when switching notes" off,
 * a pane instead remembers one of these per note, the way it already remembers
 * each note's Edit / Split / Preview mode (#794). The memory never belongs in
 * the note, which is a plain file. It outlives a restart the way tabs and
 * layout do, through the workspace snapshot: see `panePanelsForSnapshot`.
 */
export interface PanePanelsState {
  connections: boolean
  outline: boolean
  comments: boolean
  calendar: CalendarPanelState
  /**
   * The user closed the calendar on this note. Only written per note: there it
   * keeps the auto-open for daily and weekly notes from reopening a calendar
   * the note was told to forget. A sticky pane never sets it, so its auto-open
   * keeps firing on every arrival at a date note, as it always has (#502).
   */
  calendarDismissed: boolean
}

export type PanePanelsByPath = Record<string, PanePanelsState>

/** A note the pane has not seen yet starts with nothing open. */
export const PANE_PANELS_CLOSED: PanePanelsState = {
  connections: false,
  outline: false,
  comments: false,
  calendar: CALENDAR_PANEL_CLOSED,
  calendarDismissed: false
}

export function samePanePanels(a: PanePanelsState, b: PanePanelsState): boolean {
  return (
    a.connections === b.connections &&
    a.outline === b.outline &&
    a.comments === b.comments &&
    a.calendar.open === b.calendar.open &&
    a.calendar.auto === b.calendar.auto &&
    a.calendarDismissed === b.calendarDismissed
  )
}

export function panePanelsForPath(
  panelsByPath: PanePanelsByPath,
  path: string | null
): PanePanelsState {
  return path ? panelsByPath[path] ?? PANE_PANELS_CLOSED : PANE_PANELS_CLOSED
}

/**
 * The calendar after a write, with the per-note "dismissed" bit kept in step:
 * going from open to closed is the user (or Esc) putting it away on this note,
 * and any open clears that again.
 */
export function withCalendar(
  panels: PanePanelsState,
  calendar: CalendarPanelState,
  perNote: boolean
): PanePanelsState {
  const calendarDismissed = calendar.open
    ? false
    : perNote && panels.calendar.open
      ? true
      : panels.calendarDismissed
  return { ...panels, calendar, calendarDismissed }
}

/**
 * The map with `path` set to `panels`. A note whose panels are all closed is
 * dropped rather than stored, since closed is what an absent note reads as, so
 * the map only ever holds notes that differ from the default.
 */
export function panePanelsWithPath(
  panelsByPath: PanePanelsByPath,
  path: string | null,
  panels: PanePanelsState
): PanePanelsByPath {
  if (!path) return panelsByPath
  const current = panelsByPath[path]
  if (samePanePanels(panels, PANE_PANELS_CLOSED)) {
    if (!current) return panelsByPath
    const { [path]: _dropped, ...rest } = panelsByPath
    return rest
  }
  if (current && samePanePanels(current, panels)) return panelsByPath
  // Re-inserted rather than updated in place, so key order is "least recently
  // set first" and the snapshot limit below knows which notes to let go of.
  const { [path]: _previous, ...rest } = panelsByPath
  return { ...rest, [path]: panels }
}

/** How many notes per pane the workspace snapshot remembers panels for. */
export const PANE_PANELS_SNAPSHOT_LIMIT = 200

/** One note's panels as the snapshot file spells them: only what is set. */
export interface PanePanelsSnapshotEntry {
  connections?: true
  outline?: true
  comments?: true
  calendar?: { open: true; auto?: true }
  calendarDismissed?: true
}

export type PanePanelsSnapshot = Record<string, Record<string, PanePanelsSnapshotEntry>>

/**
 * The per-note panels worth writing to the workspace snapshot: panes that still
 * exist, per pane only the most recently set notes, and per note only what is
 * open. The snapshot syncs with the vault, so it has to stay small however long
 * the vault lives.
 */
export function panePanelsForSnapshot(
  panePanels: Record<string, PanePanelsByPath>,
  paneIds: ReadonlySet<string>,
  limit: number = PANE_PANELS_SNAPSHOT_LIMIT
): PanePanelsSnapshot {
  const out: PanePanelsSnapshot = {}
  for (const [paneId, byPath] of Object.entries(panePanels)) {
    if (!paneIds.has(paneId)) continue
    const entries = Object.entries(byPath)
    if (entries.length === 0) continue
    out[paneId] = Object.fromEntries(
      entries.slice(-limit).map(([path, panels]): [string, PanePanelsSnapshotEntry] => [
        path,
        {
          ...(panels.connections && { connections: true }),
          ...(panels.outline && { outline: true }),
          ...(panels.comments && { comments: true }),
          ...(panels.calendar.open && {
            calendar: panels.calendar.auto ? { open: true, auto: true } : { open: true }
          }),
          ...(panels.calendarDismissed && { calendarDismissed: true })
        }
      ])
    )
  }
  return out
}

/**
 * Per-note panels read back from a workspace snapshot. The snapshot is a file
 * that travels between machines and app versions and can be edited by hand, so
 * nothing in it is trusted: panes the layout does not have are dropped, every
 * field is coerced to its type, and a note with nothing to remember is not kept.
 */
export function panePanelsFromSnapshot(
  raw: unknown,
  paneIds: ReadonlySet<string>
): Record<string, PanePanelsByPath> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, PanePanelsByPath> = {}
  for (const [paneId, rawByPath] of Object.entries(raw)) {
    if (!paneIds.has(paneId)) continue
    if (!rawByPath || typeof rawByPath !== 'object' || Array.isArray(rawByPath)) continue
    let byPath: PanePanelsByPath = {}
    for (const [path, rawPanels] of Object.entries(rawByPath)) {
      if (!path || !rawPanels || typeof rawPanels !== 'object') continue
      const value = rawPanels as Record<string, unknown>
      const calendar = (value.calendar ?? {}) as Record<string, unknown>
      byPath = panePanelsWithPath(byPath, path, {
        connections: value.connections === true,
        outline: value.outline === true,
        comments: value.comments === true,
        calendar: { open: calendar.open === true, auto: calendar.open === true && calendar.auto === true },
        calendarDismissed: value.calendarDismissed === true
      })
    }
    if (Object.keys(byPath).length > 0) out[paneId] = byPath
  }
  return out
}

/**
 * The map without the notes `keep` turns down, used once the note listing is
 * in to retire memory for notes that were deleted somewhere else. Returns the
 * same map when nothing was dropped.
 */
export function prunePanePanels(
  panePanels: Record<string, PanePanelsByPath>,
  keep: (path: string) => boolean
): Record<string, PanePanelsByPath> {
  let changed = false
  const out: Record<string, PanePanelsByPath> = {}
  for (const [paneId, byPath] of Object.entries(panePanels)) {
    const kept = Object.entries(byPath).filter(([path]) => keep(path))
    if (kept.length !== Object.keys(byPath).length) changed = true
    if (kept.length > 0) out[paneId] = Object.fromEntries(kept)
  }
  return changed ? out : panePanels
}
