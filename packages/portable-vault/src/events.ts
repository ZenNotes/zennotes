/**
 * Vault change events. Mobile has no chokidar/fsnotify; the three sources the
 * mobile spec names are (1) in-app writes (every mutating bridge call emits),
 * (2) app-foreground rescan, and (3) the rescan the cloud-sync host service
 * runs after every sync. The subscription API is identical to desktop/web so
 * app-core consumes it as-is.
 */
import type { VaultChangeEvent } from '@zennotes/bridge-contract/ipc'

type VaultChangeListener = (ev: VaultChangeEvent) => void

const listeners = new Set<VaultChangeListener>()

export function onVaultChange(cb: VaultChangeListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function emitVaultChange(ev: VaultChangeEvent): void {
  for (const cb of listeners) {
    try {
      cb(ev)
    } catch (err) {
      console.error('vault change listener failed', err)
    }
  }
}

type OpenNoteListener = (relPath: string) => void
const openNoteListeners = new Set<OpenNoteListener>()

export function onOpenNoteRequested(cb: OpenNoteListener): () => void {
  openNoteListeners.add(cb)
  return () => {
    openNoteListeners.delete(cb)
  }
}

export function requestOpenNote(relPath: string): void {
  for (const cb of openNoteListeners) {
    try {
      cb(relPath)
    } catch (err) {
      console.error('open note listener failed', err)
    }
  }
}
