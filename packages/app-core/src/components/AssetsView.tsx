import { useMemo, useState } from 'react'
import type { AssetMeta } from '@shared/ipc'
import { useStore } from '../store'
import { assetTabPath } from '../lib/asset-tabs'
import { confirmMoveToTrash } from '../lib/confirm-trash'
import { naturalCompare } from '../lib/natural-sort'
import {
  DocumentIcon,
  ImageIcon,
  PanelLeftIcon,
  PaperclipIcon,
  SearchIcon,
  TrashIcon
} from './icons'

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
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const [filter, setFilter] = useState('')

  const assets = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matched = q
      ? assetFiles.filter((a) => a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q))
      : assetFiles
    return [...matched].sort((a, b) => naturalCompare(a.name, b.name))
  }, [assetFiles, filter])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900">
      <header className="glass-header flex h-12 shrink-0 items-center gap-2 px-4">
        {!sidebarOpen && (
          <button
            type="button"
            title="Show sidebar (⌘1)"
            onClick={() => toggleSidebar()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 hover:bg-paper-200 hover:text-ink-900"
          >
            <PanelLeftIcon className="h-4 w-4" />
          </button>
        )}
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

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {assets.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-ink-400">
            {assetFiles.length === 0 ? 'No assets yet.' : 'No assets match your filter.'}
          </div>
        ) : (
          <ul className="flex flex-col">
            {assets.map((asset) => (
              <li key={asset.path}>
                <div className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-paper-200/40">
                  <button
                    type="button"
                    onClick={() => void openNoteInTab(assetTabPath(asset.path))}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    title={asset.path}
                  >
                    <span className="shrink-0 text-ink-500">
                      <AssetGlyph kind={asset.kind} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-900">{asset.name}</span>
                    <span className="shrink-0 text-2xs uppercase tracking-wide text-ink-400">
                      {asset.kind}
                    </span>
                    <span className="hidden shrink-0 text-xs tabular-nums text-ink-500 sm:inline">
                      {formatBytes(asset.size)}
                    </span>
                    <span className="hidden w-16 shrink-0 text-right text-xs text-ink-500 md:inline">
                      {formatDate(asset.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${asset.name}`}
                    title="Move to Trash"
                    onClick={async () => {
                      if (await confirmMoveToTrash(asset.name)) await deleteAsset(asset.path)
                    }}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-400 opacity-0 transition hover:bg-paper-300/60 hover:text-danger group-hover:opacity-100"
                  >
                    <TrashIcon width={14} height={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
