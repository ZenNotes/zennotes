/**
 * The banner of a shared computer's session: sign-out is the one thing the
 * person must not forget, so it stays in view (#zn-host-banner, as Try mode's
 * banner). The palette has the same action.
 */
import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Button } from '@renderer/components/ui/Button'

function SharedBanner({ onSignOut }: { onSignOut: () => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const signOut = (): void => {
    if (busy) return
    setBusy(true)
    void onSignOut().finally(() => setBusy(false))
  }
  return (
    <div
      role="region"
      aria-label="Shared computer"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-paper-300 bg-paper-200 px-4 py-1.5 text-sm text-ink-700"
    >
      <p className="min-w-0 flex-1">
        <span className="font-medium text-ink-900">Shared computer.</span> Sign out when you finish to remove your
        notes from this browser.
      </p>
      <Button variant="primary" size="sm" disabled={busy} onClick={signOut}>
        {busy ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  )
}

export function renderSharedBanner(container: HTMLElement, onSignOut: () => Promise<void>): void {
  document.body.dataset.znHostBanner = 'shared'
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <SharedBanner onSignOut={onSignOut} />
    </React.StrictMode>
  )
}
