/**
 * Space-t / :template / :tmpl → a searchable list of every note template
 * (built-in + custom). Styled to match BufferPalette/SearchPalette so the
 * template picker feels like the same overlay with a different source.
 *
 * Selecting an entry creates a new note from that template, substituting
 * variables and placing the caret at the template's `{{cursor}}` marker.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { rankItems } from '../lib/fuzzy-score'
import { isPaletteNextKey, isPalettePreviousKey } from '../lib/palette-nav'
import { focusEditorNormalMode } from '../lib/editor-focus'
import { BUILTIN_TEMPLATES } from '@shared/builtin-templates'
import { mergeTemplates } from '@shared/template-files'
import type { NoteTemplate } from '@bridge-contract/templates'
import { Modal } from './ui/Modal'

export function TemplatePalette(): JSX.Element {
  const setOpen = useStore((s) => s.setTemplatePaletteOpen)
  const createFromTemplate = useStore((s) => s.createFromTemplate)
  const customTemplates = useStore((s) => s.customTemplates)
  const mode = useStore((s) => s.templatePaletteMode)

  const templates = useMemo(
    () => mergeTemplates(BUILTIN_TEMPLATES, customTemplates),
    [customTemplates]
  )

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const results = useMemo<NoteTemplate[]>(
    () =>
      rankItems(templates, query, [
        { get: (t) => t.name, weight: 1 },
        { get: (t) => t.description, weight: 0.8 },
        { get: (t) => t.category, weight: 0.5 }
      ]),
    [templates, query]
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-tmpl-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (template: NoteTemplate): void => {
    const state = useStore.getState()
    setOpen(false)
    if (state.templatePaletteMode === 'insert') {
      // Render the template into the note you're already in.
      state.insertTemplateIntoActiveNote(template)
      return
    }
    // A folder-scoped open (right-click) carries a target; a generic open
    // (Space t / command palette) has none, so createFromTemplate prompts.
    void createFromTemplate(template, state.templatePaletteTarget ?? undefined)
  }

  const close = (): void => {
    setOpen(false)
    focusEditorNormalMode()
  }

  return (
    <Modal size="md" layer="palette" onClose={close} closeOnEsc={false}>
      <div className="border-b border-paper-300/70 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            placeholder={mode === 'insert' ? 'Insert template into note…' : 'Create note from template…'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (isPaletteNextKey(e)) {
                e.preventDefault()
                setActive((a) => Math.min(results.length - 1, a + 1))
              } else if (isPalettePreviousKey(e)) {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const template = results[active]
                if (template) choose(template)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                close()
              }
            }}
            className="w-full bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-x-hidden overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-ink-400">No matching templates.</div>
          ) : (
            results.map((template, i) => (
              <button
                key={template.id}
                data-tmpl-idx={i}
                onClick={() => choose(template)}
                onMouseMove={() => setActive(i)}
                className={[
                  'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                  i === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                ].join(' ')}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-ink-900">{template.name}</span>
                  {template.description && (
                    <span className="truncate text-xs text-ink-400">{template.description}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs uppercase tracking-wide text-ink-400">
                  {template.category}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="flex items-center justify-end gap-4 border-t border-paper-300/70 bg-paper-100 px-4 py-2 text-xs text-ink-500">
          <span>
            <kbd className="rounded bg-paper-200 px-1">↑↓</kbd>{' '}
            <kbd className="rounded bg-paper-200 px-1">Ctrl+N/P</kbd> move
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">↵</kbd> create
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd> close
          </span>
        </div>
    </Modal>
  )
}
