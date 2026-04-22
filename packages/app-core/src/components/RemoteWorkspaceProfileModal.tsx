import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RemoteWorkspaceProfileInput } from '@shared/ipc'

export interface RemoteWorkspaceProfileModalOptions {
  title: string
  description?: string
  initialValue?: RemoteWorkspaceProfileInput
  hasStoredCredential?: boolean
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
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setName(options.initialValue?.name ?? '')
    setBaseUrl(options.initialValue?.baseUrl ?? 'http://localhost:7878')
    setAuthToken(options.initialValue?.authToken ?? '')
    setVaultPath(options.initialValue?.vaultPath ?? '')
    setClearAuthToken(false)
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
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        id: options.initialValue?.id,
        baseUrl: normalizedBaseUrl,
        authToken: authToken.trim() || null,
        clearAuthToken: clearAuthToken && !authToken.trim(),
        vaultPath: vaultPath.trim() || null,
        ...(trimmedName ? { name: trimmedName } : {})
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }, [authToken, clearAuthToken, name, normalizedBaseUrl, onSubmit, options.initialValue?.id, submitting, vaultPath])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        void submit()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onCancel, submit])

  return createPortal(
    <div
      className="fixed inset-0 z-[74] flex items-start justify-center bg-black/45 pt-[14vh] backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[min(520px,94vw)] overflow-hidden rounded-xl bg-paper-100 shadow-float ring-1 ring-paper-300"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5">
          <div className="text-sm font-semibold text-ink-900">{options.title}</div>
          {options.description && (
            <div className="mt-1 text-xs leading-5 text-ink-500">{options.description}</div>
          )}
        </div>
        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-400">
              Label
            </div>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              placeholder="Optional. Example: Home Server"
              className="w-full rounded-md border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent"
            />
            <div className="mt-1 text-[11px] leading-5 text-ink-400">
              Leave this blank if you want ZenNotes to name the remote from the server or vault.
            </div>
          </label>
          <label className="block">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-400">
              Server URL
            </div>
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
            <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-400">
              Auth token
            </div>
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
              <div className="mt-1 text-[11px] leading-5 text-ink-400">
                A token is already stored securely for this remote. Leave this blank to keep it, or enter a new one to replace it.
              </div>
            )}
            {options.hasStoredCredential && (
              <label className="mt-2 flex items-center gap-2 text-[11px] text-ink-500">
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
          <label className="block">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-400">
              Vault folder
            </div>
            <input
              value={vaultPath}
              onChange={(e) => {
                setVaultPath(e.target.value)
                setError(null)
              }}
              placeholder="Optional. If blank, ZenNotes will ask when you connect."
              className="w-full rounded-md border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 outline-none focus:border-accent"
            />
            <div className="mt-1 text-[11px] leading-5 text-ink-400">
              Leave this blank if you want to choose the vault folder when you connect.
            </div>
          </label>
          {error && <div className="text-xs text-red-700">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-paper-300/50 bg-paper-50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-paper-300 bg-paper-100 px-3 py-1.5 text-sm text-ink-800 hover:bg-paper-200"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-paper-50 hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {options.submitLabel ?? 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
