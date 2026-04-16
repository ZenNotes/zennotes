import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteContent, NoteMeta } from '@shared/ipc'
import { useStore } from '../store'
import {
  extractWikilinkTargets,
  extractMentionSnippet,
  parseCreateNotePath,
  resolveWikilinkTarget,
  suggestCreateNotePath
} from '../lib/wikilinks'
import { NoteHoverPreview } from './NoteHoverPreview'
import { promptApp } from './PromptHost'

interface MentionItem {
  note: NoteMeta
  snippet: string
}

interface MissingLinkItem {
  target: string
  suggestedPath: string
}

export function ConnectionsPanel({ note }: { note: NoteContent }): JSX.Element {
  const notes = useStore((s) => s.notes)
  const selectNote = useStore((s) => s.selectNote)
  const createAndOpen = useStore((s) => s.createAndOpen)
  const focusedPanel = useStore((s) => s.focusedPanel)
  const connectionsCursorIndex = useStore((s) => s.connectionsCursorIndex)
  const connectionPreview = useStore((s) => s.connectionPreview)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const setConnectionsCursorIndex = useStore((s) => s.setConnectionsCursorIndex)
  const setConnectionPreview = useStore((s) => s.setConnectionPreview)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [backlinks, setBacklinks] = useState<NoteMeta[]>([])
  const [mentions, setMentions] = useState<MentionItem[]>([])
  const [scanLoading, setScanLoading] = useState(false)
  const isConnectionsFocused = focusedPanel === 'connections'
  const isHoverPreviewFocused = focusedPanel === 'hoverpreview'
  const showKeyboardHints = isConnectionsFocused || isHoverPreviewFocused

  const cancelScheduledClose = (): void => {
    if (!closeTimerRef.current) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }

  const scheduleClose = (): void => {
    cancelScheduledClose()
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      setConnectionPreview(null)
    }, 140)
  }

  const setPreviewFromRect = (
    previewNote: Pick<NoteMeta, 'path' | 'title'>,
    rect: DOMRect
  ): void => {
    setConnectionPreview({
      path: previewNote.path,
      title: previewNote.title,
      anchorRect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      }
    })
  }

  const outgoing = useMemo(() => {
    const targets = extractWikilinkTargets(note.body)
    const seen = new Set<string>()
    const resolvedItems: NoteMeta[] = []
    const missingItems: MissingLinkItem[] = []
    for (const rawTarget of targets) {
      const target = rawTarget.trim()
      if (!target) continue
      const dedupeKey = target.toLowerCase()
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const resolved = resolveWikilinkTarget(notes, target)
      if (!resolved) continue
      if (resolved.folder === 'trash' || resolved.path === note.path) continue
      resolvedItems.push(resolved)
    }
    for (const rawTarget of targets) {
      const target = rawTarget.trim()
      if (!target) continue
      const resolved = resolveWikilinkTarget(notes, target)
      if (resolved || target.toLowerCase() === note.title.toLowerCase()) continue
      if (missingItems.some((item) => item.target.toLowerCase() === target.toLowerCase())) continue
      missingItems.push({
        target,
        suggestedPath: suggestCreateNotePath(target)
      })
    }
    return { resolvedItems, missingItems }
  }, [note.body, note.path, notes])

  const totalRows =
    outgoing.resolvedItems.length +
    outgoing.missingItems.length +
    backlinks.length +
    mentions.length

  const previewNote = useMemo(
    () =>
      connectionPreview
        ? notes.find((candidate) => candidate.path === connectionPreview.path) ?? null
        : null,
    [connectionPreview, notes]
  )

  const handleCreateMissingLink = async (item: MissingLinkItem): Promise<void> => {
    const value = await promptApp({
      title: `Create note for "${item.target}"?`,
      description:
        'This wikilink does not resolve yet. Use /my/path/note.md for Inbox-relative paths, or inbox/my/path/note.md for an explicit top folder.',
      initialValue: item.suggestedPath,
      placeholder: '/my/path/note.md',
      okLabel: 'Create',
      validate: (nextValue) => {
        try {
          parseCreateNotePath(nextValue)
          return null
        } catch (err) {
          return (err as Error).message
        }
      }
    })
    if (!value) return

    const parsed = parseCreateNotePath(value)
    const existing = notes.find(
      (candidate) =>
        candidate.folder !== 'trash' &&
        candidate.path.toLowerCase() === parsed.relPath.toLowerCase()
    )
    if (existing) {
      await selectNote(existing.path)
      return
    }
    await createAndOpen(parsed.folder, parsed.subpath, { title: parsed.title })
  }

  useEffect(() => {
    let cancelled = false
    const candidates = notes.filter(
      (candidate) =>
        candidate.folder !== 'trash' &&
        candidate.path !== note.path
    )

    setBacklinks([])
    setMentions([])
    setConnectionPreview(null)
    setScanLoading(candidates.length > 0)

    void Promise.all(
      candidates.map(async (candidate) => {
        try {
          const content = await window.zen.readNote(candidate.path)
          const targets = extractWikilinkTargets(content.body)
          const linksHere = targets.some(
            (target) => resolveWikilinkTarget(notes, target)?.path === note.path
          )
          const snippet = extractMentionSnippet(content.body, note.title)
          return {
            note: candidate,
            backlink: linksHere,
            mentionSnippet: snippet
          }
        } catch {
          return null
        }
      })
    ).then((results) => {
      if (cancelled) return
      const nextBacklinks: NoteMeta[] = []
      const nextMentions: MentionItem[] = []
      for (const item of results) {
        if (!item) continue
        if (item.backlink) nextBacklinks.push(item.note)
        if (item.mentionSnippet) {
          nextMentions.push({ note: item.note, snippet: item.mentionSnippet })
        }
      }
      setBacklinks(nextBacklinks)
      setMentions(nextMentions)
      setScanLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [note.path, note.title, notes, setConnectionPreview])

  useEffect(() => {
    return () => cancelScheduledClose()
  }, [])

  useEffect(() => {
    if (!isConnectionsFocused) return
    const next = totalRows === 0 ? 0 : Math.min(connectionsCursorIndex, totalRows - 1)
    if (next !== connectionsCursorIndex) setConnectionsCursorIndex(next)
  }, [connectionsCursorIndex, isConnectionsFocused, setConnectionsCursorIndex, totalRows])

  let rowIndex = 0

  return (
    <>
      <aside
        data-connections-panel
        onPointerLeave={scheduleClose}
        onMouseDownCapture={() => {
          cancelScheduledClose()
          setFocusedPanel('connections')
        }}
        onFocusCapture={() => {
          cancelScheduledClose()
          setFocusedPanel('connections')
        }}
        className="flex w-[clamp(220px,28vw,304px)] shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/18"
      >
        <div className="border-b border-paper-300/60 px-4 py-4">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-400">
            Connections
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-ink-500">
            <Pill>{outgoing.resolvedItems.length + outgoing.missingItems.length} out</Pill>
            <Pill>{backlinks.length} in</Pill>
            <Pill>{mentions.length} mentioned</Pill>
          </div>
          {showKeyboardHints && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <ConnectionKeyHint keyLabel="j/k" label="move" />
              <ConnectionKeyHint keyLabel="↑↓" label="move" />
              <ConnectionKeyHint keyLabel="p" label="preview" />
              <ConnectionKeyHint keyLabel="↵" label="open" />
              <ConnectionKeyHint
                keyLabel="esc"
                label={isHoverPreviewFocused ? 'rail' : 'note'}
              />
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" onScroll={() => setConnectionPreview(null)}>
          <ConnectionSection
            title="Links From Here"
            subtitle="Resolved notes and missing wikilinks from this page."
            empty="No linked notes yet."
          >
            {outgoing.resolvedItems.map((item) => (
              <ConnectionRow
                key={item.path}
                note={item}
                summary={item.excerpt || 'No excerpt available yet.'}
                onOpen={() => void selectNote(item.path)}
                onHover={(rect) => {
                  cancelScheduledClose()
                  setPreviewFromRect(item, rect)
                }}
                onLeave={scheduleClose}
                active={isConnectionsFocused && connectionsCursorIndex === rowIndex}
                rowIndex={rowIndex++}
              />
            ))}
            {outgoing.missingItems.map((item) => (
              <MissingConnectionRow
                key={item.target.toLowerCase()}
                target={item.target}
                suggestedPath={item.suggestedPath}
                onCreate={() => void handleCreateMissingLink(item)}
                active={isConnectionsFocused && connectionsCursorIndex === rowIndex}
                rowIndex={rowIndex++}
              />
            ))}
          </ConnectionSection>

          <div className="my-3 h-px bg-paper-300/60" />

          <ConnectionSection
            title="Links Here"
            subtitle="Notes already pointing at this page."
            empty="No backlinks yet."
          >
            {backlinks.map((item) => (
              <ConnectionRow
                key={item.path}
                note={item}
                summary={item.excerpt || 'No excerpt available yet.'}
                onOpen={() => void selectNote(item.path)}
                onHover={(rect) => {
                  cancelScheduledClose()
                  setPreviewFromRect(item, rect)
                }}
                onLeave={scheduleClose}
                active={isConnectionsFocused && connectionsCursorIndex === rowIndex}
                rowIndex={rowIndex++}
              />
            ))}
          </ConnectionSection>

          <div className="my-3 h-px bg-paper-300/60" />

          <ConnectionSection
            title="Unlinked Mentions"
            subtitle="Notes that mention this title without linking it."
            empty={scanLoading ? 'Scanning notes…' : 'No unlinked mentions found.'}
          >
            {mentions.map((item) => (
              <ConnectionRow
                key={item.note.path}
                note={item.note}
                summary={item.snippet}
                tone="mention"
                onOpen={() => void selectNote(item.note.path)}
                onHover={(rect) => {
                  cancelScheduledClose()
                  setPreviewFromRect(item.note, rect)
                }}
                onLeave={scheduleClose}
                active={isConnectionsFocused && connectionsCursorIndex === rowIndex}
                rowIndex={rowIndex++}
              />
            ))}
          </ConnectionSection>
        </div>
        {showKeyboardHints && (
          <div className="border-t border-paper-300/60 px-3 py-2 text-[11px] text-ink-500">
            {isHoverPreviewFocused
              ? 'Esc returns to Connections. Esc again returns to the note.'
              : 'Use p to focus the hover preview without leaving the keyboard.'}
          </div>
        )}
      </aside>
      {connectionPreview && previewNote && (
        <NoteHoverPreview
          note={previewNote}
          anchorRect={connectionPreview.anchorRect}
          placement="floating"
          interactive
          onPointerEnter={cancelScheduledClose}
          onPointerLeave={scheduleClose}
        />
      )}
    </>
  )
}

function ConnectionSection({
  title,
  subtitle,
  empty,
  children
}: {
  title: string
  subtitle: string
  empty: string
  children: React.ReactNode
}): JSX.Element {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : []

  return (
    <section>
      <div className="px-1">
        <div className="text-sm font-semibold text-ink-900">{title}</div>
        <div className="mt-1 text-xs leading-relaxed text-ink-500">{subtitle}</div>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {items.length > 0 ? items : <EmptyState>{empty}</EmptyState>}
      </div>
    </section>
  )
}

function ConnectionRow({
  note,
  summary,
  onOpen,
  onHover,
  onLeave,
  tone = 'link',
  active,
  rowIndex
}: {
  note: NoteMeta
  summary: string
  onOpen: () => void
  onHover: (rect: DOMRect) => void
  onLeave: () => void
  tone?: 'link' | 'mention'
  active: boolean
  rowIndex: number
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerEnter={(event) => onHover(event.currentTarget.getBoundingClientRect())}
      onPointerLeave={onLeave}
      data-connections-idx={rowIndex}
      data-connections-type="note"
      data-connections-path={note.path}
      className={[
        'group rounded-2xl border p-3 text-left transition-colors',
        active
          ? 'bg-accent text-white ring-2 ring-white/45'
          : tone === 'mention'
            ? 'border-paper-300/65 bg-paper-100/55 hover:border-accent/30 hover:bg-paper-100'
            : 'border-paper-300/65 bg-paper-50/80 hover:border-accent/35 hover:bg-paper-50'
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className={['truncate text-sm font-medium', active ? 'text-white' : 'text-ink-900'].join(' ')}>
            {note.title}
          </div>
          <div className={['mt-0.5 truncate text-[11px]', active ? 'text-white/75' : 'text-ink-500'].join(' ')}>
            {note.path}
          </div>
        </div>
        <span
          className={[
            'rounded-full px-2 py-1 text-[10px] uppercase tracking-[0.14em]',
            active ? 'bg-white/12 text-white/80' : 'bg-paper-200/80 text-ink-500'
          ].join(' ')}
        >
          hover
        </span>
      </div>
      <div className={['mt-2 line-clamp-3 text-[12px] leading-5', active ? 'text-white/85' : 'text-ink-600'].join(' ')}>
        {summary}
      </div>
      {active && (
        <div className="mt-2 flex justify-end">
          <ConnectionKeyHint keyLabel="p" label="preview" active />
        </div>
      )}
    </button>
  )
}

function MissingConnectionRow({
  target,
  suggestedPath,
  onCreate,
  active,
  rowIndex
}: {
  target: string
  suggestedPath: string
  onCreate: () => void
  active: boolean
  rowIndex: number
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onCreate}
      data-connections-idx={rowIndex}
      data-connections-type="missing"
      data-connections-target={target}
      data-connections-suggested-path={suggestedPath}
      className={[
        'group rounded-2xl border p-3 text-left transition-colors',
        active
          ? 'bg-accent text-white ring-2 ring-white/45'
          : 'border-amber-500/25 bg-amber-500/8 hover:border-amber-500/40 hover:bg-amber-500/12'
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className={['truncate text-sm font-medium', active ? 'text-white' : 'text-ink-900'].join(' ')}>
            {target}
          </div>
          <div className={['mt-0.5 truncate text-[11px]', active ? 'text-white/75' : 'text-ink-500'].join(' ')}>
            {suggestedPath}
          </div>
        </div>
        <span
          className={[
            'rounded-full px-2 py-1 text-[10px] uppercase tracking-[0.14em]',
            active ? 'bg-white/12 text-white/80' : 'bg-amber-500/12 text-amber-200'
          ].join(' ')}
        >
          create
        </span>
      </div>
      <div className={['mt-2 line-clamp-2 text-[12px] leading-5', active ? 'text-white/85' : 'text-ink-600'].join(' ')}>
        No note resolves this wikilink yet. Click to create it.
      </div>
      {active && (
        <div className="mt-2 flex justify-end">
          <ConnectionKeyHint keyLabel="↵" label="create" active />
        </div>
      )}
    </button>
  )
}

function Pill({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span className="rounded-full border border-paper-300/70 bg-paper-100/85 px-2.5 py-1 tabular-nums text-ink-600">
      {children}
    </span>
  )
}

function EmptyState({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-2xl border border-dashed border-paper-300/75 bg-paper-100/40 px-4 py-4 text-sm text-ink-400">
      {children}
    </div>
  )
}

function ConnectionKeyHint({
  keyLabel,
  label,
  active = false
}: {
  keyLabel: string
  label: string
  active?: boolean
}): JSX.Element {
  return (
    <span
      className={[
        'pointer-events-none shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] leading-none',
        active
          ? 'border-white/25 bg-white/12 text-white/80'
          : 'border-paper-300/70 bg-paper-100/75 text-ink-500'
      ].join(' ')}
    >
      <span className="font-mono text-[10px]">{keyLabel}</span>
      <span className="ml-1">{label}</span>
    </span>
  )
}
