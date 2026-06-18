import path from 'node:path'
import type { VaultChangeEvent, VaultInfo } from '@shared/ipc'

export type WindowWorkspaceMode = 'local' | 'remote'

export interface VaultWatcherLike {
  start(root: string, onEvent: (ev: VaultChangeEvent) => void): void
  stop(): void
}

interface WindowVaultSession {
  mode: WindowWorkspaceMode
  vault: VaultInfo | null
}

interface LocalVaultWatch {
  root: string
  watcher: VaultWatcherLike
  windowIds: Set<number>
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
      const watcher = this.options.makeWatcher()
      registration = {
        root,
        watcher,
        windowIds: new Set<number>()
      }
      watcher.start(root, (ev) => {
        this.options.invalidateVault(root, ev)
        this.sendLocalVaultChange(root, ev)
      })
      this.localVaultWatches.set(root, registration)
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

  stopAll(): void {
    for (const registration of this.localVaultWatches.values()) {
      registration.watcher.stop()
    }
    this.localVaultWatches.clear()
    this.sessions.clear()
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
    registration.watcher.stop()
    this.localVaultWatches.delete(root)
  }
}

function normalizeRoot(root: string): string {
  return path.resolve(root)
}

function isPathInsideRoot(absPath: string, root: string): boolean {
  return absPath === root || absPath.startsWith(root + path.sep)
}
