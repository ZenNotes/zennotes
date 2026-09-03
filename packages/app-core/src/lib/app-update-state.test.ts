import { describe, expect, it } from 'vitest'
import type { AppUpdateState } from '@shared/ipc'
import {
  appUpdateBadgeLabel,
  appUpdateNoticeLabel,
  appUpdatePrimaryActionLabel
} from './app-update-state'

function updateState(phase: AppUpdateState['phase'], overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    phase,
    installable: true,
    currentVersion: '1.3.9',
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    progressPercent: null,
    transferredBytes: null,
    totalBytes: null,
    bytesPerSecond: null,
    message: '',
    ...overrides
  }
}

describe('app update state labels', () => {
  it('shows attention labels for available updates', () => {
    const state = updateState('available', { availableVersion: '1.3.10' })

    expect(appUpdateBadgeLabel(state)).toBe('Update')
    expect(appUpdateNoticeLabel(state)).toBe('ZenNotes 1.3.10 is available')
    expect(appUpdatePrimaryActionLabel(state)).toBe('Download')
  })

  it('offers no action for a package-manager install, only the notice', () => {
    const state = updateState('available', { availableVersion: '1.3.10', installable: false })

    expect(appUpdateBadgeLabel(state)).toBe('Update')
    expect(appUpdateNoticeLabel(state)).toBe('ZenNotes 1.3.10 is available')
    expect(appUpdatePrimaryActionLabel(state)).toBeNull()
  })

  it('shows ready labels after an update downloads', () => {
    const state = updateState('downloaded', { availableVersion: '1.3.10' })

    expect(appUpdateBadgeLabel(state)).toBe('Ready')
    expect(appUpdateNoticeLabel(state)).toBe('ZenNotes 1.3.10 is ready')
    expect(appUpdatePrimaryActionLabel(state)).toBe('Relaunch')
  })

  it('shows download progress while the update is downloading', () => {
    const state = updateState('downloading', {
      availableVersion: '1.3.10',
      progressPercent: 42.4
    })

    expect(appUpdateBadgeLabel(state)).toBe('42%')
    expect(appUpdateNoticeLabel(state)).toBe('Downloading ZenNotes 1.3.10')
    expect(appUpdatePrimaryActionLabel(state)).toBeNull()
  })

  it('stays quiet when there is no update needing attention', () => {
    const state = updateState('not-available')

    expect(appUpdateBadgeLabel(state)).toBeNull()
    expect(appUpdateNoticeLabel(state)).toBeNull()
    expect(appUpdatePrimaryActionLabel(state)).toBeNull()
  })
})
