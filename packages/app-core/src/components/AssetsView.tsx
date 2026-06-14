import { useEffect, useMemo, useRef, useState } from 'react'
import type { AssetMeta } from '@shared/ipc'
import { isDatabaseCsvPath } from '@shared/databases'
import { useStore } from '../store'
import { useT } from '../lib/i18n'
import { getSystemFolderLabel } from '../lib/system-folder-labels'
import { assetTabPath } from '../lib/asset-tabs'
import { promptApp } from '../lib/prompt-requests'
import { confirmApp } from '../lib/confirm-requests'
import { droppedPathsFromTransfer, hasDroppedFiles } from '../lib/editor-drops'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Button, IconButton } from './ui/Button'
import {
  PaperclipIcon,
  ImageIcon,
  FilmIcon,
  MusicIcon,
  DocumentIcon,
  PlusIcon,
  TrashIcon,
  SortIcon,
  PanelLeftIcon
} from './icons'

/** Placeholder glyph shown when an asset has no usable thumbnail. */
function kindGlyph(kind: AssetMeta['kind']): JSX.Element {
  const cls = 'h-7 w-7'
  if (kind === 'video') return <FilmIcon className={cls} />
  if (kind === 'audio') return <MusicIcon className={cls} />
  if (kind === 'pdf') return <DocumentIcon className={cls} />
  if (kind === 'image') return <ImageIcon className={cls} />
  return <PaperclipIcon className={cls} />
}

type AssetKind = AssetMeta['kind']
type AssetFilter = 'all' | AssetKind
type SortKey = 'updated' | 'name' | 'size'
type SortDir = 'asc' | 'desc'

// One chip per kind; only kinds that actually have files are shown (plus All).
const KIND_FILTERS: { key: AssetKind; label: string }[] = [
  { key: 'image', label: 'Images' },
  { key: 'video', label: 'Video' },
  { key: 'audio', label: 'Audio' },
  { key: 'pdf', label: 'PDF' },
  { key: 'file', label: 'Other' }
]

function formatBytes(n: number): string {
  if (!n) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/**
 * The Assets (resources) view: a filterable, sortable grid of every non-note,
 * non-database file in the vault. Each card previews the file (image directly,
 * everything else via an OS thumbnail), surfaces a one-click "copy as embed",
 * and shares the same right-click menu as the sidebar.
 */
export function AssetsView(): JSX.Element {
  const t = useT()
  const assetFiles = useStore((s) => s.assetFiles)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const assetsLabel = getSystemFolderLabel('assets', systemFolderLabels, t)
  const vault = useStore((s) => s.vault)
  const workspaceMode = useStore((s) => s.workspaceMode)
  const refreshAssets = useStore((s) => s.refreshAssets)
  const deleteAssetAction = useStore((s) => s.deleteAsset)
  const openNoteInTab = useStore((s) => s.openNoteInTab)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)

  const [filter, setFilter] = useState<AssetFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('updated')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [menu, setMenu] = useState<{ asset: AssetMeta; x: number; y: number } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({})
  const requested = useRef<Set<string>>(new Set())

  const isDesktop = window.zen.getAppInfo().runtime === 'desktop'
  const canManage =
    isDesktop &&
    workspaceMode !== 'remote' &&
    typeof window.zen.renameAsset === 'function' &&
    typeof window.zen.moveAsset === 'function' &&
    typeof window.zen.duplicateAsset === 'function'
  const canImport = isDesktop && workspaceMode !== 'remote'
  const canReveal = isDesktop && workspaceMode !== 'remote'

  // Databases are documents, not assets — never list them here.
  const assets = useMemo(
    () => assetFiles.filter((a) => !isDatabaseCsvPath(a.path)),
    [assetFiles]
  )
  const counts = useMemo(() => {
    const c: Record<string, number> = {
      all: assets.length,
      image: 0,
      video: 0,
      audio: 0,
      pdf: 0,
      file: 0
    }
    for (const a of assets) c[a.kind] = (c[a.kind] ?? 0) + 1
    return c
  }, [assets])

  // All + only the kinds present. If the active kind filter empties out (e.g.
  // its last file was deleted), fall back to All so the grid never shows a
  // stale "nothing matches".
  const filterChips = useMemo(
    () => [
      { key: 'all' as AssetFilter, label: 'All' },
      ...KIND_FILTERS.filter((f) => (counts[f.key] ?? 0) > 0)
    ],
    [counts]
  )
  const activeFilter: AssetFilter =
    filter !== 'all' && (counts[filter] ?? 0) === 0 ? 'all' : filter

  const visible = useMemo(() => {
    const filtered = assets.filter((a) => (activeFilter === 'all' ? true : a.kind === activeFilter))
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (sortKey === 'name') return dir * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      if (sortKey === 'size') return dir * ((a.size ?? 0) - (b.size ?? 0))
      return dir * ((a.updatedAt ?? 0) - (b.updatedAt ?? 0))
    })
  }, [assets, activeFilter, sortKey, sortDir])

  // Lazily fetch an OS thumbnail for non-image / non-video cards (once per
  // path). Images render straight from their URL; video shows a real first
  // frame via a <video> element, so neither needs the OS thumbnail.
  useEffect(() => {
    let cancelled = false
    for (const a of visible) {
      if (a.kind === 'image' || a.kind === 'video' || requested.current.has(a.path)) continue
      requested.current.add(a.path)
      void window.zen
        .assetThumbnail(a.path, 320)
        .then((url) => {
          if (!cancelled) setThumbs((prev) => ({ ...prev, [a.path]: url }))
        })
        .catch(() => {
          if (!cancelled) setThumbs((prev) => ({ ...prev, [a.path]: null }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [visible])

  const assetUrl = (asset: AssetMeta): string | null =>
    vault ? window.zen.resolveVaultAssetUrl(vault.root, asset.path) : null

  const openAsset = (asset: AssetMeta): void => {
    void openNoteInTab(assetTabPath(asset.path))
  }

  const copyEmbed = (asset: AssetMeta): void => {
    window.zen.clipboardWriteText(`![[${asset.path}]]`)
    setCopied(asset.path)
  }
  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(null), 1200)
    return () => window.clearTimeout(id)
  }, [copied])

  const [importing, setImporting] = useState(false)
  const handleAddClick = async (): Promise<void> => {
    if (importing) return
    setImporting(true)
    try {
      const added = await window.zen.importAssetsViaDialog()
      if (added.length > 0) await refreshAssets()
    } catch (err) {
      console.error('importAssetsViaDialog failed', err)
    } finally {
      setImporting(false)
    }
  }

  // Drag external files onto the grid to import them into assets/. Drag-drop is
  // the reliable path for getPathForFile (unlike a file picker), so we reuse the
  // editor's proven path-extraction here.
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const onDragOver = (e: React.DragEvent): void => {
    if (!canImport || !hasDroppedFiles(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragEnter = (e: React.DragEvent): void => {
    if (!canImport || !hasDroppedFiles(e.dataTransfer)) return
    e.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }
  const onDragLeave = (): void => {
    if (!canImport) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    if (!canImport) return
    e.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    const paths = droppedPathsFromTransfer(e.dataTransfer)
    if (paths.length === 0) return
    setImporting(true)
    try {
      await window.zen.importAssetsToVault(paths)
      await refreshAssets()
    } catch (err) {
      console.error('drop import failed', err)
    } finally {
      setImporting(false)
    }
  }

  const menuItems = (asset: AssetMeta): ContextMenuItem[] => {
    const root = vault?.root ?? ''
    const sep = root.includes('\\') ? '\\' : '/'
    const abs = [root.replace(/[\\/]+$/, ''), ...asset.path.split('/').filter(Boolean)].join(sep)
    const currentDir = asset.path.split('/').slice(0, -1).join('/')
    const items: ContextMenuItem[] = [
      { label: t('Open'), onSelect: async () => openAsset(asset) },
      { label: t('Open in New Tab'), onSelect: async () => openAsset(asset) }
    ]
    if (canManage) {
      items.push({
        label: t('Rename…'),
        onSelect: async () => {
          const next = await promptApp({
            title: t('Rename asset'),
            initialValue: asset.name,
            okLabel: t('Rename'),
            validate: (value) => {
              const clean = value.trim()
              if (!clean) return t('Asset name is required')
              if (/[\\/]/.test(clean)) return t('Use only a file name')
              if (/\.md$/i.test(clean)) return t('Use note actions for markdown notes')
              return null
            }
          })
          if (!next || next === asset.name) return
          await window.zen.renameAsset(asset.path, next)
          await refreshAssets()
        }
      })
      items.push({
        label: t('Move…'),
        onSelect: async () => {
          const target = await promptApp({
            title: t('Move asset'),
            description: t('Enter a vault-relative folder path. Leave empty to move to the vault root.'),
            initialValue: currentDir,
            placeholder: t('media/screenshots'),
            okLabel: t('Move'),
            allowEmptySubmit: true,
            validate: (value) => {
              const clean = value.trim()
              if (clean.includes('..')) return t('Path cannot contain ..')
              if (clean.split('/').includes('.zennotes')) {
                return t('Cannot move assets into internal ZenNotes files')
              }
              return null
            }
          })
          if (target === null || target === currentDir) return
          await window.zen.moveAsset(asset.path, target)
          await refreshAssets()
        }
      })
      items.push({
        label: t('Duplicate'),
        onSelect: async () => {
          await window.zen.duplicateAsset(asset.path)
          await refreshAssets()
        }
      })
    }
    items.push({ label: t('Copy as Embed'), onSelect: async () => copyEmbed(asset) })
    items.push({
      label: t('Copy Path'),
      onSelect: async () => window.zen.clipboardWriteText(asset.path)
    })
    items.push({
      label: workspaceMode === 'remote' ? t('Copy Server Path') : t('Copy Absolute Path'),
      onSelect: async () => window.zen.clipboardWriteText(abs)
    })
    if (canReveal) {
      items.push({
        label: t('Reveal in File Manager'),
        onSelect: async () => {
          await window.zen.revealNote(asset.path)
        }
      })
    }
    if (canManage) {
      items.push({ kind: 'separator' })
      items.push({
        label: t('Delete Asset…'),
        icon: <TrashIcon />,
        danger: true,
        onSelect: async () => {
          const ok = await confirmApp({
            title: `${t('Delete')} ${asset.name}?`,
            description: t(
              'This removes the file from the vault. Notes that embed it will keep the link, but the media will no longer render.'
            ),
            confirmLabel: t('Delete asset'),
            danger: true
          })
          if (!ok) return
          await deleteAssetAction(asset.path)
        }
      })
    }
    return items
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900"
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/55 bg-accent/8">
          <span className="rounded-md bg-paper-50/90 px-3 py-1.5 text-sm font-medium text-accent shadow-sm">
            {t('Drop files to add to assets')}
          </span>
        </div>
      )}
      <header className="glass-header flex h-12 shrink-0 items-center gap-2 px-4">
        {!sidebarOpen && (
          <IconButton size="sm" title={t('Show sidebar (⌘1)')} onClick={() => toggleSidebar()}>
            <PanelLeftIcon className="h-4 w-4" />
          </IconButton>
        )}
        <PaperclipIcon className="h-4 w-4 shrink-0 text-ink-500" />
        <h2 className="truncate text-sm font-semibold text-ink-900">{assetsLabel}</h2>
        <span className="shrink-0 text-xs text-ink-500">{assets.length}</span>

        <div className="ml-auto flex items-center gap-1.5">
          {canImport && (
            <Button
              variant="secondary"
              size="sm"
              disabled={importing}
              onClick={() => void handleAddClick()}
            >
              <PlusIcon className="h-3.5 w-3.5" /> {t('Add')}
            </Button>
          )}
        </div>
      </header>

      {/* View controls live in the content area, not the title bar. No divider
          line — matches the database view's group-by toolbar (extra lines read
          as clutter). */}
      <div className="flex shrink-0 flex-wrap items-center gap-6 px-4 py-3">
        {/* Filter — segmented pill (matches the theme-mode control) */}
        <div className="inline-flex h-9 items-center rounded-xl border border-paper-300/70 bg-paper-100/75 p-1">
          {filterChips.map((f) => {
            const active = activeFilter === f.key
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={[
                  'flex h-full items-center gap-1.5 rounded-lg px-3 text-xs transition-colors',
                  active
                    ? 'bg-paper-50 text-ink-900 shadow-sm'
                    : 'text-ink-600 hover:text-ink-900'
                ].join(' ')}
              >
                {t(f.label)}
                <span className="tabular-nums text-ink-400">{counts[f.key]}</span>
              </button>
            )
          })}
        </div>

        {/* Divider between the filter and sort groups. */}
        <span className="h-5 w-px shrink-0 bg-paper-300/70" />

        {/* Sort — same pill. Custom chevron (the native <select> arrow can't be
            spaced off the divider, which left an ugly dead zone). */}
        <div className="inline-flex h-9 items-center rounded-xl border border-paper-300/70 bg-paper-100/75 text-xs">
          <div className="relative flex h-full items-center">
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              title={t('Sort by')}
              className="h-full cursor-pointer appearance-none rounded-l-xl bg-transparent pl-3.5 pr-8 text-ink-700 outline-none"
            >
              <option value="updated">{t('Date modified')}</option>
              <option value="name">{t('Name')}</option>
              <option value="size">{t('Size')}</option>
            </select>
            <ChevronDownGlyph className="pointer-events-none absolute right-2.5 text-ink-400" />
          </div>
          <button
            type="button"
            title={sortDir === 'asc' ? t('Ascending') : t('Descending')}
            onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            className="flex h-full items-center rounded-r-xl border-l border-paper-300/60 px-3 text-ink-500 transition-colors hover:text-ink-900"
          >
            <SortIcon className={['h-4 w-4', sortDir === 'asc' ? 'rotate-180' : ''].join(' ')} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-ink-500">
            {assets.length === 0 ? t('No assets yet. Add images, PDFs, and other files.') : t('Nothing matches this filter.')}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
            {visible.map((asset) => {
              const isImage = asset.kind === 'image'
              const isVideo = asset.kind === 'video'
              const videoUrl = isVideo ? assetUrl(asset) : null
              const thumb = isImage ? assetUrl(asset) : thumbs[asset.path]
              const ext = asset.name.includes('.')
                ? asset.name.split('.').pop()?.toUpperCase() ?? ''
                : ''
              return (
                <div
                  key={asset.path}
                  className="group flex flex-col overflow-hidden rounded-lg border border-paper-300/70 bg-paper-50 transition-colors hover:border-paper-400"
                >
                  <button
                    type="button"
                    onClick={() => openAsset(asset)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ asset, x: e.clientX, y: e.clientY })
                    }}
                    title={asset.name}
                    className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-paper-200/40"
                  >
                    {videoUrl ? (
                      <>
                        {/* The <video> element paints the frame at #t; the play
                            badge marks it as a video. pointer-events-none keeps
                            the card click (open) working. */}
                        <video
                          src={`${videoUrl}#t=0.1`}
                          muted
                          playsInline
                          preload="metadata"
                          draggable={false}
                          className="pointer-events-none h-full w-full object-cover"
                        />
                        <span className="pointer-events-none absolute flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white">
                          <PlayGlyph />
                        </span>
                      </>
                    ) : thumb ? (
                      <img
                        src={thumb}
                        alt={asset.name}
                        loading="lazy"
                        draggable={false}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-1 text-ink-400">
                        {kindGlyph(asset.kind)}
                        {ext && <span className="text-2xs uppercase tracking-wide">{ext}</span>}
                      </div>
                    )}
                    <span
                      role="button"
                      tabIndex={-1}
                      title={t('Copy as Embed')}
                      onClick={(e) => {
                        e.stopPropagation()
                        copyEmbed(asset)
                      }}
                      className={[
                        'absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md border border-paper-300 bg-paper-50/90 text-ink-600 shadow-sm transition hover:text-accent',
                        copied === asset.path ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      ].join(' ')}
                    >
                      {copied === asset.path ? (
                        <span className="text-2xs font-semibold text-accent">✓</span>
                      ) : (
                        <EmbedGlyph />
                      )}
                    </span>
                  </button>
                  <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs text-ink-800" title={asset.name}>
                      {asset.name}
                    </span>
                    {asset.size != null && asset.size > 0 && (
                      <span className="shrink-0 text-2xs text-ink-400">{formatBytes(asset.size)}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.asset)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

function ChevronDownGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function PlayGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function EmbedGlyph(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2" />
    </svg>
  )
}
