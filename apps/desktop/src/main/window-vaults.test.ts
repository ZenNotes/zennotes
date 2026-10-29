import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultChangeEvent } from '@shared/ipc'
import {
  WATCH_RETRY_FIRST_DELAY_MS,
  WATCH_RETRY_MAX_DELAY_MS,
  WindowVaultRegistry,
  type VaultWatcherLike
} from './window-vaults'

class TestWatcher implements VaultWatcherLike {
  root: string | null = null
  stopped = false
  onEvent: ((ev: VaultChangeEvent) => void) | null = null
  onExhausted: (() => void) | null = null

  start(root: string, onEvent: (ev: VaultChangeEvent) => void, onExhausted: () => void): void {
    this.root = root
    this.onEvent = onEvent
    this.onExhausted = onExhausted
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  /** What VaultWatcher does when the system runs out of watch handles. */
  exhaust(): void {
    this.stopped = true
    this.onExhausted?.()
  }
}

const RESYNC: VaultChangeEvent = { kind: 'change', path: '', folder: 'inbox', scope: 'resync' }

function retryingRegistry() {
  const watchers: TestWatcher[] = []
  const sent: Array<{ windowId: number; ev: VaultChangeEvent }> = []
  const invalidated: Array<{ root: string; ev: VaultChangeEvent }> = []
  const registry = new WindowVaultRegistry({
    makeWatcher: () => {
      const watcher = new TestWatcher()
      watchers.push(watcher)
      return watcher
    },
    invalidateVault: (root, ev) => invalidated.push({ root, ev }),
    sendVaultChange: (windowId, ev) => sent.push({ windowId, ev })
  })
  return { registry, watchers, sent, invalidated }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function change(path: string): VaultChangeEvent {
  return {
    kind: 'change',
    path,
    folder: 'inbox'
  }
}

describe('WindowVaultRegistry', () => {
  it('routes local vault changes only to windows attached to that vault', () => {
    const watchers: TestWatcher[] = []
    const sent: Array<{ windowId: number; ev: VaultChangeEvent }> = []
    const registry = new WindowVaultRegistry({
      makeWatcher: () => {
        const watcher = new TestWatcher()
        watchers.push(watcher)
        return watcher
      },
      invalidateVault: () => {},
      sendVaultChange: (windowId, ev) => sent.push({ windowId, ev })
    })

    const rootA = path.resolve('/tmp/zennotes-a')
    const rootB = path.resolve('/tmp/zennotes-b')
    registry.setLocalVault(1, { root: rootA, name: 'A' })
    registry.setLocalVault(2, { root: rootB, name: 'B' })

    watchers[0].onEvent?.(change('inbox/a.md'))
    watchers[1].onEvent?.(change('inbox/b.md'))

    expect(sent).toEqual([
      { windowId: 1, ev: change('inbox/a.md') },
      { windowId: 2, ev: change('inbox/b.md') }
    ])
  })

  it('shares one watcher for multiple windows on the same vault', () => {
    const watchers: TestWatcher[] = []
    const sent: number[] = []
    const registry = new WindowVaultRegistry({
      makeWatcher: () => {
        const watcher = new TestWatcher()
        watchers.push(watcher)
        return watcher
      },
      invalidateVault: () => {},
      sendVaultChange: (windowId) => sent.push(windowId)
    })

    const root = path.resolve('/tmp/zennotes-shared')
    registry.setLocalVault(1, { root, name: 'Shared' })
    registry.setLocalVault(2, { root, name: 'Shared' })

    watchers[0].onEvent?.(change('inbox/shared.md'))

    expect(watchers).toHaveLength(1)
    expect(sent).toEqual([1, 2])
  })

  it('stops a local watcher when the last window leaves that vault', () => {
    const watchers: TestWatcher[] = []
    const registry = new WindowVaultRegistry({
      makeWatcher: () => {
        const watcher = new TestWatcher()
        watchers.push(watcher)
        return watcher
      },
      invalidateVault: () => {},
      sendVaultChange: () => {}
    })

    const root = path.resolve('/tmp/zennotes-stop')
    registry.setLocalVault(1, { root, name: 'Stop' })
    registry.setLocalVault(2, { root, name: 'Stop' })

    registry.clearWindow(1)
    expect(watchers[0].stopped).toBe(false)

    registry.clearWindow(2)
    expect(watchers[0].stopped).toBe(true)
  })

  it('checks local asset paths against every open local vault root', () => {
    const registry = new WindowVaultRegistry({
      makeWatcher: () => new TestWatcher(),
      invalidateVault: () => {},
      sendVaultChange: () => {}
    })

    const rootA = path.resolve('/tmp/zennotes-assets-a')
    const rootB = path.resolve('/tmp/zennotes-assets-b')
    registry.setLocalVault(1, { root: rootA, name: 'A' })
    registry.setLocalVault(2, { root: rootB, name: 'B' })

    expect(registry.isPathInsideOpenLocalVault(path.join(rootA, 'attachements', 'a.png'))).toBe(
      true
    )
    expect(registry.isPathInsideOpenLocalVault(path.join(rootB, 'attachements', 'b.png'))).toBe(
      true
    )
    expect(registry.isPathInsideOpenLocalVault(`${rootA}-evil/secret.png`)).toBe(false)
  })

  it('lists other open local vaults when closing one window vault', () => {
    const registry = new WindowVaultRegistry({
      makeWatcher: () => new TestWatcher(),
      invalidateVault: () => {},
      sendVaultChange: () => {}
    })

    const rootA = path.resolve('/tmp/zennotes-close-a')
    const rootB = path.resolve('/tmp/zennotes-close-b')
    registry.setLocalVault(1, { root: rootA, name: 'A' })
    registry.setLocalVault(2, { root: rootB, name: 'B' })

    expect(registry.localVaultsExcept(rootA)).toEqual([{ root: rootB, name: 'B' }])
  })

  it('renames a local vault in every window on that root without touching its watcher (#692)', () => {
    const watchers: TestWatcher[] = []
    const registry = new WindowVaultRegistry({
      makeWatcher: () => {
        const watcher = new TestWatcher()
        watchers.push(watcher)
        return watcher
      },
      invalidateVault: () => {},
      sendVaultChange: () => {}
    })
    const docs = path.resolve('/tmp/zennotes-rename-docs')
    const other = path.resolve('/tmp/zennotes-rename-other')
    registry.setLocalVault(1, { root: docs, name: 'docs' })
    registry.setLocalVault(2, { root: docs, name: 'docs' })
    registry.setLocalVault(3, { root: other, name: 'other' })
    registry.setRemoteVault(4, { root: docs, name: 'docs' })

    expect(registry.renameLocalVault(`${docs}/`, 'Acme API docs').sort()).toEqual([1, 2])
    expect(registry.vaultForWindow(1)?.name).toBe('Acme API docs')
    expect(registry.vaultForWindow(2)?.name).toBe('Acme API docs')
    expect(registry.vaultForWindow(3)?.name).toBe('other')
    expect(registry.vaultForWindow(4)?.name).toBe('docs')
    expect(watchers.every((w) => !w.stopped)).toBe(true)
    // Already named: nothing to report.
    expect(registry.renameLocalVault(docs, 'Acme API docs')).toEqual([])
  })
})

describe('WindowVaultRegistry when a watcher runs out of watch handles', () => {
  it('watches the vault again later and has its windows re-read it', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { registry, watchers, sent, invalidated } = retryingRegistry()
    const root = path.resolve('/tmp/zennotes-exhausted')
    registry.setLocalVault(1, { root, name: 'Big' })
    registry.setLocalVault(2, { root, name: 'Big' })

    watchers[0].exhaust()
    // A window opening the vault meanwhile does not start one early.
    registry.setLocalVault(3, { root, name: 'Big' })
    vi.advanceTimersByTime(WATCH_RETRY_FIRST_DELAY_MS - 1)
    expect(watchers).toHaveLength(1)
    // The vault is still open while nothing watches it.
    expect(registry.isPathInsideOpenLocalVault(path.join(root, 'a.md'))).toBe(true)

    vi.advanceTimersByTime(1)
    expect(watchers).toHaveLength(2)
    expect(watchers[1].root).toBe(root)
    expect(invalidated).toEqual([{ root, ev: RESYNC }])
    expect(sent).toEqual([
      { windowId: 1, ev: RESYNC },
      { windowId: 2, ev: RESYNC },
      { windowId: 3, ev: RESYNC }
    ])

    // The new watcher reports as the first one did.
    watchers[1].onEvent?.(change('a.md'))
    expect(sent.slice(3).map((entry) => entry.windowId)).toEqual([1, 2, 3])
    // A late word from the watcher it replaced changes nothing.
    watchers[0].onExhausted?.()
    vi.advanceTimersByTime(WATCH_RETRY_MAX_DELAY_MS)
    expect(watchers).toHaveLength(2)
  })

  it('waits longer after each failure, up to a cap', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { registry, watchers } = retryingRegistry()
    registry.setLocalVault(1, { root: path.resolve('/tmp/zennotes-backoff'), name: 'Big' })

    const waits: number[] = []
    for (let attempt = 0; attempt < 7; attempt++) {
      const before = watchers.length
      watchers[before - 1].exhaust()
      let waited = 0
      while (watchers.length === before) {
        vi.advanceTimersByTime(1000)
        waited += 1000
      }
      waits.push(waited)
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
  })

  it('gives up the retry when the last window leaves the vault', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { registry, watchers, sent } = retryingRegistry()
    const root = path.resolve('/tmp/zennotes-gone')
    registry.setLocalVault(1, { root, name: 'Big' })
    registry.setLocalVault(2, { root: path.resolve('/tmp/zennotes-other'), name: 'Other' })

    watchers[0].exhaust()
    registry.clearWindow(1)
    await registry.stopAll()
    vi.advanceTimersByTime(WATCH_RETRY_MAX_DELAY_MS)
    expect(watchers).toHaveLength(2)
    expect(watchers[1].stopped).toBe(true)
    expect(sent).toEqual([])
  })
})
