import path from 'node:path'
import type { VaultChangeEvent, VaultInfo } from '@shared/ipc'

export type WindowWorkspaceMode = 'local' | 'remote'

export interface VaultWatcherLike {
  /** `onExhausted` runs if the watcher stops itself because the system ran
   *  out of watch handles. */
  start(root: string, onEvent: (ev: VaultChangeEvent) => void, onExhausted: () => void): void
  stop(): Promise<void>
}

/** How long a vault goes unwatched after the system ran out of watch handles
 *  before the registry tries again, doubling up to the cap on each failure. */
export const WATCH_RETRY_FIRST_DELAY_MS = 30_000
export const WATCH_RETRY_MAX_DELAY_MS = 10 * 60_000

/** Whatever changed while a vault went unwatched was never reported. */
const RESYNC_EVENT: VaultChangeEvent = { kind: 'change', path: '', folder: 'inbox', scope: 'resync' }

interface WindowVaultSession {
  mode: WindowWorkspaceMode
  vault: VaultInfo | null
}

interface LocalVaultWatch {
  root: string
  /** Null while the vault waits for another try after its watcher ran out of
   *  watch handles. The windows stay attached: the vault is still open. */
  watcher: VaultWatcherLike | null
  windowIds: Set<number>
  retryTimer: ReturnType<typeof setTimeout> | null
  retryDelayMs: number
}

export interface WindowVaultRegistryOptions {
  makeWatcher: () => VaultWatcherLike
  invalidateVault: (root: string, ev: VaultChangeEvent) => void
  sendVaultChange: (windowId: number, ev: VaultChangeEvent) => void
}

export class WindowVaultRegistry {
  private readonly sessions = new Map<number, WindowVaultSession>()
  private readonly localVaultWatches = new Map<string, LocalVaultWatch>()

  constructor(private readonly options: WindowVaultRegistryOptions) {}

  setLocalVault(windowId: number, vault: VaultInfo): void {
    const root = normalizeRoot(vault.root)
    const previous = this.sessions.get(windowId)
    if (previous?.mode === 'local' && previous.vault) {
      const previousRoot = normalizeRoot(previous.vault.root)
      if (previousRoot !== root) this.detachLocalWindow(windowId, previousRoot)
    }

    this.sessions.set(windowId, {
      mode: 'local',
      vault: { ...vault, root }
    })

    let registration = this.localVaultWatches.get(root)
    if (!registration) {
      registration = {
        root,
        watcher: null,
        windowIds: new Set<number>(),
        retryTimer: null,
        retryDelayMs: WATCH_RETRY_FIRST_DELAY_MS
      }
      this.localVaultWatches.set(root, registration)
      this.watchLocalVault(registration)
    }
    registration.windowIds.add(windowId)
  }

  setRemoteVault(windowId: number, vault: VaultInfo | null): void {
    const previous = this.sessions.get(windowId)
    if (previous?.mode === 'local' && previous.vault) {
      this.detachLocalWindow(windowId, normalizeRoot(previous.vault.root))
    }
    this.sessions.set(windowId, {
      mode: 'remote',
      vault
    })
  }

  clearWindow(windowId: number): void {
    const previous = this.sessions.get(windowId)
    if (previous?.mode === 'local' && previous.vault) {
      this.detachLocalWindow(windowId, normalizeRoot(previous.vault.root))
    }
    this.sessions.delete(windowId)
  }

  vaultForWindow(windowId: number): VaultInfo | null {
    return this.sessions.get(windowId)?.vault ?? null
  }

  /** Give every window on a local root the vault's new name (#692). The
   *  watchers stay as they are: the folder did not move. Returns the windows
   *  that changed, so the caller can tell each renderer. */
  renameLocalVault(root: string, name: string): number[] {
    const target = normalizeRoot(root)
    const changed: number[] = []
    for (const [windowId, session] of this.sessions) {
      if (session.mode !== 'local' || !session.vault) continue
      if (normalizeRoot(session.vault.root) !== target || session.vault.name === name) continue
      session.vault = { ...session.vault, name }
      changed.push(windowId)
    }
    return changed
  }

  localVaultsExcept(root: string): VaultInfo[] {
    const excluded = normalizeRoot(root)
    const out = new Map<string, VaultInfo>()
    for (const session of this.sessions.values()) {
      if (session.mode !== 'local' || !session.vault) continue
      const candidateRoot = normalizeRoot(session.vault.root)
      if (candidateRoot === excluded) continue
      out.set(candidateRoot, { ...session.vault, root: candidateRoot })
    }
    return [...out.values()]
  }

  modeForWindow(windowId: number): WindowWorkspaceMode | null {
    return this.sessions.get(windowId)?.mode ?? null
  }

  isRemoteWindow(windowId: number): boolean {
    return this.sessions.get(windowId)?.mode === 'remote'
  }

  hasRemoteWindows(): boolean {
    for (const session of this.sessions.values()) {
      if (session.mode === 'remote') return true
    }
    return false
  }

  isPathInsideOpenLocalVault(absPath: string): boolean {
    const resolved = path.resolve(absPath)
    for (const root of this.localVaultWatches.keys()) {
      if (isPathInsideRoot(resolved, root)) return true
    }
    return false
  }

  isPathInsideWindowVault(windowId: number, absPath: string): boolean {
    const session = this.sessions.get(windowId)
    if (session?.mode !== 'local' || !session.vault) return false
    return isPathInsideRoot(path.resolve(absPath), normalizeRoot(session.vault.root))
  }

  sendRemoteVaultChange(ev: VaultChangeEvent): void {
    for (const [windowId, session] of this.sessions) {
      if (session.mode === 'remote') this.options.sendVaultChange(windowId, ev)
    }
  }

  /** Settles once every watcher has closed. */
  async stopAll(): Promise<void> {
    const stopping: Promise<void>[] = []
    for (const registration of this.localVaultWatches.values()) {
      stopping.push(this.unwatchLocalVault(registration))
    }
    this.localVaultWatches.clear()
    this.sessions.clear()
    await Promise.all(stopping)
  }

  private watchLocalVault(registration: LocalVaultWatch): void {
    const { root } = registration
    const watcher = this.options.makeWatcher()
    registration.watcher = watcher
    watcher.start(
      root,
      (ev) => this.emitLocalVaultChange(root, ev),
      () => this.retryLocalVaultWatch(registration, watcher)
    )
  }

  /**
   * The watcher ran out of watch handles and stopped itself. Starting a new
   * one at once would hit the same wall, but the wall can move: another app
   * lets go of its handles, or the user raises the limit. So the vault waits
   * and tries again, longer each time it fails, and its windows re-read it
   * once a watcher is back, because nothing was reporting in between.
   */
  private retryLocalVaultWatch(registration: LocalVaultWatch, watcher: VaultWatcherLike): void {
    if (this.localVaultWatches.get(registration.root) !== registration) return
    if (registration.watcher !== watcher) return
    registration.watcher = null
    const delay = registration.retryDelayMs
    registration.retryDelayMs = Math.min(delay * 2, WATCH_RETRY_MAX_DELAY_MS)
    console.warn(
      `Vault watcher for ${registration.root} stopped; trying again in ${Math.round(delay / 1000)} s`
    )
    registration.retryTimer = setTimeout(() => {
      registration.retryTimer = null
      if (this.localVaultWatches.get(registration.root) !== registration) return
      this.watchLocalVault(registration)
      this.emitLocalVaultChange(registration.root, RESYNC_EVENT)
    }, delay)
  }

  private unwatchLocalVault(registration: LocalVaultWatch): Promise<void> {
    if (registration.retryTimer) clearTimeout(registration.retryTimer)
    registration.retryTimer = null
    const watcher = registration.watcher
    registration.watcher = null
    return watcher ? watcher.stop() : Promise.resolve()
  }

  private emitLocalVaultChange(root: string, ev: VaultChangeEvent): void {
    this.options.invalidateVault(root, ev)
    this.sendLocalVaultChange(root, ev)
  }

  private sendLocalVaultChange(root: string, ev: VaultChangeEvent): void {
    const registration = this.localVaultWatches.get(root)
    if (!registration) return
    for (const windowId of registration.windowIds) {
      this.options.sendVaultChange(windowId, ev)
    }
  }

  private detachLocalWindow(windowId: number, root: string): void {
    const registration = this.localVaultWatches.get(root)
    if (!registration) return
    registration.windowIds.delete(windowId)
    if (registration.windowIds.size > 0) return
    this.localVaultWatches.delete(root)
    void this.unwatchLocalVault(registration)
  }
}

function normalizeRoot(root: string): string {
  return path.resolve(root)
}

function isPathInsideRoot(absPath: string, root: string): boolean {
  return absPath === root || absPath.startsWith(root + path.sep)
}
