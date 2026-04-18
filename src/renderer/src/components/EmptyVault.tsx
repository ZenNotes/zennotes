import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { EnsoLogo } from './EnsoLogo'

export function EmptyVault(): JSX.Element {
  const openVaultPicker = useStore((s) => s.openVaultPicker)
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
            Choose a folder on your computer to use as your vault. ZenNotes will store your notes
            there as plain markdown files — yours to keep, back up, and sync any way you like.
          </p>
        </div>
        <button
          onClick={() => void openVaultPicker()}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-paper-50 shadow-panel hover:bg-ink-800"
        >
          Choose vault folder
        </button>
      </div>
    </div>
  )
}
