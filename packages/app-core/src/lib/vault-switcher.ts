import type {
  LocalVaultEntry,
  RemoteWorkspaceInfo,
  RemoteWorkspaceProfile,
  VaultInfo,
  WorkspaceMode
} from '@shared/ipc'

export interface LocalVaultSwitcherEntry extends LocalVaultEntry {
  kind: 'local'
  current: boolean
  location: string
}

export interface RemoteVaultSwitcherEntry {
  kind: 'remote'
  id: string | null
  name: string
  baseUrl: string
  hasCredential: boolean
  vaultPath: string | null
  lastConnectedAt: number | null
  current: boolean
  location: string
}

export type VaultSwitcherEntry = LocalVaultSwitcherEntry | RemoteVaultSwitcherEntry

/** Synthetic entry appended to the new-window vault picker (CommandPalette) —
 *  picking it opens the OS folder picker instead of a known vault. Kept out of
 *  `VaultSwitcherEntry` so existing consumers' local/remote narrowing is unaffected. */
export interface BrowseVaultSwitcherEntry {
  kind: 'browse'
  name: string
  location: string
  current: false
}

/** Rows for the "open vault in new window" picker (#244): the known local
 *  vaults (most-recent first, as produced by buildVaultSwitcherEntries) plus a
 *  trailing "Browse…" row. Remote workspaces don't apply to new windows. */
export function newWindowVaultRows(
  entries: VaultSwitcherEntry[]
): Array<LocalVaultSwitcherEntry | BrowseVaultSwitcherEntry> {
  const locals = entries.filter(
    (entry): entry is LocalVaultSwitcherEntry => entry.kind === 'local'
  )
  return [
    ...locals,
    {
      kind: 'browse',
      name: 'Browse for a folder…',
      location: 'Open the system folder picker',
      current: false
    }
  ]
}

interface BuildVaultSwitcherEntriesOptions {
  localVaults: LocalVaultEntry[]
  remoteProfiles: RemoteWorkspaceProfile[]
  currentVault: VaultInfo | null
  workspaceMode: WorkspaceMode
  remoteWorkspaceInfo: RemoteWorkspaceInfo | null
}

function remoteName(baseUrl: string | null): string {
  if (!baseUrl) return 'Remote vault'
  try {
    const url = new URL(baseUrl)
    return url.host || 'Remote vault'
  } catch {
    return baseUrl
  }
}

function remoteLocation(baseUrl: string, vaultPath: string | null): string {
  return vaultPath ? `${baseUrl} ${vaultPath}` : baseUrl
}

function sortTime(entry: VaultSwitcherEntry): number {
  if (entry.current) return Number.MAX_SAFE_INTEGER
  return entry.kind === 'local' ? entry.lastOpenedAt : entry.lastConnectedAt ?? 0
}

export function buildVaultSwitcherEntries({
  localVaults,
  remoteProfiles,
  currentVault,
  workspaceMode,
  remoteWorkspaceInfo
}: BuildVaultSwitcherEntriesOptions): VaultSwitcherEntry[] {
  const currentLocalRoot = workspaceMode === 'remote' ? null : currentVault?.root ?? null
  const localEntries = new Map<string, LocalVaultSwitcherEntry>()

  for (const entry of localVaults) {
    localEntries.set(entry.root, {
      ...entry,
      kind: 'local',
      current: entry.root === currentLocalRoot,
      location: entry.root
    })
  }

  if (currentVault && workspaceMode !== 'remote') {
    const existing = localEntries.get(currentVault.root)
    localEntries.set(currentVault.root, {
      root: currentVault.root,
      name: existing?.name || currentVault.name,
      lastOpenedAt: Math.max(existing?.lastOpenedAt ?? 0, Number.MAX_SAFE_INTEGER),
      kind: 'local',
      current: true,
      location: currentVault.root
    })
  }

  const remoteEntries = new Map<string, RemoteVaultSwitcherEntry>()
  const currentRemoteProfileId =
    workspaceMode === 'remote' ? remoteWorkspaceInfo?.profileId ?? null : null

  for (const profile of remoteProfiles) {
    const current = profile.id === currentRemoteProfileId
    remoteEntries.set(profile.id, {
      kind: 'remote',
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      hasCredential: profile.hasCredential,
      vaultPath: profile.vaultPath,
      lastConnectedAt: current
        ? Math.max(profile.lastConnectedAt ?? 0, Number.MAX_SAFE_INTEGER)
        : profile.lastConnectedAt,
      current,
      location: remoteLocation(profile.baseUrl, profile.vaultPath)
    })
  }

  if (workspaceMode === 'remote' && remoteWorkspaceInfo?.baseUrl) {
    const key = currentRemoteProfileId ?? '__current_remote__'
    const existing = currentRemoteProfileId ? remoteEntries.get(currentRemoteProfileId) : null
    const vaultPath = existing?.vaultPath ?? currentVault?.root ?? null
    remoteEntries.set(key, {
      kind: 'remote',
      id: currentRemoteProfileId,
      name: existing?.name || currentVault?.name || remoteName(remoteWorkspaceInfo.baseUrl),
      baseUrl: existing?.baseUrl || remoteWorkspaceInfo.baseUrl,
      hasCredential: existing?.hasCredential ?? remoteWorkspaceInfo.authConfigured,
      vaultPath,
      lastConnectedAt: Math.max(existing?.lastConnectedAt ?? 0, Number.MAX_SAFE_INTEGER),
      current: true,
      location: remoteLocation(existing?.baseUrl || remoteWorkspaceInfo.baseUrl, vaultPath)
    })
  }

  return [...localEntries.values(), ...remoteEntries.values()].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    return sortTime(b) - sortTime(a) || a.name.localeCompare(b.name)
  })
}
