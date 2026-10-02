import type { CloudSyncHttpRequest, CloudSyncHttpTransport } from './cloud-sync-api'

export type CloudSyncResponseHeaders =
  | Readonly<Record<string, string | undefined>>
  | { get(name: string): string | null }

export interface CloudSyncRateLimitScope {
  baseUrl: string
  /** Stable authenticated account identity, not a vault id or bearer token. */
  accountId: string
}

export interface CloudSyncRateLimitOptions extends CloudSyncRateLimitScope {
  signal?: AbortSignal
  /** Additional attempts for one request, 0 through 10. Defaults to 3. */
  maxRetries?: number
}

interface AccountCooldown {
  until: number
  session: AbortController
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Milliseconds to wait, or null for a missing/malformed header. Unrepresentable
 * numeric delays return Infinity, keeping the wait cancellable without retrying
 * early. Valid server delays are never shortened to fit a timer or local policy. */
export function cloudSyncRetryAfterMs(
  headers: CloudSyncResponseHeaders | null | undefined,
  now = Date.now()
): number | null {
  const value = headerValue(headers, 'retry-after')?.trim()
  if (!value) return null
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1000
    return Number.isSafeInteger(milliseconds) ? milliseconds : Infinity
  }
  // Date.parse also accepts bare numbers and fractional dates; these are
  // not HTTP dates and must not turn a malformed delay into an early retry.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(value)) return null
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return null
  const serverDate = Date.parse(headerValue(headers, 'date') ?? '')
  return Math.max(0, date - now, Number.isFinite(serverDate) ? date - serverDate : 0)
}

/** One instance per device runtime. Recreated clients and different vaults
 * share a cooldown, but only for the same authenticated account and API base. */
export class CloudSyncRateLimitCoordinator {
  private readonly accounts = new Map<string, AccountCooldown>()

  wrap(
    transport: CloudSyncHttpTransport,
    options: CloudSyncRateLimitOptions
  ): CloudSyncHttpTransport {
    const maxRetries = options.maxRetries ?? 3
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      throw new Error('Cloud rate-limit retries must be an integer from 0 through 10.')
    }
    const key = scopeKey(options)
    let account = this.accounts.get(key)
    if (!account) {
      account = { until: 0, session: new AbortController() }
      this.accounts.set(key, account)
    }
    const cooldown = account
    const session = cooldown.session.signal
    const lifetime = options.signal
    return {
      request: <Response>(request: CloudSyncHttpRequest): Promise<Response> => {
        const combined = combineSignals([session, lifetime, request.signal])
        return this.request<Response>(
          transport,
          request,
          cooldown,
          maxRetries,
          combined.signal
        ).finally(combined.dispose)
      }
    }
  }

  /** Invalidate existing clients on logout. A later login gets a new session
   * but must still respect any server cooldown that has not expired. */
  cancel(scope: CloudSyncRateLimitScope): void {
    const account = this.accounts.get(scopeKey(scope))
    if (!account) return
    account.session.abort()
    account.session = new AbortController()
  }

  cancelAll(): void {
    for (const account of this.accounts.values()) {
      account.session.abort()
      account.session = new AbortController()
    }
  }

  private async request<Response>(
    transport: CloudSyncHttpTransport,
    request: CloudSyncHttpRequest,
    account: AccountCooldown,
    maxRetries: number,
    signal: AbortSignal
  ): Promise<Response> {
    throwIfCancelled(signal)
    const replayable = request.method === 'GET' || request.retryOnRateLimit === true
    const snapshot = {
      ...request,
      ...(replayable && request.body !== undefined ? { body: cloneReplayBody(request.body) } : {}),
      signal
    }
    let retries = 0
    for (;;) {
      while (account.until > Date.now()) {
        await wait(Math.min(account.until - Date.now(), MAX_TIMER_DELAY_MS), signal)
      }
      throwIfCancelled(signal)
      try {
        return await abortable(
          () =>
            transport.request<Response>({
              ...snapshot,
              ...(replayable && snapshot.body !== undefined
                ? { body: cloneReplayBody(snapshot.body) }
                : {})
            }),
          signal
        )
      } catch (error) {
        throwIfCancelled(signal)
        if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 429) {
          throw error
        }
        const headers = 'headers' in error ? (error.headers as CloudSyncResponseHeaders) : undefined
        const delay = cloudSyncRetryAfterMs(headers) ?? Math.min(60_000 * 2 ** retries, 300_000)
        const deadline = Date.now() + delay
        account.until = Math.max(
          account.until,
          Number.isSafeInteger(deadline) ? deadline : Infinity
        )
        if (!replayable || retries >= maxRetries) throw error
        retries++
      }
    }
  }
}

/** Default shared instance; hosts can inject their own coordinator for tests. */
export const cloudSyncRateLimits = new CloudSyncRateLimitCoordinator()

/** Replayable bodies are JSON API payloads. iOS 15.0 has no structuredClone;
 * copying through JSON preserves the bytes the transport would serialize. */
function cloneReplayBody(body: unknown): unknown {
  return typeof structuredClone === 'function'
    ? structuredClone(body)
    : JSON.parse(JSON.stringify(body))
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  return new DOMException('The Cloud request was aborted.', 'AbortError')
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function scopeKey(scope: CloudSyncRateLimitScope): string {
  if (!scope.accountId.trim())
    throw new Error('Cloud request recovery requires an account identity.')
  return JSON.stringify([new URL(scope.baseUrl.trim()).href.replace(/\/+$/, ''), scope.accountId])
}

function headerValue(
  headers: CloudSyncResponseHeaders | null | undefined,
  name: string
): string | null {
  if (!headers || typeof headers !== 'object') return null
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name)
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
  return typeof value === 'string' ? value : null
}

function combineSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const listeners: Array<() => void> = []
  for (const signal of new Set(signals)) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort(abortReason(signal))
      break
    }
    const abort = () => controller.abort(abortReason(signal))
    signal.addEventListener('abort', abort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', abort))
  }
  return { signal: controller.signal, dispose: () => listeners.forEach((dispose) => dispose()) }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal)
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function abortable<Value>(work: () => Promise<Value>, signal: AbortSignal): Promise<Value> {
  throwIfCancelled(signal)
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      work().then(
        (value) => {
          cleanup()
          resolve(value)
        },
        (error) => {
          cleanup()
          reject(error)
        }
      )
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}
