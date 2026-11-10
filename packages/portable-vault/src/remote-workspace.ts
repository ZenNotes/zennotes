/**
 * Remote-workspace state for the mobile bridge: saved server profiles, the
 * active connection, and boot-time restore, the mobile analog of the desktop
 * main process's remoteWorkspace* globals + config + keychain.
 *
 * Profiles (including auth tokens) persist in the host's preferences: on the
 * phones Capacitor Preferences, i.e. the app-sandboxed UserDefaults. The
 * desktop uses the OS keychain for tokens; moving tokens into the iOS Keychain
 * is a hardening follow-up: Preferences keeps v1 dependency-free and the
 * store is app-private.
 */
import { portableHost } from './host'
import type {
  RemoteWorkspaceInfo,
  RemoteWorkspaceProfile,
  RemoteWorkspaceProfileInput,
  ServerCapabilities,
  VaultInfo
} from '@zennotes/shared-domain/ipc'
import { RemoteClient, normalizeBaseUrl } from './remote-client'
import { randomUUID } from './uuid'
import { RemoteVault } from './remote-vault'

const PROFILES_KEY = 'zn-remote-profiles'
const MODE_KEY = 'zn-workspace-mode'

interface StoredRemoteProfile {
  id: string
  name: string
  baseUrl: string
  authToken: string | null
  vaultPath: string | null
  lastConnectedAt: number | null
}

interface StoredMode {
  mode: 'local' | 'remote'
  profileId: string | null
}

export function remoteStateKey(baseUrl: string, serverVault: VaultInfo | null): string {
  return `${baseUrl}::${serverVault?.root ?? ''}`
}

export interface ActiveRemote {
  vault: RemoteVault
  client: RemoteClient
  capabilities: ServerCapabilities
  serverVault: VaultInfo | null
  profileId: string | null
}

let active: ActiveRemote | null = null

export function activeRemote(): ActiveRemote | null {
  return active
}

// --- Live updates -----------------------------------------------------------
// The server streams vault changes over a WebSocket (/api/watch) that the
// desktop and web clients subscribe to, but a WebView WebSocket can neither
// send the Bearer header nor pass the server's Origin check (an Android
// report: web and Mac edits never reached the phone). So the shell polls:
// while a remote workspace is connected and the app is visible, the vault's
// poll() diffs a listNotes snapshot and emits the same change events the
// watcher would. A native WebSocket plugin (OkHttp / URLSessionWebSocketTask
// can set both headers) is the instant-update upgrade path. Android's, now
// both phones'.
export const REMOTE_POLL_MS = 4000
// Ticks skipped after a failed poll, so an unreachable server costs one
// request every ~20s instead of hammering timeouts every tick.
const POLL_FAILURE_BACKOFF_TICKS = 5
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollInFlight = false
let pollSkipTicks = 0
let pollGeneration = 0
let visibilityHandler: (() => void) | null = null

function pollRemote(generation: number): void {
  if (generation !== pollGeneration || !active || pollInFlight) return
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  if (pollSkipTicks > 0) {
    pollSkipTicks--
    return
  }

  const remote = active
  pollInFlight = true
  remote.vault
    .poll()
    .then(() => {
      if (generation === pollGeneration) pollSkipTicks = 0
    })
    .catch(() => {
      if (generation === pollGeneration) pollSkipTicks = POLL_FAILURE_BACKOFF_TICKS
    })
    .finally(() => {
      if (generation === pollGeneration) pollInFlight = false
    })
}

function startRemotePolling(): void {
  stopRemotePolling()
  const generation = pollGeneration
  pollTimer = setInterval(() => pollRemote(generation), REMOTE_POLL_MS)
  pollRemote(generation)

  if (typeof document !== 'undefined') {
    visibilityHandler = () => pollRemote(generation)
    document.addEventListener('visibilitychange', visibilityHandler)
  }
}

function stopRemotePolling(): void {
  pollGeneration++
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler)
    visibilityHandler = null
  }
  pollInFlight = false
  pollSkipTicks = 0
}

export function remoteWorkspaceInfo(): RemoteWorkspaceInfo | null {
  if (!active) return null
  return {
    mode: 'remote',
    baseUrl: active.client.baseUrl,
    authConfigured: Boolean(active.client.authToken),
    capabilities: active.capabilities,
    profileId: active.profileId,
    // Mobile never boots into a broken remote workspace: an unreachable
    // server at boot falls back to the local vault (restoreRemoteAtBoot), so
    // by the time this info exists the connection succeeded.
    bootError: null
  }
}

async function readProfiles(): Promise<StoredRemoteProfile[]> {
  const value = await portableHost().preferences.read(PROFILES_KEY)
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as StoredRemoteProfile[]) : []
  } catch {
    return []
  }
}

async function writeProfiles(profiles: StoredRemoteProfile[]): Promise<void> {
  await portableHost().preferences.write(PROFILES_KEY, JSON.stringify(profiles))
}

async function writeMode(mode: StoredMode): Promise<void> {
  await portableHost().preferences.write(MODE_KEY, JSON.stringify(mode))
}

export async function readStoredMode(): Promise<StoredMode> {
  const value = await portableHost().preferences.read(MODE_KEY)
  if (!value) return { mode: 'local', profileId: null }
  try {
    return JSON.parse(value) as StoredMode
  } catch {
    return { mode: 'local', profileId: null }
  }
}

function toPublicProfile(p: StoredRemoteProfile): RemoteWorkspaceProfile {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    hasCredential: Boolean(p.authToken),
    vaultPath: p.vaultPath,
    lastConnectedAt: p.lastConnectedAt
  }
}

export async function listProfiles(): Promise<RemoteWorkspaceProfile[]> {
  return (await readProfiles()).map(toPublicProfile)
}

export async function saveProfile(
  input: RemoteWorkspaceProfileInput
): Promise<RemoteWorkspaceProfile> {
  const profiles = await readProfiles()
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const existing = input.id ? profiles.find((p) => p.id === input.id) : undefined
  const next: StoredRemoteProfile = {
    id: existing?.id ?? randomUUID(),
    name: input.name?.trim() || existing?.name || new URL(baseUrl).host,
    baseUrl,
    authToken: input.clearAuthToken
      ? null
      : (input.authToken?.trim() || existing?.authToken || null),
    vaultPath: input.vaultPath !== undefined ? input.vaultPath : (existing?.vaultPath ?? null),
    lastConnectedAt: existing?.lastConnectedAt ?? null
  }
  const merged = existing
    ? profiles.map((p) => (p.id === next.id ? next : p))
    : [...profiles, next]
  await writeProfiles(merged)
  // Adopt the saved profile as the current one when it matches the live
  // connection (the store saves right after a successful quick-connect).
  if (active && active.client.baseUrl === next.baseUrl && !active.profileId) {
    active.profileId = next.id
    await writeMode({ mode: 'remote', profileId: next.id })
  }
  return toPublicProfile(next)
}

export async function deleteProfile(id: string): Promise<void> {
  await writeProfiles((await readProfiles()).filter((p) => p.id !== id))
  if (active?.profileId === id) active.profileId = null
}

/** Handshake + open: mirrors the desktop's setRemoteWorkspace. */
export async function connectRemote(
  baseUrl: string,
  authToken?: string | null,
  options: { profileId?: string | null; vaultPath?: string | null } = {}
): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }> {
  const client = new RemoteClient({ baseUrl, authToken })
  const capabilities = await client.getCapabilities()
  let serverVault = await client.getCurrentVault()
  const preferred = options.vaultPath?.trim() || null
  if (capabilities.supportsVaultSelection && preferred && serverVault?.root !== preferred) {
    serverVault = await client.selectVaultPath(preferred)
  }

  const profileId = options.profileId ?? null
  active = {
    client,
    capabilities,
    serverVault,
    profileId,
    // Key device-local workspace state by URL AND server vault root, two
    // different servers (or vaults) on the same URL must not share a session
    // (a docker server on :7878 inherited the previous :7878 session's panes).
    vault: new RemoteVault(client, serverVault, remoteStateKey(client.baseUrl, serverVault), capabilities)
  }
  await writeMode({ mode: 'remote', profileId })
  startRemotePolling()
  if (profileId) {
    const profiles = await readProfiles()
    await writeProfiles(
      profiles.map((p) => (p.id === profileId ? { ...p, lastConnectedAt: Date.now() } : p))
    )
  }
  return { vault: remoteVaultInfo(), capabilities }
}

export async function connectRemoteProfile(
  id: string
): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }> {
  const profile = (await readProfiles()).find((p) => p.id === id)
  if (!profile) throw new Error('Saved remote workspace not found.')
  return connectRemote(profile.baseUrl, profile.authToken, {
    profileId: profile.id,
    vaultPath: profile.vaultPath
  })
}

export async function disconnectRemote(): Promise<void> {
  stopRemotePolling()
  active = null
  await writeMode({ mode: 'local', profileId: null })
}

/** The server's own VaultInfo, verbatim: `root` must stay the real
 *  server-side path: the store persists it as the profile's vaultPath and
 *  reconnects pass it back to selectVaultPath (a prettified label here sent
 *  the boot reconnect a bogus path). Display formatting is the UI's job. */
export function remoteVaultInfo(): VaultInfo | null {
  if (!active) return null
  return active.serverVault
}

/** Boot-time restore: reconnect the remembered profile; returns false (and
 *  resets to local mode) when the server is unreachable so bootVault falls
 *  back to the on-device vault instead of blocking launch. */
export async function restoreRemoteAtBoot(): Promise<boolean> {
  const stored = await readStoredMode()
  if (stored.mode !== 'remote' || !stored.profileId) return false
  try {
    await connectRemoteProfile(stored.profileId)
    return true
  } catch (err) {
    console.warn('remote workspace unreachable at boot, falling back to local vault', err)
    await writeMode({ mode: 'local', profileId: null })
    return false
  }
}
