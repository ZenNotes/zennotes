import { workspaceGeneration } from './lib/workspace-transition'
import type { LocalVaultRelocation } from './lib/workspace-relocation'
export type { LocalVaultRelocation } from './lib/workspace-relocation'
import { useSyncExternalStore } from 'react'
import type { RemoteWorkspaceProfile, RemoteWorkspaceProfileInput, WorkspaceMode } from '@bridge-contract/ipc'
import { useStore } from './store'
import { findLeaf } from './lib/pane-layout'

export interface WorkspaceSnapshot {
  readonly mode: WorkspaceMode
  readonly restored: boolean
  readonly transitioning: boolean
  /** Changes at transition start, including transitions that cancel or fail. */
  readonly generation: number
  readonly remoteProfileId: string | null
  readonly remoteProfiles: readonly Readonly<RemoteWorkspaceProfile>[]
  readonly folder: { readonly kind: 'folder'; readonly folder: 'inbox' | 'quick' | 'archive' | 'trash'; readonly subpath: string } | null
}
let profilesSource: readonly RemoteWorkspaceProfile[] | undefined
let profiles: WorkspaceSnapshot['remoteProfiles'] = Object.freeze([])
let viewSource: unknown
let folder: WorkspaceSnapshot['folder'] = null
let snapshot: WorkspaceSnapshot | undefined
export function getWorkspaceSnapshot(): WorkspaceSnapshot {
  const state = useStore.getState()
  if (profilesSource !== state.remoteWorkspaceProfiles) {
    profilesSource = state.remoteWorkspaceProfiles
    profiles = Object.freeze(profilesSource.map(profile => Object.freeze({
      id: profile.id, name: profile.name, baseUrl: profile.baseUrl, hasCredential: profile.hasCredential,
      vaultPath: profile.vaultPath, lastConnectedAt: profile.lastConnectedAt
    })))
  }
  if (viewSource !== state.view) {
    viewSource = state.view
    folder = state.view.kind === 'folder' ? Object.freeze({ ...state.view }) : null
  }
  const next = { mode: state.workspaceMode, restored: !!state.vault && state.workspaceRestored && !state.workspaceTransitioning,
    transitioning: state.workspaceTransitioning, generation: workspaceGeneration(),
    remoteProfileId: state.remoteWorkspaceInfo?.profileId ?? null, remoteProfiles: profiles, folder }
  if (!snapshot || (Object.keys(next) as Array<keyof WorkspaceSnapshot>).some(key => snapshot![key] !== next[key]))
    snapshot = Object.freeze(next)
  return snapshot
}
export function subscribeWorkspace(listener: (next: WorkspaceSnapshot, previous: WorkspaceSnapshot) => void): () => void {
  let previous = getWorkspaceSnapshot()
  return useStore.subscribe(() => {
    const next = getWorkspaceSnapshot()
    if (next === previous) return
    const before = previous; previous = next; listener(next, before)
  })
}
function subscribeReact(notify: () => void): () => void { return subscribeWorkspace(() => notify()) }
export function useWorkspaceSnapshot(): WorkspaceSnapshot { return useSyncExternalStore(subscribeReact, getWorkspaceSnapshot, getWorkspaceSnapshot) }

/** Native storage identifiers are opaque to core. The host bridge resolves them. */
export function openLocalVault(token: string): Promise<void> { return useStore.getState().openLocalVault(token) }
/** Reserves the whole save, native relocation, reopen and rollback lifecycle. */
export function relocateLocalVault(operation: LocalVaultRelocation): Promise<void> {
  return useStore.getState().relocateLocalVault(operation)
}
export function pickLocalVault(): Promise<void> { return useStore.getState().openVaultPicker() }
export function closeVault(): Promise<void> { return useStore.getState().closeVault() }
export function connectRemoteWorkspace(): Promise<void> { return useStore.getState().connectRemoteWorkspace() }
export function connectRemoteProfile(id: string): Promise<void> { return useStore.getState().connectRemoteWorkspaceProfile(id) }
export function changeRemoteVaultPath(): Promise<void> { return useStore.getState().changeRemoteWorkspaceVaultPath() }
export function disconnectRemoteWorkspace(): Promise<void> { return useStore.getState().disconnectRemoteWorkspace() }
export function deleteRemoteProfile(id: string): Promise<void> { return useStore.getState().deleteRemoteWorkspaceProfile(id) }
export async function refreshRemoteProfiles(): Promise<void> { await useStore.getState().refreshRemoteWorkspaceProfiles() }
export async function saveRemoteProfile(input: RemoteWorkspaceProfileInput): Promise<Readonly<RemoteWorkspaceProfile>> {
  const profile = await useStore.getState().saveRemoteWorkspaceProfile({ ...input })
  return Object.freeze({ id: profile.id, name: profile.name, baseUrl: profile.baseUrl, hasCredential: profile.hasCredential,
    vaultPath: profile.vaultPath, lastConnectedAt: profile.lastConnectedAt })
}
export function flushWorkspace(): Promise<void> { return useStore.getState().flushDirtyNotes() }
export function persistWorkspace(): void { useStore.getState().persistWorkspace() }
export function configureWorkspacePresentation(options: {
  sidebarVisible?: boolean; noteListVisible?: boolean; automaticCalendar?: boolean
}): void {
  useStore.setState({
    ...(options.sidebarVisible === undefined ? {} : { sidebarOpen: options.sidebarVisible }),
    ...(options.noteListVisible === undefined ? {} : { noteListOpen: options.noteListVisible }),
    ...(options.automaticCalendar === undefined ? {} : { autoCalendarPanel: options.automaticCalendar })
  })
}
/** Read before restoration rewrites the legacy persisted layout. */
export async function readPersistedHomeState(): Promise<boolean> {
  try {
    const raw = await window.zen.readWorkspaceState()
    if (!raw) return true
    const saved = JSON.parse(raw)
    const leaf = findLeaf(saved.paneLayout, saved.activePaneId)
    return !leaf || leaf.activeTab === null
  } catch { return true }
}
