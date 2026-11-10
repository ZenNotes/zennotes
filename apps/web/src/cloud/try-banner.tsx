/**
 * Try mode's banner: where the notes are, and the ways out with them. It sits
 * above the app in its own root (#zn-host-banner, laid out by cloud.css), so
 * app-core is unchanged. Built from app-core's Button and design tokens.
 * "Keep it in ZenNotes Cloud" signs in (or uses the account signed in) and
 * puts the vault in a new Cloud vault; the palette has it too.
 */
import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Button } from '@renderer/components/ui/Button'

/** WebKit's tracking prevention deletes a site's storage after seven days
 *  without a visit unless it is a Home Screen web app. Every iPhone browser
 *  is WebKit, so this is Safari's rule on iOS whatever the browser is called. */
export function isWebKitBrowser(userAgent = navigator.userAgent): boolean {
  return /AppleWebKit\//.test(userAgent) && !/(Chrome|Chromium|Edg|OPR)\//.test(userAgent)
}

export interface TryBannerActions {
  onDownload: () => Promise<void>
  onKeep: () => Promise<void>
}

function TryBanner({ onDownload, onKeep }: TryBannerActions): JSX.Element {
  const [busy, setBusy] = useState<'download' | 'keep' | null>(null)
  const webkit = isWebKitBrowser()
  const run = (which: 'download' | 'keep', action: () => Promise<void>): void => {
    if (busy) return
    setBusy(which)
    void action().finally(() => setBusy(null))
  }
  return (
    <div
      role="region"
      aria-label="Try ZenNotes"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-paper-300 bg-paper-200 px-4 py-1.5 text-sm text-ink-700"
    >
      <p className="min-w-0 flex-1">
        <span className="font-medium text-ink-900">This vault lives only in this browser.</span>{' '}
        {webkit
          ? 'Safari may clear it after a week without a visit. Keep it in ZenNotes Cloud, or download it.'
          : 'Keep it in ZenNotes Cloud to have it everywhere, or download it as a folder.'}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => run('keep', onKeep)}>
          {busy === 'keep' ? 'Opening ZenNotes Cloud…' : 'Keep it in ZenNotes Cloud'}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => run('download', onDownload)}>
          {busy === 'download' ? 'Preparing…' : 'Download as a folder'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => window.open('https://zennotes.org/#download', '_blank', 'noopener,noreferrer')}
        >
          Get the apps
        </Button>
      </div>
    </div>
  )
}

let bannerRoot: ReactDOM.Root | null = null

export function renderTryBanner(container: HTMLElement, actions: TryBannerActions): void {
  document.body.dataset.znHostBanner = 'try'
  bannerRoot ??= ReactDOM.createRoot(container)
  bannerRoot.render(
    <React.StrictMode>
      <TryBanner {...actions} />
    </React.StrictMode>
  )
}

/** The vault was kept in Cloud: it is no longer only in this browser. */
export function removeTryBanner(_container: HTMLElement): void {
  bannerRoot?.unmount()
  bannerRoot = null
  delete document.body.dataset.znHostBanner
}
