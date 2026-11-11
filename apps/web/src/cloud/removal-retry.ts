/**
 * Cloud removed this browser and its wipe failed. Since departure.ts, a
 * sign-out heard on the same answer stands aside, so the removal itself must
 * not leave the tab stranded: it reloads, and the next load tries the wipe
 * again before it opens anything.
 *
 * A wipe that fails every time must not reload for ever. The tries are
 * counted in this tab's sessionStorage, read before each wipe (which may clear
 * sessionStorage on its way) and written after it fails. After REMOVAL_TRIES
 * failed tries the tab stops reloading and says the copy is still here; a
 * reload by hand tries once more. Without a count it can keep, it stops at
 * once.
 */
export const REMOVAL_TRIES = 3
export const REMOVAL_PENDING_KEY = 'zn:cloud-removal-pending'

export interface PendingRemoval {
  reason: 'revoked'
  /** The tab was in a shared computer's session: the wipe takes everything. */
  shared: boolean
  tries: number
}

/** `removed`: the copy is gone. `retry`: reload, and the next load tries
 *  again. `stop`: stop reloading, the copy is still here. */
export type RemovalOutcome = 'removed' | 'retry' | 'stop'

export type TabStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function readPendingRemoval(storage: TabStorage | null): PendingRemoval | null {
  try {
    const raw = storage?.getItem(REMOVAL_PENDING_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PendingRemoval> | null
    return value?.reason === 'revoked' && typeof value.shared === 'boolean' && typeof value.tries === 'number' && value.tries > 0
      ? { reason: value.reason, shared: value.shared, tries: value.tries }
      : null
  } catch {
    return null
  }
}

function keep(storage: TabStorage | null, pending: PendingRemoval): boolean {
  if (!storage) return false
  try {
    const raw = JSON.stringify(pending)
    storage.setItem(REMOVAL_PENDING_KEY, raw)
    return storage.getItem(REMOVAL_PENDING_KEY) === raw
  } catch {
    return false
  }
}

/** One try at the wipe, and what the tab does next. */
export async function attemptRemoval(
  storage: TabStorage | null,
  removal: Pick<PendingRemoval, 'reason' | 'shared'>,
  wipe: () => Promise<void>
): Promise<RemovalOutcome> {
  const tries = readPendingRemoval(storage)?.tries ?? 0
  try {
    await wipe()
  } catch (error) {
    console.warn('[zen] removing this browser\'s copy did not finish', error)
    const pending: PendingRemoval = { reason: removal.reason, shared: removal.shared, tries: tries + 1 }
    if (!keep(storage, pending)) return 'stop'
    return pending.tries < REMOVAL_TRIES ? 'retry' : 'stop'
  }
  try {
    storage?.removeItem(REMOVAL_PENDING_KEY)
  } catch {
    // Blocked storage kept nothing to forget.
  }
  return 'removed'
}
