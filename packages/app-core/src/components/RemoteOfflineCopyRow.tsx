import { useCallback, useEffect, useState } from 'react'
import type { RemoteOfflineCopyState } from '@shared/ipc'
import { getZenBridge } from '@zennotes/bridge-contract/bridge'
import { describeCloudError } from '@zennotes/shared-domain/cloud-error-copy'
import { formatCloudBytes } from '@zennotes/shared-domain/cloud-bytes'
import { REMOTE_MIRROR_NEEDS_SERVER_MESSAGE } from '@zennotes/shared-domain/remote-mirror-copy'
import { confirmApp } from '../lib/confirm-requests'
import { useStore } from '../store'
import { Button } from './ui/Button'

/** The desktop keeps offline copies; other hosts leave the row out. */
export function supportsRemoteOfflineCopy(): boolean {
  const bridge = getZenBridge()
  return typeof bridge.getRemoteOfflineCopy === 'function' && typeof bridge.setRemoteOfflineCopy === 'function'
}

/**
 * Asks before an offline copy holding changes the server has not taken is
 * removed. Resolves true when there is nothing to lose or the person chose
 * to lose it, and then `discardUnsynced` is what main needs to hear.
 */
export async function confirmRemoveOfflineCopy(
  state: RemoteOfflineCopyState | null,
  serverName: string
): Promise<boolean> {
  const pending = state?.status?.pendingChanges ?? 0
  if (pending === 0) return true
  return await confirmApp({
    title: 'Remove the offline copy?',
    description:
      pending === 1
        ? `1 change on this computer has not reached ${serverName}. Removing the offline copy deletes it.`
        : `${pending} changes on this computer have not reached ${serverName}. Removing the offline copy deletes them.`,
    cancelLabel: 'Keep Offline Copy',
    confirmLabel: 'Remove Anyway',
    danger: true
  })
}

/**
 * Keep an offline copy (#1108): the remote's row in its dialog. It acts at
 * once rather than on Save, because turning it on downloads the vault and
 * turning it off deletes the copy; neither belongs to the form's edits.
 */
export function RemoteOfflineCopyRow({
  profileId,
  serverName
}: {
  profileId: string
  serverName: string
}): JSX.Element | null {
  const [state, setState] = useState<RemoteOfflineCopyState | null>(null)
  const [busy, setBusy] = useState<'enable' | 'disable' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await getZenBridge().getRemoteOfflineCopy!(profileId))
    } catch (cause) {
      setError(describeCloudError(cause).message)
    }
  }, [profileId])

  useEffect(() => {
    void load()
  }, [load])

  /** A window on this remote follows the change at once: reconnecting opens
   *  the copy when it is on, and the server online when it is off. */
  const followInThisWindow = async (): Promise<void> => {
    const store = useStore.getState()
    const shownProfile = store.vault?.mirrorOf?.profileId ?? store.remoteWorkspaceInfo?.profileId ?? null
    if (shownProfile === profileId) await store.connectRemoteWorkspaceProfile(profileId)
  }

  const enable = async (): Promise<void> => {
    setBusy('enable')
    setError(null)
    try {
      setState(await getZenBridge().setRemoteOfflineCopy!(profileId, true))
      await followInThisWindow()
    } catch (cause) {
      setError(describeCloudError(cause).message)
      void load()
    } finally {
      setBusy(null)
    }
  }

  const disable = async (): Promise<void> => {
    if (!(await confirmRemoveOfflineCopy(state, serverName))) return
    setBusy('disable')
    setError(null)
    try {
      setState(await getZenBridge().setRemoteOfflineCopy!(profileId, false, { discardUnsynced: true }))
      await followInThisWindow()
    } catch (cause) {
      setError(describeCloudError(cause).message)
      void load()
    } finally {
      setBusy(null)
    }
  }

  if (!state && !error) {
    return <div className="form-hint leading-5">Checking whether this server can keep an offline copy…</div>
  }
  const enabled = state?.enabled === true
  const unsupported = state?.supported === false && !enabled
  const unknown = state?.supported === null && !enabled
  const disabled = busy !== null || unsupported || unknown

  return (
    <div data-remote-offline-copy className="space-y-2">
      <label className={`flex items-start gap-2 ${disabled && !enabled ? 'opacity-60' : ''}`}>
        <input
          type="checkbox"
          data-remote-offline-copy-toggle
          checked={enabled || busy === 'enable'}
          disabled={disabled}
          onChange={(event) => void (event.target.checked ? enable() : disable())}
          className="mt-0.5 h-3.5 w-3.5 rounded border-paper-300 bg-paper-50 text-accent focus:ring-accent"
        />
        <span>
          <span className="form-label block">Keep an offline copy</span>
          <span className="form-hint block leading-5">
            {unsupported
              ? REMOTE_MIRROR_NEEDS_SERVER_MESSAGE
              : unknown
                ? 'Connect to this server once to turn this on.'
                : busy === 'enable'
                  ? 'Downloading the offline copy…'
                  : 'Notes open and save on this computer when the server is away.'}
          </span>
        </span>
      </label>
      {enabled && state?.status && (
        <div className="flex items-center justify-between gap-3 pl-5">
          <span data-remote-offline-copy-size className="form-hint leading-5">
            Uses {formatCloudBytes(state.status.sizeBytes)} on this computer.
          </span>
          <Button
            variant="secondary"
            size="sm"
            data-remote-offline-copy-remove
            disabled={busy !== null}
            onClick={() => void disable()}
          >
            Remove offline copy
          </Button>
        </div>
      )}
      {error && <div className="pl-5 text-xs text-danger">{error}</div>}
    </div>
  )
}
