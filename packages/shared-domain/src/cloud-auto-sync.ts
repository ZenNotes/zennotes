export type CloudAutoSyncReason =
  | 'startup'
  | 'local-change'
  | 'foreground'
  | 'online'
  | 'account-change'
  | 'vault-link'
  | 'periodic'
  | 'remote-change'

export interface CloudAutoSyncControllerOptions {
  ready(): boolean | Promise<boolean>
  sync(): Promise<void>
  /** A cheap cursor check; only a changed vault needs a full scan and sync. */
  checkRemoteChanges?: () => Promise<boolean>
  online?: () => boolean
  active?: () => boolean
  debounceMs?: number
  intervalMs?: number
  retryDelaysMs?: readonly number[]
  onError?: (error: unknown, retryInMs: number) => void
}

type ScheduledRun = 'immediate' | 'debounce' | 'retry'

const immediateReasons = new Set<CloudAutoSyncReason>([
  'startup',
  'foreground',
  'online',
  'account-change',
  'vault-link',
  'periodic',
  'remote-change'
])

/**
 * Coordinates best-effort automatic sync without owning host lifecycle APIs.
 * Hosts feed it vault, connectivity, and foreground signals; one controller
 * coalesces those signals and keeps retry pressure bounded.
 */
export class CloudAutoSyncController {
  private readonly online: () => boolean
  private readonly active: () => boolean
  private readonly debounceMs: number
  private readonly intervalMs: number
  private readonly retryDelaysMs: readonly number[]
  private started = false
  private running = false
  private retryAttempt = 0
  private runTimer: ReturnType<typeof setTimeout> | null = null
  private runTimerKind: ScheduledRun | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private pollRetryAt = 0
  private pollRetryAttempt = 0
  private pollGeneration = 0
  private pendingImmediate = false
  private pendingDebounce = false

  constructor(private readonly options: CloudAutoSyncControllerOptions) {
    this.online = options.online ?? (() => true)
    this.active = options.active ?? (() => true)
    this.debounceMs = Math.max(0, options.debounceMs ?? 2_000)
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 60_000)
    this.retryDelaysMs = options.retryDelaysMs?.length
      ? options.retryDelaysMs.map((delay) => Math.max(0, delay))
      : [5_000, 15_000, 60_000, 300_000]
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.intervalTimer = setInterval(() => this.request('periodic'), this.intervalMs)
    if (this.options.checkRemoteChanges) {
      this.pollTimer = setInterval(() => void this.poll(), 5_000)
    }
    this.request('startup')
  }

  stop(): void {
    this.started = false
    this.pollGeneration++
    this.polling = false
    this.pendingImmediate = false
    this.pendingDebounce = false
    this.clearRunTimer()
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async poll(): Promise<void> {
    if (!this.started || !this.canRun() || this.running || this.polling ||
        this.runTimer !== null || Date.now() < this.pollRetryAt) return
    this.polling = true
    const generation = this.pollGeneration
    try {
      const changed = await this.options.checkRemoteChanges!()
      if (generation !== this.pollGeneration) return
      this.pollRetryAttempt = 0
      this.pollRetryAt = 0
      if (changed && this.started) this.request('remote-change')
    } catch (error) {
      if (generation !== this.pollGeneration) return
      const delay = this.retryDelaysMs[Math.min(this.pollRetryAttempt++, this.retryDelaysMs.length - 1)]
      this.pollRetryAt = Date.now() + delay
      if (this.started) this.options.onError?.(error, delay)
    } finally {
      if (generation === this.pollGeneration) this.polling = false
    }
  }

  request(reason: CloudAutoSyncReason): void {
    if (!this.started) return

    const immediate = immediateReasons.has(reason)
    if (this.running) {
      if (immediate) this.pendingImmediate = true
      else this.pendingDebounce = true
      return
    }

    if (!this.canRun()) {
      if (immediate) this.pendingImmediate = true
      else this.pendingDebounce = true
      return
    }

    const lifecycleRetry = ['foreground', 'online', 'account-change', 'vault-link'].includes(reason)
    if (this.runTimerKind === 'retry' && !lifecycleRetry) return
    if (lifecycleRetry) {
      this.retryAttempt = 0
      this.pollRetryAttempt = 0
      this.pollRetryAt = 0
    }

    if (immediate) {
      this.schedule(0, 'immediate')
    } else {
      this.schedule(this.debounceMs, 'debounce')
    }
  }

  private canRun(): boolean {
    return this.online() && this.active()
  }

  private schedule(delayMs: number, kind: ScheduledRun): void {
    this.clearRunTimer()
    this.runTimerKind = kind
    this.runTimer = setTimeout(() => {
      this.runTimer = null
      this.runTimerKind = null
      void this.run()
    }, delayMs)
  }

  private clearRunTimer(): void {
    if (this.runTimer !== null) {
      clearTimeout(this.runTimer)
      this.runTimer = null
    }
    this.runTimerKind = null
  }

  private async run(): Promise<void> {
    if (!this.started || this.running) return
    if (!this.canRun()) {
      this.pendingImmediate = true
      return
    }

    this.running = true
    try {
      if (!await this.options.ready()) return
      await this.options.sync()
      this.retryAttempt = 0
    } catch (error) {
      const retryInMs = this.retryDelaysMs[
        Math.min(this.retryAttempt, this.retryDelaysMs.length - 1)
      ]
      this.retryAttempt += 1
      this.pendingImmediate = false
      this.pendingDebounce = false
      this.options.onError?.(error, retryInMs)
      if (this.started) this.schedule(retryInMs, 'retry')
      return
    } finally {
      this.running = false
    }

    if (!this.started) return
    if (this.pendingImmediate) {
      this.pendingImmediate = false
      this.pendingDebounce = false
      this.schedule(0, 'immediate')
    } else if (this.pendingDebounce) {
      this.pendingDebounce = false
      this.schedule(this.debounceMs, 'debounce')
    }
  }
}
