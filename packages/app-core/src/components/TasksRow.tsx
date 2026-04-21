import type { VaultTask } from '@shared/tasks'
import { ArrowUpRightIcon } from './icons'

interface Props {
  task: VaultTask
  isOverdue: boolean
  isCursor: boolean
  onToggle: () => void
  onOpen: () => void
  onFocusRow: () => void
}

function priorityLabel(p: VaultTask['priority']): string {
  if (p === 'high') return '!high'
  if (p === 'med') return '!med'
  if (p === 'low') return '!low'
  return ''
}

function priorityClass(p: VaultTask['priority']): string {
  if (p === 'high') return 'text-rose-400'
  if (p === 'med') return 'text-amber-400'
  if (p === 'low') return 'text-sky-400'
  return 'text-current/50'
}

function formatDue(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function TasksRow({
  task,
  isOverdue,
  isCursor,
  onToggle,
  onOpen,
  onFocusRow
}: Props): JSX.Element {
  return (
    <div
      data-task-row={task.id}
      onMouseEnter={onFocusRow}
      onClick={onFocusRow}
      className={[
        'group flex items-start gap-2 rounded-md px-3 py-1.5',
        'border-l-2 transition-colors',
        isOverdue ? 'border-rose-500/70' : 'border-transparent',
        // `vim-cursor` uses the theme accent at 15% — same convention as
        // the sidebar/notelist so the highlight reads consistently across
        // light and dark themes.
        isCursor ? 'vim-cursor' : 'hover:bg-current/5'
      ].join(' ')}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={task.checked}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        className={[
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors',
          task.checked
            ? 'border border-accent bg-accent text-white'
            : 'border border-current/40 hover:bg-current/10'
        ].join(' ')}
      >
        {task.checked && (
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
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div
          className={[
            'truncate text-sm',
            task.checked ? 'text-current/50 line-through' : 'text-current/90'
          ].join(' ')}
        >
          {task.content || '(empty task)'}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-current/50">
          <span className="truncate">{task.noteTitle}</span>
          {task.waiting && (
            <span className="rounded bg-current/10 px-1.5 py-0.5 text-purple-300">
              @waiting
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs">
        {task.priority && (
          <span className={`font-medium ${priorityClass(task.priority)}`}>
            {priorityLabel(task.priority)}
          </span>
        )}
        {task.due && (
          <span
            className={[
              'rounded px-1.5 py-0.5 font-medium',
              isOverdue
                ? 'bg-rose-500/15 text-rose-300'
                : 'bg-current/10 text-current/70'
            ].join(' ')}
          >
            {formatDue(task.due)}
          </span>
        )}
        {isCursor && (
          // Inline key hints — only on the cursor row so the strip stays
          // quiet and acts as an in-line cheat sheet for the user.
          <div className="flex items-center gap-1 text-[10px] text-current/60">
            <KeyHint keyLabel="Space" label={task.checked ? 'uncheck' : 'check'} />
            <KeyHint keyLabel="⏎" label="open" />
          </div>
        )}
        <button
          type="button"
          aria-label={`Open ${task.noteTitle}`}
          title="Open note (Enter / o)"
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          // Always visible (non-zero opacity) so `f` hint mode can target
          // it — HintOverlay skips elements with `opacity: 0`. Subtle at
          // rest, brightens on hover / when the row is the cursor.
          className={[
            'flex h-6 w-6 items-center justify-center rounded-md transition-colors',
            'hover:bg-current/10',
            isCursor ? 'text-current/90' : 'text-current/30 group-hover:text-current/80'
          ].join(' ')}
        >
          <ArrowUpRightIcon width={14} height={14} />
        </button>
      </div>
    </div>
  )
}

function KeyHint({ keyLabel, label }: { keyLabel: string; label: string }): JSX.Element {
  return (
    <span className="pointer-events-none flex items-center gap-1 rounded-md border border-current/20 bg-current/5 px-1.5 py-0.5 leading-none">
      <span className="font-mono text-[10px] text-current/90">{keyLabel}</span>
      <span className="text-current/60">{label}</span>
    </span>
  )
}
