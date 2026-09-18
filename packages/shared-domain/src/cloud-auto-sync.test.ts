import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudAutoSyncController } from './cloud-auto-sync'

function setup(overrides: {
  ready?: () => boolean | Promise<boolean>
  online?: () => boolean
  active?: () => boolean
  sync?: () => Promise<void>
} = {}) {
  const sync = vi.fn(overrides.sync ?? (async () => {}))
  const controller = new CloudAutoSyncController({
    ready: overrides.ready ?? (() => true),
    sync,
    online: overrides.online ?? (() => true),
    active: overrides.active ?? (() => true),
    debounceMs: 2_000,
    intervalMs: 60_000,
    retryDelaysMs: [5_000, 15_000]
  })

  return { controller, sync }
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('CloudAutoSyncController', () => {
  it('checks for incoming edits every five seconds without running idle vault scans', async () => {
    let incoming = false
    const checkRemoteChanges = vi.fn(async () => incoming)
    const sync = vi.fn(async () => { incoming = false })
    const controller = new CloudAutoSyncController({ ready: () => true, sync, checkRemoteChanges })
    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(checkRemoteChanges).toHaveBeenCalledOnce()
    expect(sync).toHaveBeenCalledOnce()
    incoming = true
    await vi.advanceTimersByTimeAsync(5_001)
    expect(sync).toHaveBeenCalledTimes(2)
    controller.stop()
    await vi.advanceTimersByTimeAsync(5_001)
    expect(checkRemoteChanges).toHaveBeenCalledTimes(2)
  })

  it('ignores a probe result from a stopped lifecycle after restart', async () => {
    let finish!: (changed: boolean) => void
    const pending = new Promise<boolean>((resolve) => { finish = resolve })
    const sync = vi.fn(async () => {})
    const controller = new CloudAutoSyncController({
      ready: () => true, sync, checkRemoteChanges: vi.fn().mockReturnValueOnce(pending).mockResolvedValue(false)
    })
    controller.start()
    await vi.advanceTimersByTimeAsync(5_001)
    controller.stop()
    controller.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(sync).toHaveBeenCalledTimes(2)
    finish(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(sync).toHaveBeenCalledTimes(2)
    controller.stop()
  })

  it('does not poll in the background, offline, or during failure backoff', async () => {
    let active = false
    let online = true
    const checkRemoteChanges = vi.fn(async () => { throw new Error('offline') })
    const controller = new CloudAutoSyncController({
      ready: () => true, sync: async () => {}, checkRemoteChanges,
      active: () => active, online: () => online, onError: vi.fn()
    })
    controller.start()
    await vi.advanceTimersByTimeAsync(5_001)
    expect(checkRemoteChanges).not.toHaveBeenCalled()
    active = true
    online = false
    await vi.advanceTimersByTimeAsync(5_001)
    expect(checkRemoteChanges).not.toHaveBeenCalled()
    online = true
    await vi.advanceTimersByTimeAsync(5_001)
    expect(checkRemoteChanges).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(checkRemoteChanges).toHaveBeenCalledOnce()
    controller.stop()
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('syncs when started and periodically while the host is ready', async () => {
    const { controller, sync } = setup()

    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(sync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(sync).toHaveBeenCalledTimes(2)

    controller.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('debounces a burst of local vault changes into one sync', async () => {
    const { controller, sync } = setup()
    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    sync.mockClear()

    controller.request('local-change')
    await vi.advanceTimersByTimeAsync(1_000)
    controller.request('local-change')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(sync).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('waits while offline or inactive and resumes immediately on a lifecycle signal', async () => {
    let online = false
    let active = false
    const { controller, sync } = setup({
      online: () => online,
      active: () => active
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sync).not.toHaveBeenCalled()

    online = true
    active = true
    controller.request('foreground')
    await vi.advanceTimersByTimeAsync(0)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('coalesces a request that arrives during a running sync', async () => {
    let finishFirstSync: (() => void) | undefined
    const firstSync = new Promise<void>((resolve) => {
      finishFirstSync = resolve
    })
    const { controller, sync } = setup({
      sync: vi.fn()
        .mockImplementationOnce(() => firstSync)
        .mockResolvedValue(undefined)
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sync).toHaveBeenCalledTimes(1)

    controller.request('local-change')
    finishFirstSync?.()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(sync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('backs off after failures and resets the retry delay after success', async () => {
    const failure = new Error('service unavailable')
    const sync = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined)
    const onError = vi.fn()
    const controller = new CloudAutoSyncController({
      ready: () => true,
      sync,
      online: () => true,
      active: () => true,
      debounceMs: 2_000,
      intervalMs: 60_000,
      retryDelaysMs: [5_000, 15_000],
      onError
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(failure, 5_000)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sync).toHaveBeenCalledTimes(2)

    controller.request('foreground')
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenLastCalledWith(failure, 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync).toHaveBeenCalledTimes(4)
  })

  it('checks account and vault readiness before invoking sync', async () => {
    let ready = false
    const { controller, sync } = setup({ ready: () => ready })

    controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sync).not.toHaveBeenCalled()

    ready = true
    controller.request('account-change')
    await vi.advanceTimersByTimeAsync(0)
    expect(sync).toHaveBeenCalledTimes(1)
  })
})
