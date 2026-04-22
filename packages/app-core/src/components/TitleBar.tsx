import { useStore } from '../store'
import { isTasksTabPath } from '@shared/tasks'
import { isTagsTabPath } from '@shared/tags'
import { isHelpTabPath } from '@shared/help'
import { isArchiveTabPath } from '@shared/archive'
import { isTrashTabPath } from '@shared/trash'
import { isQuickNotesTabPath } from '@shared/quick-notes'
import { resolveSystemFolderLabels } from '../lib/system-folder-labels'

export function TitleBar(): JSX.Element {
  const vault = useStore((s) => s.vault)
  const activeNote = useStore((s) => s.activeNote)
  const selectedPath = useStore((s) => s.selectedPath)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const workspaceMode = useStore((s) => s.workspaceMode)
  const isMac = window.zen.platformSync() === 'darwin'
  const labels = resolveSystemFolderLabels(systemFolderLabels)

  const title = activeNote
    ? activeNote.title
    : isQuickNotesTabPath(selectedPath)
      ? labels.quick
    : isTasksTabPath(selectedPath)
      ? 'Tasks'
      : isTagsTabPath(selectedPath)
        ? 'Tags'
        : isHelpTabPath(selectedPath)
          ? 'Help'
          : isArchiveTabPath(selectedPath)
            ? labels.archive
          : isTrashTabPath(selectedPath)
            ? labels.trash
          : vault
            ? vault.name
            : 'ZenNotes'

  return (
    <div
      className="drag-region glass-titlebar flex h-11 shrink-0 items-center px-4 text-xs text-ink-500"
      style={{ paddingLeft: isMac ? 80 : 12 }}
    >
      <div className="flex flex-1 items-center justify-center gap-2 text-center tracking-wide">
        <span className="truncate">{title}</span>
        {workspaceMode === 'remote' && (
          <span className="rounded-full border border-paper-300/70 bg-paper-100/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-700">
            Remote
          </span>
        )}
      </div>
      {!isMac && (
        <div className="flex items-center gap-1">
          <WinButton onClick={() => window.zen.windowMinimize()} label="–" />
          <WinButton onClick={() => window.zen.windowToggleMaximize()} label="▢" />
          <WinButton
            onClick={() => window.zen.windowClose()}
            label="✕"
            className="hover:bg-red-500/90 hover:text-white"
          />
        </div>
      )}
    </div>
  )
}

function WinButton({
  onClick,
  label,
  className
}: {
  onClick: () => void
  label: string
  className?: string
}): JSX.Element {
  return (
    <button
      className={`no-drag flex h-8 w-10 items-center justify-center rounded-md text-ink-600 hover:bg-paper-200 ${className ?? ''}`}
      onClick={onClick}
      aria-label={label}
    >
      {label}
    </button>
  )
}
