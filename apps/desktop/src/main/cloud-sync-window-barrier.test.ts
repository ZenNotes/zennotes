import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudSyncRunSummary,
  CloudSyncWindowEvent
} from '@zennotes/bridge-contract/cloud-sync'
import { CloudSyncWindowBarrier } from './cloud-sync-window-barrier'

const root = '/test/vault'
const summary: CloudSyncRunSummary = {
  cursor: 3,
  pulled: 1,
  pushed: 0,
  conflicts: [],
  bootstrap_conflicts: [],
  local_conflicts: [],
  pending_conflicts: []
}

function windowParticipant(id: number) {
  const events: CloudSyncWindowEvent[] = []
  return { id, events, send: (event: CloudSyncWindowEvent) => events.push(event) }
}

function requestId(participant: ReturnType<typeof windowParticipant>): string {
  const prepare = participant.events.find((event) => event.phase === 'prepare')
  expect(prepare).toBeDefined()
  return prepare!.requestId
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('CloudSyncWindowBarrier', () => {
  it('allows only one review writer per vault/conflict, including same-window mounts', () => {
    const barrier = new CloudSyncWindowBarrier({ participants: () => [] })
    barrier.claimReview(1, root, 'note', 'review-a')
    expect(() => barrier.claimReview(1, root, 'note', 'review-a')).not.toThrow()
    expect(() => barrier.claimReview(2, root, 'note', 'review-b')).toThrow(
      'another ZenNotes window'
    )
    expect(() => barrier.claimReview(1, root, 'note', 'review-b')).toThrow(
      'another ZenNotes window'
    )
    expect(() => barrier.claimReview(2, root, 'other', 'review-b')).not.toThrow()
    expect(() => barrier.claimReview(2, '/other/vault', 'note', 'review-b')).not.toThrow()
    barrier.releaseReview(2, 'note', 'review-a')
    barrier.releaseReview(1, 'note', 'stale-session')
    expect(() => barrier.claimReview(2, root, 'note', 'review-b')).toThrow()
    barrier.releaseReview(1, 'note', 'review-a')
    expect(() => barrier.claimReview(2, root, 'note', 'review-b')).not.toThrow()
    barrier.releaseReview(2)
    expect(() => barrier.claimReview(1, root, 'note', 'review-c')).not.toThrow()
  })

  it('prepares every window and waits for every draft acknowledgement before syncing', async () => {
    const first = windowParticipant(1)
    const second = windowParticipant(2)
    const barrier = new CloudSyncWindowBarrier({ participants: () => [first, second] })
    const work = vi.fn(async () => summary)

    const result = barrier.run(root, work)
    await vi.advanceTimersByTimeAsync(0)
    const id = requestId(first)
    expect(second.events).toEqual([{ phase: 'prepare', requestId: id }])
    expect(work).not.toHaveBeenCalled()

    barrier.acknowledge(first.id, id, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(work).not.toHaveBeenCalled()
    barrier.acknowledge(second.id, id, null)

    await expect(result).resolves.toEqual(summary)
    expect(work).toHaveBeenCalledTimes(1)
    for (const participant of [first, second]) {
      expect(participant.events).toEqual([
        { phase: 'prepare', requestId: id },
        { phase: 'finished', requestId: id, summary, error: null }
      ])
    }
  })

  it('ignores unrelated senders, stale requests, and duplicate acknowledgements', async () => {
    const first = windowParticipant(1)
    const second = windowParticipant(2)
    const barrier = new CloudSyncWindowBarrier({ participants: () => [first, second] })
    const work = vi.fn(async () => summary)
    const result = barrier.run(root, work)
    await vi.advanceTimersByTimeAsync(0)
    const id = requestId(first)

    barrier.acknowledge(99, id, null)
    barrier.acknowledge(second.id, 'previous-request', null)
    barrier.acknowledge(99, id, 'Unrelated error')
    barrier.acknowledge(first.id, id, null)
    barrier.acknowledge(first.id, id, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(work).not.toHaveBeenCalled()

    barrier.acknowledge(second.id, id, null)
    await expect(result).resolves.toEqual(summary)
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('aborts and releases all prepared windows when a draft cannot be saved', async () => {
    const first = windowParticipant(1)
    const second = windowParticipant(2)
    const barrier = new CloudSyncWindowBarrier({ participants: () => [first, second] })
    const work = vi.fn(async () => summary)
    const outcome = barrier.run(root, work).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    const id = requestId(first)

    barrier.acknowledge(first.id, id, 'Cannot save conflict draft')
    expect(await outcome).toBeInstanceOf(Error)
    expect(work).not.toHaveBeenCalled()
    for (const participant of [first, second]) {
      expect(participant.events.at(-1)).toEqual({
        phase: 'finished',
        requestId: id,
        summary: null,
        error: expect.stringContaining('Cannot save conflict draft')
      })
    }
  })

  it('times out without running sync and does not accept a late acknowledgement', async () => {
    const participant = windowParticipant(1)
    const barrier = new CloudSyncWindowBarrier({
      participants: () => [participant],
      timeoutMs: 100
    })
    const work = vi.fn(async () => summary)
    const outcome = barrier.run(root, work).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    const id = requestId(participant)

    await vi.advanceTimersByTimeAsync(100)
    expect(await outcome).toBeInstanceOf(Error)
    barrier.acknowledge(participant.id, id, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(work).not.toHaveBeenCalled()
    expect(participant.events).toEqual([
      { phase: 'prepare', requestId: id },
      { phase: 'finished', requestId: id, summary: null, error: expect.any(String) }
    ])
  })

  it.each(['opened', 'closed'] as const)(
    'aborts if another window is %s before all drafts are saved',
    async (change) => {
      const first = windowParticipant(1)
      const second = windowParticipant(2)
      let participants = [first, second]
      const barrier = new CloudSyncWindowBarrier({ participants: () => participants })
      const work = vi.fn(async () => summary)
      const outcome = barrier.run(root, work).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      const id = requestId(first)
      barrier.acknowledge(first.id, id, null)
      participants = change === 'opened' ? [...participants, windowParticipant(3)] : [first]
      barrier.acknowledge(second.id, id, null)

      expect(await outcome).toBeInstanceOf(Error)
      expect(work).not.toHaveBeenCalled()
      expect(first.events.at(-1)).toEqual({
        phase: 'finished',
        requestId: id,
        summary: null,
        error: expect.any(String)
      })
    }
  )

  it('releases prepared windows when the actual sync fails', async () => {
    const participant = windowParticipant(1)
    const barrier = new CloudSyncWindowBarrier({ participants: () => [participant] })
    const failure = new Error('Cloud connection failed')
    const work = vi.fn(async () => {
      throw failure
    })
    const outcome = barrier.run(root, work).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    const id = requestId(participant)
    barrier.acknowledge(participant.id, id, null)

    expect(await outcome).toBe(failure)
    expect(participant.events.at(-1)).toEqual({
      phase: 'finished',
      requestId: id,
      summary: null,
      error: 'Cloud connection failed'
    })
  })

  it('runs immediately when no window is attached to the vault', async () => {
    const work = vi.fn(async () => summary)
    const barrier = new CloudSyncWindowBarrier({ participants: () => [] })
    await expect(barrier.run(root, work)).resolves.toEqual(summary)
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('aborts if preparing a window throws and still releases other prepared windows', async () => {
    const first = windowParticipant(1)
    const second = windowParticipant(2)
    const failure = new Error('Window closed before it could save')
    const barrier = new CloudSyncWindowBarrier({
      participants: () => [
        first,
        {
          ...second,
          send(event) {
            second.send(event)
            throw failure
          }
        }
      ]
    })
    const work = vi.fn(async () => summary)

    await expect(barrier.run(root, work)).rejects.toBe(failure)

    expect(work).not.toHaveBeenCalled()
    expect(first.events.at(-1)).toEqual({
      phase: 'finished',
      requestId: requestId(first),
      summary: null,
      error: failure.message
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not let one failed completion notification strand another window', async () => {
    const first = windowParticipant(1)
    const second = windowParticipant(2)
    const barrier = new CloudSyncWindowBarrier({
      participants: () => [
        {
          ...first,
          send(event) {
            first.send(event)
            if (event.phase === 'finished') throw new Error('Window closed')
          }
        },
        second
      ]
    })
    const result = barrier.run(root, async () => summary)
    await vi.advanceTimersByTimeAsync(0)
    const id = requestId(first)
    barrier.acknowledge(first.id, id, null)
    barrier.acknowledge(second.id, id, null)

    await expect(result).resolves.toEqual(summary)
    expect(second.events.at(-1)).toEqual({
      phase: 'finished',
      requestId: id,
      summary,
      error: null
    })
  })

  it('requires a fresh acknowledgement when retrying a timed-out sync', async () => {
    const participant = windowParticipant(1)
    const barrier = new CloudSyncWindowBarrier({
      participants: () => [participant],
      timeoutMs: 100
    })
    const work = vi.fn(async () => summary)
    const failed = barrier.run(root, work).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    const oldId = requestId(participant)
    await vi.advanceTimersByTimeAsync(100)
    expect(await failed).toBeInstanceOf(Error)
    participant.events.length = 0

    const retried = barrier.run(root, work)
    await vi.advanceTimersByTimeAsync(0)
    const freshId = requestId(participant)
    expect(freshId).not.toBe(oldId)
    barrier.acknowledge(participant.id, oldId, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(work).not.toHaveBeenCalled()
    barrier.acknowledge(participant.id, freshId, null)

    await expect(retried).resolves.toEqual(summary)
    expect(work).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('supports immediate acknowledgements and does not apply the preparation timeout to sync work', async () => {
    const first = windowParticipant(1)
    const second = windowParticipant(2)
    let finish!: (value: CloudSyncRunSummary) => void
    const work = vi.fn(
      () =>
        new Promise<CloudSyncRunSummary>((resolve) => {
          finish = resolve
        })
    )
    const barrier = new CloudSyncWindowBarrier({
      participants: () =>
        [first, second].map((participant) => ({
          id: participant.id,
          send(event) {
            participant.send(event)
            if (event.phase === 'prepare')
              barrier.acknowledge(participant.id, event.requestId, null)
          }
        })),
      timeoutMs: 100
    })

    const result = barrier.run(root, work)
    await vi.advanceTimersByTimeAsync(500)
    expect(work).toHaveBeenCalledTimes(1)
    expect(first.events).toHaveLength(1)
    expect(second.events).toHaveLength(1)
    finish(summary)
    await expect(result).resolves.toEqual(summary)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps draft acknowledgements isolated between concurrent vault syncs', async () => {
    const first = windowParticipant(1)
    const second = windowParticipant(2)
    const otherRoot = '/test/other-vault'
    const barrier = new CloudSyncWindowBarrier({
      participants: (vaultRoot) => (vaultRoot === root ? [first] : [second])
    })
    const firstWork = vi.fn(async () => summary)
    const otherSummary = { ...summary, cursor: 9 }
    const secondWork = vi.fn(async () => otherSummary)
    const firstResult = barrier.run(root, firstWork)
    const secondResult = barrier.run(otherRoot, secondWork)
    await vi.advanceTimersByTimeAsync(0)
    const firstId = requestId(first)
    const secondId = requestId(second)
    expect(firstId).not.toBe(secondId)

    barrier.acknowledge(first.id, secondId, null)
    barrier.acknowledge(second.id, firstId, null)
    barrier.acknowledge(first.id, firstId, null)
    await expect(firstResult).resolves.toEqual(summary)
    expect(secondWork).not.toHaveBeenCalled()
    expect(second.events).toEqual([{ phase: 'prepare', requestId: secondId }])

    barrier.acknowledge(second.id, secondId, null)
    await expect(secondResult).resolves.toEqual(otherSummary)
    expect(second.events.at(-1)).toEqual({
      phase: 'finished',
      requestId: secondId,
      summary: otherSummary,
      error: null
    })
  })
})
