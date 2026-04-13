import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface PromptOptions {
  title: string
  description?: string
  initialValue?: string
  placeholder?: string
  okLabel?: string
  /** Return an error string to block submission, or null/undefined to allow. */
  validate?: (value: string) => string | null | undefined
}

/**
 * A themed, portalled prompt dialog. Returns the entered string, or
 * null if the user cancels. Designed to replace `window.prompt()`
 * (which is broken in Electron).
 */
export function PromptModal({
  options,
  onSubmit,
  onCancel
}: {
  options: PromptOptions
  onSubmit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState(options.initialValue ?? '')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setValue(options.initialValue ?? '')
    setError(null)
  }, [options.initialValue, options.title])

  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [])

  const submit = (): void => {
    const v = value.trim()
    if (!v) return
    const err = options.validate?.(v) ?? null
    if (err) {
      setError(err)
      return
    }
    onSubmit(v)
  }

  return createPortal(
    <div
      data-prompt-modal
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 pt-[18vh] backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[min(420px,92vw)] overflow-hidden rounded-xl bg-paper-100 shadow-float ring-1 ring-paper-300"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5">
          <div className="text-sm font-semibold text-ink-900">{options.title}</div>
          {options.description && (
            <div className="mt-1 text-xs text-ink-500">{options.description}</div>
          )}
        </div>
        <div className="px-5 pt-3">
          <input
            ref={inputRef}
            value={value}
            placeholder={options.placeholder}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
              }
            }}
            className="w-full rounded-md border border-paper-300 bg-paper-50 px-2.5 py-1.5 text-sm text-ink-900 outline-none focus:border-accent"
          />
          {error && (
            <div className="mt-2 text-xs" style={{ color: 'rgb(var(--z-red))' }}>
              {error}
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t border-paper-300/50 bg-paper-50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-paper-300 bg-paper-100 px-3 py-1.5 text-sm text-ink-800 hover:bg-paper-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-paper-50 hover:bg-ink-800"
          >
            {options.okLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * Hook that returns a `prompt(opts)` function returning a Promise
 * resolving to the string the user entered (or `null` if cancelled),
 * along with the modal element to render somewhere in the tree.
 */
export function usePrompt(): {
  prompt: (options: PromptOptions) => Promise<string | null>
  modal: JSX.Element | null
} {
  const [state, setState] = useState<{
    options: PromptOptions
    resolve: (v: string | null) => void
  } | null>(null)

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setState({ options, resolve })
      }),
    []
  )

  const modal = state ? (
    <PromptModal
      options={state.options}
      onSubmit={(v) => {
        const resolve = state.resolve
        setState(null)
        queueMicrotask(() => resolve(v))
      }}
      onCancel={() => {
        const resolve = state.resolve
        setState(null)
        queueMicrotask(() => resolve(null))
      }}
    />
  ) : null

  return { prompt, modal }
}
