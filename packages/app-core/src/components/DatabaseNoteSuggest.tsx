/**
 * Note discovery for database surfaces (#500): the same link-candidates
 * engine as the editor's `[[` completion, scoped by an optional
 * SelectOptionsSource, plus the shared suggestion list the cell editors
 * render inside their popovers. The editors own their popovers and keys;
 * this file owns candidates and rows so every surface ranks and looks alike.
 */
import { useEffect, useMemo, useRef } from 'react'
import type { VaultSettings } from '@shared/ipc'
import type { SelectOptionsSource } from '@shared/databases'
import { resolveTemplateFolder } from '@shared/template-folder'
import { useStore } from '../store'
import {
  linkCandidates,
  notesMatchingSource,
  type LinkCandidate
} from '../lib/link-candidates'

export function useNoteSuggestions(
  query: string,
  opts: {
    enabled: boolean
    source?: SelectOptionsSource | null
    limit?: number
  }
): LinkCandidate[] {
  const notes = useStore((s) => s.notes)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const activePath = useStore((s) => s.activeNote?.path ?? null)
  return useMemo(() => {
    if (!opts.enabled) return []
    return linkCandidates(query, {
      notes: notesMatchingSource(notes, opts.source, resolveTemplateFolder(vaultSettings)),
      vaultSettings: vaultSettings as VaultSettings | null,
      activePath,
      limit: opts.limit ?? 8
    })
  }, [query, notes, vaultSettings, activePath, opts.enabled, opts.source, opts.limit])
}

/** Move an active index by delta across `length` rows, wrapping, -1 aware. */
export function stepSuggestIndex(current: number, delta: number, length: number): number {
  if (length === 0) return -1
  if (current < 0) return delta > 0 ? 0 : length - 1
  const next = current + delta
  if (next < 0) return -1
  if (next >= length) return -1
  return next
}

export function NoteSuggestRows({
  items,
  activeIndex,
  onPick,
  checkedValues,
  indexOffset = 0
}: {
  items: LinkCandidate[]
  activeIndex: number
  onPick: (candidate: LinkCandidate) => void
  /** Values rendered with a ✓ — matched against target (note fields) or
   *  label (select fields store the plain title). */
  checkedValues?: ReadonlySet<string>
  /** The `data-db-suggest-idx` base when rows sit under other entries. */
  indexOffset?: number
}): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-db-suggest-idx="${activeIndex}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div ref={listRef}>
      {items.map((candidate, i) => {
        const idx = indexOffset + i
        const active = idx === activeIndex
        return (
          <button
            key={`${candidate.kind}:${candidate.target}`}
            type="button"
            data-db-suggest-idx={idx}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(candidate)}
            className={[
              'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm',
              active ? 'bg-paper-200 text-ink-900' : 'text-ink-800 hover:bg-paper-200/70'
            ].join(' ')}
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="text-ink-900">{candidate.label}</span>
              {candidate.subtitle && (
                <span className="ml-2 text-2xs text-ink-400">{candidate.subtitle}</span>
              )}
            </span>
            {(checkedValues?.has(candidate.target) || checkedValues?.has(candidate.label)) && (
              <span className="text-accent">✓</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
