/**
 * Whether the open vault holds changes ZenNotes Cloud does not have
 * (docs/ideas/cloud-in-browser.md, "Losing nothing"). The mark lives in
 * IndexedDB per vault (browser-vaults.ts), so a reload, the account switch
 * and a shared computer's sign-out all read the same answer.
 *
 * A run clears it only when nothing changed while it ran and it set nothing
 * aside: a parked conflict, a local conflict, a file the service refused or a
 * first-link conflict all stay here until resolved, and wiping the copy would
 * lose them. A call made while another run is going never clears it: the sync
 * service hands that call the run already in flight, which started before
 * any change the second caller is waiting on.
 */
import type { CloudSyncRunSummary } from '@zennotes/bridge-contract/cloud-sync'
import { isVaultUnsynced, markVaultUnsynced } from './browser-vaults'

export function syncLeftNothingBehind(summary: CloudSyncRunSummary): boolean {
  return (
    (summary.pending_conflicts?.length ?? 0) === 0 &&
    summary.local_conflicts.length === 0 &&
    (summary.refused_paths?.length ?? 0) === 0 &&
    summary.bootstrap_conflicts.length === 0
  )
}

export interface UnsyncedStore {
  mark(key: string, unsynced: boolean): Promise<void>
  read(key: string): Promise<boolean>
}

const idbStore: UnsyncedStore = { mark: markVaultUnsynced, read: isVaultUnsynced }

export class UnsyncedChanges {
  /** True while the vault holds changes Cloud has not received. */
  pending = false
  private changes = 0
  private running = 0
  private writing: Promise<void> = Promise.resolve()

  /** `syncing`: whether the sync service already has a run going for this
   *  vault, started by anyone (a link's first sync is not tracked here). */
  constructor(
    private readonly key: string,
    private readonly store: UnsyncedStore = idbStore,
    private readonly syncing: () => boolean = () => false
  ) {}

  /** What the last page left: a reload must not forget unsynced edits. */
  async restore(): Promise<void> {
    if (await this.store.read(this.key).catch(() => false)) this.pending = true
  }

  changed(): void {
    this.changes += 1
    this.pending = true
    this.write(true)
  }

  /** Runs a sync and clears the mark when it carried everything. */
  async track<T extends CloudSyncRunSummary>(run: () => Promise<T>): Promise<T> {
    const before = this.changes
    const joined = this.running > 0 || this.syncing()
    this.running += 1
    let result: T
    try {
      result = await run()
    } finally {
      this.running -= 1
    }
    if (!joined && this.changes === before && syncLeftNothingBehind(result)) {
      this.pending = false
      this.write(false)
      await this.settled()
    }
    return result
  }

  /**
   * Runs until a run vouches for everything here, or one sets something
   * aside, at most `attempts` times. A run that only joined one already going
   * cannot vouch for a change made after it started, so the next one, which
   * starts after it, does: the sign-out's final push uses this, or it would
   * ask to discard changes the joined run (or the next) carried to Cloud.
   */
  async pushUntilSettled<T extends CloudSyncRunSummary>(run: () => Promise<T>, attempts = 3): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const joined = this.running > 0 || this.syncing()
      const result = await this.track(run)
      if (!this.pending || (!joined && !syncLeftNothingBehind(result))) return
    }
  }

  /** Resolves once the mark is written. */
  settled(): Promise<void> {
    return this.writing
  }

  private write(unsynced: boolean): void {
    this.writing = this.writing.then(() => this.store.mark(this.key, unsynced)).catch(() => undefined)
  }
}
