import { useCallback, useEffect, useMemo, useState } from 'react'
import { isImeComposing } from '../lib/ime'
import type { RemoteWorkspaceProfileInput } from '@shared/ipc'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import {
  RemoteHeadersField,
  readRemoteHeadersDraft,
  supportsRemoteHeaders
} from './RemoteHeadersField'
import { RemoteOfflineCopyRow, supportsRemoteOfflineCopy } from './RemoteOfflineCopyRow'

export interface RemoteWorkspaceProfileModalOptions {
  title: string
  description?: string
  initialValue?: RemoteWorkspaceProfileInput
  hasStoredCredential?: boolean
  /** Names of the extra headers already saved for this remote (#1091). */
  storedHeaderNames?: string[]
  submitLabel?: string
}

export function RemoteWorkspaceProfileModal({
  options,
  onSubmit,
  onCancel
}: {
  options: RemoteWorkspaceProfileModalOptions
  onSubmit: (value: RemoteWorkspaceProfileInput) => Promise<void> | void
  onCancel: () => void
}): JSX.Element {
  const [name, setName] = useState(options.initialValue?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(options.initialValue?.baseUrl ?? 'http://localhost:7878')
  const [authToken, setAuthToken] = useState(options.initialValue?.authToken ?? '')
  const [vaultPath, setVaultPath] = useState(options.initialValue?.vaultPath ?? '')
  const [clearAuthToken, setClearAuthToken] = useState(false)
  const [headersText, setHeadersText] = useState('')
  const [clearHeaders, setClearHeaders] = useState(false)
  const [headersError, setHeadersError] = useState<string | null>(null)
  const showHeaders = useMemo(() => supportsRemoteHeaders(), [])
  // A saved remote only: the copy is kept per remote, and a new one has none.
  const savedProfileId = options.initialValue?.id ?? null
  const showOfflineCopy = useMemo(() => savedProfileId !== null && supportsRemoteOfflineCopy(), [savedProfileId])
  const storedHeaderNames = options.storedHeaderNames ?? []
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setName(options.initialValue?.name ?? '')
    setBaseUrl(options.initialValue?.baseUrl ?? 'http://localhost:7878')
    setAuthToken(options.initialValue?.authToken ?? '')
    setVaultPath(options.initialValue?.vaultPath ?? '')
    setClearAuthToken(false)
    setHeadersText('')
    setClearHeaders(false)
    setHeadersError(null)
    setError(null)
    setSubmitting(false)
  }, [options.initialValue, options.title])

  const normalizedBaseUrl = useMemo(() => {
    const trimmed = baseUrl.trim()
    if (!trimmed) return ''
    return /^https?:\/\//i.test(trimmed) ? trimmed.replace(/\/+$/, '') : `http://${trimmed.replace(/\/+$/, '')}`
  }, [baseUrl])

  const submit = useCallback(async (): Promise<void> => {
    if (submitting) return
    const trimmedName = name.trim()
    if (!normalizedBaseUrl) {
      setError('Enter a server URL.')
      return
    }
    try {
      // eslint-disable-next-line no-new
      new URL(normalizedBaseUrl)
    } catch {
      setError('Enter a valid server URL.')
      return
    }
    // New lines replace the saved headers; a blank box keeps them, unless
    // the remove box is ticked. Mirrors the auth token just above.
    let headers: RemoteWorkspaceProfileInput['headers']
    if (showHeaders) {
      const draft = readRemoteHeadersDraft(headersText)
      if (!draft.ok) {
        setHeadersError(draft.error)
        return
      }
      if (draft.headers.length > 0) headers = draft.headers
      else if (clearHeaders) headers = []
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        id: options.initialValue?.id,
        baseUrl: normalizedBaseUrl,
        authToken: authToken.trim() || null,
        clearAuthToken: clearAuthToken && !authToken.trim(),
        ...(headers !== undefined ? { headers } : {}),
        vaultPath: vaultPath.trim() || null,
        ...(trimmedName ? { name: trimmedName } : {})
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }, [
    authToken,
    clearAuthToken,
    clearHeaders,
    headersText,
    name,
    normalizedBaseUrl,
    onSubmit,
    options.initialValue?.id,
    showHeaders,
    submitting,
    vaultPath
  ])

  // Esc handled by Modal; we keep Enter (→ submit) here. closeOnEsc stays true.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // While composing (IME), let the input own Enter/Arrows. (#183)
      if (isImeComposing(e)) return
      // The headers box takes Enter for its next line and submits on
      // Cmd/Ctrl+Enter itself. This listener runs first (capture), so it has
      // to step aside rather than rely on the box stopping the event.
      if (e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        void submit()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [submit])

  return (
    // Opened from within the workspace switcher (atop other chrome) → nested layer.
    <Modal size="md" layer="nested" onClose={onCancel}>
      <Modal.Header title={options.title} description={options.description} />
      <div className="space-y-4 px-5 py-4">
        <label className="block">
          <div className="form-label mb-1">Label</div>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            placeholder="Optional. Example: Home Server"
            className="w-full rounded-md border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent"
          />
          <div className="form-hint mt-1 leading-5">
            Leave this blank if you want ZenNotes to name the remote from the server or vault.
          </div>
        </label>
        <label className="block">
          <div className="form-label mb-1">Server URL</div>
          <input
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value)
              setError(null)
            }}
            placeholder="http://localhost:7878"
            className="w-full rounded-md border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <div className="form-label mb-1">Auth token</div>
          <input
            value={authToken}
            onChange={(e) => {
              setAuthToken(e.target.value)
              setError(null)
            }}
            placeholder="Optional"
            className="w-full rounded-md border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent"
          />
          {options.hasStoredCredential && !authToken.trim() && (
            <div className="form-hint mt-1 leading-5">
              A token is already stored securely for this remote. Leave this blank to keep it, or enter a new one to replace it.
            </div>
          )}
          {options.hasStoredCredential && (
            <label className="mt-2 flex items-center gap-2 text-xs text-ink-500">
              <input
                type="checkbox"
                checked={clearAuthToken}
                onChange={(e) => {
                  setClearAuthToken(e.target.checked)
                  setError(null)
                }}
                className="h-3.5 w-3.5 rounded border-paper-300 bg-paper-50 text-accent focus:ring-accent"
              />
              Clear the stored token for this remote
            </label>
          )}
        </label>
        {showHeaders && (
          <div>
            <RemoteHeadersField
              key={`${options.title}:${options.initialValue?.id ?? ''}`}
              value={headersText}
              onChange={(value) => {
                setHeadersText(value)
                setHeadersError(null)
                setError(null)
              }}
              onSubmit={() => void submit()}
              savedNames={storedHeaderNames}
              error={headersError}
            />
            {storedHeaderNames.length > 0 && (
              <label className="mt-2 flex items-center gap-2 text-xs text-ink-500">
                <input
                  type="checkbox"
                  checked={clearHeaders}
                  onChange={(e) => {
                    setClearHeaders(e.target.checked)
                    setError(null)
                  }}
                  className="h-3.5 w-3.5 rounded border-paper-300 bg-paper-50 text-accent focus:ring-accent"
                />
                Remove the saved headers for this remote
              </label>
            )}
          </div>
        )}
        <label className="block">
          <div className="form-label mb-1">Vault folder</div>
          <input
            value={vaultPath}
            onChange={(e) => {
              setVaultPath(e.target.value)
              setError(null)
            }}
            placeholder="Optional. If blank, ZenNotes will ask when you connect."
            className="w-full rounded-md border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent"
          />
          <div className="form-hint mt-1 leading-5">
            Leave this blank if you want to choose the vault folder when you connect.
          </div>
        </label>
        {showOfflineCopy && savedProfileId && (
          <RemoteOfflineCopyRow
            profileId={savedProfileId}
            serverName={options.initialValue?.name?.trim() || normalizedBaseUrl}
          />
        )}
        {error && <div className="text-xs text-danger">{error}</div>}
      </div>
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={submitting} onClick={() => void submit()}>
          {options.submitLabel ?? 'Save'}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
