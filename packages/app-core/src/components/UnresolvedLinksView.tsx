import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteMeta } from '@shared/ipc'
import {
  unresolvedOccurrencesIn,
  type UnresolvedLinkGroup,
  type WikilinkOccurrence
} from '@shared/unresolved-links'
import { isUnresolvedLinksViewActive, useStore } from '../store'
import { databaseLinkTargetsFor, vaultUnresolvedLinks } from '../lib/unresolved-links'
import { createNoteFromLinkNow } from '../lib/create-note-from-link'
import { requestLinkPopover } from '../lib/link-popover-open'
import { focusEditorNormalMode } from '../lib/editor-focus'
import { isAppOverlayOpen } from '../lib/overlay-open'
import {
  advanceSequence,
  getKeymapBinding,
  getKeymapDisplay,
  matchesSequenceToken,
  matchesShortcut,
  type KeymapId
} from '../lib/keymaps'
import {
  listViewBindingMatches,
  listViewKey,
  listViewSequencesLive,
  listViewYieldsKey
} from '../lib/list-view-keys'
import { linkCreateDestination } from '../lib/link-popover'
import { getSystemFolderLabel } from '../lib/system-folder-labels'
import { Button } from './ui'
import { LinkIcon, SearchIcon } from './icons'

// Every action this view answers, so a chord bound to one reaches it.
const UNRESOLVED_LINKS_VIEW_ACTIONS: readonly KeymapId[] = [
  'nav.filter',
  'nav.moveDown',
  'nav.moveUp',
  'nav.jumpBottom',
  'nav.jumpTop',
  'nav.openResult'
]

/**
 * The Unresolved Links view: every `[[wikilink]]` in the vault that names a
 * note no one has written yet, with the notes and lines that link to it.
 * Asked for by a user who links notes they mean to write later and then
 * forgets to (uNyanda, Discord). Enter on a name creates the note (the `gD`
 * path), Enter on a line opens the linking note there, and the link popover
 * key writes the note in place without leaving the list.
 *
 * Which links are listed is the editor's own decision (`wikilinkReaches`):
 * a link listed here is exactly a link the editor draws as unresolved.
 * Grouping uses the vault index's per-note link lists; the lines come from
 * reading the linking notes, which only happens while the view is open.
 */

type Row =
  | { kind: 'target'; id: string; group: UnresolvedLinkGroup<NoteMeta> }
  | {
      kind: 'mention'
      id: string
      group: UnresolvedLinkGroup<NoteMeta>
      note: NoteMeta
      occurrence: WikilinkOccurrence | null
      /** The note was read; a null occurrence then means its saved text no
       *  longer has the link (an unsaved edit, or the index running ahead). */
      loaded: boolean
    }

interface LoadedBody {
  updatedAt: number
  body: string
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

/** The linking line, trimmed to the neighborhood of the link. */
function excerpt(occurrence: WikilinkOccurrence): { before: string; link: string; after: string } {
  const text = occurrence.text
  const start = occurrence.column
  const end = start + (occurrence.to - occurrence.from)
  const before = text.slice(0, start)
  const clippedBefore = before.length > 48 ? `…${before.slice(-46).trimStart()}` : before.trimStart()
  return { before: clippedBefore, link: text.slice(start, end), after: text.slice(end) }
}

export function UnresolvedLinksView(): JSX.Element {
  const notes = useStore((s) => s.notes)
  const folders = useStore((s) => s.folders)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const assetFiles = useStore((s) => s.assetFiles)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const vimMode = useStore((s) => s.vimMode)
  const amActive = useStore(isUnresolvedLinksViewActive)
  const openNoteAtOffset = useStore((s) => s.openNoteAtOffset)
  const selectNote = useStore((s) => s.selectNote)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)

  const [filter, setFilter] = useState('')
  const [cursor, setCursor] = useState(0)
  const [bodies, setBodies] = useState<Map<string, LoadedBody>>(() => new Map())
  const rootRef = useRef<HTMLDivElement | null>(null)
  const filterRef = useRef<HTMLInputElement | null>(null)
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()

  const groups = useMemo(
    () =>
      vaultUnresolvedLinks(notes, {
        databases: databaseLinkTargetsFor(folders, vaultSettings),
        assets: assetFiles
      }),
    [notes, folders, vaultSettings, assetFiles]
  )

  // Read the linking notes for their lines. Keyed on each note's mtime so an
  // edit elsewhere refreshes its lines, and nothing is read twice.
  useEffect(() => {
    if (!amActive) return
    let cancelled = false
    const wanted = new Map<string, NoteMeta>()
    for (const group of groups) for (const note of group.sources) wanted.set(note.path, note)
    const stale = [...wanted.values()].filter(
      (note) => bodies.get(note.path)?.updatedAt !== note.updatedAt
    )
    if (stale.length === 0) return
    void (async () => {
      const loaded: Array<[string, LoadedBody]> = []
      for (const note of stale) {
        const cached = useStore.getState().noteContents[note.path]?.body
        try {
          const body = cached ?? (await window.zen.readNote(note.path)).body
          loaded.push([note.path, { updatedAt: note.updatedAt, body }])
        } catch {
          loaded.push([note.path, { updatedAt: note.updatedAt, body: '' }])
        }
        if (cancelled) return
      }
      setBodies((prev) => {
        const next = new Map(prev)
        for (const [path, entry] of loaded) next.set(path, entry)
        return next
      })
    })()
    return () => {
      cancelled = true
    }
    // `bodies` is read, not tracked: tracking it would rerun the effect for
    // the result it just stored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amActive, groups])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const out: Row[] = []
    for (const group of groups) {
      const matches =
        !q ||
        group.target.toLowerCase().includes(q) ||
        group.sources.some((note) => note.title.toLowerCase().includes(q))
      if (!matches) continue
      out.push({ kind: 'target', id: `t:${group.key}`, group })
      for (const note of group.sources) {
        const loaded = bodies.get(note.path)
        const hits = loaded ? unresolvedOccurrencesIn(loaded.body, new Set([group.key])) : []
        if (hits.length === 0) {
          out.push({
            kind: 'mention',
            id: `m:${group.key}:${note.path}`,
            group,
            note,
            occurrence: null,
            loaded: !!loaded
          })
          continue
        }
        for (const hit of hits) {
          out.push({
            kind: 'mention',
            id: `m:${group.key}:${note.path}:${hit.from}`,
            group,
            note,
            occurrence: hit,
            loaded: true
          })
        }
      }
    }
    return out
  }, [groups, bodies, filter])

  const safeCursor = Math.min(cursor, Math.max(0, rows.length - 1))
  const current = rows[safeCursor] ?? null

  useEffect(() => {
    if (safeCursor !== cursor) setCursor(safeCursor)
  }, [cursor, safeCursor])

  useEffect(() => {
    if (!current) return
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-unresolved-row="${cssEscape(current.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [current])

  // Take the keyboard when the view comes up with nothing else holding it.
  useEffect(() => {
    if (!amActive) return
    const raf = requestAnimationFrame(() => {
      const active = document.activeElement
      if (!active || active === document.body) rootRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(raf)
  }, [amActive])

  const createNote = useCallback((group: UnresolvedLinkGroup<NoteMeta>) => {
    void createNoteFromLinkNow(group.target)
  }, [])

  const openMention = useCallback(
    async (row: Extract<Row, { kind: 'mention' }>) => {
      if (row.occurrence) await openNoteAtOffset(row.note.path, row.occurrence.from)
      else await selectNote(row.note.path)
      focusEditorNormalMode()
    },
    [openNoteAtOffset, selectNote]
  )

  const activate = useCallback(
    (row: Row) => {
      if (row.kind === 'target') createNote(row.group)
      else void openMention(row)
    },
    [createNote, openMention]
  )

  /** Write the missing note in the link popover, hanging off its row. */
  const writeInPopover = useCallback((row: Row) => {
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-unresolved-row="${cssEscape(row.id)}"]`
    )
    const rect = el?.getBoundingClientRect()
    if (!rect) return
    requestLinkPopover({
      target: row.group.target,
      sourcePath: row.kind === 'mention' ? row.note.path : row.group.sources[0]?.path ?? null,
      anchorRect: {
        left: rect.left + 24,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      mode: 'pinned',
      focus: true
    })
  }, [])

  useEffect(() => {
    if (!amActive) return
    const handler = (e: KeyboardEvent): void => {
      if (isAppOverlayOpen()) return
      const target = e.target instanceof HTMLElement ? e.target : null
      if (target?.closest('[data-link-popover]')) return
      const focusedPanel = useStore.getState().focusedPanel
      if (focusedPanel !== null && focusedPanel !== 'editor') return
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      const overrides = keymapOverrides
      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      // The popover key works with Vim on or off; its Vim twin is `K`.
      if (
        current &&
        (matchesShortcut(e, overrides, 'editor.linkPopover') ||
          (vimMode && matchesSequenceToken(e, overrides, 'vim.linkPopover')))
      ) {
        consume()
        writeInPopover(current)
        return
      }
      // A chord gets through only as the key of one of this view's actions,
      // and never past a global shortcut (#972, lib/list-view-keys.ts).
      if (listViewYieldsKey(e, overrides, UNRESOLVED_LINKS_VIEW_ACTIONS, vimMode)) return
      // With Vim off, single-key shortcuts stay off: arrows, Enter, Escape,
      // plus any action the user bound to a chord.
      const seq = (id: KeymapId): boolean => listViewBindingMatches(e, overrides, id, vimMode)
      const key = listViewKey(e)
      if (key === 'Escape') {
        if (!filter) return
        consume()
        setFilter('')
        return
      }
      if (seq('nav.filter')) {
        consume()
        filterRef.current?.focus()
        filterRef.current?.select()
        return
      }
      if (seq('nav.moveDown') || key === 'ArrowDown') {
        consume()
        setCursor((i) => Math.min(rows.length - 1, i + 1))
        return
      }
      if (seq('nav.moveUp') || key === 'ArrowUp') {
        consume()
        setCursor((i) => Math.max(0, i - 1))
        return
      }
      if (seq('nav.jumpBottom')) {
        consume()
        setCursor(Math.max(0, rows.length - 1))
        return
      }
      if (
        listViewSequencesLive(e, vimMode) &&
        advanceSequence(
          e,
          getKeymapBinding(overrides, 'nav.jumpTop'),
          gPending,
          gTimer,
          () => setCursor(0),
          consume,
          500
        )
      ) {
        return
      }
      if ((key === 'Enter' || seq('nav.openResult')) && current) {
        consume()
        activate(current)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => {
      if (gTimer.current) clearTimeout(gTimer.current)
      window.removeEventListener('keydown', handler, true)
    }
  }, [activate, amActive, current, filter, keymapOverrides, rows.length, vimMode, writeInPopover])

  const popoverKey = vimMode
    ? getKeymapDisplay(keymapOverrides, 'vim.linkPopover')
    : getKeymapDisplay(keymapOverrides, 'editor.linkPopover')
  const mentionCount = groups.reduce((sum, group) => sum + group.sources.length, 0)

  return (
    <div
      ref={rootRef}
      data-unresolved-links-view=""
      tabIndex={0}
      className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900 outline-none"
    >
      <header className="glass-header flex h-12 shrink-0 items-center gap-2 px-4">
        <LinkIcon className="h-4 w-4 shrink-0 text-ink-500" />
        <h2 className="text-sm font-semibold text-ink-900">Unresolved Links</h2>
        <span className="shrink-0 text-xs text-ink-500" data-unresolved-count={groups.length}>
          {groups.length}
        </span>
        <div className="ml-auto flex items-center gap-1.5 rounded-md bg-paper-200/60 px-2 py-1">
          <SearchIcon className="h-3.5 w-3.5 text-ink-400" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              setCursor(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || e.key === 'Enter') {
                e.preventDefault()
                if (e.key === 'Escape') setFilter('')
                rootRef.current?.focus({ preventScroll: true })
              }
            }}
            placeholder="Filter links or notes"
            className="w-44 bg-transparent text-xs text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
      </header>
      <p className="shrink-0 border-b border-paper-300/60 px-4 py-2 text-xs text-ink-500">
        {groups.length === 0
          ? 'Links to notes that do not exist yet show up here.'
          : `${groups.length} ${groups.length === 1 ? 'note' : 'notes'} linked but not written yet, from ${mentionCount} ${mentionCount === 1 ? 'link' : 'links'}. Enter on a name creates the note; Enter on a line opens it there${popoverKey ? `; ${popoverKey} writes the note in a popover` : ''}.`}
      </p>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink-400">
            {groups.length === 0
              ? 'No unresolved links. Every [[wikilink]] in this vault points at a note that exists.'
              : 'Nothing matches your filter.'}
          </div>
        ) : (
          <ul className="flex flex-col py-1">
            {rows.map((row, index) => {
              const selected = index === safeCursor
              const base = [
                'group flex cursor-pointer items-center gap-3 px-4 outline-none',
                selected ? 'bg-paper-200/80' : 'hover:bg-paper-200/40'
              ].join(' ')
              if (row.kind === 'target') {
                const count = row.group.sources.length
                const destination = linkCreateDestination(row.group.target)
                return (
                  <li
                    key={row.id}
                    data-unresolved-row={row.id}
                    data-unresolved-kind="target"
                    data-unresolved-target={row.group.target}
                    data-unresolved-cursor={selected ? 'true' : undefined}
                    className={`${base} mt-1 py-1.5`}
                    onClick={() => setCursor(index)}
                    onDoubleClick={() => activate(row)}
                  >
                    <LinkIcon width={14} height={14} className="shrink-0 text-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink-900">{row.group.target}</div>
                      {destination && (
                        <div className="truncate text-xs text-ink-400">
                          {`New note in ${getSystemFolderLabel(destination.folder, systemFolderLabels)}${destination.subpath ? ` / ${destination.subpath}` : ''}`}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-ink-500">
                      {count === 1 ? 'linked from 1 note' : `linked from ${count} notes`}
                    </span>
                    <Button
                      size="sm"
                      variant={selected ? 'primary' : 'secondary'}
                      onClick={(e) => {
                        e.stopPropagation()
                        createNote(row.group)
                      }}
                      data-unresolved-create=""
                    >
                      Create note
                    </Button>
                  </li>
                )
              }
              const parts = row.occurrence ? excerpt(row.occurrence) : null
              return (
                <li
                  key={row.id}
                  data-unresolved-row={row.id}
                  data-unresolved-kind="mention"
                  data-unresolved-target={row.group.target}
                  data-unresolved-source={row.note.path}
                  data-unresolved-line={row.occurrence?.line ?? ''}
                  data-unresolved-cursor={selected ? 'true' : undefined}
                  className={`${base} py-1 pl-10`}
                  onClick={() => {
                    setCursor(index)
                    void openMention(row)
                  }}
                  title={row.note.path}
                >
                  <span className="w-40 shrink-0 truncate text-xs font-medium text-ink-700">
                    {row.note.title}
                  </span>
                  <span className="w-12 shrink-0 text-right text-xs tabular-nums text-ink-400">
                    {row.occurrence ? `line ${row.occurrence.line}` : ''}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-500">
                    {parts ? (
                      <>
                        {parts.before}
                        <span className="text-accent">{parts.link}</span>
                        {parts.after}
                      </>
                    ) : row.loaded ? (
                      ''
                    ) : (
                      'Reading…'
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
