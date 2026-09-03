import { useEffect, useState } from 'react'
import type { AppUpdateState } from '@shared/ipc'
import { getZenBridge } from '@zennotes/bridge-contract/bridge'

export function useAppUpdateState(): AppUpdateState | null {
  const [state, setState] = useState<AppUpdateState | null>(null)

  useEffect(() => {
    const zen = getZenBridge()
    let cancelled = false

    void zen.getAppUpdateState().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      () => {
        if (!cancelled) setState(null)
      }
    )

    const unsubscribe = zen.onAppUpdateState((next) => {
      if (!cancelled) setState(next)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return state
}

export function appUpdateBadgeLabel(state: AppUpdateState | null): string | null {
  switch (state?.phase) {
    case 'available':
      return 'Update'
    case 'downloaded':
      return 'Ready'
    case 'downloading':
      return `${Math.round(state.progressPercent ?? 0)}%`
    default:
      return null
  }
}

export function appUpdateNoticeLabel(state: AppUpdateState | null): string | null {
  switch (state?.phase) {
    case 'available':
      return `ZenNotes ${state.availableVersion ?? 'update'} is available`
    case 'downloaded':
      return `ZenNotes ${state.availableVersion ?? 'update'} is ready`
    case 'downloading':
      return `Downloading ZenNotes ${state.availableVersion ?? 'update'}`
    default:
      return null
  }
}

export function appUpdatePrimaryActionLabel(state: AppUpdateState | null): string | null {
  // A package-manager install (AUR, a tarball) is only told that a version
  // exists; there is nothing the app can download for it.
  if (state && state.installable === false) return null
  switch (state?.phase) {
    case 'available':
      return 'Download'
    case 'downloaded':
      return 'Relaunch'
    default:
      return null
  }
}
