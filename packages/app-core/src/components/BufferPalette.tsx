/**
 * Space-o / :buffers / :ls → a searchable list of every open buffer
 * (tab) across every pane. Styled to match SearchPalette so switching
 * between `:search` and `:buffers` feels like the same overlay with a
 * different source.
 *
 * Open behavior mirrors vim splits: if the target buffer is already
 * active in some pane we focus that pane; if it's loaded in another
 * pane (not active), we activate that pane on it; otherwise we open
 * it in the currently active pane.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { rankItems } from '../lib/fuzzy-score'
import {
  allLeaves,
  findLeafWithActiveTab,
  findLeavesContaining
} from '../lib/pane-layout'
import { isHelpTabPath } from '@shared/help'
import { isTagsTabPath } from '@shared/tags'
import { isTasksTabPath } from '@shared/tasks'
import { isArchiveTabPath } from '@shared/archive'
import { isTrashTabPath } from '@shared/trash'
import { isQuickNotesTabPath } from '@shared/quick-notes'
import { resolveSystemFolderLabels, type SystemFolderLabels } from '../lib/system-folder-labels'

interface BufferEntry {
  path: string
  title: string
  subtitle: string
  keywords: string
  badge: string
  current: boolean
  dirty: boolean
  virtual: boolean
}

function fallbackTitle(path: string): string {
  const filename = path.split('/').pop() ?? path
  return filename.replace(/\.md$/i, '') || path
}

interface BuildDeps {
  paneLayout: ReturnType<typeof useStore.getState>['paneLayout']
  activePaneId: string
  selectedPath: string | null
  noteContents: ReturnType<typeof useStore.getState>['noteContents']
  notes: ReturnType<typeof useStore.getState>['notes']
  noteDirty: ReturnType<typeof useStore.getState>['noteDirty']
  systemFolderLabels: SystemFolderLabels
}

function buildEntries(deps: BuildDeps): BufferEntry[] {
  const labels = resolveSystemFolderLabels(deps.systemFolderLabels)
  const leaves = allLeaves(deps.paneLayout)
  const activeLeafId = deps.activePaneId
  const seen = new Set<string>()
  const entries: BufferEntry[] = []

  const push = (path: string): void => {
    if (seen.has(path)) return
    seen.add(path)

    const activeInSomeLeaf = leaves.some((leaf) => leaf.activeTab === path)
    const inActivePane = leaves.some(
      (leaf) => leaf.id === activeLeafId && leaf.tabs.includes(path)
    )
    const isCurrent = leaves.some(
      (leaf) => leaf.id === activeLeafId && leaf.activeTab === path
    )

    let badge: string
    if (isCurrent) badge = 'current'
    else if (activeInSomeLeaf) badge = 'split'
    else if (inActivePane) badge = 'hidden'
    else badge = 'recent'

    if (isTasksTabPath(path)) {
      entries.push({
        path,
        title: 'Tasks',
        subtitle: 'Vault-wide task list',
        keywords: 'tasks todos checklist vault virtual',
        badge,
        current: isCurrent,
        dirty: false,
        virtual: true
      })
      return
    }
    if (isQuickNotesTabPath(path)) {
      entries.push({
        path,
        title: labels.quick,
        subtitle: 'Quick capture notes list',
        keywords: 'quick notes capture scratch inbox virtual',
        badge,
        current: isCurrent,
        dirty: false,
        virtual: true
      })
      return
    }
    if (isTagsTabPath(path)) {
      entries.push({
        path,
        title: 'Tags',
        subtitle: 'Vault-wide tag browser',
        keywords: 'tags browse filter vault virtual',
        badge,
        current: isCurrent,
        dirty: false,
        virtual: true
      })
      return
    }
    if (isHelpTabPath(path)) {
      entries.push({
        path,
        title: 'Help',
        subtitle: 'Built-in manual and shortcuts',
        keywords: 'help manual docs shortcuts vim virtual',
        badge,
        current: isCurrent,
        dirty: false,
        virtual: true
      })
      return
    }
    if (isArchiveTabPath(path)) {
      entries.push({
        path,
        title: labels.archive,
        subtitle: 'Archived notes list',
        keywords: 'archive archived storage cold notes list virtual',
        badge,
        current: isCurrent,
        dirty: false,
        virtual: true
      })
      return
    }
    if (isTrashTabPath(path)) {
      entries.push({
        path,
        title: labels.trash,
        subtitle: 'Deleted notes and recovery',
        keywords: 'trash deleted restore bin recovery virtual',
        badge,
        current: isCurrent,
        dirty: false,
        virtual: true
      })
      return
    }

    const meta =
      deps.noteContents[path] ?? deps.notes.find((note) => note.path === path) ?? null
    const title = meta?.title?.trim() || fallbackTitle(path)
    entries.push({
      path,
      title,
      subtitle: path,
      keywords: [title, path, meta?.folder].filter(Boolean).join(' '),
      badge,
      current: isCurrent,
      dirty: deps.noteDirty[path] ?? false,
      virtual: false
    })
  }

  // Order in which paths are collected doubles as the natural default
  // sort: non-current first (so Enter switches away from the current
  // buffer), current last.
  for (const leaf of leaves) {
    if (leaf.id === activeLeafId) continue
    if (leaf.activeTab) push(leaf.activeTab)
  }
  for (const leaf of leaves) {
    if (leaf.id === activeLeafId) continue
    for (const path of leaf.tabs) push(path)
  }
  const activeLeaf = leaves.find((leaf) => leaf.id === activeLeafId)
  for (const path of activeLeaf?.tabs ?? []) {
    if (path === activeLeaf?.activeTab) continue
    push(path)
  }
  if (activeLeaf?.activeTab) push(activeLeaf.activeTab)
  if (deps.selectedPath) push(deps.selectedPath)

  return entries
}

export function BufferPalette(): JSX.Element {
  const setOpen = useStore((s) => s.setBufferPaletteOpen)
  const setActivePane = useStore((s) => s.setActivePane)
  const focusTabInPane = useStore((s) => s.focusTabInPane)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)

  // Select primitives separately so each selector returns a stable
  // reference; compute the derived entries list with useMemo. Returning
  // a freshly-built array from a single selector would trip zustand's
  // getSnapshot stability check and loop forever.
  const paneLayout = useStore((s) => s.paneLayout)
  const activePaneId = useStore((s) => s.activePaneId)
  const selectedPath = useStore((s) => s.selectedPath)
  const noteContents = useStore((s) => s.noteContents)
  const notes = useStore((s) => s.notes)
  const noteDirty = useStore((s) => s.noteDirty)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)

  const entries = useMemo(
    () =>
      buildEntries({
        paneLayout,
        activePaneId,
        selectedPath,
        noteContents,
        notes,
        noteDirty,
        systemFolderLabels
      }),
    [paneLayout, activePaneId, selectedPath, noteContents, notes, noteDirty, systemFolderLabels]
  )

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const results = useMemo<BufferEntry[]>(
    () =>
      rankItems(entries, query, [
        { get: (entry) => entry.title, weight: 1 },
        { get: (entry) => entry.subtitle, weight: 0.9 },
        { get: (entry) => entry.keywords, weight: 0.6 }
      ]),
    [entries, query]
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-buf-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const open = async (entry: BufferEntry): Promise<void> => {
    setOpen(false)
    const state = useStore.getState()

    const activeLeaf = findLeafWithActiveTab(state.paneLayout, entry.path)
    if (activeLeaf) {
      setActivePane(activeLeaf.id)
    } else {
      const containing = findLeavesContaining(state.paneLayout, entry.path)[0]
      const targetPaneId = containing?.id ?? state.activePaneId
      await focusTabInPane(targetPaneId, entry.path)
      setActivePane(targetPaneId)
    }

    setFocusedPanel('editor')
    requestAnimationFrame(() => {
      useStore.getState().editorViewRef?.focus()
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[15vh] backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[min(560px,90vw)] overflow-hidden rounded-xl bg-paper-100 shadow-float ring-1 ring-paper-300/70"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-paper-300/70 px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            placeholder="Switch buffer…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(results.length - 1, a + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const entry = results[active]
                if (entry) void open(entry)
              }
            }}
            className="w-full bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-x-hidden overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-ink-400">
              {entries.length === 0 ? 'No open buffers yet.' : 'No matching buffers.'}
            </div>
          ) : (
            results.map((entry, i) => (
              <button
                key={entry.path}
                data-buf-idx={i}
                onClick={() => void open(entry)}
                onMouseMove={() => setActive(i)}
                className={[
                  'flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left',
                  i === active ? 'bg-paper-200' : 'hover:bg-paper-200/70'
                ].join(' ')}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">
                  {entry.title}
                  {entry.dirty && (
                    <span
                      className="ml-2 align-middle text-[11px] text-accent"
                      aria-label="Unsaved changes"
                    >
                      •
                    </span>
                  )}
                </span>
                <span className="shrink-0 truncate text-[11px] text-ink-400">
                  {entry.virtual ? 'virtual' : entry.subtitle}
                </span>
                <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-400">
                  {entry.badge}
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
            <kbd className="rounded bg-paper-200 px-1">↵</kbd> switch
          </span>
          <span>
            <kbd className="rounded bg-paper-200 px-1">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
