import { describe, expect, it } from 'vitest'
import { CALENDAR_PANEL_CLOSED } from './calendar-panel-auto'
import {
  PANE_PANELS_CLOSED,
  panePanelsForPath,
  panePanelsForSnapshot,
  panePanelsFromSnapshot,
  panePanelsWithPath,
  prunePanePanels,
  withCalendar,
  type PanePanelsState
} from './pane-panels'

const outlineOpen: PanePanelsState = { ...PANE_PANELS_CLOSED, outline: true }

describe('per-note panels (#794)', () => {
  it('reads a note the pane has not seen yet as all closed', () => {
    expect(panePanelsForPath({}, 'inbox/A.md')).toEqual(PANE_PANELS_CLOSED)
    expect(panePanelsForPath({ 'inbox/A.md': outlineOpen }, 'inbox/B.md')).toEqual(
      PANE_PANELS_CLOSED
    )
    expect(panePanelsForPath({ 'inbox/A.md': outlineOpen }, null)).toEqual(PANE_PANELS_CLOSED)
  })

  it('remembers each note separately', () => {
    const map = panePanelsWithPath({}, 'inbox/A.md', outlineOpen)
    expect(panePanelsForPath(map, 'inbox/A.md').outline).toBe(true)
    expect(panePanelsForPath(map, 'inbox/B.md').outline).toBe(false)
  })

  it('returns the same map when nothing changed, so the store does not notify', () => {
    const map = { 'inbox/A.md': outlineOpen }
    expect(panePanelsWithPath(map, 'inbox/A.md', { ...outlineOpen })).toBe(map)
    expect(panePanelsWithPath(map, null, PANE_PANELS_CLOSED)).toBe(map)
    expect(panePanelsWithPath(map, 'inbox/B.md', PANE_PANELS_CLOSED)).toBe(map)
  })

  it('drops a note whose panels are all closed instead of storing the default', () => {
    const map = panePanelsWithPath({ 'inbox/A.md': outlineOpen }, 'inbox/A.md', PANE_PANELS_CLOSED)
    expect(map).toEqual({})
  })

  // Closed-by-the-user has to survive as an entry, or a daily note's calendar
  // would auto-open again every time you came back to it.
  it('keeps a note whose only memory is a calendar the user put away', () => {
    const open = withCalendar(PANE_PANELS_CLOSED, { open: true, auto: true }, true)
    const dismissed = withCalendar(open, CALENDAR_PANEL_CLOSED, true)
    expect(dismissed.calendarDismissed).toBe(true)
    expect(panePanelsWithPath({}, 'daily/today.md', dismissed)).toEqual({
      'daily/today.md': dismissed
    })
  })

  it('forgets the dismissal as soon as the calendar is opened again', () => {
    const dismissed = { ...PANE_PANELS_CLOSED, calendarDismissed: true }
    expect(withCalendar(dismissed, { open: true, auto: false }, true).calendarDismissed).toBe(false)
  })

  it('never records a dismissal for a sticky pane, whose auto-open keeps firing (#502)', () => {
    const open = withCalendar(PANE_PANELS_CLOSED, { open: true, auto: true }, false)
    expect(withCalendar(open, CALENDAR_PANEL_CLOSED, false).calendarDismissed).toBe(false)
  })
})

describe('per-note panels in the workspace snapshot (#794)', () => {
  const panes = new Set(['pane-a', 'pane-b'])

  it('round-trips through JSON, so a restart brings each note back as it was left', () => {
    const live = {
      'pane-a': {
        'inbox/A.md': outlineOpen,
        'inbox/Daily.md': withCalendar(PANE_PANELS_CLOSED, { open: true, auto: true }, true)
      },
      'pane-b': { 'inbox/B.md': { ...PANE_PANELS_CLOSED, comments: true, connections: true } }
    }
    const file = JSON.parse(JSON.stringify(panePanelsForSnapshot(live, panes)))
    expect(panePanelsFromSnapshot(file, panes)).toEqual(live)
  })

  it('keeps a calendar the user closed on a note closed after a restart', () => {
    const open = withCalendar(PANE_PANELS_CLOSED, { open: true, auto: true }, true)
    const dismissed = withCalendar(open, CALENDAR_PANEL_CLOSED, true)
    const file = JSON.parse(JSON.stringify(panePanelsForSnapshot({ 'pane-a': { d: dismissed } }, panes)))
    expect(panePanelsFromSnapshot(file, panes)['pane-a'].d.calendarDismissed).toBe(true)
  })

  it('writes only panes the layout still has', () => {
    const live = { 'pane-a': { a: outlineOpen }, 'pane-closed': { b: outlineOpen }, 'pane-b': {} }
    expect(panePanelsForSnapshot(live, panes)).toEqual({ 'pane-a': { a: { outline: true } } })
  })

  it('spells out only what is open, so the synced file stays small', () => {
    const live = {
      'pane-a': {
        a: { ...PANE_PANELS_CLOSED, connections: true, calendar: { open: true, auto: false } },
        b: withCalendar(
          withCalendar(PANE_PANELS_CLOSED, { open: true, auto: true }, true),
          CALENDAR_PANEL_CLOSED,
          true
        )
      }
    }
    expect(panePanelsForSnapshot(live, panes)).toEqual({
      'pane-a': { a: { connections: true, calendar: { open: true } }, b: { calendarDismissed: true } }
    })
  })

  it('lets go of the least recently set notes past the limit', () => {
    let byPath = {}
    for (const path of ['one', 'two', 'three']) byPath = panePanelsWithPath(byPath, path, outlineOpen)
    // Touching "one" again makes it the most recent, so "two" is the one to go.
    byPath = panePanelsWithPath(byPath, 'one', { ...outlineOpen, comments: true })
    const kept = panePanelsForSnapshot({ 'pane-a': byPath }, panes, 2)['pane-a']
    expect(Object.keys(kept)).toEqual(['three', 'one'])
  })

  // The file syncs between machines and versions and can be edited by hand.
  it('trusts nothing in the file', () => {
    expect(panePanelsFromSnapshot(null, panes)).toEqual({})
    expect(panePanelsFromSnapshot('nope', panes)).toEqual({})
    expect(panePanelsFromSnapshot([], panes)).toEqual({})
    const restored = panePanelsFromSnapshot(
      {
        'pane-a': {
          good: { outline: true, connections: 'yes', calendar: { open: false, auto: true } },
          allClosed: { outline: false },
          garbage: 7,
          '': { outline: true }
        },
        'pane-b': 'not a map',
        'pane-from-another-layout': { x: { outline: true } }
      },
      panes
    )
    expect(restored).toEqual({ 'pane-a': { good: outlineOpen } })
  })

  it('retires notes that no longer exist, and says so only when something went', () => {
    const live = { 'pane-a': { kept: outlineOpen, gone: outlineOpen }, 'pane-b': { gone: outlineOpen } }
    expect(prunePanePanels(live, (path) => path === 'kept')).toEqual({ 'pane-a': { kept: outlineOpen } })
    expect(prunePanePanels(live, () => true)).toBe(live)
  })
})
