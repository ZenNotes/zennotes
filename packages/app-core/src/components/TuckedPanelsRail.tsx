import { TUCKED_RAIL_WIDTH, type SidePanelId } from '../lib/side-panel-fit'
import { CalendarIcon, FeedbackIcon, ListTreeIcon, PanelRightIcon } from './icons'

const PANELS: Record<SidePanelId, { label: string; icon: typeof PanelRightIcon }> = {
  connections: { label: 'Connections', icon: PanelRightIcon },
  comments: { label: 'Comments', icon: FeedbackIcon },
  outline: { label: 'Outline', icon: ListTreeIcon },
  calendar: { label: 'Calendar', icon: CalendarIcon }
}

/**
 * The panels that are open but do not fit next to the note in a narrow pane
 * (#805). They are tucked, not closed: nothing the user opened is lost, and
 * each one comes forward with a click here or with its usual shortcut, at
 * which point the panel opened longest ago takes its place in the rail.
 */
export function TuckedPanelsRail({
  tucked,
  onReveal
}: {
  tucked: readonly SidePanelId[]
  onReveal: (id: SidePanelId) => void
}): JSX.Element | null {
  if (tucked.length === 0) return null
  return (
    <nav
      data-tucked-panels
      aria-label="Open panels that do not fit"
      style={{ width: TUCKED_RAIL_WIDTH }}
      className="flex shrink-0 flex-col items-center gap-1 border-l border-paper-300/70 bg-paper-50/18 py-2"
    >
      {tucked.map((id) => {
        const { label, icon: Icon } = PANELS[id]
        const title = `Show ${label} (open, tucked away to leave room for the note)`
        return (
          <button
            key={id}
            type="button"
            data-tucked-panel={id}
            title={title}
            aria-label={title}
            onClick={() => onReveal(id)}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-paper-200/70 text-ink-700 transition-colors hover:bg-paper-200 hover:text-ink-900"
          >
            <Icon />
          </button>
        )
      })}
    </nav>
  )
}
