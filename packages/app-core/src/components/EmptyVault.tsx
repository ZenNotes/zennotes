import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { EnsoLogo } from './EnsoLogo'

export function EmptyVault(): JSX.Element {
  const openVaultPicker = useStore((s) => s.openVaultPicker)
  const connectRemoteWorkspace = useStore((s) => s.connectRemoteWorkspace)
  const workspaceSetupError = useStore((s) => s.workspaceSetupError)
  const capabilities = window.zen.getCapabilities()
  const appInfo = window.zen.getAppInfo()
  const isServerVaultSetup =
    appInfo.runtime === 'web' && !capabilities.supportsLocalFilesystemPickers
  const canConnectRemote = appInfo.runtime === 'desktop' && capabilities.supportsRemoteWorkspace
  const [appIconUrl, setAppIconUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.zen.getAppIconDataUrl().then((url) => {
      if (!cancelled) setAppIconUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex h-[calc(100vh-2.75rem)] items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        {appIconUrl ? (
          <img
            src={appIconUrl}
            alt="ZenNotes app icon"
            className="h-[72px] w-[72px] rounded-[18px] shadow-panel"
          />
        ) : (
          <EnsoLogo size={72} className="drop-shadow-panel" />
        )}
        <div>
          <h1 className="font-serif text-2xl font-semibold text-ink-900">Welcome to ZenNotes</h1>
          <p className="mt-2 text-sm text-ink-600">
            {isServerVaultSetup
              ? 'Choose the vault directory on the server running ZenNotes. The normal self-hosted path is `make up`, which serves the browser app and server together.'
              : 'Choose a folder on your computer to use as your vault. ZenNotes will store your notes there as plain markdown files — yours to keep, back up, and sync any way you like.'}
          </p>
          {isServerVaultSetup && (
            <p className="mt-2 text-xs text-ink-500">
              If you are using the web dev server, you also need{' '}
              <code className="rounded bg-paper-200 px-1 py-0.5">npm run dev:server</code>. You can
              also preconfigure the vault on the server with{' '}
              <code className="rounded bg-paper-200 px-1 py-0.5">ZENNOTES_VAULT_PATH</code>.
            </p>
          )}
          {canConnectRemote && (
            <p className="mt-2 text-xs text-ink-500">
              You can open a local vault on this machine or connect the desktop app to a ZenNotes
              server.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={() => void openVaultPicker()}
            className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-paper-50 shadow-panel hover:bg-ink-800"
          >
            {isServerVaultSetup ? 'Connect to server vault' : 'Choose vault folder'}
          </button>
          {canConnectRemote && (
            <button
              onClick={() => void connectRemoteWorkspace()}
              className="rounded-lg border border-paper-300 bg-paper-100 px-4 py-2 text-sm font-medium text-ink-900 shadow-panel hover:bg-paper-200"
            >
              Connect to ZenNotes Server
            </button>
          )}
        </div>
        {workspaceSetupError && (
          <p className="max-w-lg text-sm text-[rgb(var(--z-red))]">{workspaceSetupError}</p>
        )}
      </div>
    </div>
  )
}
