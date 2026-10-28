import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isTagsViewActive, useStore } from '../store'
import type { NoteMeta } from '@shared/ipc'
import type { TagBlock } from '@shared/tag-blocks'
import { buildTagTree, flattenTagTree, matchesSelectedTags, noteTagsForCount } from '../lib/tags'
import { openTaggedBlock, useTagBlockIndex } from '../lib/tag-block-index'
import {
  buildTagViewRows,
  nextNoteRowIndex,
  previousNoteRowIndex,
  type TagViewRow
} from '../lib/tag-view-rows'
import { resolveTypstPreambleFolder } from '../lib/typst-preamble'
import { TagIcon, CloseIcon, DocumentIcon } from './icons'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { TaggedBlockText } from './TaggedBlockText'
import { advanceSequence, getKeymapBinding, type KeymapId } from '../lib/keymaps'
import {
  listViewBindingMatches,
  listViewKey,
  listViewSequencesLive,
  listViewYieldsKey
} from '../lib/list-view-keys'
import { isPrimaryNotesAtRoot, noteFolderSubpath } from '../lib/vault-layout'
import { isImeComposing } from '../lib/ime'
import { isAppOverlayOpen } from '../lib/overlay-open'

// Every action this view answers, so a chord bound to one reaches it.
const TAG_VIEW_ACTIONS: readonly KeymapId[] = [
  'nav.filter',
  'nav.localEx',
  'nav.moveDown',
  'nav.moveUp',
  'nav.jumpBottom',
  'tags.nextNote',
  'tags.previousNote',
  'nav.jumpTop',
  'nav.openResult'
]

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
  const preambleFolder = useStore((s) =>
    resolveTypstPreambleFolder(s.vaultSettings?.typstPreambles?.folder)
  )
  const selectedTags = useStore((s) => s.selectedTags)
  const tagMatchMode = useStore((s) => s.tagMatchMode)
  const setTagMatchMode = useStore((s) => s.setTagMatchMode)
  const toggleTagSelection = useStore((s) => s.toggleTagSelection)
  const setSelectedTags = useStore((s) => s.setSelectedTags)
  const nestedTags = useStore((s) => s.nestedTags)
  const collapsedTagNodes = useStore((s) => s.collapsedTagNodes)
  const toggleCollapseTagNode = useStore((s) => s.toggleCollapseTagNode)
  const closeTagView = useStore((s) => s.closeTagView)
  const selectNote = useStore((s) => s.selectNote)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const vimMode = useStore((s) => s.vimMode)
  const amActive = useStore(isTagsViewActive)

  const [filter, setFilter] = useState('')
  // The cursor follows a row's key, not its position: block rows fill in
  // under notes as their bodies are read, and the selected row must not
  // drift while they do. `index` is the fallback when the key leaves the list.
  const [cursor, setCursor] = useState<{ key: string | null; index: number }>({
    key: null,
    index: 0
  })
  const [exOpen, setExOpen] = useState(false)
  const [exValue, setExValue] = useState('')
  // Right-click menu for a selected tag chip (deselect / keep only / clear). (#356)
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; tag: string } | null>(null)

  const filterRef = useRef<HTMLInputElement>(null)

  // A "+N more" row in Search notes opens this view with its free text as the
  // filter, so the list shows the blocks that row stood for.
  const filterSeed = useStore((s) => s.tagViewFilterSeed)
  useEffect(() => {
    if (filterSeed === null) return
    setFilter(filterSeed)
    useStore.setState({ tagViewFilterSeed: null })
  }, [filterSeed])
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
      for (const t of noteTagsForCount(note, activeNote, preambleFolder)) {
        counter.set(t, (counter.get(t) ?? 0) + 1)
      }
    }
    return [...counter.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [notes, activeNote, preambleFolder])

  // Nested-tag tree (#439). Shares the collapsed-node set with the sidebar so
  // expand/collapse stays in sync across both surfaces.
  const collapsedTagSet = useMemo(() => new Set(collapsedTagNodes), [collapsedTagNodes])
  const tagTreeRows = useMemo(
    () => (nestedTags ? flattenTagTree(buildTagTree(allTags), collapsedTagSet) : []),
    [nestedTags, allTags, collapsedTagSet]
  )

  // Notes matching the selected tags. Default `all` = intersection (AND), so
  // adding a tag narrows the result set (matches the "narrowing" wording and
  // #221); `any` = union (OR) for the "everything in these areas" case. Live-
  // extract tags from the active buffer so a freshly-typed `#tag` appears
  // without waiting for the watcher.
  const matching = useMemo(() => {
    if (selectedTags.length === 0) return [] as NoteMeta[]
    return notes
      .filter((n) => {
        if (n.folder === 'trash') return false
        const tags = noteTagsForCount(n, activeNote, preambleFolder)
        return matchesSelectedTags(tags, selectedTags, tagMatchMode)
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [notes, activeNote, selectedTags, tagMatchMode, preambleFolder])

  // Block-level results (#837): the blocks inside each matching note that
  // carry a selected tag, read on demand for the listed notes only.
  const tagBlocks = useTagBlockIndex(matching)
  const { rows, blockCount } = useMemo(
    () => buildTagViewRows(matching, tagBlocks.blocksByPath, selectedTags, filter),
    [matching, tagBlocks.blocksByPath, selectedTags, filter]
  )
  const matchingBlockCount = useMemo(
    () =>
      filter.trim()
        ? buildTagViewRows(matching, tagBlocks.blocksByPath, selectedTags, '').blockCount
        : blockCount,
    [filter, matching, tagBlocks.blocksByPath, selectedTags, blockCount]
  )

  const cursorIndex = useMemo(() => {
    if (rows.length === 0) return 0
    if (cursor.key !== null) {
      const at = rows.findIndex((row) => row.key === cursor.key)
      if (at >= 0) return at
    }
    return Math.min(cursor.index, rows.length - 1)
  }, [rows, cursor])
  const current: TagViewRow | undefined = rows[cursorIndex]

  const moveTo = useCallback(
    (index: number) => {
      const row = rows[index]
      if (row) setCursor({ key: row.key, index })
    },
    [rows]
  )

  useEffect(() => {
    if (!current) return
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-tag-view-index="${cursorIndex}"]`
    )
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [current, cursorIndex])

  const openNote = useCallback(
    async (note: NoteMeta) => {
      await selectNote(note.path)
      useStore.getState().setFocusedPanel('editor')
      requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
    },
    [selectNote]
  )

  const openBlock = useCallback(async (note: NoteMeta, block: TagBlock) => {
    if (await openTaggedBlock(note.path, block.startLine)) {
      requestAnimationFrame(() => useStore.getState().editorViewRef?.focus())
    }
  }, [])

  const openRow = useCallback(
    async (row: TagViewRow) => {
      if (row.kind === 'block') await openBlock(row.note, row.block)
      else await openNote(row.note)
    },
    [openBlock, openNote]
  )

  const moveCursor = useCallback(
    (delta: number) => {
      if (rows.length === 0) return
      moveTo(Math.max(0, Math.min(rows.length - 1, cursorIndex + delta)))
    },
    [rows.length, cursorIndex, moveTo]
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
        case 'clear':
        case 'clr':
          store.setSelectedTags([])
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

  const tagMenuItems = useMemo<ContextMenuItem[]>(() => {
    const tag = tagMenu?.tag
    if (!tag) return []
    return [
      { label: `Deselect #${tag}`, onSelect: () => toggleTagSelection(tag) },
      {
        label: 'Unselect others',
        disabled: selectedTags.length <= 1,
        onSelect: () => setSelectedTags([tag])
      },
      { kind: 'separator' },
      {
        label: 'Clear all tags',
        hint: vimMode ? 'c' : undefined,
        onSelect: () => setSelectedTags([])
      }
    ]
  }, [tagMenu, selectedTags, toggleTagSelection, setSelectedTags, vimMode])

  // Activating the Tags tab claims panel focus for the Tags view so pane
  // navigation and the key handler below agree on where focus is. Fires only on
  // the activation edge, so a later Ctrl+W to another panel isn't overridden. (#412)
  useEffect(() => {
    if (amActive) useStore.getState().setFocusedPanel('tags')
  }, [amActive])

  useEffect(() => {
    if (!amActive) return
    const handler = (e: KeyboardEvent): void => {
      // A modal/menu owns the keyboard while open — don't fire list shortcuts
      // through it. (songgenqing report)
      if (isAppOverlayOpen()) return
      // While the Vim hint overlay is open it owns the keyboard; don't let
      // tag navigation (or Esc closing the view) steal its keys. (#151)
      if (document.querySelector('[data-vim-hint-overlay]')) return
      // The Tags tab can stay "active" while pane navigation (Ctrl+W h/j/k/l)
      // moves keyboard focus to another panel. Once focusedPanel is no longer
      // 'tags', release the keys so the target panel (e.g. the sidebar) receives
      // j/k instead of this window-capture listener swallowing them first. A
      // `null` panel means "no explicit focus yet" — keep handling as before. (#412)
      const fp = useStore.getState().focusedPanel
      if (fp != null && fp !== 'tags') return
      const focused = document.activeElement as HTMLElement | null
      if (focused) {
        const t = focused.tagName
        if (t === 'INPUT' || t === 'TEXTAREA' || focused.isContentEditable) return
      }
      const overrides = keymapOverrides
      // A chord gets through only as the key of one of this view's actions,
      // and never past a global shortcut (#972, lib/list-view-keys.ts).
      if (listViewYieldsKey(e, overrides, TAG_VIEW_ACTIONS, vimMode)) return

      const k = listViewKey(e)
      // When Vim mode is off, the single-key Vim shortcuts (j/k/gg/G/o//…) are
      // disabled: only arrows/Enter/Escape navigate, plus any action the user
      // bound to a chord. (songgenqing report)
      const seq = (id: KeymapId): boolean => listViewBindingMatches(e, overrides, id, vimMode)
      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }

      if (k === 'Escape') {
        // Tags is a tab like a note tab — Esc clears an active filter but must
        // never close the tab (other tabs don't close on Esc). Close with :q,
        // the header ✕, or ⌘W. (#151)
        consume()
        if (filter) setFilter('')
        return
      }
      if (seq('nav.filter')) {
        consume()
        filterRef.current?.focus()
        filterRef.current?.select()
        return
      }
      if (seq('nav.localEx')) {
        consume()
        setExValue('')
        setExOpen(true)
        requestAnimationFrame(() => exRef.current?.focus())
        return
      }
      if (seq('nav.moveDown') || k === 'ArrowDown') {
        consume()
        moveCursor(1)
        return
      }
      if (seq('nav.moveUp') || k === 'ArrowUp') {
        consume()
        moveCursor(-1)
        return
      }
      if (seq('nav.jumpBottom')) {
        consume()
        moveTo(rows.length - 1)
        return
      }
      // `}` / `{` hop between notes, past a note's block rows (vim-gated).
      if (seq('tags.nextNote')) {
        consume()
        const next = nextNoteRowIndex(rows, cursorIndex)
        if (next >= 0) moveTo(next)
        return
      }
      if (seq('tags.previousNote')) {
        consume()
        const previous = previousNoteRowIndex(rows, cursorIndex)
        if (previous >= 0) moveTo(previous)
        return
      }
      if (
        listViewSequencesLive(e, vimMode) &&
        advanceSequence(
          e,
          getKeymapBinding(overrides, 'nav.jumpTop'),
          gPending,
          gTimer,
          () => moveTo(0),
          consume,
          500
        )
      ) {
        return
      }
      // `m` toggles AND/OR matching when 2+ tags are selected (vim-gated).
      if (vimMode && k === 'm' && useStore.getState().selectedTags.length >= 2) {
        consume()
        const s = useStore.getState()
        s.setTagMatchMode(s.tagMatchMode === 'all' ? 'any' : 'all')
        return
      }
      // `c` clears every selected tag at once (vim-gated). (#356)
      if (vimMode && k === 'c' && useStore.getState().selectedTags.length > 0) {
        consume()
        setSelectedTags([])
        return
      }
      if ((k === 'Enter' || seq('nav.openResult')) && current) {
        consume()
        void openRow(current)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [
    amActive,
    filter,
    moveCursor,
    moveTo,
    rows,
    cursorIndex,
    current,
    keymapOverrides,
    vimMode,
    openRow,
    closeTagView,
    setSelectedTags
  ])

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900"
      // EditorPane claims 'editor' for any click or focus inside the pane, which
      // made the key handler above stand down after the first click on a tag
      // chip or the filter. Inner capture handlers run after the pane's, so the
      // view wins it back, as Tasks and Atlas do.
      onMouseDownCapture={() => useStore.getState().setFocusedPanel('tags')}
      onFocusCapture={() => useStore.getState().setFocusedPanel('tags')}
    >
      <div className="flex items-center gap-2 border-b border-paper-300/50 px-4 py-3">
        <TagIcon width={18} height={18} />
        <h1 className="text-sm font-semibold">Tags</h1>
        <span className="ml-2 rounded bg-current/10 px-1.5 py-0.5 text-xs text-current/60">
          {matching.length} {matching.length === 1 ? 'note' : 'notes'}
          {matchingBlockCount > 0 &&
            ` · ${matchingBlockCount} ${matchingBlockCount === 1 ? 'block' : 'blocks'}`}
        </span>
        {tagBlocks.pending > 0 && (
          <span className="text-xs text-current/40">Finding tagged blocks…</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {selectedTags.length >= 2 && (
            <div className="flex items-center gap-1" title="How multiple tags combine">
              <span className="text-2xs font-semibold uppercase tracking-wider text-current/40">
                Match
              </span>
              <div className="flex overflow-hidden rounded-md ring-1 ring-paper-300/60">
                {(['all', 'any'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setTagMatchMode(m)}
                    title={
                      m === 'all'
                        ? 'All: notes with every selected tag (AND)'
                        : 'Any: notes with at least one selected tag (OR)'
                    }
                    className={[
                      'px-2 py-1 text-xs transition-colors',
                      tagMatchMode === m
                        ? 'bg-accent/20 font-medium text-accent'
                        : 'text-current/60 hover:bg-paper-200/70'
                    ].join(' ')}
                  >
                    {m === 'all' ? 'All' : 'Any'}
                  </button>
                ))}
              </div>
            </div>
          )}
          {selectedTags.length >= 1 && (
            <button
              type="button"
              onClick={() => setSelectedTags([])}
              title={vimMode ? 'Clear all selected tags (c)' : 'Clear all selected tags'}
              className="rounded-md border border-paper-300/60 px-2 py-1 text-xs text-current/60 transition-colors hover:bg-paper-200/70 hover:text-current/90"
            >
              Clear all
            </button>
          )}
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
              if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur()
            }}
            className="w-56 rounded-md border border-paper-300/60 bg-paper-200/60 px-2 py-1 text-xs outline-none focus:border-paper-400/70"
          />
          <button
            type="button"
            onClick={closeTagView}
            title="Close (:q)"
            className="flex h-6 w-6 items-center justify-center rounded-md text-current/70 hover:bg-current/10"
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      </div>

      {/* Tag chip strip — the single source of truth for what's in the
          result set. Click any chip to toggle; shows un-selected tags in
          a quieter style so the user can pick more without leaving. */}
      {allTags.length > 0 && (
        <div className="space-y-2 border-b border-paper-300/50 px-4 py-2.5">
          {selectedTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 shrink-0 text-2xs font-semibold uppercase tracking-wider text-current/40">
                Selected
              </span>
              {selectedTags.map((t) => (
                <button
                  key={`sel-${t}`}
                  type="button"
                  onClick={() => toggleTagSelection(t)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setTagMenu({ x: e.clientX, y: e.clientY, tag: t })
                  }}
                  className="flex items-center gap-1 rounded-full bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent ring-1 ring-accent/30 hover:bg-accent/30"
                  title="Click to remove · right-click for more"
                >
                  <span>#{t}</span>
                  <CloseIcon width={10} height={10} />
                </button>
              ))}
            </div>
          )}
          {nestedTags
            ? allTags.length > 0 && (
                // #439: hierarchical tree of every tag. A leaf (or real tag)
                // toggles the selection; a pure grouping node expands/collapses.
                <div className="flex items-start gap-1.5">
                  <span className="w-16 shrink-0 pt-1 text-2xs font-semibold uppercase tracking-wider text-current/40">
                    Tags
                  </span>
                  {/* Cap the tag list so a vault with many tags scrolls here
                      instead of pushing the results (and the app frame) off the
                      bottom of the viewport. (#451) */}
                  <div className="flex max-h-[40vh] min-w-0 flex-1 flex-col gap-px overflow-y-auto overscroll-contain">
                    {tagTreeRows.map((node) => {
                      const hasChildren = node.children.length > 0
                      const collapsed = collapsedTagSet.has(node.path)
                      const active = selectedTags.includes(node.path)
                      return (
                        <div
                          key={node.path}
                          style={{ paddingLeft: `${node.depth * 14}px` }}
                          className={[
                            'flex items-center gap-0.5 rounded-md pr-1',
                            active ? 'bg-accent/15' : 'hover:bg-current/5'
                          ].join(' ')}
                        >
                          {hasChildren ? (
                            <button
                              type="button"
                              title={collapsed ? 'Expand' : 'Collapse'}
                              aria-label={collapsed ? 'Expand' : 'Collapse'}
                              onClick={() => toggleCollapseTagNode(node.path)}
                              className="flex h-6 w-4 shrink-0 items-center justify-center text-current/50 hover:text-current/90"
                            >
                              <svg
                                viewBox="0 0 24 24"
                                width="10"
                                height="10"
                                aria-hidden="true"
                                className={collapsed ? '' : 'rotate-90'}
                              >
                                <path
                                  d="M9 6l6 6-6 6"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </button>
                          ) : (
                            <span className="h-6 w-4 shrink-0" />
                          )}
                          <button
                            type="button"
                            title={node.isTag ? `#${node.path}` : node.path}
                            onClick={() =>
                              node.isTag
                                ? toggleTagSelection(node.path)
                                : toggleCollapseTagNode(node.path)
                            }
                            className={[
                              'flex min-w-0 flex-1 items-center py-1 text-left text-xs',
                              active
                                ? 'font-medium text-accent'
                                : node.isTag
                                  ? 'text-current/80'
                                  : 'text-current/50'
                            ].join(' ')}
                          >
                            <span className="truncate">{node.name}</span>
                            <span className="ml-auto shrink-0 pl-2 text-current/40">
                              {node.isTag ? node.count : node.subtreeCount}
                            </span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            : allTags.length > selectedTags.length && (
                <div className="flex items-start gap-1.5">
                  <span className="w-16 shrink-0 pt-1 text-2xs font-semibold uppercase tracking-wider text-current/40">
                    {selectedTags.length > 0 ? 'Add' : 'Tags'}
                  </span>
                  {/* Cap the tag chips so many tags scroll here rather than
                      overflowing the app frame. (#451) */}
                  <div className="flex max-h-[40vh] min-w-0 flex-1 flex-wrap items-center gap-1.5 overflow-y-auto overscroll-contain">
                    {allTags
                      .filter(([t]) => !selectedTags.includes(t))
                      .map(([t, count]) => (
                        <button
                          key={`pick-${t}`}
                          type="button"
                          onClick={() => toggleTagSelection(t)}
                          className="rounded-full bg-current/5 px-2 py-0.5 text-xs text-current/70 hover:bg-current/15 hover:text-current/90"
                        >
                          #{t}
                          <span className="ml-1 text-current/40">{count}</span>
                        </button>
                      ))}
                  </div>
                </div>
              )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {selectedTags.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-current/50">
            Pick one or more tags above to see matching notes.
          </div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-current/50">
            {matching.length === 0
              ? tagMatchMode === 'all' && selectedTags.length >= 2
                ? 'No notes carry all of the selected tags. Try Match: Any.'
                : 'No notes carry any of the selected tags.'
              : `No notes match "${filter}".`}
          </div>
        ) : (
          rows.map((row, i) => {
            const isCursor = i === cursorIndex
            if (row.kind === 'block') {
              const { note, block } = row
              return (
                <button
                  key={row.key}
                  type="button"
                  data-tag-view-index={i}
                  data-tag-block-row={`${note.path}:${block.startLine + 1}`}
                  onMouseMove={() => moveTo(i)}
                  onClick={() => {
                    moveTo(i)
                    void openBlock(note, block)
                  }}
                  title={`Open ${note.title || 'note'} at line ${block.startLine + 1}`}
                  className={[
                    'flex w-full items-start gap-2 rounded-md py-1.5 pl-9 pr-3 text-left transition-colors',
                    isCursor ? 'vim-cursor' : 'hover:bg-current/5'
                  ].join(' ')}
                >
                  <span className="min-w-0 flex-1 border-l-2 border-paper-300/70 pl-2.5">
                    <TaggedBlockText block={block} tags={selectedTags} highlight={filter} />
                  </span>
                  <span className="shrink-0 pt-0.5 font-mono text-2xs text-current/40">
                    L{block.startLine + 1}
                  </span>
                </button>
              )
            }
            const { note } = row
            return (
              <button
                key={row.key}
                type="button"
                data-tag-view-index={i}
                data-tag-row={note.path}
                onMouseMove={() => moveTo(i)}
                onClick={() => {
                  moveTo(i)
                  void openNote(note)
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
                  <div className="mt-0.5 truncate text-xs text-current/50">
                    {folderLabel(note) || note.folder}
                  </div>
                  {/* The tagged blocks listed below say more than the opening
                      of the note, so the excerpt only shows without them. */}
                  {note.excerpt && row.blockCount === 0 && (
                    <div className="mt-0.5 truncate text-xs text-current/40">
                      {note.excerpt}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-xs text-current/40">
                  {formatDate(note.updatedAt)}
                </span>
              </button>
            )
          })
        )}
      </div>

      {exOpen ? (
        <form
          className="flex items-center gap-1 border-t border-paper-300/50 px-4 py-1.5 font-mono text-xs"
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
        <div className="border-t border-paper-300/50 px-4 py-1.5 text-xs text-current/40">
          {vimMode
            ? 'j/k move · {/} prev/next note · Enter/o open note or block · click chips to toggle · c clear tags · / filter · : command · :q close'
            : '↑/↓ move · Enter open note or block · click chips to toggle'}
        </div>
      )}
      {tagMenu && (
        <ContextMenu
          x={tagMenu.x}
          y={tagMenu.y}
          items={tagMenuItems}
          onClose={() => setTagMenu(null)}
        />
      )}
    </div>
  )
}
