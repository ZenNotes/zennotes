import { useMemo, useState } from 'react'
import type { AssetMeta } from '@shared/ipc'
import { useStore, type AssetSortColumn, type AssetSortOrder } from '../store'
import { assetTabPath } from '../lib/asset-tabs'
import { confirmMoveToTrash } from '../lib/confirm-trash'
import { promptApp } from '../lib/prompt-requests'
import { naturalCompare } from '../lib/natural-sort'
import { resolveAssetVaultRelativePath } from '../lib/local-assets'
import { downloadAsset } from '../lib/download-asset'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { DocumentIcon, ImageIcon, PaperclipIcon, SearchIcon, TrashIcon } from './icons'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDate(ms: number): string {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric'
  })
}

// Shared column template for the header + every row, so columns line up:
// name (flex) · used · type · size · modified · action.
const ASSET_ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_6rem_4rem_5rem_5rem_1.75rem] items-center gap-4'

// Which column the Assets list is sorted by. (#460)
export type AssetSortKey = AssetSortColumn
export interface AssetSort {
  key: AssetSortKey
  dir: 'asc' | 'desc'
}

/** Split the stored `<column>-<dir>` preference into the shape `sortAssets`
 *  takes. The value is validated in the store, so a bad split can't reach
 *  here; fall back to the default anyway rather than sorting by `undefined`. (#473) */
export function parseAssetSortOrder(order: AssetSortOrder): AssetSort {
  const at = order.lastIndexOf('-')
  const key = order.slice(0, at) as AssetSortKey
  const dir = order.slice(at + 1) as AssetSort['dir']
  if (!key || (dir !== 'asc' && dir !== 'desc')) return { key: 'name', dir: 'asc' }
  return { key, dir }
}

/** Inverse of `parseAssetSortOrder`, for writing the preference back. (#473) */
export function assetSortOrderOf(sort: AssetSort): AssetSortOrder {
  return `${sort.key}-${sort.dir}` as AssetSortOrder
}

/** Display label for a note path in the "used by" menu — its filename. */
function noteLabel(notePath: string): string {
  return notePath.split('/').pop()?.replace(/\.md$/i, '') ?? notePath
}

/**
 * Sort assets by the chosen column. `used` sorts on how many notes reference
 * the asset; name is the stable tiebreak for every column so equal rows keep a
 * predictable order. (#460)
 */
export function sortAssets(
  list: AssetMeta[],
  usage: Map<string, string[]>,
  sort: AssetSort
): AssetMeta[] {
  const usedCount = (a: AssetMeta): number => usage.get(a.path)?.length ?? 0
  const dir = sort.dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    let cmp = 0
    switch (sort.key) {
      case 'used':
        cmp = usedCount(a) - usedCount(b)
        break
      case 'type':
        cmp = naturalCompare(a.kind, b.kind)
        break
      case 'size':
        cmp = a.size - b.size
        break
      case 'modified':
        cmp = a.updatedAt - b.updatedAt
        break
      default:
        cmp = 0
    }
    if (cmp === 0) cmp = naturalCompare(a.name, b.name)
    return cmp * dir
  })
}

function AssetGlyph({ kind }: { kind: AssetMeta['kind'] }): JSX.Element {
  if (kind === 'image') return <ImageIcon width={15} height={15} />
  if (kind === 'pdf') return <DocumentIcon width={15} height={15} />
  return <PaperclipIcon width={15} height={15} />
}

/**
 * The built-in Assets view: browse every asset in the vault in one place
 * (images, PDFs, attachments), independent of the notes tree.
 */
export function AssetsView(): JSX.Element {
  const assetFiles = useStore((s) => s.assetFiles)
  const openNoteInTab = useStore((s) => s.openNoteInTab)
  const deleteAsset = useStore((s) => s.deleteAsset)
  const refreshAssets = useStore((s) => s.refreshAssets)
  const notes = useStore((s) => s.notes)
  const vaultRoot = useStore((s) => s.vault?.root ?? null)
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; asset: AssetMeta } | null>(null)
  const [usageMenu, setUsageMenu] = useState<{ x: number; y: number; notes: string[] } | null>(null)
  // Sort lives in the store (and config.toml), not local state, so leaving the
  // view and coming back keeps the column you picked. (#473)
  const assetSortOrder = useStore((s) => s.assetSortOrder)
  const setAssetSortOrder = useStore((s) => s.setAssetSortOrder)
  const sort = useMemo(() => parseAssetSortOrder(assetSortOrder), [assetSortOrder])

  // assetPath → note paths that embed it (resolved via relative-path + the
  // unique-basename fallback, matching how embeds render). (#185)
  const usage = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const note of notes) {
      for (const href of note.assetEmbeds ?? []) {
        const resolved = resolveAssetVaultRelativePath(vaultRoot, note.path, href)
        if (!resolved) continue
        const arr = map.get(resolved)
        if (arr) {
          if (!arr.includes(note.path)) arr.push(note.path)
        } else {
          map.set(resolved, [note.path])
        }
      }
    }
    return map
  }, [notes, vaultRoot, assetFiles])

  const assets = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matched = q
      ? assetFiles.filter((a) => a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q))
      : assetFiles
    return sortAssets(matched, usage, sort)
  }, [assetFiles, filter, sort, usage])

  // Click a header: sort by it, or flip direction if it's already active. Text
  // columns start ascending; count/size/date start descending (biggest first).
  const toggleSort = (key: AssetSortKey): void => {
    const next: AssetSort =
      sort.key === key
        ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' || key === 'type' ? 'asc' : 'desc' }
    setAssetSortOrder(assetSortOrderOf(next))
  }

  const copyEmbed = (asset: AssetMeta): void => {
    void navigator.clipboard?.writeText(`![[${asset.name}]]`)
  }

  const triggerDownload = (asset: AssetMeta): void => {
    downloadAsset(vaultRoot, asset.path).catch((err: unknown) => {
      window.alert(err instanceof Error ? err.message : String(err))
    })
  }

  const renameAsset = async (asset: AssetMeta): Promise<void> => {
    if (typeof window.zen.renameAsset !== 'function') return
    const ext = asset.name.includes('.') ? asset.name.slice(asset.name.lastIndexOf('.')) : ''
    const base = ext ? asset.name.slice(0, -ext.length) : asset.name
    const next = await promptApp({
      title: 'Rename asset',
      initialValue: base,
      okLabel: 'Rename',
      validate: (v) => (v.includes('/') ? 'Use only a name' : null)
    })
    if (!next) return
    const clean = next.trim()
    if (!clean || `${clean}${ext}` === asset.name) return
    try {
      await window.zen.renameAsset(asset.path, `${clean}${ext}`)
      await refreshAssets()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }

  const menuItems = (asset: AssetMeta): ContextMenuItem[] => [
    { label: 'Open', onSelect: () => void openNoteInTab(assetTabPath(asset.path)) },
    { label: 'Copy embed', onSelect: () => copyEmbed(asset) },
    { label: 'Download', onSelect: () => void triggerDownload(asset) },
    { label: 'Reveal in file manager', onSelect: () => void window.zen.revealNote(asset.path) },
    { label: 'Rename…', onSelect: () => void renameAsset(asset) },
    {
      label: 'Move to Trash',
      danger: true,
      onSelect: async () => {
        if (await confirmMoveToTrash(asset.name)) await deleteAsset(asset.path)
      }
    }
  ]

  const sortHeader = (
    label: string,
    key: AssetSortKey,
    align: 'left' | 'right' = 'right'
  ): JSX.Element => {
    const active = sort.key === key
    return (
      <button
        type="button"
        onClick={() => toggleSort(key)}
        aria-label={active ? `Sort by ${label} (${sort.dir === 'asc' ? 'ascending' : 'descending'})` : `Sort by ${label}`}
        className={[
          'flex w-full items-center gap-1 uppercase tracking-wide outline-none transition-colors hover:text-ink-600 focus-visible:text-ink-600',
          align === 'right' ? 'justify-end' : 'justify-start',
          active ? 'text-ink-600' : ''
        ].join(' ')}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden="true" className="text-[0.55rem] leading-none">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900">
      <header className="glass-header flex h-12 shrink-0 items-center gap-2 px-4">
        <PaperclipIcon className="h-4 w-4 shrink-0 text-ink-500" />
        <h2 className="text-sm font-semibold text-ink-900">Assets</h2>
        <span className="shrink-0 text-xs text-ink-500">{assetFiles.length}</span>
        <div className="ml-auto flex items-center gap-1.5 rounded-md bg-paper-200/60 px-2 py-1">
          <SearchIcon className="h-3.5 w-3.5 text-ink-400" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter assets"
            className="w-40 bg-transparent text-xs text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {assets.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-ink-400">
            {assetFiles.length === 0 ? 'No assets yet.' : 'No assets match your filter.'}
          </div>
        ) : (
          <>
            <div className={`${ASSET_ROW_GRID} sticky top-0 z-10 border-b border-paper-300/60 bg-paper-100 px-3 py-1.5 text-2xs font-medium text-ink-400`}>
              {sortHeader('Name', 'name', 'left')}
              {sortHeader('Used', 'used')}
              {sortHeader('Type', 'type')}
              {sortHeader('Size', 'size')}
              {sortHeader('Modified', 'modified')}
              <span />
            </div>
            <ul className="flex flex-col py-1">
              {assets.map((asset) => {
                const usedIn = usage.get(asset.path)?.length ?? 0
                const open = (): void => void openNoteInTab(assetTabPath(asset.path))
                return (
                  <li key={asset.path}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          open()
                        }
                        // Keyboard-first download (#716): `d` on a focused
                        // row saves the asset, matching the context menu.
                        if (e.key === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey) {
                          e.preventDefault()
                          triggerDownload(asset)
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu({ x: e.clientX, y: e.clientY, asset })
                      }}
                      className={`${ASSET_ROW_GRID} group cursor-pointer px-3 py-1.5 outline-none hover:bg-paper-200/40 focus-visible:bg-paper-200/40`}
                      title={asset.path}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="shrink-0 text-ink-500">
                          <AssetGlyph kind={asset.kind} />
                        </span>
                        <span className="min-w-0 truncate text-sm text-ink-900">{asset.name}</span>
                      </div>
                      <button
                        type="button"
                        disabled={usedIn === 0}
                        onClick={(e) => {
                          e.stopPropagation()
                          const notePaths = usage.get(asset.path) ?? []
                          if (notePaths.length === 1) void openNoteInTab(notePaths[0]!)
                          else if (notePaths.length > 1)
                            setUsageMenu({ x: e.clientX, y: e.clientY, notes: notePaths })
                        }}
                        className={[
                          'truncate text-right text-2xs outline-none',
                          usedIn === 0
                            ? 'cursor-default text-ink-400/70'
                            : 'text-ink-500 hover:text-accent hover:underline focus-visible:text-accent'
                        ].join(' ')}
                        title={
                          usedIn === 0
                            ? 'Not referenced by any note'
                            : `Used by:\n${(usage.get(asset.path) ?? [])
                                .map(noteLabel)
                                .join('\n')}\n\nClick to open`
                        }
                      >
                        {usedIn === 0 ? 'unused' : `used in ${usedIn}`}
                      </button>
                      <span className="text-right text-2xs uppercase tracking-wide text-ink-400">
                        {asset.kind}
                      </span>
                      <span className="text-right text-xs tabular-nums text-ink-500">
                        {formatBytes(asset.size)}
                      </span>
                      <span className="text-right text-xs tabular-nums text-ink-500">
                        {formatDate(asset.updatedAt)}
                      </span>
                      <button
                        type="button"
                        aria-label={`Delete ${asset.name}`}
                        title="Move to Trash"
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (await confirmMoveToTrash(asset.name)) await deleteAsset(asset.path)
                        }}
                        className="flex h-6 w-6 items-center justify-center justify-self-end rounded text-ink-400 opacity-0 transition hover:bg-paper-300/60 hover:text-danger group-hover:opacity-100"
                      >
                        <TrashIcon width={14} height={14} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.asset)}
          onClose={() => setMenu(null)}
        />
      )}
      {usageMenu && (
        <ContextMenu
          x={usageMenu.x}
          y={usageMenu.y}
          items={usageMenu.notes.map((notePath) => ({
            label: noteLabel(notePath),
            onSelect: () => void openNoteInTab(notePath)
          }))}
          onClose={() => setUsageMenu(null)}
        />
      )}
    </div>
  )
}
