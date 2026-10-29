import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NoteMeta } from '@shared/ipc'
import type { NoteCover } from '@shared/note-cover'
import { noteCoverCreditLine } from '@shared/unsplash'
import { useStore } from '../store'
import {
  GALLERY_SORTS,
  GALLERY_SORT_LABELS,
  filterGalleryNotes,
  formatGalleryDate,
  galleryCardTimestamp,
  galleryContentHeight,
  galleryFolderExists,
  galleryFolderFromTabPath,
  galleryFolderName,
  galleryGeometry,
  galleryInitial,
  galleryNotesIn,
  galleryRowRange,
  galleryScrollTopFor,
  galleryThumbnail,
  normalizeGallerySort,
  sortGalleryNotes,
  stepGalleryCursor,
  type GalleryGeometry,
  type GalleryMove,
  type GalleryThumbnailSource
} from '../lib/folder-gallery'
import { galleryCoverCache, runLimited } from '../lib/gallery-covers'
import { resolveLocalAsset } from '../lib/local-assets'
import { focusEditorNormalMode } from '../lib/editor-focus'
import { isOverlayOrDialogOpen } from '../lib/overlay-open'
import { advanceSequence, getKeymapBinding, type KeymapId } from '../lib/keymaps'
import {
  listViewBindingMatches,
  listViewKey,
  listViewSequencesLive,
  listViewYieldsKey
} from '../lib/list-view-keys'
import { resolveSystemFolderLabels } from '../lib/system-folder-labels'
import { NoteCoverCredit } from './NoteCoverCredit'
import { GalleryIcon, SearchIcon } from './icons'

// Every action this view answers, so a chord bound to one reaches it (#972).
const GALLERY_VIEW_ACTIONS: readonly KeymapId[] = [
  'nav.filter',
  'nav.moveDown',
  'nav.moveUp',
  'nav.moveLeft',
  'nav.moveRight',
  'nav.jumpBottom',
  'nav.jumpTop',
  'nav.openResult'
]

/** Reads at once for the covers on screen; a fast scroll queues no more. */
const COVER_READ_CONCURRENCY = 4
/** A row flying past during a scroll is not worth a read. */
const COVER_READ_DELAY_MS = 60
/** Rows mounted above and below the screen, so a scroll never shows a gap. */
const OVERSCAN_ROWS = 2

/** Where each Gallery tab was, so coming back to it (Ctrl+O after opening a
 *  note, or its tab) lands on the card it left from. */
interface GalleryMemory {
  cursorPath: string | null
  scrollTop: number
  filter: string
}
const galleryMemory = new Map<string, GalleryMemory>()

function coverScope(s: {
  workspaceMode: string
  vault: { root: string } | null
  remoteWorkspaceInfo: { baseUrl?: string | null } | null
}): string {
  return [s.workspaceMode, s.vault?.root ?? '', s.remoteWorkspaceInfo?.baseUrl ?? ''].join('\0')
}

/** The note's text the way the editor gets it: an open buffer first (it has
 *  unsaved edits, and costs no read), the bridge otherwise. */
async function readNoteBody(path: string): Promise<string> {
  const open = useStore.getState().noteContents[path]?.body
  if (open != null) return open
  return (await window.zen.readNote(path)).body
}

/**
 * Reads the covers of `notes` (the cards on screen) that the cache does not
 * know yet, a few at a time, and answers with a number that changes as they
 * land. A scroll that moves on cancels what has not started.
 */
function useGalleryCovers(notes: readonly NoteMeta[], scope: string): number {
  const [version, setVersion] = useState(0)
  galleryCoverCache.setScope(scope)
  const key = notes.map((note) => `${note.path}\0${note.updatedAt}`).join('\n')
  useEffect(() => {
    const missing = notes.filter((note) => galleryCoverCache.peek(note) === undefined)
    if (missing.length === 0) return
    let cancelled = false
    let frame = 0
    const bump = (): void => {
      if (cancelled || frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setVersion((v) => v + 1)
      })
    }
    const timer = window.setTimeout(() => {
      void runLimited(
        missing,
        COVER_READ_CONCURRENCY,
        async (note) => {
          await galleryCoverCache.load(note, readNoteBody)
          bump()
        },
        () => cancelled
      )
    }, COVER_READ_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (frame) cancelAnimationFrame(frame)
    }
    // `notes` is read through `key`: a new array with the same notes must not
    // restart the reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scope])
  return version
}

interface GalleryCardProps {
  note: NoteMeta
  index: number
  cursor: boolean
  /** Undefined while the note has not been read. */
  cover: NoteCover | null | undefined
  /** The picture to draw (galleryThumbnail), as plain values so a card
   *  whose picture did not change skips the render. */
  imageUrl: string | null
  imageY: number
  imageSource: GalleryThumbnailSource | null
  dateLabel: string
  geometry: GalleryGeometry
  onOpen: (index: number) => void
}

const GalleryCard = memo(function GalleryCard({
  note,
  index,
  cursor,
  cover,
  imageUrl,
  imageY,
  imageSource,
  dateLabel,
  geometry,
  onOpen
}: GalleryCardProps): JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [imageUrl])
  const showImage = !!imageUrl && !failed
  const state = cover === undefined ? 'loading' : showImage ? 'image' : 'placeholder'
  const credit = showImage && cover ? noteCoverCreditLine(cover) : null
  return (
    <div
      role="button"
      tabIndex={-1}
      data-gallery-card=""
      data-gallery-path={note.path}
      data-gallery-index={index}
      data-gallery-cursor={cursor ? 'true' : undefined}
      data-gallery-thumb={state}
      data-gallery-thumb-source={showImage ? (imageSource ?? undefined) : undefined}
      aria-label={`${note.title}, ${dateLabel}`}
      title={note.path}
      onClick={() => onOpen(index)}
      className={[
        'group relative flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg border bg-paper-50 outline-none transition-colors',
        cursor
          ? 'border-accent ring-2 ring-accent/60'
          : 'border-paper-300/70 hover:border-paper-400'
      ].join(' ')}
      style={{ height: geometry.cardHeight }}
    >
      <div
        className="zen-gallery-cover relative w-full shrink-0 overflow-hidden bg-paper-200"
        style={{ height: geometry.coverHeight }}
      >
        {showImage && imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="pointer-events-none h-full w-full object-cover"
            style={{ objectPosition: `50% ${Math.round(imageY * 1000) / 10}%` }}
          />
        ) : state === 'placeholder' ? (
          <div
            aria-hidden="true"
            className="flex h-full w-full select-none items-center justify-center text-3xl font-semibold text-ink-400"
          >
            {galleryInitial(note.title)}
          </div>
        ) : null}
        {credit && (
          // The credit's links open the photographer's page, not the note.
          <div onClick={(e) => e.stopPropagation()}>
            <NoteCoverCredit line={credit} persistent={false} compact />
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-0.5 px-3">
        <div data-gallery-title="" className="truncate text-sm font-medium text-ink-900">
          {note.title}
        </div>
        <div data-gallery-date="" className="truncate text-xs text-ink-500">
          {dateLabel}
        </div>
      </div>
    </div>
  )
})

/**
 * A folder's Gallery: its notes as a grid of cards, each led by the note's
 * cover (an image in the vault, an Unsplash photo or a gradient), then its
 * title and date. Asked for by charles b. once covers shipped.
 *
 * Only the rows on screen are mounted, and only the cards on screen have
 * their notes read for a cover (gallery-covers.ts), so a folder of a
 * thousand notes opens as fast as one of ten. With Vim on, h/j/k/l move
 * across the grid, gg/G jump to the ends, Enter or o opens and / filters by
 * title; with it off the arrows, Enter and Escape do the work. The view holds
 * the keyboard the way the Unresolved Links view does: VimNav stands down
 * for it except for the leader.
 */
export function GalleryView({ tabPath, isActive }: { tabPath: string; isActive: boolean }): JSX.Element {
  const target = useMemo(() => galleryFolderFromTabPath(tabPath), [tabPath])
  const notes = useStore((s) => s.notes)
  const folders = useStore((s) => s.folders)
  const vaultSettings = useStore((s) => s.vaultSettings)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const vaultRoot = useStore((s) => s.vault?.root ?? null)
  // Subscribed so a vault cover resolves as soon as the file list lands.
  const assetFiles = useStore((s) => s.assetFiles)
  const assetFilesListed = useStore((s) => s.assetFilesListed)
  const sort = useStore((s) => s.gallerySort)
  const setSort = useStore((s) => s.setGallerySort)
  const includeSubfolders = useStore((s) => s.galleryIncludeSubfolders)
  const setIncludeSubfolders = useStore((s) => s.setGalleryIncludeSubfolders)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const vimMode = useStore((s) => s.vimMode)
  const selectNote = useStore((s) => s.selectNote)
  const scope = useStore(coverScope)

  const remembered = galleryMemory.get(tabPath)
  const [filter, setFilter] = useState(remembered?.filter ?? '')
  const [cursorPath, setCursorPath] = useState<string | null>(remembered?.cursorPath ?? null)
  const [scrollTop, setScrollTop] = useState(remembered?.scrollTop ?? 0)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const filterRef = useRef<HTMLInputElement | null>(null)
  const revealCursor = useRef(false)
  const gPending = useRef(0)
  const gTimer = useRef<ReturnType<typeof setTimeout>>()

  const labels = useMemo(() => resolveSystemFolderLabels(systemFolderLabels), [systemFolderLabels])
  const exists = target ? galleryFolderExists(target, folders) : false

  const inFolder = useMemo(
    () => (target ? galleryNotesIn(notes, target, includeSubfolders, vaultSettings) : []),
    [notes, target, includeSubfolders, vaultSettings]
  )
  // Notes the switch would add: an empty folder with full subfolders says so.
  const belowCount = useMemo(
    () =>
      target && !includeSubfolders
        ? galleryNotesIn(notes, target, true, vaultSettings).length - inFolder.length
        : 0,
    [notes, target, includeSubfolders, vaultSettings, inFolder.length]
  )
  const sorted = useMemo(() => sortGalleryNotes(inFolder, sort), [inFolder, sort])
  const items = useMemo(() => filterGalleryNotes(sorted, filter), [sorted, filter])

  const geometry = useMemo(() => galleryGeometry(size.width), [size.width])
  const cursor = Math.max(
    0,
    cursorPath ? items.findIndex((note) => note.path === cursorPath) : 0
  )
  const current = items[cursor] ?? null

  // Remember where this tab was, for the next time it shows.
  useEffect(() => {
    galleryMemory.set(tabPath, { cursorPath: current?.path ?? null, scrollTop, filter })
  }, [tabPath, current, scrollTop, filter])

  // The scroller's size decides the columns and which rows are on screen.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => {
      setSize((prev) =>
        prev.width === el.clientWidth && prev.height === el.clientHeight
          ? prev
          : { width: el.clientWidth, height: el.clientHeight }
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Put a remembered scroll back once the grid has a size to scroll in.
  const restored = useRef(false)
  useLayoutEffect(() => {
    if (restored.current || size.width === 0) return
    restored.current = true
    const el = scrollRef.current
    if (el && remembered?.scrollTop) el.scrollTop = remembered.scrollTop
    // Only on the first measured layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width])

  // Keep the cursor's card in view when the keyboard moves it.
  useEffect(() => {
    if (!revealCursor.current) return
    revealCursor.current = false
    const el = scrollRef.current
    if (!el || size.height === 0) return
    const next = galleryScrollTopFor(cursor, geometry, el.scrollTop, el.clientHeight)
    if (next !== el.scrollTop) el.scrollTop = next
  }, [cursor, geometry, size.height])

  // Take the keyboard when the view comes up with nothing else holding it.
  useEffect(() => {
    if (!isActive) return
    const raf = requestAnimationFrame(() => {
      const active = document.activeElement
      if (!active || active === document.body) rootRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(raf)
  }, [isActive])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) setScrollTop(el.scrollTop)
  }, [])

  const rendered = galleryRowRange(items.length, geometry, scrollTop, size.height, OVERSCAN_ROWS)
  const onScreen = galleryRowRange(items.length, geometry, scrollTop, size.height, 0)
  const visibleNotes = useMemo(
    () =>
      size.width === 0
        ? []
        : items.slice(onScreen.start * geometry.columns, onScreen.end * geometry.columns),
    [items, onScreen.start, onScreen.end, geometry.columns, size.width]
  )
  useGalleryCovers(visibleNotes, scope)

  const openAt = useCallback(
    async (index: number) => {
      const note = items[index]
      if (!note) return
      setCursorPath(note.path)
      galleryMemory.set(tabPath, {
        cursorPath: note.path,
        scrollTop: scrollRef.current?.scrollTop ?? 0,
        filter
      })
      await selectNote(note.path)
      focusEditorNormalMode()
    },
    [filter, items, selectNote, tabPath]
  )

  // One callback for every card, so a card that did not change skips the
  // render; it reaches the latest openAt through the ref.
  const openRef = useRef(openAt)
  openRef.current = openAt
  const onOpenCard = useCallback((index: number) => void openRef.current(index), [])

  const move = useCallback(
    (direction: GalleryMove) => {
      const next = stepGalleryCursor(cursor, items.length, geometry.columns, direction)
      if (next < 0) return
      revealCursor.current = true
      setCursorPath(items[next]?.path ?? null)
    },
    [cursor, geometry.columns, items]
  )

  useEffect(() => {
    if (!isActive) return
    const handler = (e: KeyboardEvent): void => {
      if (isOverlayOrDialogOpen()) return
      const focusedPanel = useStore.getState().focusedPanel
      if (focusedPanel !== null && focusedPanel !== 'editor') return
      const eventTarget = e.target instanceof HTMLElement ? e.target : null
      if (eventTarget) {
        const tag = eventTarget.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || eventTarget.isContentEditable)
          return
      }
      const overrides = keymapOverrides
      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      // A chord gets through only as the key of one of this view's actions,
      // and never past a global shortcut (#972, lib/list-view-keys.ts).
      if (listViewYieldsKey(e, overrides, GALLERY_VIEW_ACTIONS, vimMode)) return
      // With Vim off, single-key shortcuts stay off: the arrows, Enter and
      // Escape, plus any action the user bound to a chord.
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
      if (seq('nav.moveLeft') || key === 'ArrowLeft') {
        consume()
        move('left')
        return
      }
      if (seq('nav.moveRight') || key === 'ArrowRight') {
        consume()
        move('right')
        return
      }
      if (seq('nav.moveDown') || key === 'ArrowDown') {
        consume()
        move('down')
        return
      }
      if (seq('nav.moveUp') || key === 'ArrowUp') {
        consume()
        move('up')
        return
      }
      if (seq('nav.jumpBottom')) {
        consume()
        move('last')
        return
      }
      if (
        listViewSequencesLive(e, vimMode) &&
        advanceSequence(
          e,
          getKeymapBinding(overrides, 'nav.jumpTop'),
          gPending,
          gTimer,
          () => move('first'),
          consume,
          500
        )
      ) {
        return
      }
      if ((key === 'Enter' || seq('nav.openResult')) && current) {
        consume()
        void openAt(cursor)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => {
      if (gTimer.current) clearTimeout(gTimer.current)
      window.removeEventListener('keydown', handler, true)
    }
  }, [cursor, current, filter, isActive, keymapOverrides, move, openAt, vimMode])

  const resolveVault = useCallback(
    (notePath: string) =>
      (href: string): string | null => {
        const asset = resolveLocalAsset(vaultRoot, notePath, href)
        return asset && !asset.missing ? asset.url : null
      },
    // The asset list is read inside resolveLocalAsset; a new list means new
    // answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vaultRoot, assetFiles, assetFilesListed]
  )

  if (!target) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-paper-100 px-6 text-sm text-ink-400">
        This Gallery tab does not name a folder.
      </div>
    )
  }

  const name = galleryFolderName(target, labels)
  const place = target.subpath ? `${labels[target.folder]} / ${target.subpath}` : labels[target.folder]
  const total = inFolder.length
  const countLabel = filter.trim()
    ? `${items.length} of ${total} ${total === 1 ? 'note' : 'notes'}`
    : `${total} ${total === 1 ? 'note' : 'notes'}`
  const now = Date.now()

  const rows: JSX.Element[] = []
  if (size.width > 0) {
    for (let row = rendered.start; row < rendered.end; row += 1) {
      const cards: JSX.Element[] = []
      for (let col = 0; col < geometry.columns; col += 1) {
        const index = row * geometry.columns + col
        const note = items[index]
        if (!note) break
        const cover = galleryCoverCache.peek(note)
        const thumbnail = galleryThumbnail(cover ?? null, resolveVault(note.path))
        const image = thumbnail.kind === 'image' ? thumbnail : null
        cards.push(
          <GalleryCard
            key={note.path}
            note={note}
            index={index}
            cursor={index === cursor}
            cover={cover}
            imageUrl={image?.url ?? null}
            imageY={image?.y ?? 0.5}
            imageSource={image?.source ?? null}
            dateLabel={formatGalleryDate(galleryCardTimestamp(note, sort), now)}
            geometry={geometry}
            onOpen={onOpenCard}
          />
        )
      }
      rows.push(
        <div
          key={row}
          data-gallery-row={row}
          className="absolute grid"
          style={{
            top: geometry.padding + row * geometry.rowHeight,
            left: geometry.padding,
            right: geometry.padding,
            height: geometry.cardHeight,
            gridTemplateColumns: `repeat(${geometry.columns}, minmax(0, 1fr))`,
            columnGap: geometry.gap
          }}
        >
          {cards}
        </div>
      )
    }
  }

  const empty = !exists
    ? 'This folder is no longer in the vault.'
    : total === 0
      ? belowCount > 0
        ? `No notes here yet. Include subfolders to see the ${belowCount} ${belowCount === 1 ? 'note' : 'notes'} below this folder.`
        : 'No notes in this folder yet.'
      : items.length === 0
        ? `No note titles match “${filter.trim()}”.`
        : null

  return (
    <div
      ref={rootRef}
      data-gallery-view=""
      data-gallery-folder={target.folder}
      data-gallery-subpath={target.subpath}
      data-gallery-count={items.length}
      data-gallery-columns={geometry.columns}
      tabIndex={0}
      aria-label={`Gallery of ${place}`}
      className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900 outline-none"
    >
      <header className="glass-header flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <GalleryIcon className="h-4 w-4 shrink-0 text-ink-500" />
          <h2 className="truncate text-sm font-semibold text-ink-900" title={place}>
            {name}
          </h2>
          <span className="shrink-0 text-xs text-ink-500" data-gallery-count-label="">
            Gallery · {countLabel}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-500">
            Sort
            <select
              data-gallery-sort=""
              value={sort}
              onChange={(e) => setSort(normalizeGallerySort(e.target.value))}
              className="rounded-md border border-paper-300/60 bg-paper-200/60 px-2 py-0.5 text-xs text-ink-800 outline-none focus:border-paper-400/70"
            >
              {GALLERY_SORTS.map((option) => (
                <option key={option} value={option}>
                  {GALLERY_SORT_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-500">
            <button
              type="button"
              role="switch"
              aria-checked={includeSubfolders}
              data-gallery-subfolders=""
              onClick={() => setIncludeSubfolders(!includeSubfolders)}
              className={[
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                includeSubfolders ? 'bg-accent' : 'bg-paper-300'
              ].join(' ')}
            >
              <span
                className={[
                  'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                  includeSubfolders ? 'translate-x-4' : 'translate-x-0.5'
                ].join(' ')}
              />
            </button>
            Include subfolders
          </label>
          <div className="flex items-center gap-1.5 rounded-md bg-paper-200/60 px-2 py-1">
            <SearchIcon className="h-3.5 w-3.5 shrink-0 text-ink-400" />
            <input
              ref={filterRef}
              data-gallery-filter=""
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
                setCursorPath(null)
                if (scrollRef.current) scrollRef.current.scrollTop = 0
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'ArrowDown') {
                  e.preventDefault()
                  if (e.key === 'Escape') setFilter('')
                  rootRef.current?.focus({ preventScroll: true })
                }
              }}
              placeholder="Filter by title"
              aria-label="Filter the Gallery by title"
              className="w-36 bg-transparent text-xs text-ink-900 outline-none placeholder:text-ink-400"
            />
          </div>
        </div>
      </header>
      <div
        ref={scrollRef}
        data-gallery-scroller=""
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        {empty ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink-400">
            {empty}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: galleryContentHeight(items.length, geometry) }}>
            {rows}
          </div>
        )}
      </div>
    </div>
  )
}
