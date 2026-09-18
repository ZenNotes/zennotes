// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
import { calendarPanelOnToggle } from './calendar-panel-auto'
import { usePanePanels, type PanePanels } from './use-pane-panels'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PANE = 'pane-a'
const A = 'inbox/A.md'
const B = 'inbox/B.md'

describe('usePanePanels (#794)', () => {
  let host: HTMLDivElement
  let root: Root
  let original: ReturnType<typeof useStore.getState>
  let latest: PanePanels

  function Probe({ path }: { path: string | null }): null {
    latest = usePanePanels(PANE, path)
    return null
  }
  const show = (path: string | null): void => act(() => root.render(createElement(Probe, { path })))
  const keepPanels = (on: boolean): void => act(() => useStore.getState().setKeepPanelsAcrossNotes(on))

  beforeEach(() => {
    original = useStore.getState()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    useStore.setState({ keepPanelsAcrossNotes: true, panePanels: {} })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useStore.setState(original, true)
  })

  it('keeps one sticky set per pane by default, exactly as before', () => {
    show(A)
    act(() => latest.setOutlineOpen(true))
    expect(latest.outline).toBe(true)

    show(B)
    expect(latest.outline).toBe(true)
    // Nothing is remembered per note while the preference is on.
    expect(useStore.getState().panePanels).toEqual({})
  })

  it('gives each note its own panels once the preference is off', () => {
    keepPanels(false)
    show(A)
    act(() => {
      latest.setOutlineOpen(true)
      latest.setConnectionsOpen((open) => !open)
    })

    show(B)
    expect([latest.outline, latest.connections, latest.comments]).toEqual([false, false, false])
    act(() => latest.setCommentsOpen(true))

    show(A)
    expect([latest.outline, latest.connections, latest.comments]).toEqual([true, true, false])
    show(B)
    expect([latest.outline, latest.connections, latest.comments]).toEqual([false, false, true])
  })

  // The editor builds its CodeMirror handlers once and keeps the setter it was
  // given, so a setter must act on the note showing NOW, not the one it was
  // captured on.
  it('hands out stable setters that always write to the note on screen', () => {
    keepPanels(false)
    show(A)
    const captured = latest.setCommentsOpen

    show(B)
    expect(latest.setCommentsOpen).toBe(captured)
    act(() => captured(true))

    expect(latest.comments).toBe(true)
    show(A)
    expect(latest.comments).toBe(false)
  })

  it('does not rearrange the screen when the preference is flipped', () => {
    show(A)
    act(() => latest.setOutlineOpen(true))

    keepPanels(false)
    expect(latest.outline).toBe(true) // A adopted what was showing
    show(B)
    expect(latest.outline).toBe(false)
    act(() => latest.setConnectionsOpen(true))

    keepPanels(true)
    expect([latest.outline, latest.connections]).toEqual([false, true]) // B's set became the pane's
    show(A)
    expect([latest.outline, latest.connections]).toEqual([false, true])
  })

  // The panel toggles write to the store from inside their updater (closing a
  // preview, moving focus). A write nested in a zustand `set` callback would be
  // clobbered when that callback returned.
  it('keeps store writes an updater makes along the way', () => {
    keepPanels(false)
    show(A)
    act(() =>
      latest.setConnectionsOpen(() => {
        useStore.getState().setFocusedPanel('editor')
        return true
      })
    )
    expect(latest.connections).toBe(true)
    expect(useStore.getState().focusedPanel).toBe('editor')
  })

  it('remembers a calendar the user put away on one note, without touching the others', () => {
    keepPanels(false)
    show(A)
    act(() => latest.setCalendarPanel({ open: true, auto: true })) // the auto-open
    expect(latest.calendarAutoOpenAllowed).toBe(true)

    act(() => latest.setCalendarPanel(calendarPanelOnToggle)) // the user closes it
    expect(latest.calendar.open).toBe(false)
    expect(latest.calendarAutoOpenAllowed).toBe(false)

    show(B)
    expect(latest.calendarAutoOpenAllowed).toBe(true)
    show(A)
    expect(latest.calendarAutoOpenAllowed).toBe(false)

    act(() => latest.setCalendarPanel(calendarPanelOnToggle)) // opened by hand again
    expect(latest.calendarAutoOpenAllowed).toBe(true)
  })

  it('never blocks the auto-open for a sticky pane (#502 behaviour is unchanged)', () => {
    show(A)
    act(() => latest.setCalendarPanel({ open: true, auto: true }))
    act(() => latest.setCalendarPanel(calendarPanelOnToggle))
    expect(latest.calendarAutoOpenAllowed).toBe(true)
  })

  it('falls back to the sticky set where there is no note', () => {
    keepPanels(false)
    show(null)
    act(() => latest.setOutlineOpen(true))
    expect(latest.outline).toBe(true)
    expect(useStore.getState().panePanels).toEqual({})
  })
})
