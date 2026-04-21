import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type {
  VaultTextSearchBackendPreference,
  VaultTextSearchCapabilities,
  VaultTextSearchMatch
} from '@shared/ipc'
import { useStore } from '../store'
import { resolveSystemFolderLabels } from '../lib/system-folder-labels'
import { recordRendererPerf } from '../lib/perf'

type ResolvedVaultTextSearchBackend = 'builtin' | 'ripgrep' | 'fzf'

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function scoreMatch(query: string, text: string): number {
  if (!query) return 1
  if (!text) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t === q) return 1000
  if (t.startsWith(q)) return 900 - t.length * 0.5
  const wordBoundary = new RegExp(`(?:^|[\\s·:_\\-/])${escapeRegex(q)}`)
  if (wordBoundary.test(t)) return 700 - t.length * 0.5
  if (t.includes(q)) return 500 - t.length * 0.5

  let i = 0
  let gaps = 0
  let prev = -1
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] !== q[i]) continue
    if (prev === -1) gaps += j
    else gaps += j - prev - 1
    prev = j
    i += 1
  }
  if (i === q.length) return Math.max(1, 200 - gaps * 3 - t.length * 0.2)
  return 0
}

function firstMatchColumn(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  const t = text.toLowerCase()
  const direct = t.indexOf(q)
  if (direct >= 0) return direct

  let qi = 0
  let start = -1
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] !== q[qi]) continue
    if (start === -1) start = i
    qi += 1
  }
  return start >= 0 ? start : 0
}

function collapseSearchLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

function getHighlightRanges(text: string, query: string): Array<[number, number]> {
  const trimmed = query.trim()
  if (!trimmed || !text) return []
  const lowerText = text.toLowerCase()
  const lowerQuery = trimmed.toLowerCase()
  const directIndex = lowerText.indexOf(lowerQuery)
  if (directIndex >= 0) return [[directIndex, directIndex + lowerQuery.length]]

  const matchedIndexes: number[] = []
  let queryIndex = 0
  for (let textIndex = 0; textIndex < text.length && queryIndex < lowerQuery.length; textIndex += 1) {
    if (lowerText[textIndex] !== lowerQuery[queryIndex]) continue
    matchedIndexes.push(textIndex)
    queryIndex += 1
  }
  if (queryIndex < lowerQuery.length || matchedIndexes.length === 0) return []

  const ranges: Array<[number, number]> = []
  let rangeStart = matchedIndexes[0]
  let previous = matchedIndexes[0]
  for (let index = 1; index < matchedIndexes.length; index += 1) {
    const current = matchedIndexes[index]
    if (current === previous + 1) {
      previous = current
      continue
    }
    ranges.push([rangeStart, previous + 1])
    rangeStart = current
    previous = current
  }
  ranges.push([rangeStart, previous + 1])
  return ranges
}

function renderHighlightedText(text: string, query: string): JSX.Element {
  const ranges = getHighlightRanges(text, query)
  if (ranges.length === 0) return <>{text}</>

  const nodes: JSX.Element[] = []
  let cursor = 0
  ranges.forEach(([start, end], index) => {
    if (cursor < start) {
      nodes.push(
        <Fragment key={`plain-${index}-${cursor}`}>{text.slice(cursor, start)}</Fragment>
      )
    }
    nodes.push(
      <mark
        key={`hit-${index}-${start}`}
        className="rounded-sm bg-accent/18 px-[1px] text-accent"
      >
        {text.slice(start, end)}
      </mark>
    )
    cursor = end
  })
  if (cursor < text.length) {
    nodes.push(<Fragment key={`plain-tail-${cursor}`}>{text.slice(cursor)}</Fragment>)
  }
  return <>{nodes}</>
}

function resolveVaultTextSearchBackend(
  preferred: VaultTextSearchBackendPreference,
  capabilities: VaultTextSearchCapabilities | null
): ResolvedVaultTextSearchBackend | null {
  if (!capabilities) return null
  if (preferred === 'builtin') return 'builtin'
  if (preferred === 'ripgrep') return capabilities.ripgrep ? 'ripgrep' : 'builtin'
  if (preferred === 'fzf') return capabilities.fzf ? 'fzf' : 'builtin'
  if (capabilities.fzf) return 'fzf'
  if (capabilities.ripgrep) return 'ripgrep'
  return 'builtin'
}

export function VaultTextSearchPalette(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const noteContents = useStore((s) => s.noteContents)
  const setOpen = useStore((s) => s.setVaultTextSearchOpen)
  const openNoteAtOffset = useStore((s) => s.openNoteAtOffset)
  const backend = useStore((s) => s.vaultTextSearchBackend)
  const ripgrepBinaryPath = useStore((s) => s.ripgrepBinaryPath)
  const fzfBinaryPath = useStore((s) => s.fzfBinaryPath)
  const [capabilities, setCapabilities] = useState<VaultTextSearchCapabilities | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<VaultTextSearchMatch[]>([])
  const [active, setActive] = useState(0)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const folderLabels = useMemo(
    () => resolveSystemFolderLabels(systemFolderLabels),
    [systemFolderLabels]
  )
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const openedAtRef = useRef(performance.now())
  const requestIdRef = useRef(0)
  const bodyCacheRef = useRef(new Map<string, string>())
  const notesRef = useRef(notes)
  const noteContentsRef = useRef(noteContents)
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      recordRendererPerf('vaultTextSearch.open', performance.now() - openedAtRef.current, {
        preferredBackend: backend
      })
    })
    return () => window.cancelAnimationFrame(raf)
  }, [backend])

  useEffect(() => {
    let cancelled = false
    if (typeof window.zen.getVaultTextSearchCapabilities !== 'function') {
      setCapabilities(null)
      return () => {
        cancelled = true
      }
    }
    void window.zen
      .getVaultTextSearchCapabilities({
        ripgrepPath: ripgrepBinaryPath,
        fzfPath: fzfBinaryPath
      })
      .then(
        (next) => {
          if (!cancelled) setCapabilities(next)
        },
        () => {
          if (!cancelled) setCapabilities(null)
        }
      )
    return () => {
      cancelled = true
    }
  }, [fzfBinaryPath, ripgrepBinaryPath])

  const resolvedBackend = useMemo(
    () => resolveVaultTextSearchBackend(backend, capabilities),
    [backend, capabilities]
  )
  const resolvedBackendLabel =
    resolvedBackend === 'ripgrep'
      ? 'ripgrep'
      : resolvedBackend === 'fzf'
        ? 'fzf'
        : resolvedBackend === 'builtin'
          ? 'built-in'
          : 'resolving…'

  useEffect(() => {
    setActive(0)
  }, [query, results.length])

  useEffect(() => {
    notesRef.current = notes
  }, [notes])

  useEffect(() => {
    noteContentsRef.current = noteContents
  }, [noteContents])

  useEffect(() => {
    resultRefs.current.length = results.length
  }, [results.length])

  useEffect(() => {
    if (loading || results.length === 0) return
    resultRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [active, loading, results.length])

  async function fallbackSearchVaultText(trimmed: string): Promise<VaultTextSearchMatch[]> {
    type ScoredMatch = VaultTextSearchMatch & { score: number }
    const results: ScoredMatch[] = []
    const searchableNotes = notesRef.current.filter(
      (note) => note.folder === 'inbox' || note.folder === 'quick' || note.folder === 'archive'
    )

    const bodies = await Promise.all(
      searchableNotes.map(async (note) => {
        const cachedBody =
          noteContentsRef.current[note.path]?.body ?? bodyCacheRef.current.get(note.path)
        if (typeof cachedBody === 'string') {
          bodyCacheRef.current.set(note.path, cachedBody)
          return { note, body: cachedBody }
        }
        try {
          const content = await window.zen.readNote(note.path)
          bodyCacheRef.current.set(note.path, content.body)
          return { note, body: content.body }
        } catch {
          return { note, body: '' }
        }
      })
    )

    for (const { note, body } of bodies) {
      if (!body) continue
      const lines = body.split('\n')
      let lineOffset = 0

      for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index] ?? ''
        const lineText = collapseSearchLine(rawLine)
        const bodyScore = scoreMatch(trimmed, lineText)
        if (bodyScore <= 0) {
          lineOffset += rawLine.length + 1
          continue
        }

        const column = firstMatchColumn(trimmed, rawLine)
        const titleScore = scoreMatch(trimmed, note.title) * 0.18
        const pathScore = scoreMatch(trimmed, note.path) * 0.1
        results.push({
          path: note.path,
          title: note.title,
          folder: note.folder,
          lineNumber: index + 1,
          offset: lineOffset + Math.max(0, Math.min(column, rawLine.length)),
          lineText: lineText.slice(0, 220),
          score: bodyScore + titleScore + pathScore
        })

        lineOffset += rawLine.length + 1
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, 80).map(({ score: _score, ...match }) => match)
  }

  useEffect(() => {
    const trimmed = query.trim()
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    if (!trimmed) {
      setResults([])
      setLoading(false)
      return
    }

    setLoading(true)
    const timer = window.setTimeout(() => {
      const runSearch = async (): Promise<void> => {
        const startedAt = performance.now()
        try {
          const matches =
            typeof window.zen.searchVaultText === 'function'
              ? await window.zen.searchVaultText(trimmed, backend, {
                  ripgrepPath: ripgrepBinaryPath,
                  fzfPath: fzfBinaryPath
                })
              : await fallbackSearchVaultText(trimmed)
          if (requestIdRef.current !== requestId) return
          setResults(matches)
          setLoading(false)
          recordRendererPerf('vaultTextSearch.results', performance.now() - startedAt, {
            backend: resolvedBackend ?? backend,
            queryLength: trimmed.length,
            results: matches.length
          })
        } catch (error) {
          console.error('searchVaultText failed, falling back to renderer search', error)
          try {
            const matches = await fallbackSearchVaultText(trimmed)
            if (requestIdRef.current !== requestId) return
            setResults(matches)
            setLoading(false)
            recordRendererPerf(
              'vaultTextSearch.results.fallback',
              performance.now() - startedAt,
              {
                backend: resolvedBackend ?? backend,
                queryLength: trimmed.length,
                results: matches.length
              }
            )
          } catch (fallbackError) {
            console.error('fallbackSearchVaultText failed', fallbackError)
            if (requestIdRef.current !== requestId) return
            setResults([])
            setLoading(false)
            recordRendererPerf('vaultTextSearch.results.error', performance.now() - startedAt, {
              backend: resolvedBackend ?? backend,
              queryLength: trimmed.length
            })
          }
        }
      }

      void runSearch()
    }, 120)

    return () => window.clearTimeout(timer)
  }, [backend, fzfBinaryPath, query, resolvedBackend, ripgrepBinaryPath])

  const openMatch = async (match: VaultTextSearchMatch): Promise<void> => {
    setOpen(false)
    await openNoteAtOffset(match.path, match.offset, { scrollMode: 'center' })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[12vh] backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[min(760px,92vw)] overflow-hidden rounded-xl bg-paper-100 shadow-float ring-1 ring-paper-300/70"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-paper-300/70 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            placeholder="Search text across the vault…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                if (results.length === 0) return
                setActive((value) => Math.min(results.length - 1, value + 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                if (results.length === 0) return
                setActive((value) => Math.max(0, value - 1))
                return
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                const match = results[active]
                if (match) void openMatch(match)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setOpen(false)
              }
            }}
            className="w-full bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
          />
          <div className="mt-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-ink-400">
            <span>Vault text search</span>
            <span className="rounded-full border border-paper-300/70 bg-paper-100/80 px-2 py-0.5 text-[10px] tracking-[0.16em] text-ink-500">
              {resolvedBackendLabel}
            </span>
          </div>
        </div>
        <div className="max-h-[56vh] overflow-x-hidden overflow-y-auto py-1">
          {!query.trim() ? (
            <div className="px-4 py-7 text-center text-sm text-ink-400">
              {`Type to search note text across ${folderLabels.inbox}, ${folderLabels.quick}, and ${folderLabels.archive}.`}
            </div>
          ) : loading ? (
            <div className="px-4 py-7 text-center text-sm text-ink-400">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-4 py-7 text-center text-sm text-ink-400">
              No text matches in the vault.
            </div>
          ) : (
            results.map((match, index) => (
              <button
                key={`${match.path}:${match.offset}`}
                ref={(element) => {
                  resultRefs.current[index] = element
                }}
                onClick={() => void openMatch(match)}
                onMouseMove={() => setActive(index)}
                className={[
                  'flex w-full items-start gap-3 px-4 py-3 text-left',
                  index === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                ].join(' ')}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-sm font-medium text-ink-900">
                      {renderHighlightedText(match.title, query)}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-ink-400">
                      {match.folder}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-500">L{match.lineNumber}</span>
                  </div>
                  <div className="truncate text-[11px] text-ink-500">
                    {renderHighlightedText(match.path, query)}
                  </div>
                  <div className="truncate text-sm text-ink-700">
                    {renderHighlightedText(match.lineText, query)}
                  </div>
                </div>
                <span className="shrink-0 rounded-full bg-paper-200 px-2 py-1 text-[11px] text-ink-600">
                  Open
                </span>
              </button>
            ))
          )}
        </div>
        <div className="flex items-center justify-end gap-4 border-t border-paper-300/70 bg-paper-100 px-4 py-2 text-[11px] text-ink-500">
          <span>
            <kbd className="rounded bg-paper-200 px-1">↑↓</kbd> move
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">↵</kbd> open
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
