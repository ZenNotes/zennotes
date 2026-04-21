import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isTagsViewActive, useStore } from '../store'
import type { NoteMeta } from '@shared/ipc'
import { extractTags } from '../lib/tags'
import { TagIcon, CloseIcon, DocumentIcon } from './icons'
import { advanceSequence, getKeymapBinding, matchesSequenceToken } from '../lib/keymaps'
import { isPrimaryNotesAtRoot, noteFolderSubpath } from '../lib/vault-layout'

function formatDate(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric'
  })
}

function folderLabel(note: NoteMeta): string {
  const vaultSettings = useStore.getState().vaultSettings
  const subpath = noteFolderSubpath(note, vaultSettings)
  if (note.folder === 'inbox' && isPrimaryNotesAtRoot(vaultSettings)) {
    return subpath
  }
  return subpath ? `${note.folder} › ${subpath}` : note.folder
}

export function TagView(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const activeNote = useStore((s) => s.activeNote)
  const selectedTags = useStore((s) => s.selectedTags)
  const toggleTagSelection = useStore((s) => s.toggleTagSelection)
  const closeTagView = useStore((s) => s.closeTagView)
  const selectNote = useStore((s) => s.selectNote)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const amActive = useStore(isTagsViewActive)

  const [filter, setFilter] = useState('')
  const [cursorIndex, setCursorIndex] = useState(0)
  const [exOpen, setExOpen] = useState(false)
  const [exValue, setExValue] = useState('')

  const filterRef = useRef<HTMLInputElement>(null)
  const exRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()

  // Every tag the vault knows about, so the panel can offer a "pick more
  // tags" affordance even when the sidebar is hidden.
  const allTags = useMemo(() => {
    const counter = new Map<string, number>()
    for (const note of notes) {
      if (note.folder === 'trash') continue
      const tags =
        activeNote && activeNote.path === note.path
          ? extractTags(activeNote.body)
          : note.tags
      for (const t of tags) {
        counter.set(t, (counter.get(t) ?? 0) + 1)
      }
    }
    return [...counter.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [notes, activeNote])

  // Notes matching ANY selected tag (union). More tags selected → wider
  // result set; matches the user's mental model of "show me everything in
  // these areas at once." Live-extract tags from the active buffer so a
  // freshly-typed `#tag` appears without waiting for the watcher.
  const matching = useMemo(() => {
    if (selectedTags.length === 0) return [] as NoteMeta[]
    const lowered = selectedTags.map((t) => t.toLowerCase())
    return notes
      .filter((n) => {
        if (n.folder === 'trash') return false
        const tags = (
          activeNote && activeNote.path === n.path
            ? extractTags(activeNote.body)
            : n.tags
        ).map((t) => t.toLowerCase())
        return lowered.some((sel) => tags.includes(sel))
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [notes, activeNote, selectedTags])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return matching
    return matching.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.excerpt.toLowerCase().includes(q) ||
        n.path.toLowerCase().includes(q)
    )
  }, [matching, filter])

  const safeCursor = Math.min(cursorIndex, Math.max(0, filtered.length - 1))
  const current = filtered[safeCursor]

  useEffect(() => {
    if (safeCursor !== cursorIndex) setCursorIndex(safeCursor)
  }, [safeCursor, cursorIndex])

  useEffect(() => {
    if (!current) return
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-tag-row="${cssEscape(current.path)}"]`
    )
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [current])

  const openCurrent = useCallback(async () => {
    if (!current) return
    await selectNote(current.path)
    useStore.getState().setFocusedPanel('editor')
    requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
  }, [current, selectNote])

  const moveCursor = useCallback(
    (delta: number) => {
      if (filtered.length === 0) return
      setCursorIndex((i) =>
        Math.max(0, Math.min(filtered.length - 1, i + delta))
      )
    },
    [filtered.length]
  )

  const runExCommand = useCallback(
    (raw: string): void => {
      const store = useStore.getState()
      const trimmed = raw.trim().replace(/^:/, '')
      if (!trimmed) return
      // `:tag foo bar` replaces the selection. Plain `:tag` clears it.
      if (/^tag(\s|$)/i.test(trimmed)) {
        const args = trimmed
          .slice(3)
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => t.replace(/^#/, ''))
        store.setSelectedTags(args)
        return
      }
      const cmd = trimmed.toLowerCase()
      const path = store.selectedPath
      switch (cmd) {
        case 'q':
        case 'quit':
        case 'wq':
        case 'x':
          closeTagView()
          return
        case 'w':
        case 'write':
          return
        case 'h':
        case 'help':
          void store.openHelpView()
          return
        case 'sp':
        case 'split':
          if (path) {
            void store.splitPaneWithTab({
              targetPaneId: store.activePaneId,
              edge: 'bottom',
              path
            })
          }
          return
        case 'vs':
        case 'vsp':
        case 'vsplit':
          if (path) {
            void store.splitPaneWithTab({
              targetPaneId: store.activePaneId,
              edge: 'right',
              path
            })
          }
          return
        default:
          return
      }
    },
    [closeTagView]
  )

  useEffect(() => {
    if (!amActive) return
    const handler = (e: KeyboardEvent): void => {
      const focused = document.activeElement as HTMLElement | null
      if (focused) {
        const t = focused.tagName
        if (t === 'INPUT' || t === 'TEXTAREA' || focused.isContentEditable) return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const k = e.key
      const overrides = keymapOverrides
      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }

      if (k === 'Escape') {
        if (filter) {
          consume()
          setFilter('')
          return
        }
        consume()
        closeTagView()
        return
      }
      if (matchesSequenceToken(e, overrides, 'nav.filter')) {
        consume()
        filterRef.current?.focus()
        filterRef.current?.select()
        return
      }
      if (matchesSequenceToken(e, overrides, 'nav.localEx')) {
        consume()
        setExValue('')
        setExOpen(true)
        requestAnimationFrame(() => exRef.current?.focus())
        return
      }
      if (matchesSequenceToken(e, overrides, 'nav.moveDown') || k === 'ArrowDown') {
        consume()
        moveCursor(1)
        return
      }
      if (matchesSequenceToken(e, overrides, 'nav.moveUp') || k === 'ArrowUp') {
        consume()
        moveCursor(-1)
        return
      }
      if (matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
        consume()
        setCursorIndex(filtered.length - 1)
        return
      }
      if (
        advanceSequence(
          e,
          getKeymapBinding(overrides, 'nav.jumpTop'),
          gPending,
          gTimer,
          () => setCursorIndex(0),
          consume,
          500
        )
      ) {
        return
      }
      if ((k === 'Enter' || matchesSequenceToken(e, overrides, 'nav.openResult')) && current) {
        consume()
        void openCurrent()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [
    amActive,
    filter,
    moveCursor,
    filtered.length,
    current,
    keymapOverrides,
    openCurrent,
    closeTagView
  ])

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900"
    >
      <div className="flex items-center gap-2 border-b border-current/10 px-4 py-3">
        <TagIcon width={18} height={18} />
        <h1 className="text-sm font-semibold">Tags</h1>
        <span className="ml-2 rounded bg-current/10 px-1.5 py-0.5 text-[11px] text-current/60">
          {matching.length} {matching.length === 1 ? 'note' : 'notes'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <input
            ref={filterRef}
            type="text"
            placeholder="Filter…  /  to focus"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                if (filter) setFilter('')
                else e.currentTarget.blur()
              }
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            className="w-56 rounded-md border border-current/15 bg-current/5 px-2 py-1 text-xs outline-none focus:border-current/30"
          />
          <button
            type="button"
            onClick={closeTagView}
            title="Close (:q or Esc)"
            className="flex h-6 w-6 items-center justify-center rounded-md text-current/70 hover:bg-current/10"
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      </div>

      {/* Tag chip strip — the single source of truth for what's in the
          result set. Click any chip to toggle; shows un-selected tags in
          a quieter style so the user can pick more without leaving. */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-current/10 px-4 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-current/40">
          Selected
        </span>
        {selectedTags.length === 0 ? (
          <span className="text-[11px] text-current/50">
            Click a tag below to start narrowing.
          </span>
        ) : (
          selectedTags.map((t) => (
            <button
              key={`sel-${t}`}
              type="button"
              onClick={() => toggleTagSelection(t)}
              className="flex items-center gap-1 rounded-full bg-accent/20 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/30"
              title="Remove from selection"
            >
              <span>#{t}</span>
              <CloseIcon width={10} height={10} />
            </button>
          ))
        )}
        {allTags.length > selectedTags.length && (
          <>
            <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-current/40">
              Add
            </span>
            {allTags
              .filter(([t]) => !selectedTags.includes(t))
              .map(([t, count]) => (
                <button
                  key={`pick-${t}`}
                  type="button"
                  onClick={() => toggleTagSelection(t)}
                  className="rounded-full bg-current/5 px-2 py-0.5 text-[11px] text-current/70 hover:bg-current/15 hover:text-current/90"
                >
                  #{t}
                  <span className="ml-1 text-current/40">{count}</span>
                </button>
              ))}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {selectedTags.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-current/50">
            Pick one or more tags above to see matching notes.
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-current/50">
            {matching.length === 0
              ? 'No notes carry any of the selected tags.'
              : `No notes match "${filter}".`}
          </div>
        ) : (
          filtered.map((note, i) => {
            const isCursor = i === safeCursor
            return (
              <button
                key={note.path}
                type="button"
                data-tag-row={note.path}
                onMouseMove={() => setCursorIndex(i)}
                onClick={() => {
                  setCursorIndex(i)
                  void selectNote(note.path).then(() => {
                    useStore.getState().setFocusedPanel('editor')
                    requestAnimationFrame(() =>
                      useStore.getState().editorViewRef?.focus()
                    )
                  })
                }}
                className={[
                  'group flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition-colors',
                  isCursor ? 'vim-cursor' : 'hover:bg-current/5'
                ].join(' ')}
              >
                <span className="mt-0.5 shrink-0 text-current/50">
                  <DocumentIcon width={14} height={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-current/90">
                    {note.title || '(untitled)'}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-current/50">
                    {folderLabel(note) || note.folder}
                  </div>
                  {note.excerpt && (
                    <div className="mt-0.5 truncate text-[11px] text-current/40">
                      {note.excerpt}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-[11px] text-current/40">
                  {formatDate(note.updatedAt)}
                </span>
              </button>
            )
          })
        )}
      </div>

      {exOpen ? (
        <form
          className="flex items-center gap-1 border-t border-current/10 px-4 py-1.5 font-mono text-xs"
          onSubmit={(e) => {
            e.preventDefault()
            runExCommand(exValue)
            setExOpen(false)
            setExValue('')
          }}
        >
          <span className="text-current/80">:</span>
          <input
            ref={exRef}
            autoFocus
            value={exValue}
            onChange={(e) => setExValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setExOpen(false)
                setExValue('')
              }
            }}
            onBlur={() => {
              setExOpen(false)
              setExValue('')
            }}
            className="flex-1 bg-transparent outline-none"
            spellCheck={false}
            autoComplete="off"
          />
        </form>
      ) : (
        <div className="border-t border-current/10 px-4 py-1.5 text-[11px] text-current/40">
          j/k move · Enter/o open · click chips to toggle · / filter · : command · Esc close
        </div>
      )}
    </div>
  )
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}
