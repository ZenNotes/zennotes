import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { VaultChangeEvent } from '@shared/ipc'
import { WindowVaultRegistry, type VaultWatcherLike } from './window-vaults'

class TestWatcher implements VaultWatcherLike {
  root: string | null = null
  stopped = false
  onEvent: ((ev: VaultChangeEvent) => void) | null = null

  start(root: string, onEvent: (ev: VaultChangeEvent) => void): void {
    this.root = root
    this.onEvent = onEvent
  }

  stop(): void {
    this.stopped = true
  }
}

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
