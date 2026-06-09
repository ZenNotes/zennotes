import { useStore } from '../store'
import { Button } from './ui/Button'
import appIcon from '../assets/zennotes-app-icon.png'

export function EmptyVault(): JSX.Element {
  const openVaultPicker = useStore((s) => s.openVaultPicker)
  const connectRemoteWorkspace = useStore((s) => s.connectRemoteWorkspace)
  const workspaceSetupError = useStore((s) => s.workspaceSetupError)
  const capabilities = window.zen.getCapabilities()
  const appInfo = window.zen.getAppInfo()
  const isServerVaultSetup =
    appInfo.runtime === 'web' && !capabilities.supportsLocalFilesystemPickers
  const canConnectRemote = appInfo.runtime === 'desktop' && capabilities.supportsRemoteWorkspace

  return (
    <div className="flex h-[calc(100vh-2.75rem)] items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <img
          src={appIcon}
          alt="ZenNotes app icon"
          className="h-[72px] w-[72px] rounded-2xl shadow-panel"
        />
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
          <Button
            variant="primary"
            size="md"
            onClick={() => void openVaultPicker()}
            className="shadow-panel"
          >
            {isServerVaultSetup ? 'Connect to server vault' : 'Choose vault folder'}
          </Button>
          {canConnectRemote && (
            <Button
              variant="secondary"
              size="md"
              onClick={() => void connectRemoteWorkspace()}
              className="shadow-panel"
            >
              Connect to ZenNotes Server
            </Button>
          )}
        </div>
        {workspaceSetupError && (
          <p className="max-w-lg text-sm text-[rgb(var(--z-red))]">{workspaceSetupError}</p>
        )}
      </div>
    </div>
  )
}
