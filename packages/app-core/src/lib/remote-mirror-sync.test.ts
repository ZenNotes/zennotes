import { describe, expect, it } from 'vitest'
import type { RemoteMirrorStatus } from '@shared/ipc'
import { remoteMirrorChangesLabel, remoteMirrorStatusLine } from './remote-mirror-sync'

const NOW = 1_800_000_000_000

function mirror(overrides: Partial<RemoteMirrorStatus> = {}): RemoteMirrorStatus {
  return {
    origin: { profileId: 'p', profileName: 'Home server', baseUrl: 'http://nas:7878', vaultId: 'v' },
    pendingChanges: 0,
    lastReachedAt: NOW - 5 * 60_000,
    reachable: true,
    lastSyncedAt: NOW - 5 * 60_000,
    paused: false,
    vaultMismatch: false,
    sizeBytes: 1000,
    ...overrides
  }
}

const line = (m: RemoteMirrorStatus | null, phase = 'ready', error: string | null = null) =>
  remoteMirrorStatusLine({ phase, error, mirror: m, lastSyncedAt: null }, NOW)

describe('remoteMirrorStatusLine', () => {
  it('counts what waits while the server is away, calmly', () => {
    const shown = line(mirror({ reachable: false, pendingChanges: 3 }), 'error', 'x')!
    expect(shown.label).toBe('Offline · 3 changes waiting')
    expect(shown.tone).toBe('offline')
    expect(shown.title).toContain('Home server was last reached 5 minutes ago.')
  })

  it('says Synced when nothing waits', () => {
    expect(line(mirror())!.label).toBe('Synced')
  })

  it('says Working offline while paused', () => {
    expect(line(mirror({ paused: true, pendingChanges: 1 }))!.label).toBe('Working offline · 1 change waiting')
  })

  it('stops on a vault switch', () => {
    expect(line(mirror({ vaultMismatch: true }))!.label).toBe('Sync stopped')
  })

  it('names the server in an error written for Cloud', () => {
    expect(line(mirror(), 'error', 'ZenNotes Cloud is having trouble.')!.title).toBe('Home server is having trouble.')
  })

  it('shows nothing without a copy', () => {
    expect(line(null)).toBeNull()
    expect(remoteMirrorChangesLabel(1)).toBe('1 change waiting')
  })
})
