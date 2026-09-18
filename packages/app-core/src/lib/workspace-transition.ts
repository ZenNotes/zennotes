import { useToastStore } from './toast'
import { useStore } from '../store'
import { lockVaultEditing } from './note-lifecycle-lock'

let pending = false
let generation = 0
let writesBlocked = false

export function isWorkspaceTransitionPending(): boolean { return pending }
export function workspaceGeneration(): number { return generation }
export function workspaceWritesBlocked(): boolean { return writesBlocked }

/** Reserve before the first await, including connection prompts and save drains. */
export async function runWorkspaceTransition(work: () => Promise<void>, silentIfBusy = false, propagateError = false): Promise<void> {
  if (pending) {
    if (propagateError) throw new Error('Wait for the current vault change to finish.')
    if (!silentIfBusy) useToastStore.getState().addToast('Wait for the current vault change to finish.', 'info')
    return
  }
  pending = true
  generation += 1
  // These belong to navigation invalidated by this generation, even if a picker cancels.
  useStore.setState({ workspaceTransitioning: true, loadingNote: false, pendingJumpLocation: null, databasesLoading: {} })
  let unlock: (() => void) | undefined
  try {
    // Let operations already dispatched finish in their original vault. Then
    // lock input and drain once more before any host changes its active root.
    await useStore.getState().flushDirtyNotes()
    const vault = useStore.getState().vault
    if (vault) unlock = lockVaultEditing(vault)
    writesBlocked = true
    await useStore.getState().flushDirtyNotes()
    await work()
  } catch (error) {
    if (propagateError) throw error
    useToastStore.getState().addToast(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    writesBlocked = false
    unlock?.()
    pending = false
    useStore.setState({ workspaceTransitioning: false })
  }
}
