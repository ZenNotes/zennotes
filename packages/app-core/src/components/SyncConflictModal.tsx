import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { useStore } from '../store'

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

/** Recover the original path from a conflict-copy path. */
function originalOf(copyPath: string): string {
  return copyPath.replace(
    / \(conflict [0-9a-f]{8} \d{4}-\d{2}-\d{2} \d{6}\)(?=(\.[^/]+)?$)/,
    ''
  )
}

function isTextPath(p: string): boolean {
  return /\.(md|excalidraw|json|csv|txt|markdown)$/i.test(p)
}

/**
 * Lists kept-both sync conflicts and lets the user resolve each: open either
 * version, adopt the copy's content into the original, or discard the copy.
 */
export function SyncConflictModal({ onClose }: { onClose: () => void }): JSX.Element {
  const conflicts = useStore((s) => s.syncStatus?.conflicts ?? [])
  const resolveSyncConflict = useStore((s) => s.resolveSyncConflict)
  const selectNote = useStore((s) => s.selectNote)

  return (
    <Modal size="lg" onClose={onClose} labelledBy="sync-conflicts-title">
      <div className="p-5">
        <h2 id="sync-conflicts-title" className="text-base font-semibold text-ink-900">
          Sync conflicts
        </h2>
        <p className="mt-1 text-sm text-ink-600">
          These notes were edited in two places before they synced. Nothing was lost — each
          conflicting version is kept. Review and pick which to keep.
        </p>
        {conflicts.length === 0 ? (
          <p className="mt-4 text-sm text-ink-500">No conflicts to resolve.</p>
        ) : (
          <ul className="mt-4 max-h-[55vh] space-y-3 overflow-y-auto pr-1">
            {conflicts.map((copyPath) => {
              const original = originalOf(copyPath)
              const text = isTextPath(copyPath)
              return (
                <li
                  key={copyPath}
                  className="rounded-lg border border-paper-300/70 bg-paper-50 p-3"
                >
                  <div className="truncate text-sm font-medium text-ink-900">
                    {basename(original)}
                  </div>
                  <div className="truncate text-xs text-ink-500">
                    conflict copy: {basename(copyPath)}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void selectNote(original)}
                    >
                      Open original
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void selectNote(copyPath)}
                    >
                      Open copy
                    </Button>
                    {text && (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => void resolveSyncConflict(copyPath, 'keepTheirs')}
                      >
                        Use the copy's version
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void resolveSyncConflict(copyPath, 'keepMine')}
                    >
                      Discard copy
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  )
}
