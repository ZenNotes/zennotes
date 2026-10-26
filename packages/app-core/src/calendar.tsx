import { CalendarPanel } from './components/CalendarPanel'
import { useStore } from './store'

/**
 * The date calendar as a surface of its own, for hosts that open it from a
 * main screen instead of beside a note (the phone shells' Calendar entry),
 * so it works with no note open. It orients on the open note when that is a
 * daily or weekly note, else on today. `onOpen` runs once it has opened a
 * day, a week or a task's line; a host that shows it as a sheet closes it
 * there.
 */
export function DateCalendar({ onOpen }: { onOpen?: () => void }): JSX.Element {
  const note = useStore((s) => s.activeNote)
  return <CalendarPanel note={note} onOpen={onOpen} />
}
