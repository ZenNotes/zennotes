import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import { useStore } from '../store'
import type { CalendarPanelState } from './calendar-panel-auto'
import {
  PANE_PANELS_CLOSED,
  panePanelsForPath,
  withCalendar,
  type PanePanelsByPath,
  type PanePanelsState
} from './pane-panels'

const NO_PANELS: PanePanelsByPath = {}

function resolve<T>(next: SetStateAction<T>, current: T): T {
  return typeof next === 'function' ? (next as (value: T) => T)(current) : next
}

export interface PanePanels extends Omit<PanePanelsState, 'calendarDismissed'> {
  /** False on a note whose calendar the user put away while panels are per
   *  note; the auto-open for date notes has to respect that. */
  calendarAutoOpenAllowed: boolean
  setConnectionsOpen: (next: SetStateAction<boolean>) => void
  setOutlineOpen: (next: SetStateAction<boolean>) => void
  setCommentsOpen: (next: SetStateAction<boolean>) => void
  setCalendarPanel: (next: SetStateAction<CalendarPanelState>) => void
}

/**
 * The right-hand panels of one editor pane, from wherever the "Keep panels
 * when switching notes" preference says they live (#794).
 *
 * On, the default, they are this component's own state: one sticky set per
 * pane, exactly as before, with the same lifetime as the pane. Off, they come
 * from the store's per-note map for `path`, so opening another note shows that
 * note's panels and coming back restores these.
 *
 * The setters keep `useState`'s shape and a stable identity, because the
 * editor hands them to CodeMirror handlers that are built once per mount; they
 * read the live preference and path through refs instead of closing over them.
 */
export function usePanePanels(paneId: string, path: string | null): PanePanels {
  const keep = useStore((s) => s.keepPanelsAcrossNotes)
  const byPath = useStore((s) => s.panePanels[paneId]) ?? NO_PANELS
  const [sticky, setSticky] = useState<PanePanelsState>(PANE_PANELS_CLOSED)
  const perNote = panePanelsForPath(byPath, path)
  const usesSticky = keep || !path
  const panels = usesSticky ? sticky : perNote

  const live = useRef({ paneId, path, usesSticky, panels })
  live.current = { paneId, path, usesSticky, panels }

  // Flipping the preference must not rearrange the screen under the user: the
  // set that was showing is carried into the store that takes over, so the
  // panels on view stay put and only later note switches behave differently.
  const previousKeep = useRef(keep)
  useEffect(() => {
    if (previousKeep.current === keep) return
    previousKeep.current = keep
    const { paneId: pane, path: note } = live.current
    if (keep) setSticky(panePanelsForPath(useStore.getState().panePanels[pane] ?? NO_PANELS, note))
    else if (note) {
      useStore.getState().updatePanePanelsForPath(pane, note, () => ({
        ...sticky,
        calendarDismissed: false
      }))
    }
    // `sticky` is read at the moment of the flip only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keep])

  const update = useCallback((change: (current: PanePanelsState) => PanePanelsState) => {
    const now = live.current
    if (now.usesSticky) setSticky(change)
    else useStore.getState().updatePanePanelsForPath(now.paneId, now.path, change)
  }, [])

  const setConnectionsOpen = useCallback(
    (next: SetStateAction<boolean>) =>
      update((p) => ({ ...p, connections: resolve(next, p.connections) })),
    [update]
  )
  const setOutlineOpen = useCallback(
    (next: SetStateAction<boolean>) => update((p) => ({ ...p, outline: resolve(next, p.outline) })),
    [update]
  )
  const setCommentsOpen = useCallback(
    (next: SetStateAction<boolean>) =>
      update((p) => ({ ...p, comments: resolve(next, p.comments) })),
    [update]
  )
  const setCalendarPanel = useCallback(
    (next: SetStateAction<CalendarPanelState>) =>
      update((p) => withCalendar(p, resolve(next, p.calendar), !live.current.usesSticky)),
    [update]
  )

  const { calendarDismissed, ...shown } = panels
  return {
    ...shown,
    calendarAutoOpenAllowed: usesSticky || !calendarDismissed,
    setConnectionsOpen,
    setOutlineOpen,
    setCommentsOpen,
    setCalendarPanel
  }
}
