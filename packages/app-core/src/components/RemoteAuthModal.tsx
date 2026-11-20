import { useRef, useState } from 'react'
import { isImeComposing } from '../lib/ime'
import type { RemoteAuthAnswer } from '../lib/remote-auth-requests'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { RemoteHeadersField, readRemoteHeadersDraft } from './RemoteHeadersField'

/**
 * The Auth Token step of Connect to Remote Vault on a host that sends extra
 * headers (#1091). It reads as the old one-field step until "Add extra
 * headers" is chosen, so a server without a gateway costs nothing more.
 */
export function RemoteAuthModal({
  onSubmit,
  onCancel
}: {
  onSubmit: (value: RemoteAuthAnswer) => void
  onCancel: () => void
}): JSX.Element {
  const [authToken, setAuthToken] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [headersError, setHeadersError] = useState<string | null>(null)
  const tokenRef = useRef<HTMLInputElement | null>(null)

  const submit = (): void => {
    const draft = readRemoteHeadersDraft(headersText)
    if (!draft.ok) {
      setHeadersError(draft.error)
      return
    }
    onSubmit({ authToken: authToken.trim(), headers: draft.headers })
  }

  return (
    <Modal size="md" onClose={onCancel} initialFocus={tokenRef}>
      <Modal.Header
        title="Auth Token"
        description="The server's auth token. Leave blank if it doesn't need one."
      />
      <div className="space-y-3 px-5 pt-3">
        <input
          ref={tokenRef}
          value={authToken}
          placeholder="Optional"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setAuthToken(e.target.value)}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          className="w-full rounded-md border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent"
        />
        <RemoteHeadersField
          value={headersText}
          onChange={(value) => {
            setHeadersText(value)
            setHeadersError(null)
          }}
          onSubmit={submit}
          error={headersError}
        />
      </div>
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit}>
          Connect
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
