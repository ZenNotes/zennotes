/**
 * Cloud removed this browser and the wipe failed. Since departure.ts a
 * sign-out on the same answer stands aside, so the removal itself must reload
 * and try again, and a wipe that fails every time must not reload for ever.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  attemptRemoval,
  readPendingRemoval,
  REMOVAL_PENDING_KEY,
  REMOVAL_TRIES,
  type RemovalOutcome,
  type TabStorage
} from '../removal-retry'

class MemoryStorage implements TabStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const removal = { reason: 'revoked' as const, shared: true }
const failing = async (): Promise<void> => {
  throw new DOMException('in use', 'NoModificationAllowedError')
}
const working = async (): Promise<void> => {}

/** One load after another, each trying the wipe once, until one stops. */
async function loads(storage: TabStorage, wipes: Array<() => Promise<void>>): Promise<RemovalOutcome[]> {
  const outcomes: RemovalOutcome[] = []
  for (const wipe of wipes) {
    const pending = readPendingRemoval(storage)
    const outcome = await attemptRemoval(storage, pending ?? removal, wipe)
    outcomes.push(outcome)
    if (outcome !== 'retry') break
  }
  return outcomes
}

describe('a removal whose wipe fails', () => {
  it('reloads to try again, and keeps what the next load needs', async () => {
    const storage = new MemoryStorage()
    assert.equal(await attemptRemoval(storage, removal, failing), 'retry')
    assert.deepEqual(readPendingRemoval(storage), { reason: 'revoked', shared: true, tries: 1 })
  })

  it('ends removed once a later try works, with nothing left to retry', async () => {
    const storage = new MemoryStorage()
    assert.deepEqual(await loads(storage, [failing, failing, working]), ['retry', 'retry', 'removed'])
    assert.equal(storage.getItem(REMOVAL_PENDING_KEY), null)
  })

  it('stops reloading when the wipe fails every time', async () => {
    const storage = new MemoryStorage()
    const outcomes = await loads(storage, Array.from({ length: 10 }, () => failing))
    assert.equal(outcomes.length, REMOVAL_TRIES)
    assert.equal(outcomes.at(-1), 'stop')
    assert.deepEqual(outcomes.slice(0, -1), Array(REMOVAL_TRIES - 1).fill('retry'))
  })

  it('tries once more on a reload by hand after stopping, and stops again', async () => {
    const storage = new MemoryStorage()
    await loads(storage, Array.from({ length: REMOVAL_TRIES }, () => failing))
    assert.equal(await attemptRemoval(storage, readPendingRemoval(storage)!, failing), 'stop')
    assert.equal(await attemptRemoval(storage, readPendingRemoval(storage)!, working), 'removed')
  })

  it('counts a try whose wipe cleared sessionStorage before it failed', async () => {
    const storage = new MemoryStorage()
    await attemptRemoval(storage, removal, failing)
    const clearsThenFails = async (): Promise<void> => {
      storage.values.clear()
      await failing()
    }
    assert.equal(await attemptRemoval(storage, removal, clearsThenFails), 'retry')
    assert.equal(readPendingRemoval(storage)?.tries, 2)
  })

  it('stops at once when the count cannot be kept, rather than reload blind', async () => {
    const blocked: TabStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
      removeItem: () => {}
    }
    assert.equal(await attemptRemoval(blocked, removal, failing), 'stop')
    assert.equal(await attemptRemoval(null, removal, failing), 'stop')
  })

  it('remembers whether the tab was a shared computer’s', async () => {
    const storage = new MemoryStorage()
    await attemptRemoval(storage, { reason: 'revoked', shared: false }, failing)
    assert.equal(readPendingRemoval(storage)?.shared, false)
  })

  it('ignores a record it cannot read', () => {
    const storage = new MemoryStorage()
    storage.setItem(REMOVAL_PENDING_KEY, '{not json')
    assert.equal(readPendingRemoval(storage), null)
    storage.setItem(REMOVAL_PENDING_KEY, JSON.stringify({ reason: 'other', shared: true, tries: 1 }))
    assert.equal(readPendingRemoval(storage), null)
  })
})
