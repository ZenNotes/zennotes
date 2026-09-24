import type { VaultTask } from '@shared/tasks'

/**
 * The little box in front of a task on the Tasks surfaces.
 *
 * It draws the state char the line actually carries: a check for `[x]`, a
 * half-filled box for `[/]` in progress, a ✕ for `[-]` cancelled, an arrow for
 * `[>]` forwarded, and an empty box for open. The list and the board used to
 * render every one of those as the same empty checkbox, so the only thing
 * telling a cancelled task from a live one was which group it sat under.
 *
 * Clicking still toggles done, everywhere, which is what the checkbox shape
 * promises.
 */
interface Props {
  task: VaultTask
  onToggle: () => void
  /** Border/hover classes for the idle (unchecked) box, so each surface keeps
   *  its own palette. */
  idleClassName?: string
  /** Extra classes on the button (margins differ per surface). */
  className?: string
  /** Stop the pointer events that would otherwise start a card drag. */
  stopPointerEvents?: boolean
  /** The key that toggles the task from the keyboard, named in the tooltip.
   *  Left out with Vim mode off, where no such key exists: the tooltip then
   *  promises only what the click does. */
  toggleKey?: string | null
}

function stateLabel(task: VaultTask): string {
  if (task.inProgress) return 'In progress. '
  if (task.cancelled) return 'Cancelled. '
  if (task.forwarded) return 'Forwarded to another note. '
  return ''
}

export function TaskStateBox({
  task,
  onToggle,
  idleClassName = 'border border-current/40 hover:bg-current/10',
  className = 'mt-0.5',
  stopPointerEvents = false,
  toggleKey = null
}: Props): JSX.Element {
  const stopper = stopPointerEvents
    ? {
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation()
      }
    : {}
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={task.checked}
      draggable={false}
      title={`${stateLabel(task)}Toggle task${toggleKey ? ` (${toggleKey})` : ''}`}
      {...stopper}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={[
        className,
        'flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors',
        task.checked
          ? 'border border-accent bg-accent text-white'
          : task.inProgress
            ? 'border border-accent text-accent hover:bg-current/10'
            : task.cancelled || task.forwarded
              ? 'border-none text-current/50 hover:bg-current/10'
              : idleClassName
      ].join(' ')}
    >
      {task.checked ? (
        <svg
          viewBox="0 0 24 24"
          width="11"
          height="11"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m5 12 5 5L20 7" />
        </svg>
      ) : task.inProgress ? (
        // The same box, half filled: started, not finished.
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M12 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h5z" fill="currentColor" />
        </svg>
      ) : task.cancelled ? (
        <svg
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      ) : task.forwarded ? (
        <svg
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 12h15M13 6l7 6-7 6" />
        </svg>
      ) : null}
    </button>
  )
}
