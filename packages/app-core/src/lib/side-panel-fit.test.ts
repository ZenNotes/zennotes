import { describe, expect, it } from 'vitest'
import {
  MIN_NOTE_WIDTH,
  TUCKED_RAIL_WIDTH,
  bumpSidePanel,
  fitSidePanels,
  syncSidePanelRecency,
  type SidePanelId
} from './side-panel-fit'

const MIN_PANEL = 200
const panel = (id: SidePanelId, width: number) => ({ id, width })
const OUTLINE = panel('outline', 260)
const CONNECTIONS = panel('connections', 288)
const COMMENTS = panel('comments', 360)
const total = (widths: Partial<Record<SidePanelId, number>>): number =>
  Object.values(widths).reduce((sum, width) => sum + (width ?? 0), 0)

describe('fitting the side panels next to the note (#805)', () => {
  it('changes nothing when there is room, which is every full-width window', () => {
    const fit = fitSidePanels(1330, MIN_NOTE_WIDTH, [CONNECTIONS, OUTLINE], MIN_PANEL)
    expect(fit).toEqual({ widths: { connections: 288, outline: 260 }, tucked: [] })
  })

  it('changes nothing before the pane has been measured', () => {
    const fit = fitSidePanels(0, MIN_NOTE_WIDTH, [CONNECTIONS, OUTLINE, COMMENTS], MIN_PANEL)
    expect(fit.tucked).toEqual([])
    expect(fit.widths).toEqual({ connections: 288, outline: 260, comments: 360 })
  })

  // The report: a 665 px half pane, Outline then Connections. 548 px of panels
  // left the note about 117.
  it('shrinks the panels before it hides any, and the note keeps its minimum', () => {
    const fit = fitSidePanels(800, MIN_NOTE_WIDTH, [CONNECTIONS, OUTLINE], MIN_PANEL)
    expect(fit.tucked).toEqual([])
    expect(total(fit.widths)).toBeLessThanOrEqual(800 - MIN_NOTE_WIDTH)
    expect(fit.widths.connections!).toBeGreaterThanOrEqual(MIN_PANEL)
    expect(fit.widths.outline!).toBeGreaterThanOrEqual(MIN_PANEL)
    // In proportion: the wider panel is still the wider one.
    expect(fit.widths.connections!).toBeGreaterThan(fit.widths.outline!)
  })

  it('tucks the panel opened longest ago when even the smallest widths do not fit', () => {
    const fit = fitSidePanels(665, MIN_NOTE_WIDTH, [CONNECTIONS, OUTLINE], MIN_PANEL)
    expect(fit.tucked).toEqual(['outline'])
    expect(fit.widths).toEqual({ connections: 288 })
    expect(665 - total(fit.widths) - TUCKED_RAIL_WIDTH).toBeGreaterThanOrEqual(MIN_NOTE_WIDTH)
  })

  it('keeps the tucked panels in the order they would come back', () => {
    const fit = fitSidePanels(665, MIN_NOTE_WIDTH, [COMMENTS, CONNECTIONS, OUTLINE], MIN_PANEL)
    expect(Object.keys(fit.widths)).toEqual(['comments'])
    expect(fit.tucked).toEqual(['connections', 'outline'])
  })

  it('always shows the panel that was just asked for, even in a pane too narrow for both', () => {
    const fit = fitSidePanels(420, MIN_NOTE_WIDTH, [OUTLINE, CONNECTIONS], MIN_PANEL)
    expect(fit.tucked).toEqual(['connections'])
    expect(fit.widths.outline).toBe(180)
  })

  it('never makes a panel wider than the user set it', () => {
    const narrow = panel('outline', 200)
    const fit = fitSidePanels(760, MIN_NOTE_WIDTH, [CONNECTIONS, narrow], MIN_PANEL)
    expect(fit.tucked).toEqual([])
    expect(fit.widths).toEqual({ connections: 240, outline: 200 })
  })
})

describe('which panel was opened last', () => {
  it('moves a panel to the front when it is asked for again', () => {
    expect(bumpSidePanel(['outline', 'comments'], 'comments')).toEqual(['comments', 'outline'])
    const same: SidePanelId[] = ['outline', 'comments']
    expect(bumpSidePanel(same, 'outline')).toBe(same)
  })

  it('drops closed panels and lets restored ones join in a stable order', () => {
    expect(syncSidePanelRecency(['outline', 'comments'], ['comments'])).toEqual(['comments'])
    expect(syncSidePanelRecency(['outline'], ['connections', 'outline', 'calendar'])).toEqual([
      'connections',
      'calendar',
      'outline'
    ])
    const same: SidePanelId[] = ['outline']
    expect(syncSidePanelRecency(same, ['outline'])).toBe(same)
  })
})
