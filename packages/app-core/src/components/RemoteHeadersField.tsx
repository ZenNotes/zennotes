import { useEffect, useRef, useState } from 'react'
import type { RemoteHeaderInput } from '@shared/ipc'
import { parseRemoteHeaders } from '@shared/remote-headers'

/** What a header box says to its form: the list to send, or why it cannot. */
export type RemoteHeadersDraft =
  | { ok: true; headers: RemoteHeaderInput[] }
  | { ok: false; error: string }

export function readRemoteHeadersDraft(text: string): RemoteHeadersDraft {
  return parseRemoteHeaders(text)
}

/** Whether this host sends extra headers at all (#1091). The phones share
 *  this UI and do not yet, so the field is hidden there. */
export function supportsRemoteHeaders(): boolean {
  return Boolean(window.zen.getCapabilities().supportsRemoteHeaders)
}

const PLACEHOLDER = 'CF-Access-Client-Id: <client id>\nCF-Access-Client-Secret: <client secret>'

/**
 * Extra request headers for a server behind an access gateway (#1091). Closed
 * until asked for, since most servers need none: a remote that already has
 * headers saved opens with their names listed. Enter adds a line, and
 * Cmd/Ctrl+Enter submits the form (`onSubmit`).
 */
export function RemoteHeadersField({
  value,
  onChange,
  onSubmit,
  savedNames = [],
  error
}: {
  value: string
  onChange: (value: string) => void
  onSubmit?: () => void
  savedNames?: readonly string[]
  error?: string | null
}): JSX.Element {
  const [open, setOpen] = useState(() => value.trim().length > 0 || savedNames.length > 0)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const focusOnOpen = useRef(false)

  useEffect(() => {
    if (open && focusOnOpen.current) {
      focusOnOpen.current = false
      areaRef.current?.focus()
    }
  }, [open])

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          focusOnOpen.current = true
          setOpen(true)
        }}
        className="text-xs text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline focus-visible:text-ink-800 focus-visible:underline focus-visible:outline-none"
      >
        Add extra headers
      </button>
    )
  }

  return (
    <label className="block">
      <div className="form-label mb-1">Extra headers</div>
      <textarea
        ref={areaRef}
        value={value}
        rows={3}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter writes the next header; the form's own Enter handlers must
          // not see it. Cmd/Ctrl+Enter is the way out of the box.
          if (e.key !== 'Enter') return
          e.stopPropagation()
          if ((e.metaKey || e.ctrlKey) && onSubmit) {
            e.preventDefault()
            onSubmit()
          }
        }}
        placeholder={PLACEHOLDER}
        className="w-full resize-y rounded-md border border-paper-300 bg-paper-50 px-3 py-2 font-mono text-xs leading-5 text-ink-900 outline-none placeholder:text-ink-400 focus:border-accent"
      />
      {error ? (
        <div className="mt-1 text-xs text-danger">{error}</div>
      ) : savedNames.length > 0 && !value.trim() ? (
        <div className="form-hint mt-1 leading-5">
          Saved: {savedNames.join(', ')}. Leave this blank to keep them, or enter new ones to replace them.
        </div>
      ) : (
        <div className="form-hint mt-1 leading-5">
          One <code className="font-mono">Name: value</code> per line, for a gateway such as Cloudflare Access.
        </div>
      )}
    </label>
  )
}
