import { randomUUID } from 'node:crypto'
import type {
  CloudSyncRunSummary,
  CloudSyncWindowEvent
} from '@zennotes/bridge-contract/cloud-sync'

interface Participant {
  id: number
  send(event: CloudSyncWindowEvent): void
}

/** Flush outside the vault's exclusive lock: saving a draft needs that lock. */
export class CloudSyncWindowBarrier {
  private reviews = new Map<string, { owner: number; conflictId: string; reviewId: string }>()
  private pending = new Map<
    string,
    {
      waiting: Set<number>
      resolve(): void
      reject(error: Error): void
    }
  >()

  constructor(
    private readonly options: {
      participants(root: string): Participant[]
      timeoutMs?: number
    }
  ) {}

  claimReview(owner: number, root: string, conflictId: string, reviewId: string): void {
    const key = JSON.stringify([root, conflictId])
    const current = this.reviews.get(key)
    if (current && (current.owner !== owner || current.reviewId !== reviewId)) {
      throw new Error(
        'This file is already being reviewed in another ZenNotes window. Finish that review first.'
      )
    }
    this.reviews.set(key, { owner, conflictId, reviewId })
  }

  releaseReview(owner: number, conflictId?: string, reviewId?: string): void {
    for (const [key, review] of this.reviews) {
      if (
        review.owner === owner &&
        (conflictId === undefined || review.conflictId === conflictId) &&
        (reviewId === undefined || review.reviewId === reviewId)
      ) {
        this.reviews.delete(key)
      }
    }
  }

  acknowledge(senderId: number, requestId: string, error: string | null): void {
    const pending = this.pending.get(requestId)
    if (!pending?.waiting.delete(senderId)) return
    if (error !== null) pending.reject(new Error(error))
    else if (pending.waiting.size === 0) pending.resolve()
  }

  async run(root: string, work: () => Promise<CloudSyncRunSummary>): Promise<CloudSyncRunSummary> {
    const participants = this.options.participants(root)
    const requestId = randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    let summary: CloudSyncRunSummary | null = null
    let error: string | null = null
    try {
      if (participants.length > 0) {
        await new Promise<void>((resolve, reject) => {
          this.pending.set(requestId, {
            waiting: new Set(participants.map((participant) => participant.id)),
            resolve,
            reject
          })
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'Another ZenNotes window could not save its review draft. Sync paused; try again.'
                )
              ),
            this.options.timeoutMs ?? 10_000
          )
          for (const participant of participants) participant.send({ phase: 'prepare', requestId })
        })
      }
      clearTimeout(timer)
      const current = this.options.participants(root)
      if (
        current.length !== participants.length ||
        current.some(
          (candidate) => !participants.some((participant) => participant.id === candidate.id)
        )
      )
        throw new Error('Vault windows changed while preparing sync. Please try again.')
      summary = await work()
      return summary
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      clearTimeout(timer)
      this.pending.delete(requestId)
      for (const participant of participants) {
        try {
          participant.send({ phase: 'finished', requestId, summary, error })
        } catch {
          /* A closed window must not prevent releasing the others. */
        }
      }
    }
  }
}
