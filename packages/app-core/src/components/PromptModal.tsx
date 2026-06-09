import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

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
  // Suggestions show automatically whenever there are matches; `dismissed`
  // hides them after Escape. `activeSuggestion` of -1 means the typed value is
  // selected (Enter submits it); 0..n highlights a suggestion (Enter picks it).
  const [dismissed, setDismissed] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
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

  const showSuggestions = !dismissed && filteredSuggestions.length > 0

  useEffect(() => {
    setValue(options.initialValue ?? '')
    setError(null)
    setDismissed(false)
    setActiveSuggestion(-1)
  }, [options.initialValue, options.title])

  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!showSuggestions || activeSuggestion < 0) return
    const el = suggestionsRef.current?.querySelector<HTMLElement>(
      `[data-prompt-suggestion-idx="${activeSuggestion}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeSuggestion, showSuggestions])

  const submit = (raw: string = value): void => {
    const v = raw.trim()
    if (!v && !options.allowEmptySubmit) return
    const err = options.validate?.(v) ?? null
    if (err) {
      setError(err)
      return
    }
    onSubmit(v)
  }

  // Picking a suggestion submits it directly (e.g. create in that folder).
  const chooseSuggestion = (next: PromptSuggestion): void => {
    setValue(next.value)
    setError(null)
    submit(next.value)
  }

  // Cycle through [typed value (-1), suggestion 0 … n-1] and wrap around.
  const moveSuggestion = (delta: number): void => {
    const n = filteredSuggestions.length
    if (n === 0) return
    setDismissed(false)
    setActiveSuggestion((prev) => {
      const next = (prev < 0 ? -1 : prev) + delta
      if (next < -1) return n - 1
      if (next >= n) return -1
      return next
    })
  }

  return (
    <Modal
      size="xs"
      layer="modal"
      onClose={onCancel}
      closeOnEsc={false}
      data={{ 'data-prompt-modal': '' }}
    >
      <Modal.Header title={options.title} description={options.description} />
      <div className="px-5 pt-3">
        <input
          ref={inputRef}
          value={value}
          placeholder={options.placeholder}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
            setActiveSuggestion(-1)
            setDismissed(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && filteredSuggestions.length > 0) {
              e.preventDefault()
              moveSuggestion(e.shiftKey ? -1 : 1)
            } else if (e.key === 'ArrowDown' && filteredSuggestions.length > 0) {
              e.preventDefault()
              moveSuggestion(1)
            } else if (e.key === 'ArrowUp' && filteredSuggestions.length > 0) {
              e.preventDefault()
              moveSuggestion(-1)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const suggestion =
                showSuggestions && activeSuggestion >= 0
                  ? filteredSuggestions[activeSuggestion]
                  : null
              if (suggestion) chooseSuggestion(suggestion)
              else submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              if (showSuggestions && !dismissed) {
                setDismissed(true)
                setActiveSuggestion(-1)
              } else {
                onCancel()
              }
            }
          }}
          className="w-full rounded-md border border-paper-300 bg-paper-50 px-2.5 py-1.5 text-sm text-ink-900 outline-none focus:border-accent"
        />
        {options.suggestionsHint && (
          <div className="mt-2 text-xs text-ink-400">{options.suggestionsHint}</div>
        )}
        {showSuggestions && (
          <div
            ref={suggestionsRef}
            className="mt-2 overflow-hidden rounded-lg border border-paper-300/70 bg-paper-50/95 shadow-[0_10px_30px_rgba(15,23,42,0.08)]"
          >
            <div className="form-label border-b border-paper-300/50 px-3 py-2">Suggestions</div>
            <div className="max-h-48 overflow-y-auto py-1">
              {filteredSuggestions.map((suggestion, index) => {
                const active = index === activeSuggestion
                return (
                  <button
                    key={suggestion.value}
                    type="button"
                    data-prompt-suggestion-idx={index}
                    onMouseEnter={() => setActiveSuggestion(index)}
                    onClick={() => chooseSuggestion(suggestion)}
                    className={[
                      'flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors',
                      active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                    ].join(' ')}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                      {suggestion.label ?? suggestion.value}
                    </span>
                    {suggestion.detail && (
                      <span className="shrink-0 text-xs text-ink-500">{suggestion.detail}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {error && <div className="mt-2 text-xs text-danger">{error}</div>}
      </div>
      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => submit()}>
          {options.okLabel ?? 'OK'}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
