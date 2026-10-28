import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { NoteMeta } from '@shared/ipc'
import { isExcalidrawPath, isObsidianExcalidrawPath } from '@shared/excalidraw'
import { rankItems } from '../lib/fuzzy-score'
import { isPaletteNextKey, isPalettePreviousKey } from '../lib/palette-nav'
import { isImeComposing } from '../lib/ime'
import { focusEditorAfterPaletteClose, focusEditorNormalMode } from '../lib/editor-focus'
import { Modal } from './ui/Modal'

/**
 * "Embed existing drawing" picker. Lists every Excalidraw drawing in the vault
 * (native `.excalidraw` plus Obsidian `.excalidraw.md`) and inserts an
 * `![[path]]` embed at the cursor in the active note when chosen.
 */
export function EmbedDrawingPalette(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const setOpen = useStore((s) => s.setEmbedDrawingPaletteOpen)
  const insertEmbedAtCursor = useStore((s) => s.insertEmbedAtCursor)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const drawings = useMemo(
    () => notes.filter((n) => isExcalidrawPath(n.path) || isObsidianExcalidrawPath(n.path)),
    [notes]
  )

  const results = useMemo(
    () =>
      rankItems(drawings, query, [
        { get: (n) => n.title, weight: 1 },
        { get: (n) => n.path, weight: 0.7 }
      ]).slice(0, 50),
    [drawings, query]
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-embed-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (note: NoteMeta): void => {
    setOpen(false)
    insertEmbedAtCursor(`![[${note.path}]]\n`)
    focusEditorNormalMode()
  }

  const close = (): void => {
    setOpen(false)
    focusEditorAfterPaletteClose()
  }

  return (
    <Modal size="md" layer="palette" onClose={close} closeOnEsc={false}>
      <div className="border-b border-paper-300/70 px-4 py-3">
        <input
          ref={inputRef}
          value={query}
          placeholder="Embed existing drawing…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return
            if (isPaletteNextKey(e)) {
              e.preventDefault()
              e.stopPropagation()
              setActive((a) => Math.min(results.length - 1, a + 1))
            } else if (isPalettePreviousKey(e)) {
              e.preventDefault()
              e.stopPropagation()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const note = results[active]
              if (note) choose(note)
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
          <div className="px-4 py-6 text-center text-sm text-ink-400">
            {drawings.length === 0 ? 'No drawings in this vault yet.' : 'No matches.'}
          </div>
        ) : (
          results.map((n, i) => (
            <button
              key={n.path}
              data-embed-idx={i}
              onClick={() => choose(n)}
              onMouseMove={() => setActive(i)}
              className={[
                'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                i === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
              ].join(' ')}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">
                {n.title}
              </span>
              <span className="shrink-0 truncate text-xs text-ink-400">{n.folder}</span>
            </button>
          ))
        )}
      </div>
      <div className="flex items-center justify-end gap-4 border-t border-paper-300/70 bg-paper-100 px-4 py-2 text-xs text-ink-500">
        <span>
          <kbd className="rounded bg-paper-200 px-1">↑↓</kbd> move
        </span>
        <span>
          <kbd className="rounded bg-paper-200 px-1">↵</kbd> embed
        </span>
        <span>
          <kbd className="rounded bg-paper-200 px-1">esc</kbd> close
        </span>
      </div>
    </Modal>
  )
}
