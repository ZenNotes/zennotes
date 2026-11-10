/**
 * Try mode's banner: where the notes are, and the way out with them. It sits
 * above the app in its own root (#zn-host-banner, laid out by cloud.css), so
 * app-core is unchanged. Built from app-core's Button and design tokens.
 * "Keep it in ZenNotes Cloud" joins it in Phase 4, when the browser can sign
 * in.
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

function TryBanner({ onDownload }: { onDownload: () => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const webkit = isWebKitBrowser()
  const download = (): void => {
    if (busy) return
    setBusy(true)
    void onDownload().finally(() => setBusy(false))
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
          ? 'Safari may clear it after a week without a visit, so download it to keep it.'
          : 'Download it as a folder to keep it, or get the app.'}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={download}>
          {busy ? 'Preparing…' : 'Download as a folder'}
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

export function renderTryBanner(container: HTMLElement, onDownload: () => Promise<void>): void {
  document.body.dataset.znHostBanner = 'try'
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <TryBanner onDownload={onDownload} />
    </React.StrictMode>
  )
}
