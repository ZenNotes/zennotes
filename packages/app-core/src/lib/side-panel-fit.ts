/**
 * How the right-hand panels of an editor pane share its width with the note.
 *
 * Connections, Comments, Outline and Calendar each have a width the user
 * chose (200 to 640 px) and can all be open at once, and nothing used to
 * reserve room for the note itself. In a full-width window that is fine. In a
 * split pane two panels left the note a column a few characters wide, and a
 * third left it none. (#805)
 *
 * The note comes first: it keeps a readable minimum, and the panels give way
 * in two steps. First they shrink, in proportion, down to the smallest width a
 * panel can be dragged to. If that is still too much, the panels opened
 * longest ago are tucked away (they stay open, a rail lists them, and their
 * shortcut brings one forward) until the rest fits.
 */
export type SidePanelId = 'connections' | 'comments' | 'outline' | 'calendar'

/** Below this an editor column stops being readable. */
export const MIN_NOTE_WIDTH = 320
/** Split mode shows the source and the preview side by side. */
export const MIN_SPLIT_NOTE_WIDTH = 520
/** The rail that lists tucked panels. */
export const TUCKED_RAIL_WIDTH = 40
/** A lone panel in a pane too narrow for both still has to be usable. */
const LAST_PANEL_FLOOR = 180

export interface SidePanelFit {
  /** Width to render each panel that is shown. */
  widths: Partial<Record<SidePanelId, number>>
  /** Open panels that do not fit, most recently opened first. */
  tucked: SidePanelId[]
}

/**
 * `panels` are the open ones, most recently opened first. `rowWidth` is the
 * pane's inner width; 0 or less means "not measured yet", and then nothing is
 * changed, so the first paint is what it always was.
 */
export function fitSidePanels(
  rowWidth: number,
  minNoteWidth: number,
  panels: ReadonlyArray<{ id: SidePanelId; width: number }>,
  minPanelWidth: number
): SidePanelFit {
  const full = (): SidePanelFit => ({
    widths: Object.fromEntries(panels.map((panel) => [panel.id, panel.width])),
    tucked: []
  })
  if (rowWidth <= 0 || panels.length === 0) return full()

  const shown = [...panels]
  const tucked: SidePanelId[] = []
  for (;;) {
    const available = rowWidth - minNoteWidth - (tucked.length > 0 ? TUCKED_RAIL_WIDTH : 0)
    const wanted = shown.reduce((sum, panel) => sum + panel.width, 0)
    if (wanted <= available) {
      return { widths: Object.fromEntries(shown.map((p) => [p.id, p.width])), tucked }
    }
    const floors = shown.map((panel) => Math.min(panel.width, minPanelWidth))
    const floorTotal = floors.reduce((sum, floor) => sum + floor, 0)
    if (floorTotal <= available) {
      // Everyone keeps their floor; what is left goes out in proportion to how
      // much each panel wanted above it.
      const spare = available - floorTotal
      const stretch = wanted - floorTotal
      return {
        widths: Object.fromEntries(
          shown.map((panel, i) => [
            panel.id,
            Math.floor(floors[i] + (stretch > 0 ? ((panel.width - floors[i]) * spare) / stretch : 0))
          ])
        ),
        tucked
      }
    }
    if (shown.length === 1) {
      // Too narrow for a note and a panel both: the panel the user just asked
      // for still shows, as small as a panel can usefully be.
      const only = shown[0]
      return {
        widths: { [only.id]: Math.min(only.width, Math.max(LAST_PANEL_FLOOR, available)) },
        tucked
      }
    }
    tucked.unshift(shown.pop()!.id)
  }
}

/** `recency` with `id` moved to the front; the same array when it already is. */
export function bumpSidePanel(recency: readonly SidePanelId[], id: SidePanelId): SidePanelId[] {
  if (recency[0] === id) return recency as SidePanelId[]
  return [id, ...recency.filter((other) => other !== id)]
}

/**
 * `recency` brought in line with what is open: closed panels leave, and panels
 * that opened without anyone saying which came first (a note switch restoring
 * several at once) join at the front in the given order.
 */
export function syncSidePanelRecency(
  recency: readonly SidePanelId[],
  open: readonly SidePanelId[]
): SidePanelId[] {
  const kept = recency.filter((id) => open.includes(id))
  const joined = open.filter((id) => !kept.includes(id))
  if (joined.length === 0 && kept.length === recency.length) return recency as SidePanelId[]
  return [...joined, ...kept]
}
