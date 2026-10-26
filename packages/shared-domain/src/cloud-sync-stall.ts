/**
 * How a phone notices a ZenNotes Cloud request that stopped moving, and what
 * it does next.
 *
 * A phone's HTTP stack measures idle time, not total time: Android's socket
 * read timeout and an iOS URLRequest's timeout both start over whenever bytes
 * arrive. One short bound therefore drops a connection that went quiet (a
 * filtering network that holds a connection open and passes nothing is the
 * usual cause) while a large download that keeps moving runs as long as it
 * needs. Phones used to wait 300 seconds there, and the rest of the sync
 * waited behind it. A request dropped that way never got an answer, so one
 * that is safe to send twice goes out again on a fresh connection instead of
 * failing the whole sync.
 *
 * Sending is the exception. Bytes going out do not restart the iOS timeout,
 * and URLSession reports a body as sent once it holds it, long before the
 * bytes leave, so on iOS a request with a body gets cloudSendTimeoutMs.
 * Android's read timeout does not run while it sends; its native uploader
 * watches the bytes it writes instead.
 */

/**
 * No bytes for this long and a request is stalled. The desktop gives a whole
 * request 30 seconds, so 30 seconds without a single byte never treats a slow
 * but moving connection worse than the desktop does.
 */
export const CLOUD_STALL_TIMEOUT_MS = 30_000

/** A connection that has not opened in this long is not going to. */
export const CLOUD_CONNECT_TIMEOUT_MS = 15_000

/**
 * The slowest upload a phone still waits out. URLSession on iOS restarts a
 * request's timeout only when data arrives, so while a body goes out the
 * timeout keeps running from the start (Android's runs only while it reads).
 * 8 KiB a second is a weak mobile signal; slower than that, retrying later
 * serves better than waiting.
 */
export const CLOUD_SLOWEST_UPLOAD_BYTES_PER_SECOND = 8 * 1024

/**
 * The timeout for a request that sends `bodyBytes`, on a host whose timeout
 * keeps running while it sends (iOS): the stall bound, which also covers the
 * service's answer, plus the time the body takes at the slowest upload rate.
 */
export function cloudSendTimeoutMs(bodyBytes: number): number {
  return CLOUD_STALL_TIMEOUT_MS + Math.ceil((Math.max(0, bodyBytes) / CLOUD_SLOWEST_UPLOAD_BYTES_PER_SECOND) * 1000)
}

/**
 * The wait before each new attempt at a request that got no answer, one entry
 * per retry. Each is shortened by up to half at random, so devices behind the
 * same unsteady link do not all come back at once.
 */
export const CLOUD_TRANSPORT_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 15_000]

/**
 * A request that got no HTTP answer at all: it stalled, its connection was
 * reset, or the connection never opened. Hosts wrap their native failures in
 * it so a retry can tell them from an answer the service gave. The message is
 * the host's own, so the words a person sees do not change.
 */
export class CloudSyncTransportError extends Error {
  /** The connection went quiet, as opposed to failing outright. */
  readonly stalled: boolean
  /** The host's own name for the failure, for the details line. */
  readonly code: string | null

  constructor(message: string, options: { stalled?: boolean; code?: string | null; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'CloudSyncTransportError'
    this.stalled = options.stalled === true
    this.code = options.code ?? null
  }
}

export function isCloudSyncTransportError(error: unknown): error is CloudSyncTransportError {
  return error instanceof CloudSyncTransportError ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'CloudSyncTransportError')
}

/** How long to wait before retry number `attempt` (0 first), or null when none is left. */
export function cloudTransportRetryDelayMs(
  attempt: number,
  delays: readonly number[] = CLOUD_TRANSPORT_RETRY_DELAYS_MS,
  random: () => number = Math.random
): number | null {
  const base = delays[attempt]
  if (base === undefined) return null
  return Math.round(base * (0.5 + random() * 0.5))
}

/** Throws unless `delays` is a usable retry schedule. */
export function assertCloudTransportRetryDelays(delays: readonly number[]): void {
  if (delays.length > 10 || delays.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new Error('Cloud transport retry delays must be at most 10 non-negative numbers.')
  }
}

/**
 * Runs `transfer`, and runs it again after each failure `isTransportFailure`
 * recognizes, waiting out the delays in between; anything else is thrown at
 * once, and so is the last failure. Only for work that is safe to repeat: a
 * GET, or a PUT of the same bytes to the same object.
 */
export async function retryCloudTransfer<Value>(
  transfer: () => Promise<Value>,
  options: {
    signal?: AbortSignal
    isTransportFailure?: (error: unknown) => boolean
    delaysMs?: readonly number[]
  } = {}
): Promise<Value> {
  const isTransportFailure = options.isTransportFailure ?? isCloudSyncTransportError
  const delays = options.delaysMs ?? CLOUD_TRANSPORT_RETRY_DELAYS_MS
  assertCloudTransportRetryDelays(delays)
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(options.signal)
    try {
      return await transfer()
    } catch (error) {
      if (options.signal?.aborted) throw error
      const delay = isTransportFailure(error) ? cloudTransportRetryDelayMs(attempt, delays) : null
      if (delay === null) throw error
      await pause(delay, options.signal)
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The Cloud request was aborted.', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

function pause(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(abortReason(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
