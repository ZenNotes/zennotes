import { useStore } from '../store'
import { isWorkspaceTransitionPending, workspaceGeneration } from './workspace-transition'

/** A relative path is meaningful only in the workspace where navigation began. */
export function captureNavigationContext(): () => boolean {
  const { vault, workspaceMode, remoteWorkspaceInfo } = useStore.getState()
  const bridge = window.zen
  const generation = workspaceGeneration()
  const startedDuringTransition = isWorkspaceTransitionPending()
  return () => {
    const state = useStore.getState()
    return !startedDuringTransition && !isWorkspaceTransitionPending()
      && generation === workspaceGeneration() && state.vault === vault && window.zen === bridge
      && state.workspaceMode === workspaceMode && state.remoteWorkspaceInfo?.baseUrl === remoteWorkspaceInfo?.baseUrl
      && state.remoteWorkspaceInfo?.profileId === remoteWorkspaceInfo?.profileId
  }
}
