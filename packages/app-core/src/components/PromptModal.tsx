import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface PromptSuggestion {
  value: string
  label?: string
  detail?: string
}

export interface PromptOptions {
  title: string
  description?: string
  initialValue?: string
  placeholder?: string
  okLabel?: string
  allowEmptySubmit?: boolean
  suggestions?: PromptSuggestion[]
  suggestionsHint?: string
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
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const suggestionsRef = useRef<HTMLDivElement | null>(null)

  const filteredSuggestions = useMemo(() => {
    const suggestions = options.suggestions ?? []
    if (suggestions.length === 0) return []
    const query = value.trim().toLowerCase().replace(/\\/g, '/')
    const scored = suggestions
      .map((suggestion, index) => {
        const label = (suggestion.label ?? suggestion.value).toLowerCase()
        const target = suggestion.value.toLowerCase()
        let rank = 0
        if (!query) {
          rank = 4
        } else if (target === query) {
          rank = 0
        } else if (target.startsWith(query)) {
          rank = 1
        } else if (label.startsWith(query)) {
          rank = 2
        } else if (target.includes(query) || label.includes(query)) {
          rank = 3
        } else {
          return null
        }
        return { suggestion, rank, index }
      })
      .filter((entry): entry is { suggestion: PromptSuggestion; rank: number; index: number } => !!entry)
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
    return scored.map((entry) => entry.suggestion).slice(0, 8)
  }, [options.suggestions, value])

  const showSuggestions = suggestionsOpen && filteredSuggestions.length > 0

  useEffect(() => {
    setValue(options.initialValue ?? '')
    setError(null)
    setSuggestionsOpen(false)
    setActiveSuggestion(0)
  }, [options.initialValue, options.title])

  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!showSuggestions) return
    const el = suggestionsRef.current?.querySelector<HTMLElement>(
      `[data-prompt-suggestion-idx="${activeSuggestion}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeSuggestion, showSuggestions])

  const submit = (): void => {
    const v = value.trim()
    if (!v && !options.allowEmptySubmit) return
    const err = options.validate?.(v) ?? null
    if (err) {
      setError(err)
      return
    }
    onSubmit(v)
  }

  const applySuggestion = (next: PromptSuggestion): void => {
    setValue(next.value)
    setError(null)
    setSuggestionsOpen(false)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      const len = next.value.length
      inputRef.current?.setSelectionRange(len, len)
    })
  }

  const moveSuggestion = (delta: number): void => {
    if (filteredSuggestions.length === 0) return
    setSuggestionsOpen(true)
    setActiveSuggestion((prev) => {
      const base = suggestionsOpen ? prev : delta > 0 ? -1 : 0
      return (base + delta + filteredSuggestions.length) % filteredSuggestions.length
    })
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
              if (suggestionsOpen) setActiveSuggestion(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && filteredSuggestions.length > 0) {
                e.preventDefault()
                if (!suggestionsOpen) {
                  setSuggestionsOpen(true)
                  setActiveSuggestion(0)
                } else {
                  moveSuggestion(e.shiftKey ? -1 : 1)
                }
              } else if (e.key === 'ArrowDown' && filteredSuggestions.length > 0) {
                e.preventDefault()
                moveSuggestion(1)
              } else if (e.key === 'ArrowUp' && filteredSuggestions.length > 0) {
                e.preventDefault()
                moveSuggestion(-1)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (showSuggestions) {
                  const suggestion = filteredSuggestions[activeSuggestion]
                  if (suggestion && suggestion.value !== value.trim()) {
                    applySuggestion(suggestion)
                    return
                  }
                }
                submit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                if (showSuggestions) {
                  setSuggestionsOpen(false)
                } else {
                  onCancel()
                }
              }
            }}
            className="w-full rounded-md border border-paper-300 bg-paper-50 px-2.5 py-1.5 text-sm text-ink-900 outline-none focus:border-accent"
          />
          {options.suggestionsHint && (
            <div className="mt-2 text-[11px] text-ink-400">{options.suggestionsHint}</div>
          )}
          {showSuggestions && (
            <div
              ref={suggestionsRef}
              className="mt-2 overflow-hidden rounded-lg border border-paper-300/70 bg-paper-50/95 shadow-[0_10px_30px_rgba(15,23,42,0.08)]"
            >
              <div className="border-b border-paper-300/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-ink-400">
                Suggestions
              </div>
              <div className="max-h-48 overflow-y-auto py-1">
                {filteredSuggestions.map((suggestion, index) => {
                  const active = index === activeSuggestion
                  return (
                    <button
                      key={suggestion.value}
                      type="button"
                      data-prompt-suggestion-idx={index}
                      onMouseEnter={() => setActiveSuggestion(index)}
                      onClick={() => applySuggestion(suggestion)}
                      className={[
                        'flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors',
                        active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                      ].join(' ')}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                        {suggestion.label ?? suggestion.value}
                      </span>
                      {suggestion.detail && (
                        <span className="shrink-0 text-[11px] text-ink-400">{suggestion.detail}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
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
