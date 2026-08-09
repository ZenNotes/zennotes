import { isArchiveTabPath } from '@shared/archive'
import { isHelpTabPath } from '@shared/help'
import { isQuickNotesTabPath } from '@shared/quick-notes'
import { isTagsTabPath } from '@shared/tags'
import { isTasksTabPath } from '@shared/tasks'
import { isTrashTabPath } from '@shared/trash'
import { isWorkflowsTabPath } from '@shared/workflows-view'
import { isDatabaseTabPath } from '@shared/databases'
import { isAssetsViewTabPath } from '@shared/assets-view'
import { isAssetTabPath } from './asset-tabs'
import { isDiagramTabPath } from './diagram-tabs'
import { allLeaves, type PaneLayout } from './pane-layout'

export function isWorkspaceVirtualTabPath(path: string): boolean {
  return (
    isQuickNotesTabPath(path) ||
    isTasksTabPath(path) ||
    isWorkflowsTabPath(path) ||
    isTagsTabPath(path) ||
    isHelpTabPath(path) ||
    isArchiveTabPath(path) ||
    isTrashTabPath(path) ||
    isAssetsViewTabPath(path) ||
    isAssetTabPath(path) ||
    isDiagramTabPath(path) ||
    isDatabaseTabPath(path)
  )
}

export function initialWorkspaceRestoreContentPaths(
  layout: PaneLayout,
  existingPaths: Set<string> | null
): string[] {
  const seen = new Set<string>()
  const paths: string[] = []

  for (const leaf of allLeaves(layout)) {
    const path = leaf.activeTab
    if (!path || isWorkspaceVirtualTabPath(path) || seen.has(path)) {
      continue
    }
    if (existingPaths !== null && !existingPaths.has(path)) {
      continue
    }
    seen.add(path)
    paths.push(path)
  }

  return paths
}

export function workspaceRestorePrefetchContentPaths(
  layout: PaneLayout,
  existingPaths: Set<string> | null,
  initiallyLoadedPaths: Set<string>
): string[] {
  const seen = new Set(initiallyLoadedPaths)
  const paths: string[] = []

  for (const leaf of allLeaves(layout)) {
    for (const path of leaf.tabs) {
      if (isWorkspaceVirtualTabPath(path) || seen.has(path)) {
        continue
      }
      if (existingPaths !== null && !existingPaths.has(path)) {
        continue
      }
      seen.add(path)
      paths.push(path)
    }
  }

  return paths
}
