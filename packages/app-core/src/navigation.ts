import { captureNavigationContext } from './lib/navigation-context'
import { useStore } from './store'
import { findLeaf, updateLeaf } from './lib/pane-layout'
import { paneModesWithPathMode, type PaneMode } from './lib/pane-mode'

/** Open a note or app-generated page path through the normal save and history flow. */
export function openNote(path: string, options?: { mode?: PaneMode }): Promise<void> {
  if (!captureNavigationContext()()) return Promise.resolve()
  if (options?.mode) {
    const mode = options.mode
    useStore.setState(state => ({
      paneModes: { ...state.paneModes, [state.activePaneId]: paneModesWithPathMode(state.paneModes[state.activePaneId] ?? {}, path, mode) },
      ...(state.keepViewModeAcrossNotes ? { paneStickyModes: { ...state.paneStickyModes, [state.activePaneId]: mode } } : {})
    }))
  }
  return useStore.getState().selectNote(path)
}

export function goBack(): Promise<void> {
  return useStore.getState().jumpToPreviousNote()
}

export function goForward(): Promise<void> {
  return useStore.getState().jumpToNextNote()
}

/** Observe the current selection without exposing mutable application state. */
export function useSelectedNotePath(): string | null {
  return useStore((state) => state.selectedPath)
}

/** Show Home, retaining open tabs and starting the normal save for pending edits. */
export function goHome(): void {
  if (!captureNavigationContext()()) return
  const state = useStore.getState()
  if (state.selectedPath && state.noteDirty[state.selectedPath]) {
    void state.persistNote(state.selectedPath)
  }
  const leaf = findLeaf(state.paneLayout, state.activePaneId)
  if (!leaf || leaf.activeTab === null) return
  const next = updateLeaf(state.paneLayout, leaf.id, (pane) => ({
    ...pane,
    activeTab: null
  }))
  if (!next) return
  useStore.setState({
    paneLayout: next,
    selectedPath: null,
    activeNote: null,
    activeDirty: false
  })
}

/**
 * Install once for the lifetime of a shell that offers Home alongside open tabs.
 * Register before mounting React or adding other store subscribers. Call the
 * returned disposer when the host shell is torn down.
 *
 * A rescan or vault mutation can promote the first tab while rewriting paths.
 * Restore Home only for that transition. Deliberate note navigation does not
 * replace the note index and must remain visible.
 */
export function installHomeGuard(): () => void {
  return useStore.subscribe((state, previous) => {
    if (
      state.notes === previous.notes ||
      state.paneLayout === previous.paneLayout
    )
      return
    const leaf = findLeaf(state.paneLayout, state.activePaneId)
    const before = findLeaf(previous.paneLayout, state.activePaneId)
    if (
      !leaf ||
      !before ||
      before.activeTab !== null ||
      before.tabs.length === 0
    )
      return
    if (leaf.activeTab === null || leaf.activeTab !== leaf.tabs[0]) return
    const next = updateLeaf(state.paneLayout, leaf.id, (pane) => ({
      ...pane,
      activeTab: null
    }))
    if (!next) return
    useStore.setState({
      paneLayout: next,
      selectedPath: null,
      activeNote: null,
      activeDirty: false
    })
  })
}

/** Follow note, heading, block, or database links without taking editor focus. */
export async function openWikilink(target: string): Promise<boolean> {
  const isCurrent = captureNavigationContext()
  if (!isCurrent()) return false
  const { resolveWikilinkPath } = await import('./lib/wikilinks')
  const { openWikilinkTarget } = await import('./lib/wikilink-navigation')
  const { listDatabaseLinkTargets, resolveDatabaseWikilink } = await import('./lib/database-links')
  if (!isCurrent()) return false
  const state = useStore.getState()
  const path = resolveWikilinkPath(state.notes, target, state.selectedPath)
  if (path) return openWikilinkTarget(path, target)
  const database = resolveDatabaseWikilink(listDatabaseLinkTargets(state.folders, state.vaultSettings), target)
  if (!database) return false
  await state.openDatabase(database.csvPath)
  return isCurrent() && !!useStore.getState().databases[database.csvPath]

}

export function openTodayDailyNote(): Promise<void> {
  return captureNavigationContext()() ? useStore.getState().openTodayDailyNote() : Promise.resolve()
}

export type AppPage = 'tasks' | 'quick-notes' | 'tags' | 'assets' | 'archive' | 'trash'
export function openAppPage(page: AppPage): Promise<void> {
  if (!captureNavigationContext()()) return Promise.resolve()
  const state = useStore.getState()
  switch (page) {
    case 'tasks': return state.openTasksView()
    case 'quick-notes': return state.openQuickNotesView()
    case 'tags': return state.openTagView('')
    case 'assets': return state.openAssetsView()
    case 'archive': return state.openArchiveView()
    case 'trash': return state.openTrashView()
  }
}
