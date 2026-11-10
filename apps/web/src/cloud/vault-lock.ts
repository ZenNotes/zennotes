/**
 * One tab owns a vault (docs/ideas/cloud-in-browser.md, "Sync, tabs and
 * lifecycle"). Opening a vault asks for the Web Lock `zennotes:vault:<key>`;
 * the owner edits (and, from Phase 4, syncs). Another tab shows "ZenNotes is
 * open in another tab" with Use here, which asks the owner over a
 * BroadcastChannel to save and let go, and steals the lock only after a
 * timeout.
 *
 * Fencing: stealing a lock does not stop writes the old tab already has in
 * flight. Every acquisition bumps the vault's generation in IndexedDB
 * (idb.ts), the OPFS worker checks it before each change, and a worker whose
 * generation is older refuses to write, so a tab that lost the vault cannot
 * overwrite what the new owner saved.
 */
import { bumpFenceGeneration } from './idb'

const LOCK_PREFIX = 'zennotes:vault:'

type ChannelMessage =
  | { type: 'use-here'; from: string }
  | { type: 'released'; from: string }

export interface HeldVault {
  readonly vaultKey: string
  readonly generation: number
  /** Resolves when the lock is gone without this tab letting go (stolen). */
  readonly lost: Promise<void>
  /** Another tab pressed Use here. */
  onUseHereRequest(listener: () => void): void
  /** Lets go of the lock and tells the waiting tab. */
  release(): void
}

const tabId = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2)

export function vaultLocksSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.locks && typeof BroadcastChannel !== 'undefined'
}

function channelFor(vaultKey: string): BroadcastChannel {
  return new BroadcastChannel(`${LOCK_PREFIX}${vaultKey}`)
}

interface Granted {
  release(): void
  lost: Promise<void>
}

/** Resolves once granted (or null with ifAvailable and the lock taken). */
function requestLock(name: string, options: LockOptions): Promise<Granted | null> {
  return new Promise<Granted | null>((resolve, reject) => {
    let granted = false
    let releasing = false
    let letGo!: () => void
    const held = new Promise<void>((done) => (letGo = done))
    let markLost!: () => void
    const lost = new Promise<void>((done) => (markLost = done))
    navigator.locks
      .request(name, options, async (lock) => {
        if (!lock) {
          resolve(null)
          return
        }
        granted = true
        resolve({
          release: () => {
            releasing = true
            letGo()
          },
          lost
        })
        await held
      })
      .then(
        () => {
          if (granted && !releasing) markLost()
        },
        (error) => {
          // AbortError: stolen while held, or the wait was abandoned.
          if (granted) {
            if (!releasing) markLost()
          } else reject(error)
        }
      )
  })
}

async function hold(vaultKey: string, granted: Granted): Promise<HeldVault> {
  const generation = await bumpFenceGeneration(vaultKey)
  const channel = channelFor(vaultKey)
  const listeners: Array<() => void> = []
  channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
    if (event.data?.type === 'use-here' && event.data.from !== tabId) {
      for (const listener of listeners) listener()
    }
  }
  void granted.lost.then(() => channel.close())
  return {
    vaultKey,
    generation,
    lost: granted.lost,
    onUseHereRequest(listener) {
      listeners.push(listener)
    },
    release() {
      granted.release()
      try {
        channel.postMessage({ type: 'released', from: tabId } satisfies ChannelMessage)
      } catch {
        // closed
      }
      channel.close()
    }
  }
}

/** The vault for this tab when no other tab holds it, else null. */
export async function tryAcquireVault(vaultKey: string): Promise<HeldVault | null> {
  const granted = await requestLock(`${LOCK_PREFIX}${vaultKey}`, { ifAvailable: true })
  return granted ? hold(vaultKey, granted) : null
}

/**
 * Use here: asks the owner to save and let go, waits up to `timeoutMs` for
 * the lock, then steals it (an owner that is frozen in the background or
 * busy past the timeout never answers).
 */
export async function takeVaultHere(vaultKey: string, timeoutMs = 4000): Promise<HeldVault> {
  const name = `${LOCK_PREFIX}${vaultKey}`
  const channel = channelFor(vaultKey)
  channel.postMessage({ type: 'use-here', from: tabId } satisfies ChannelMessage)
  channel.close()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const granted = await requestLock(name, { signal: abort.signal })
    if (granted) return hold(vaultKey, granted)
  } catch (error) {
    if ((error as { name?: string }).name !== 'AbortError') throw error
  } finally {
    clearTimeout(timer)
  }
  const stolen = await requestLock(name, { steal: true })
  if (!stolen) throw new Error('This tab could not take the vault.')
  return hold(vaultKey, stolen)
}
