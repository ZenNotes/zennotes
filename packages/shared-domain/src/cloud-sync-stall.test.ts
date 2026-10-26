import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLOUD_TRANSPORT_RETRY_DELAYS_MS,
  CloudSyncTransportError,
  cloudSendTimeoutMs,
  cloudTransportRetryDelayMs,
  isCloudSyncTransportError,
  retryCloudTransfer
} from './cloud-sync-stall'

const stalled = () => new CloudSyncTransportError('timeout', { stalled: true, code: 'SocketTimeoutException' })

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('cloudTransportRetryDelayMs', () => {
  it('waits between half and all of each listed delay, then has none left', () => {
    expect(cloudTransportRetryDelayMs(0, [1_000, 4_000], () => 0)).toBe(500)
    expect(cloudTransportRetryDelayMs(0, [1_000, 4_000], () => 0.999_999)).toBe(1_000)
    expect(cloudTransportRetryDelayMs(1, [1_000, 4_000], () => 0.5)).toBe(3_000)
    expect(cloudTransportRetryDelayMs(2, [1_000, 4_000], () => 0.5)).toBeNull()
  })

  it('retries three times by default, the longest wait 15 seconds', () => {
    expect(CLOUD_TRANSPORT_RETRY_DELAYS_MS).toEqual([1_000, 4_000, 15_000])
  })
})

describe('cloudSendTimeoutMs', () => {
  it('gives a body the time it takes at 8 KiB a second on top of the stall bound', () => {
    expect(cloudSendTimeoutMs(0)).toBe(30_000)
    expect(cloudSendTimeoutMs(4 * 1024)).toBe(30_500)
    expect(cloudSendTimeoutMs(1024 * 1024)).toBe(158_000)
    // A note at the 5 MiB inline cap, base64 in JSON: never less than the
    // 300 seconds every iOS request used to get.
    expect(cloudSendTimeoutMs(Math.ceil((5 * 1024 * 1024 * 4) / 3))).toBeGreaterThan(300_000)
    expect(cloudSendTimeoutMs(-1)).toBe(30_000)
  })
})

describe('isCloudSyncTransportError', () => {
  it('knows the error by name too, for a copy from another bundle', () => {
    expect(isCloudSyncTransportError(stalled())).toBe(true)
    expect(isCloudSyncTransportError(Object.assign(new Error('timeout'), { name: 'CloudSyncTransportError' }))).toBe(true)
    expect(isCloudSyncTransportError(Object.assign(new Error('Not found'), { status: 404 }))).toBe(false)
    expect(isCloudSyncTransportError(new DOMException('Stopped', 'AbortError'))).toBe(false)
    expect(isCloudSyncTransportError(null)).toBe(false)
  })
})

describe('retryCloudTransfer', () => {
  it('runs a stalled transfer again after each wait until it lands', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999_999)
    const transfer = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(stalled())
      .mockRejectedValueOnce(stalled())
      .mockResolvedValueOnce('landed')
    const result = retryCloudTransfer(transfer)
    await vi.advanceTimersByTimeAsync(0)
    expect(transfer).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(transfer).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(transfer).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(transfer).toHaveBeenCalledTimes(3)
    await expect(result).resolves.toBe('landed')
  })

  it('throws the last failure once the waits run out', async () => {
    const failures = [stalled(), stalled(), stalled(), stalled()]
    const transfer = vi.fn<() => Promise<string>>()
    for (const failure of failures) transfer.mockRejectedValueOnce(failure)
    const result = retryCloudTransfer(transfer)
    const settled = expect(result).rejects.toBe(failures[3])
    await vi.advanceTimersByTimeAsync(20_000)
    await settled
    expect(transfer).toHaveBeenCalledTimes(4)
  })

  it('never repeats an answer the service gave', async () => {
    const refused = Object.assign(new Error('Forbidden'), { status: 403 })
    const transfer = vi.fn<() => Promise<string>>().mockRejectedValueOnce(refused)
    await expect(retryCloudTransfer(transfer)).rejects.toBe(refused)
    expect(transfer).toHaveBeenCalledTimes(1)
  })

  it('takes the host\'s word for what counts as a transport failure', async () => {
    const nativeFailure = Object.assign(new Error('Cloud object download failed.'), { code: 'DIRECT_DOWNLOAD_FAILED' })
    const transfer = vi.fn<() => Promise<string>>().mockRejectedValueOnce(nativeFailure).mockResolvedValueOnce('landed')
    const result = retryCloudTransfer(transfer, {
      isTransportFailure: (error) => (error as { code?: string }).code === 'DIRECT_DOWNLOAD_FAILED',
      delaysMs: [10]
    })
    await vi.advanceTimersByTimeAsync(10)
    await expect(result).resolves.toBe('landed')
  })

  it('stops waiting when the sync is cancelled, and sends nothing more', async () => {
    const controller = new AbortController()
    const transfer = vi.fn<() => Promise<string>>().mockRejectedValue(stalled())
    const result = retryCloudTransfer(transfer, { signal: controller.signal })
    const settled = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await settled
    await vi.advanceTimersByTimeAsync(60_000)
    expect(transfer).toHaveBeenCalledTimes(1)
  })

  it('does not retry a transfer that failed because the sync was cancelled', async () => {
    const controller = new AbortController()
    const transfer = vi.fn<() => Promise<string>>().mockImplementation(async () => {
      controller.abort()
      throw stalled()
    })
    await expect(retryCloudTransfer(transfer, { signal: controller.signal })).rejects.toBeInstanceOf(CloudSyncTransportError)
    expect(transfer).toHaveBeenCalledTimes(1)
  })

  it('refuses a schedule it cannot keep', async () => {
    await expect(retryCloudTransfer(async () => 'x', { delaysMs: [Number.NaN] })).rejects.toThrow(/retry delays/)
    await expect(retryCloudTransfer(async () => 'x', { delaysMs: new Array(11).fill(1) })).rejects.toThrow(/retry delays/)
  })
})
